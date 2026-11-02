import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gatewaySdkArchiveSha256, gatewaySdkCapability, gatewaySdkCodexVersion,
  gatewaySdkPatches, gatewaySdkPatchDigest, gatewaySdkRevision, gatewaySdkSourceDigest } from './gateway-sdk-source.mjs';
import { gatewaySdkLockRepairDigest, gatewaySdkTestRunnerDigest } from './gateway-sdk-source.mjs';
import { gatewaySdkLockSha256, repairGatewaySdkLock } from './gateway-sdk-lock.mjs';
import { recoverGatewaySdkCompactionTests, withGatewaySdkCompactionTests } from './gateway-sdk-test-runner.mjs';
import { withPrivateFileLock } from '../dist/private-file-lock.js';
import { withCargoTargetLocks } from './cargo-target-lock.mjs';
import { assertFreeSpaceForPaths, releaseDiskSpaceRequirements } from './disk-space.mjs';

const { values } = parseArgs({ options: { archive: { type: 'string' }, 'target-dir': { type: 'string' },
  'build-root': { type: 'string' }, dev: { type: 'boolean' }, test: { type: 'boolean' }, version: { type: 'string' } } });

/**
 * Fetches the V8 static library the code-mode host links, exactly as Codex's `setup-rusty-v8` action does: OpenAI's own
 * `rusty-v8-v<version>` release, a two-line checksum manifest whose SHA-256 is pinned in the verified source tree
 * (`third_party/v8/rusty_v8_<version>_release_manifests.sha256`), and both files checked against that manifest.
 */
async function rustyV8Artifacts(sdk, root) {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const lock = readFileSync(join(sdk, 'codex-rs/Cargo.lock'), 'utf8');
  const version = /\[\[package\]\]\nname = "v8"\nversion = "(\d+\.\d+\.\d+)"/.exec(lock)?.[1];
  if (!version) throw Error('Pinned Cargo.lock names no v8 version');
  const profile = 'ptrcomp_sandbox_release'; const target = 'aarch64-apple-darwin';
  const names = { manifest: `rusty_v8_${profile}_${target}.sha256`, archive: `librusty_v8_${profile}_${target}.a.gz`, binding: `src_binding_${profile}_${target}.rs` };
  const trusted = readFileSync(join(sdk, `third_party/v8/rusty_v8_${version.replaceAll('.', '_')}_release_manifests.sha256`), 'utf8')
    .split('\n').map(line => line.trim().split(/\s+/)).find(([, name]) => name === names.manifest)?.[0];
  if (!/^[a-f0-9]{64}$/.test(trusted || '')) throw Error('Pinned source has no trusted V8 manifest checksum for this target');
  const directory = join(root, 'rusty-v8', version); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fetched = async (name, expected) => {
    const path = join(directory, name);
    if (!existsSync(path) || sha(readFileSync(path)) !== expected) {
      const response = await fetch(`https://github.com/openai/codex/releases/download/rusty-v8-v${version}/${name}`);
      if (!response.ok) throw Error(`V8 artifact download failed: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (sha(bytes) !== expected) throw Error(`V8 artifact checksum mismatch: ${name}`);
      writeFileSync(path, bytes, { mode: 0o600 });
    }
    return path;
  };
  // The manifest is checked as raw bytes (some are CRLF); then each line pins one artifact.
  const manifest = readFileSync(await fetched(names.manifest, trusted), 'utf8').replaceAll('\r', '').split('\n').filter(Boolean)
    .map(line => line.trim().split(/\s+/));
  if (manifest.length !== 2) throw Error('V8 manifest must list exactly two artifacts');
  const pinned = name => { const hash = manifest.find(([, file]) => file.replace(/^\*/, '') === name)?.[0]; if (!/^[a-f0-9]{64}$/.test(hash || '')) throw Error(`V8 manifest omits ${name}`); return hash; };
  const archiveSha256 = pinned(names.archive);
  return { version, archiveSha256, archive: await fetched(names.archive, archiveSha256), binding: await fetched(names.binding, pinned(names.binding)) };
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Gateway SDK release requires an Apple Silicon Mac');
const root = resolve(values['build-root'] || '.state/gateway-sdk-build');
const target = resolve(values['target-dir'] || join(root, 'target'));
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
await withPrivateFileLock(join(root, 'build'), async () => {
await withCargoTargetLocks([target], async () => {
assertFreeSpaceForPaths([root, target], values.test ? releaseDiskSpaceRequirements.gatewaySdkTest : releaseDiskSpaceRequirements.gatewaySdkBuild,
  values.test ? 'Gateway SDK test build' : 'Gateway SDK build');
const archive = resolve(values.archive || join(root, `source-${gatewaySdkRevision}.tar.gz`));
if (!existsSync(archive)) {
  const response = await fetch(`https://api.github.com/repos/openai/codex/tarball/${gatewaySdkRevision}`);
  if (!response.ok) throw Error(`SDK download failed: HTTP ${response.status}`);
  mkdirSync(resolve(archive, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
if (digest(archive) !== gatewaySdkArchiveSha256) throw Error('Pinned gateway SDK archive checksum mismatch');
const patchSha256 = gatewaySdkPatchDigest();
const lockfileRepairSha256 = gatewaySdkLockRepairDigest();
const sourceSha256 = gatewaySdkSourceDigest();
const sdkKey = createHash('sha256').update(patchSha256).update(lockfileRepairSha256).digest('hex').slice(0, 12);
const sdk = join(root, `sdk-${gatewaySdkRevision.slice(0, 12)}-${sdkKey}`);
const marker = join(sdk, '.gateway-build-input.json');
function treeDigest(directory) {
  const hash = createHash('sha256');
  function walk(path, relative = '') {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (key === '.gateway-build-input.json') continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child, key);
      else if (entry.isFile()) hash.update(key).update('\0').update(readFileSync(child)).update('\0');
      else if (entry.isSymbolicLink()) hash.update(key).update('\0link\0').update(readlinkSync(child)).update('\0');
      else throw Error('Unsupported SDK source entry');
    }
  }
  walk(directory); return hash.digest('hex');
}
if (!existsSync(sdk)) {
  mkdirSync(sdk, { mode: 0o700 });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', sdk]);
  const gitEnvironment = { ...process.env, GIT_CEILING_DIRECTORIES: root };
  for (const path of gatewaySdkPatches) {
    const patch = resolve(path);
    execFileSync('git', ['apply', '--check', patch], { cwd: sdk, env: gitEnvironment });
    execFileSync('git', ['apply', patch], { cwd: sdk, env: gitEnvironment });
  }
  repairGatewaySdkLock(join(sdk, 'codex-rs/Cargo.lock'));
  writeFileSync(marker, JSON.stringify({ revision: gatewaySdkRevision, archiveSha256: gatewaySdkArchiveSha256,
    patchSha256, lockfileRepairSha256, lockfileSha256: gatewaySdkLockSha256, patchedSdkSha256: treeDigest(sdk) }), { mode: 0o600 });
}
if (!lstatSync(sdk).isDirectory() || !existsSync(marker)) throw Error('Refusing an unrecognized gateway SDK checkout');
const input = JSON.parse(readFileSync(marker, 'utf8'));
recoverGatewaySdkCompactionTests(sdk);
if (input.revision !== gatewaySdkRevision || input.archiveSha256 !== gatewaySdkArchiveSha256 ||
    input.patchSha256 !== patchSha256 || input.lockfileRepairSha256 !== lockfileRepairSha256 ||
    input.lockfileSha256 !== gatewaySdkLockSha256 || input.patchedSdkSha256 !== treeDigest(sdk)) {
  throw Error('Gateway SDK checkout changed since verified extraction');
}
const version = values.version || JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid gateway SDK release version');
const manifest = join(sdk, 'codex-rs/Cargo.toml');
// A build started from inside a gateway chat inherits the executor marker; the SDK's tests set or remove it per case themselves.
const cargoEnvironment = { ...process.env, CARGO_BUILD_JOBS: '2' }; delete cargoEnvironment.HARNESS_GATEWAY_EXECUTOR;
const profile = values.dev ? [] : ['--release'];
if (values.test) {
  if (cargoEnvironment.CODEX_SANDBOX_NETWORK_DISABLED !== undefined) throw Error('Gateway SDK tests require the local mock server network');
  // The compaction cases set the executor marker in the process environment, so every case runs on one thread.
  const run = args => execFileSync('cargo', ['test', '--locked', ...profile, '--manifest-path', manifest, '--target-dir', target, ...args,
    '--', '--nocapture', '--test-threads=1'], { cwd: join(sdk, 'codex-rs'), env: cargoEnvironment, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  const passed = (output, count, name) => {
    const result = /test result: ok\. (\d+) passed; 0 failed;/.exec(output);
    if (!result || Number(result[1]) !== count || output.includes('Skipping test')) throw Error(`Gateway SDK regression gate did not execute all ${name} cases`);
  };
  passed(run(['-p', 'codex-model-provider-info', '--lib', 'gateway_executor']), 3, 'executor identity');
  passed(withGatewaySdkCompactionTests(sdk, () => run(['-p', 'codex-core', '--test', 'all',
    'gateway_pre_sampling_compaction_stays_in_selected_user_turn'])), 6, 'compaction');
  passed(run(['-p', 'codex-queue-extension', '--test', 'queue_service', 'gateway_']), 2, 'queue preservation');
  // Declared-deferred client tools: flat and namespaced fallback, search-capable discovery, policy and namespace rules.
  passed(run(['-p', 'codex-core', '--lib', 'gateway_dynamic_tool']), 7, 'dynamic client tool');
  // The existing router test this patch changes (search-capable model plus baseline namespaces) must keep passing.
  passed(run(['-p', 'codex-core', '--lib', 'specs_filter_deferred_dynamic_tools']), 1, 'deferred dynamic tool filtering');
  passed(run(['-p', 'codex-core', '--lib', 'gateway_role_context']), 3, 'managed and named Qwen role context');
  passed(run(['-p', 'codex-core', '--lib', 'gateway_cache_recovery']), 3, 'cache recovery active context');
  if (treeDigest(sdk) !== input.patchedSdkSha256) throw Error('SDK test gate changed the verified source tree');
  console.log(JSON.stringify({ tests: 25, revision: gatewaySdkRevision, patchSha256, sourceSha256,
    testRunnerSha256: gatewaySdkTestRunnerDigest() }));
} else {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', manifest],
    { cwd: join(sdk, 'codex-rs'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const cli = metadata.packages.find(value => value.name === 'codex-cli' && value.manifest_path === join(sdk, 'codex-rs/cli/Cargo.toml'));
  if (!cli) throw Error('Isolated gateway CLI package is unavailable');
  const host = metadata.packages.find(value => value.name === 'codex-code-mode-host' && value.manifest_path === join(sdk, 'codex-rs/code-mode-host/Cargo.toml'));
  if (!host) throw Error('Gateway code-mode host package is unavailable');
  // The host links V8's pointer-compression sandbox build, which denoland does not publish. Codex's own CI fetches the
  // build OpenAI publishes on its releases and checks it against a manifest checksum kept in the pinned source; this does
  // the same, so every V8 byte traces back to the verified source archive.
  const v8 = await rustyV8Artifacts(sdk, root);
  Object.assign(cargoEnvironment, { RUSTY_V8_ARCHIVE: v8.archive, RUSTY_V8_SRC_BINDING_PATH: v8.binding });
  const artifact = join(root, 'artifact'); mkdirSync(artifact, { recursive: true, mode: 0o700 });
  // One Cargo build per packaged binary: the same profile, flags and target directory, so the host is the
  // companion of this CLI. Each is stripped to its symbol table, and both hashes cover the shipped file.
  const compiled = (spec, bin, label) => {
    const output = execFileSync('cargo', ['build', '--locked', '--message-format=json', ...profile, '--manifest-path', manifest,
      '--target-dir', target, '-p', spec.name, '--bin', bin],
      { cwd: join(sdk, 'codex-rs'), env: cargoEnvironment, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
    const artifacts = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(value =>
      value.reason === 'compiler-artifact' && value.package_id === spec.id && value.target.name === bin &&
      value.target.kind.includes('bin') && typeof value.executable === 'string');
    if (artifacts.length !== 1) throw Error(`Cargo did not identify one ${label} executable`);
    const path = artifacts[0].executable;
    if (!lstatSync(path).isFile()) throw Error(`${label} artifact is not a regular file`);
    const header = Buffer.alloc(16); const file = openSync(path, 'r');
    try { if (readSync(file, header, 0, header.length, 0) !== header.length) throw Error(`${label} header is incomplete`); }
    finally { closeSync(file); }
    if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c || header.readUInt32LE(12) !== 2) {
      throw Error(`${label} artifact is not a thin Mach-O ARM64 executable`);
    }
    return path;
  };
  const staged = (spec, bin, name, label) => {
    const executable = join(artifact, name);
    cpSync(compiled(spec, bin, label), executable);
    chmodSync(executable, 0o700); execFileSync('strip', ['-S', executable]);
    return executable;
  };
  const executable = staged(cli, 'codex', 'gateway-codex', 'Gateway CLI');
  const codeModeHost = staged(host, 'codex-code-mode-host', 'codex-code-mode-host', 'Gateway code-mode host');
  if (execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim() !== `codex-cli ${gatewaySdkCodexVersion}`) {
    throw Error('Compiled gateway SDK version mismatch');
  }
  cpSync(join(sdk, 'LICENSE'), join(artifact, 'CODEX-LICENSE'));
  cpSync(join(sdk, 'NOTICE'), join(artifact, 'CODEX-NOTICE'));
  writeFileSync(join(artifact, 'NOTICE'), 'Harness Gateway uses a separately compiled OpenAI Codex SDK for gateway-provider execution.\n' +
    'Executor identity, selected-model compaction and failed-turn queue preservation apply inside marked gateway executors.\n' +
    'Its dynamic-tool registration also exposes declared-deferred tools directly when the selected model cannot search.\n' +
    'The native signed Codex executable is unchanged.\n' +
    'The package also carries codex-code-mode-host, the Code Mode process Codex starts beside itself. It is built from the\n' +
    'same pinned Codex source and statically links V8 through Codex\'s code-mode runtime; dependencies.json lists the Cargo\n' +
    'packages and their licenses, including V8\'s.\n', { mode: 0o600 });
  writeFileSync(join(artifact, 'dependencies.json'), JSON.stringify(metadata.packages.map(({ name, version, license, repository }) =>
    ({ name, version, license, repository })), null, 2), { mode: 0o600 });
  writeFileSync(join(artifact, 'build.json'), JSON.stringify({ schemaVersion: 1, version,
    codexVersion: gatewaySdkCodexVersion, revision: gatewaySdkRevision, archiveSha256: gatewaySdkArchiveSha256,
    patchSha256, lockfileRepairSha256, lockfileSha256: gatewaySdkLockSha256,
    sourceSha256, testRunnerSha256: gatewaySdkTestRunnerDigest(),
    patchedSdkSha256: input.patchedSdkSha256, binarySha256: digest(executable), codeModeHostSha256: digest(codeModeHost),
    rustyV8: { version: v8.version, archiveSha256: v8.archiveSha256 },
    profile: values.dev ? 'dev' : 'release', platform: process.platform, arch: process.arch,
    capabilities: [gatewaySdkCapability] }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ artifact, version, revision: gatewaySdkRevision, patchSha256, sourceSha256 }));
}
});
}, 3_600_000);
