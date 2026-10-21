import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { nativeSourceDigest } from './native-source.mjs';
import { sdkArchiveSha256 as relaySdkArchiveSha256, sdkCodexVersion as relaySdkCodexVersion, sdkRevision as relaySdkRevision } from './native-relay-sdk.mjs';
import { releaseVersionProblem } from './release-version.mjs';
import { releaseComponentPlan, verifyReleaseComponentSources, copyReleaseComponents } from './release-components.mjs';
import { gatewaySdkArchiveSha256, gatewaySdkCapability, gatewaySdkCodexVersion,
  gatewaySdkPatchDigest, gatewaySdkRevision, gatewaySdkSourceDigest } from './gateway-sdk-source.mjs';
import { gatewaySdkLockRepairDigest, gatewaySdkLockSha256, gatewaySdkTestRunnerDigest } from './gateway-sdk-source.mjs';
import { assertFreeSpace, releaseDiskSpaceRequirements } from './disk-space.mjs';
import { withReleaseTempStorage } from './release-temp-storage.mjs';

const { values } = parseArgs({ options: { 'allow-dirty': { type: 'boolean' }, 'with-native': { type: 'boolean' },
  'with-gateway-sdk': { type: 'boolean' }, 'reuse-components-from': { type: 'string' }, 'components-sha256': { type: 'string' },
  'reuse-native-from': { type: 'string' }, 'native-sha256': { type: 'string' }, 'fresh-native': { type: 'boolean' },
  'output-dir': { type: 'string' } } });
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const result = withReleaseTempStorage({ outputDir: values['output-dir'] }, storage => {
  const root = storage.work;
  assertFreeSpace(root, releaseDiskSpaceRequirements.buildRelease, 'Release archive build');
  const versionProblem = releaseVersionProblem(version); if (versionProblem) throw new Error(versionProblem);
  if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() && !values['allow-dirty']) throw new Error('Commit release source first; use --allow-dirty only for installer tests');
  const plan = releaseComponentPlan({ withNative: values['with-native'], withGatewaySdk: values['with-gateway-sdk'],
    reuseFrom: values['reuse-components-from'], componentsSha256: values['components-sha256'],
    reuseNativeFrom: values['reuse-native-from'], nativeSha256: values['native-sha256'], freshNative: values['fresh-native'] });
  const sources = {};
  if (plan.reuse) for (const [key, selected] of Object.entries(plan.reuse)) {
    if (selected) sources[key] = { archivePath: resolve(values['reuse-components-from']), expectedSha256: values['components-sha256'], flag: '--components-sha256' };
  }
  // The relay can come from its own published bundle, authenticated and selected independently of the SDK's.
  if (plan.reuseNative) sources.native = { archivePath: resolve(plan.reuseNative.from), expectedSha256: plan.reuseNative.sha256, flag: '--native-sha256' };
  const reused = plan.reuse || plan.reuseNative ? verifyReleaseComponentSources(sources) : undefined;
  const name = `harness-gateway-${version}-macos-arm64`; const directory = join(root, name);
  const runtimeArchive = resolve('.state/release-runtime/node-v24.22.1-darwin-arm64.tar.gz');
  const runtimeDigest = createHash('sha256').update(readFileSync(runtimeArchive)).digest('hex');
  if (runtimeDigest !== '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7') throw new Error('Official Node runtime checksum mismatch');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { encoding: 'utf8' }))[0];
  execFileSync('tar', ['-xzf', join(root, packed.filename), '-C', directory]);
  mkdirSync(join(directory, 'runtime/bin'), { recursive: true });
  const runtime = resolve('.state/release-runtime/node-v24.22.1-darwin-arm64');
  cpSync(join(runtime, 'bin/node'), join(directory, 'runtime/bin/node'));
  cpSync(join(runtime, 'LICENSE'), join(directory, 'runtime/LICENSE'));
  cpSync('scripts/install.sh', join(directory, 'install')); chmodSync(join(directory, 'install'), 0o700);
  const nativeArtifact = resolve('.state/native-relay-build/artifact');
  if (reused) copyReleaseComponents(reused, join(directory, 'package'));
  if (plan.freshNative) {
    const metadata = JSON.parse(readFileSync(join(nativeArtifact, 'build.json'), 'utf8'));
    if (metadata.version !== version || metadata.profile !== 'release' || metadata.revision !== relaySdkRevision || metadata.codexVersion !== relaySdkCodexVersion || metadata.archiveSha256 !== relaySdkArchiveSha256 || metadata.sourceSha256 !== nativeSourceDigest()) throw new Error('Native relay artifact does not match this release source');
    cpSync(nativeArtifact, join(directory, 'package/native'), { recursive: true });
  }
  const gatewayArtifact = resolve('.state/gateway-sdk-build/artifact');
  if (plan.freshGatewaySdk) {
    const metadata = JSON.parse(readFileSync(join(gatewayArtifact, 'build.json'), 'utf8'));
    if (metadata.schemaVersion !== 1 || metadata.version !== version || metadata.profile !== 'release' ||
        metadata.platform !== 'darwin' || metadata.arch !== 'arm64' || metadata.codexVersion !== gatewaySdkCodexVersion ||
        metadata.revision !== gatewaySdkRevision || metadata.archiveSha256 !== gatewaySdkArchiveSha256 ||
        metadata.patchSha256 !== gatewaySdkPatchDigest() || metadata.lockfileRepairSha256 !== gatewaySdkLockRepairDigest() ||
        metadata.lockfileSha256 !== gatewaySdkLockSha256 || metadata.sourceSha256 !== gatewaySdkSourceDigest() ||
        metadata.testRunnerSha256 !== gatewaySdkTestRunnerDigest() ||
        metadata.capabilities?.length !== 1 || metadata.capabilities[0] !== gatewaySdkCapability ||
        metadata.binarySha256 !== createHash('sha256').update(readFileSync(join(gatewayArtifact, 'gateway-codex'))).digest('hex')) {
      throw new Error('Gateway SDK artifact does not match this release source');
    }
    // The Code Mode companion is optional: a receipt names it, or the artifact carries none.
    const namedHost = typeof metadata.codeModeHostSha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.codeModeHostSha256);
    if ('codeModeHostSha256' in metadata && !namedHost) throw new Error('Gateway SDK artifact code-mode host receipt is invalid');
    const expectedFiles = ['CODEX-LICENSE', 'CODEX-NOTICE', 'NOTICE', 'build.json', 'dependencies.json', 'gateway-codex',
      ...(namedHost ? ['codex-code-mode-host'] : [])];
    if (JSON.stringify(readdirSync(gatewayArtifact).sort()) !== JSON.stringify(expectedFiles.sort())) throw new Error('Unexpected gateway SDK artifact files');
    if (namedHost && metadata.codeModeHostSha256 !== createHash('sha256').update(readFileSync(join(gatewayArtifact, 'codex-code-mode-host'))).digest('hex')) {
      throw new Error('Gateway SDK code-mode host does not match its receipt');
    }
    cpSync(gatewayArtifact, join(directory, 'package/gateway-sdk'), { recursive: true });
  }
  writeFileSync(join(directory, 'package/release.json'), JSON.stringify({ version, node: '24.22.1', nodeArchiveSha256: runtimeDigest,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    ...(reused ? { reusedComponents: reused.provenance } : {}) }, null, 2));
  const files = [];
  function walk(path, relative = '') { for (const name of readdirSync(path).sort()) { const child = join(path, name); const entry = relative ? `${relative}/${name}` : name; if (statSync(child).isDirectory()) walk(child, entry); else if (entry !== 'checksums.txt') files.push(entry); } }
  walk(directory);
  writeFileSync(join(directory, 'checksums.txt'), files.map(file => `${createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')}  ${file}`).join('\n') + '\n');
  const assetName = `${name}.tar.gz`; const asset = join(storage.output, assetName);
  execFileSync('tar', ['--format=ustar', '-czf', asset, '-C', root, name],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  writeFileSync(join(storage.output, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(asset)).digest('hex')}  ${assetName}\n`);
  return { assetName };
});
console.log(JSON.stringify({ asset: result.asset, checksum: result.checksum, version, bundledRuntime: true }));
