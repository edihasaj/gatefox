import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { installRoot } from './install-root.mjs';
import { appAsset, appBundle, backendAsset } from './release-names.mjs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { copyVerifiedBackend, verifiedBackend } from './macos-app-backend.mjs';
import { productionOptions, removeProductionStage, requireProductionSource, stageProductionBackend } from './macos-app-production.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  backend: { type: 'string' }, 'install-local': { type: 'boolean' }, production: { type: 'boolean' },
  'backend-archive': { type: 'string' }, 'backend-sha256': { type: 'string' },
} });
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Build the native app on an Apple Silicon Mac');
}
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const production = productionOptions(values);
const git = gitArgs => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
const source = production ? requireProductionSource({ runGit: git, root }) : git(['rev-parse', 'HEAD']).trim();
const sourceBranch = production ? 'production' : git(['branch', '--show-current']).trim();
const sourceModified = production ? false : Boolean(git(['status', '--porcelain']).trim());
let productionStage = null;
const backend = production
  ? (() => {
    productionStage = stageProductionBackend({ ...production, version, source });
    return productionStage.backend;
  })()
  : verifiedBackend(resolve(values.backend ?? join(installRoot(join(homedir(), '.local')), 'current')));
if (backend.version !== version) throw new Error('Bundled backend version must match the app version');
process.on('exit', () => { if (productionStage) removeProductionStage(productionStage.stage); });
const buildEnvironment = { ...process.env };
const xcodeDeveloper = '/Applications/Xcode.app/Contents/Developer';
if (!buildEnvironment.DEVELOPER_DIR && existsSync(xcodeDeveloper)) buildEnvironment.DEVELOPER_DIR = xcodeDeveloper;
const run = (command, args) => execFileSync(command, args, { cwd: root, env: buildEnvironment, stdio: 'inherit' });
run('npm', ['run', 'build']);
run('swift', ['build', '--build-system', 'native', '--package-path', 'native/macos', '-c', 'release']);
const binaryDirectory = execFileSync('swift', ['build', '--build-system', 'native', '--package-path', 'native/macos',
  '-c', 'release', '--show-bin-path'], { cwd: root, env: buildEnvironment, encoding: 'utf8' }).trim();
const output = join(root, '.state/macos-app');
mkdirSync(output, { recursive: true });
const stage = mkdtempSync(join(output, 'build-'));
const app = join(stage, appBundle);
const resources = join(app, 'Contents/Resources');
mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
mkdirSync(resources, { recursive: true });
copyFileSync(join(binaryDirectory, 'GatewayApp'), join(app, 'Contents/MacOS/GatewayApp'));
chmodSync(join(app, 'Contents/MacOS/GatewayApp'), 0o755);
copyFileSync(join(binaryDirectory, 'GatewayService'), join(app, 'Contents/MacOS/GatewayService'));
chmodSync(join(app, 'Contents/MacOS/GatewayService'), 0o755);
copyFileSync(join(binaryDirectory, 'GatewayUpdateInstaller'), join(app, 'Contents/MacOS/GatewayUpdateInstaller'));
chmodSync(join(app, 'Contents/MacOS/GatewayUpdateInstaller'), 0o755);
copyFileSync(join(root, 'assets/brand/macos/AppIcon.icns'), join(resources, 'AppIcon.icns'));
copyFileSync(join(root, 'assets/brand/fox-master.png'), join(resources, 'fox.png'));
copyFileSync(join(root, 'LICENSE'), join(resources, 'LICENSE'));
const stagedBackend = join(resources, 'backend');
copyVerifiedBackend(backend, stagedBackend);
const management = join(resources, 'management');
mkdirSync(management);
// This app's management operations have their own complete module set. Keep the
// installed inference engine and its release payload byte-for-byte unchanged.
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', stage], {
  cwd: root, encoding: 'utf8',
}))[0];
run('/usr/bin/tar', ['-xzf', join(stage, packed.filename), '-C', management, '--strip-components=1']);
for (const path of ['install', 'runtime/bin/node']) chmodSync(join(resources, 'backend', path), 0o755);
// Native executables, if present in the release, keep their executable bit.
for (const path of ['package/native/gateway-native-relay', 'package/gateway-sdk/gateway-codex', 'package/gateway-sdk/codex-code-mode-host']) {
  if (backend.files.includes(path)) chmodSync(join(resources, 'backend', path), 0o755);
}
const runtime = join(stagedBackend, 'runtime/bin/node');
const cli = join(stagedBackend, 'package/dist/cli.js');
const smoke = args => execFileSync(runtime, args, {
  cwd: stage, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
}).trim();
if (smoke(['--version']) !== `v${backend.node}` || smoke([cli, '--version']) !== backend.version ||
    smoke(['-p', 'process.platform + "/" + process.arch']) !== 'darwin/arm64') {
  throw new Error('Bundled runtime or gateway version check failed');
}
const managementProbe = execFileSync(runtime, [join(management, 'dist/app-management.js')], {
  cwd: stage, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  env: { HOME: homedir(), PATH: `${homedir()}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` },
  input: JSON.stringify({ operation: 'inspect', configPath: join(stage, 'empty-configuration/gateway.json') }),
});
const managementResult = JSON.parse(managementProbe);
if (managementResult.ok !== true || !Array.isArray(managementResult.result?.providers) ||
    managementResult.result.providers.length !== 0) {
  throw new Error('Bundled connection management failed its clean-configuration check');
}
// Exercise configuration policy with the actual packaged engine. In particular,
// an existing engine-supported transport must survive management inspection.
const validateWithEngine = `
import {pathToFileURL} from 'node:url';
const {validateConfig}=await import(pathToFileURL(process.argv[1]));
let text=''; for await (const chunk of process.stdin) text+=chunk;
try { validateConfig(JSON.parse(text),process.cwd()); process.stdout.write('accepted'); }
catch { process.stdout.write('unsupported'); }
`;
const policyEnvironment = { HOME: homedir(), PATH: '/usr/bin:/bin' };
let acceptedPolicies = 0;
for (const [index, provider] of [
  { id: 'fixture', type: 'chat-completions-api', baseUrl: 'https://api.example.invalid/v1' },
  { id: 'fixture', type: 'chat-completions-api', baseUrl: 'http://127.0.0.1:1/v1' },
  { id: 'fixture', type: 'chat-completions-api', baseUrl: 'http://tailnet.example.invalid:1/v1', tailnet: true },
].entries()) {
  const fixture = { version: 1, port: 3457, stateDirectory: join(stage, 'policy-state'),
    providers: [{ ...provider, apiKeyEnv: 'GATEWAY_BUILD_FIXTURE_KEY', models: { 'fixture/model': 'model' } }] };
  const accepted = execFileSync(runtime, ['--input-type=module', '-e', validateWithEngine,
    join(stagedBackend, 'package/dist/config.js')], {
    cwd: stage, env: policyEnvironment, encoding: 'utf8', timeout: 15000, input: JSON.stringify(fixture),
  }).trim() === 'accepted';
  if (!accepted) continue;
  acceptedPolicies++;
  const fixturePath = join(stage, `policy-${index}.json`);
  writeFileSync(fixturePath, JSON.stringify(fixture), { mode: 0o600 });
  const result = JSON.parse(execFileSync(runtime, [join(management, 'dist/app-management.js')], {
    cwd: stage, env: policyEnvironment, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ operation: 'inspect', configPath: fixturePath }),
  }));
  if (result.ok !== true || result.result?.providers?.length !== 1) {
    throw new Error('App management rejected a configuration supported by its bundled engine');
  }
}
if (!acceptedPolicies) throw new Error('Bundled engine did not accept a baseline app configuration');
// Grok subscription routes have no app discovery/login flow. Verify the shipped
// engine accepts one and the separately packed management module projects it,
// rather than relying on source fixtures or starting paid inference.
const grokFixture = { version: 1, port: 3457, stateDirectory: join(stage, 'grok-state'), providers: [{
  id: 'grok', label: 'Grok', type: 'grok-subscription', models: { 'grok/build-fast': 'grok-4.7-build-fast' },
  modelMetadata: { 'grok/build-fast': { displayName: 'Grok Build Fast', contextWindow: 4096 } },
}] };
const grokAccepted = execFileSync(runtime, ['--input-type=module', '-e', validateWithEngine,
  join(stagedBackend, 'package/dist/config.js')], {
  cwd: stage, env: policyEnvironment, encoding: 'utf8', timeout: 15000, input: JSON.stringify(grokFixture),
}).trim() === 'accepted';
if (!grokAccepted) throw new Error('Bundled engine rejected the Grok subscription configuration');
const grokPath = join(stage, 'grok-policy.json');
writeFileSync(grokPath, JSON.stringify(grokFixture), { mode: 0o600 });
const grokResult = JSON.parse(execFileSync(runtime, [join(management, 'dist/app-management.js')], {
  cwd: stage, env: policyEnvironment, encoding: 'utf8', timeout: 15000,
  input: JSON.stringify({ operation: 'inspect', configPath: grokPath }),
}));
const grokProvider = grokResult.result?.providers?.[0];
if (grokResult.ok !== true || grokResult.result?.providers?.length !== 1 || grokProvider?.type !== 'grok-subscription' ||
    grokProvider?.canDiscover !== false || grokProvider?.canReconnect !== false ||
    grokProvider?.models?.[0]?.id !== 'grok-4.7-build-fast' || grokProvider?.models?.[0]?.label !== 'Grok Build Fast') {
  throw new Error('Bundled connection management failed its Grok projection check');
}
run('/usr/bin/ditto', [join(root, 'docs'), join(resources, 'guide')]);
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.edihasaj.harness-gateway.app</string>
<key>CFBundleName</key><string>GateFox</string>
<key>CFBundleDisplayName</key><string>GateFox</string>
<key>CFBundleExecutable</key><string>GatewayApp</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundleShortVersionString</key><string>${xml(version)}</string>
<key>CFBundleVersion</key><string>${xml(version)}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppleEventsUsageDescription</key><string>GateFox lets tools you approve automate other apps on this Mac.</string>
<key>NSLocalNetworkUsageDescription</key><string>GateFox connects to the gateway and model servers you configure on your local network.</string>
</dict></plist>
`);
writeFileSync(join(resources, 'app-build.json'), JSON.stringify({
  appVersion: version, backendVersion: backend.version, managementVersion: version,
  source, sourceBranch, sourceModified, production: Boolean(production),
  ...(production ? { backendSha256: production.sha256 } : {}),
  signedForDistribution: false,
}, null, 2) + '\n');
if (production) {
  writeFileSync(join(resources, 'update-policy.json'), JSON.stringify({
    schemaVersion: 1, version, source, branch: 'production',
    backendAsset: backendAsset(version),
    backendSha256: production.sha256,
  }, null, 2) + '\n');
}
run('/usr/bin/plutil', ['-lint', join(app, 'Contents/Info.plist')]);
const archive = join(stage, appAsset(version));
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
if (values['install-local']) {
  const applications = join(homedir(), 'Applications');
  const target = join(applications, appBundle);
  mkdirSync(applications, { recursive: true });
  // Exclusive creation also refuses dangling links and concurrent installers.
  try { mkdirSync(target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${appBundle} already exists. Quit it and move it to Trash before reinstalling.`);
    throw error;
  }
  run('/usr/bin/ditto', [app, target]);
  console.log(`Installed: ${target}`);
}
console.log(JSON.stringify({ app, archive, backendVersion: backend.version, signedForDistribution: false }));
