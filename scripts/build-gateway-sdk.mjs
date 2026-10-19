import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gatewaySdkArchiveSha256, gatewaySdkCapability, gatewaySdkCodexVersion,
  gatewaySdkPatches, gatewaySdkPatchDigest, gatewaySdkRevision, gatewaySdkSourceDigest } from './gateway-sdk-source.mjs';
import { gatewaySdkLockRepairDigest, gatewaySdkTestRunnerDigest } from './gateway-sdk-source.mjs';
import { gatewaySdkLockSha256, repairGatewaySdkLock } from './gateway-sdk-lock.mjs';
import { withGatewaySdkCompactionTests } from './gateway-sdk-test-runner.mjs';

const { values } = parseArgs({ options: { archive: { type: 'string' }, 'target-dir': { type: 'string' },
  dev: { type: 'boolean' }, test: { type: 'boolean' }, version: { type: 'string' } } });
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Gateway SDK release requires an Apple Silicon Mac');
const root = resolve('.state/gateway-sdk-build');
mkdirSync(root, { recursive: true, mode: 0o700 });
const archive = resolve(values.archive || '.state/native-relay-build/sdk.tar.gz');
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
if (input.revision !== gatewaySdkRevision || input.archiveSha256 !== gatewaySdkArchiveSha256 ||
    input.patchSha256 !== patchSha256 || input.lockfileRepairSha256 !== lockfileRepairSha256 ||
    input.lockfileSha256 !== gatewaySdkLockSha256 || input.patchedSdkSha256 !== treeDigest(sdk)) {
  throw Error('Gateway SDK checkout changed since verified extraction');
}
const version = values.version || JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid gateway SDK release version');
const manifest = join(sdk, 'codex-rs/Cargo.toml');
const target = resolve(values['target-dir'] || join(root, 'target'));
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
  if (treeDigest(sdk) !== input.patchedSdkSha256) throw Error('SDK test gate changed the verified source tree');
  console.log(JSON.stringify({ tests: 11, revision: gatewaySdkRevision, patchSha256, sourceSha256,
    testRunnerSha256: gatewaySdkTestRunnerDigest() }));
} else {
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--locked', '--format-version', '1', '--manifest-path', manifest],
    { cwd: join(sdk, 'codex-rs'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const cli = metadata.packages.find(value => value.name === 'codex-cli' && value.manifest_path === join(sdk, 'codex-rs/cli/Cargo.toml'));
  if (!cli) throw Error('Isolated gateway CLI package is unavailable');
  const output = execFileSync('cargo', ['build', '--locked', '--message-format=json', ...profile, '--manifest-path', manifest,
    '--target-dir', target, '-p', 'codex-cli', '--bin', 'codex'],
    { cwd: join(sdk, 'codex-rs'), env: cargoEnvironment, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  const artifacts = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(value =>
    value.reason === 'compiler-artifact' && value.package_id === cli.id && value.target.name === 'codex' &&
    value.target.kind.includes('bin') && typeof value.executable === 'string');
  if (artifacts.length !== 1) throw Error('Cargo did not identify one gateway CLI executable');
  const compiled = artifacts[0].executable;
  if (!lstatSync(compiled).isFile()) throw Error('Gateway CLI artifact is not a regular file');
  const header = Buffer.alloc(16); const file = openSync(compiled, 'r');
  try { if (readSync(file, header, 0, header.length, 0) !== header.length) throw Error('Gateway CLI header is incomplete'); }
  finally { closeSync(file); }
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c || header.readUInt32LE(12) !== 2) {
    throw Error('Gateway CLI artifact is not a thin Mach-O ARM64 executable');
  }
  const artifact = join(root, 'artifact'); mkdirSync(artifact, { recursive: true, mode: 0o700 });
  const executable = join(artifact, 'gateway-codex');
  cpSync(compiled, executable); chmodSync(executable, 0o700);
  execFileSync('strip', ['-S', executable]);
  if (execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim() !== `codex-cli ${gatewaySdkCodexVersion}`) {
    throw Error('Compiled gateway SDK version mismatch');
  }
  cpSync(join(sdk, 'LICENSE'), join(artifact, 'CODEX-LICENSE'));
  cpSync(join(sdk, 'NOTICE'), join(artifact, 'CODEX-NOTICE'));
  writeFileSync(join(artifact, 'NOTICE'), 'Harness Gateway uses a separately compiled OpenAI Codex SDK for gateway-provider execution.\n' +
    'Its patch applies only inside a gateway executor: selected-model compaction for the gateway provider, and the openai id\n' +
    'naming that loopback gateway provider when HARNESS_GATEWAY_EXECUTOR=1. The native signed Codex executable is unchanged.\n', { mode: 0o600 });
  writeFileSync(join(artifact, 'dependencies.json'), JSON.stringify(metadata.packages.map(({ name, version, license, repository }) =>
    ({ name, version, license, repository })), null, 2), { mode: 0o600 });
  writeFileSync(join(artifact, 'build.json'), JSON.stringify({ schemaVersion: 1, version,
    codexVersion: gatewaySdkCodexVersion, revision: gatewaySdkRevision, archiveSha256: gatewaySdkArchiveSha256,
    patchSha256, lockfileRepairSha256, lockfileSha256: gatewaySdkLockSha256,
    sourceSha256, testRunnerSha256: gatewaySdkTestRunnerDigest(),
    patchedSdkSha256: input.patchedSdkSha256, binarySha256: digest(executable),
    profile: values.dev ? 'dev' : 'release', platform: process.platform, arch: process.arch,
    capabilities: [gatewaySdkCapability] }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ artifact, version, revision: gatewaySdkRevision, patchSha256, sourceSha256 }));
}
