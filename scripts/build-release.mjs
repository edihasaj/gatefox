import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync, chmodSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { nativeSourceDigest } from './native-source.mjs';
import { sdkArchiveSha256 as relaySdkArchiveSha256, sdkCodexVersion as relaySdkCodexVersion, sdkRevision as relaySdkRevision } from './native-relay-sdk.mjs';
import { releaseVersionProblem } from './release-version.mjs';
import { releaseComponentPlan, verifyReleaseComponents, copyReleaseComponents } from './release-components.mjs';
import { gatewaySdkArchiveSha256, gatewaySdkCapability, gatewaySdkCodexVersion,
  gatewaySdkPatchDigest, gatewaySdkRevision, gatewaySdkSourceDigest } from './gateway-sdk-source.mjs';
import { gatewaySdkLockRepairDigest, gatewaySdkLockSha256, gatewaySdkTestRunnerDigest } from './gateway-sdk-source.mjs';

const { values } = parseArgs({ options: { 'allow-dirty': { type: 'boolean' }, 'with-native': { type: 'boolean' },
  'with-gateway-sdk': { type: 'boolean' }, 'reuse-components-from': { type: 'string' }, 'components-sha256': { type: 'string' },
  'fresh-native': { type: 'boolean' } } });
const root = resolve('.state/release'); const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const versionProblem = releaseVersionProblem(version); if (versionProblem) throw new Error(versionProblem);
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() && !values['allow-dirty']) throw new Error('Commit release source first; use --allow-dirty only for installer tests');
const plan = releaseComponentPlan({ withNative: values['with-native'], withGatewaySdk: values['with-gateway-sdk'],
  reuseFrom: values['reuse-components-from'], componentsSha256: values['components-sha256'], freshNative: values['fresh-native'] });
const reused = plan.reuse ? verifyReleaseComponents(resolve(values['reuse-components-from']),
  values['components-sha256'], plan.reuse) : undefined;
const name = `harness-gateway-${version}-macos-arm64`; const directory = join(root, name);
if (reused && existsSync(directory)) throw new Error('Component reuse requires a fresh release stage; move the previous stage to Trash first');
const runtimeArchive = resolve('.state/release-runtime/node-v24.21.0-darwin-arm64.tar.gz');
const runtimeDigest = createHash('sha256').update(readFileSync(runtimeArchive)).digest('hex');
if (runtimeDigest !== 'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057') throw new Error('Official Node runtime checksum mismatch');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { encoding: 'utf8' }))[0];
execFileSync('tar', ['-xzf', join(root, packed.filename), '-C', directory]);
mkdirSync(join(directory, 'runtime/bin'), { recursive: true });
const runtime = resolve('.state/release-runtime/node-v24.21.0-darwin-arm64');
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
  const expectedFiles = ['CODEX-LICENSE', 'CODEX-NOTICE', 'NOTICE', 'build.json', 'dependencies.json', 'gateway-codex'];
  if (JSON.stringify(readdirSync(gatewayArtifact).sort()) !== JSON.stringify(expectedFiles.sort())) throw new Error('Unexpected gateway SDK artifact files');
  cpSync(gatewayArtifact, join(directory, 'package/gateway-sdk'), { recursive: true });
} else if (!values['with-gateway-sdk'] && existsSync(join(directory, 'package/gateway-sdk'))) {
  throw new Error('Release stage already contains a gateway SDK; select --with-gateway-sdk or use a fresh stage');
}
writeFileSync(join(directory, 'package/release.json'), JSON.stringify({ version, node: '24.21.0', nodeArchiveSha256: runtimeDigest,
  source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  ...(reused ? { reusedComponents: reused.provenance } : {}) }, null, 2));
const files = [];
function walk(path, relative = '') { for (const name of readdirSync(path).sort()) { const child = join(path, name); const entry = relative ? `${relative}/${name}` : name; if (statSync(child).isDirectory()) walk(child, entry); else if (entry !== 'checksums.txt') files.push(entry); } }
walk(directory);
writeFileSync(join(directory, 'checksums.txt'), files.map(file => `${createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')}  ${file}`).join('\n') + '\n');
execFileSync('tar', ['-czf', join(root, `${name}.tar.gz`), '-C', root, name]);
const asset = join(root, `${name}.tar.gz`);
writeFileSync(join(root, 'SHA256SUMS'), `${createHash('sha256').update(readFileSync(asset)).digest('hex')}  ${name}.tar.gz\n`);
console.log(JSON.stringify({ asset, checksum: join(root, 'SHA256SUMS'), version, bundledRuntime: true }));
