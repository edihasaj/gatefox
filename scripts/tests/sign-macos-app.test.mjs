import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { parseArgs, signMacosApp } from '../sign-macos-app.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(value, 'utf8');

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function checksums(root, files) {
  write(join(root, 'checksums.txt'), `${files.map(path => `${hash(readFileSync(join(root, path)))}  ${path}`).join('\n')}\n`);
}

function refreshChecksums(root) {
  const files = readFileSync(join(root, 'checksums.txt'), 'utf8').trim().split('\n').map(line => line.slice(66));
  checksums(root, files);
}

// Mirrors the production receipt: fresh native is absent from reuse, while an older SDK is reused.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gateway-sign-test-'));
  const app = join(root, 'Harness Gateway.app');
  const backend = join(app, 'Contents/Resources/backend');
  const nativeBuild = { version: '1.2.3', source: 'native-source', license: 'MIT', provenance: 'local-build' };
  const sdkBuild = { version: '1.1.9', binarySha256: hash(bytes('sdk')), source: 'sdk-source', license: 'Apache-2.0', provenance: 'reused-release' };
  write(join(backend, 'package/native/build.json'), JSON.stringify(nativeBuild));
  write(join(backend, 'package/gateway-sdk/build.json'), JSON.stringify(sdkBuild));
  const release = {
    version: '1.2.3', node: '22.18.0', source: 'a'.repeat(40),
    reusedComponents: { components: { gatewaySdk: { version: '1.1.9', files: [
      { name: 'build.json', size: readFileSync(join(backend, 'package/gateway-sdk/build.json')).length,
        sha256: hash(readFileSync(join(backend, 'package/gateway-sdk/build.json'))) },
      { name: 'gateway-codex', size: 3, sha256: hash(bytes('sdk')) },
    ] } } },
  };
  const files = [
    ['install', 'install'], ['package/package.json', JSON.stringify({ name: '@edihasaj/harness-gateway', version: '1.2.3' })],
    ['package/LICENSE', 'license'], ['package/dist/cli.js', 'cli'], ['package/release.json', JSON.stringify(release)],
    ['package/native/CODEX-LICENSE', 'license'], ['package/native/CODEX-NOTICE', 'notice'], ['package/native/NOTICE', 'notice'],
    ['package/native/dependencies.json', '{}'], ['package/native/gateway-native-relay', 'native'],
    ['package/gateway-sdk/CODEX-LICENSE', 'license'], ['package/gateway-sdk/CODEX-NOTICE', 'notice'], ['package/gateway-sdk/NOTICE', 'notice'],
    ['package/gateway-sdk/dependencies.json', '{}'], ['package/gateway-sdk/gateway-codex', 'sdk'],
    ['runtime/bin/node', 'official-node-signature'], ['runtime/LICENSE', 'node-license'],
  ];
  for (const [path, value] of files) write(join(backend, path), value);
  const manifestFiles = [...files.map(([path]) => path), 'package/native/build.json', 'package/gateway-sdk/build.json'];
  checksums(backend, manifestFiles);
  write(join(app, 'Contents/MacOS/GatewayService'), 'service');
  write(join(app, 'Contents/MacOS/GatewayUpdateInstaller'), 'updater');
  write(join(app, 'Contents/MacOS/GatewayApp'), 'main');
  write(join(app, 'Contents/Resources/app-build.json'), JSON.stringify({ signedForDistribution: false, build: 'fixture' }));
  return { app, backend, nativeBuild, sdkBuild };
}

function runner({ failFinalSign = false, failFinalVerify = false, failTrust = false, notaryStatus = null } = {}) {
  return (binary, args) => {
    if (binary === 'codesign' && args.includes('--sign')) {
      const target = args.at(-1);
      if (target.endsWith('.app') && failFinalSign) throw new Error('codesign failed');
      try { writeFileSync(target, Buffer.concat([readFileSync(target), bytes(':signed')])); } catch { /* bundle root */ }
    }
    if (binary === 'codesign' && args.includes('--verify')) {
      assert.ok(args.some(arg => arg.startsWith('-R=anchor apple generic')),
        'codesign requires = before an inline requirement; otherwise it reads a filename');
      if (failTrust) throw new Error('codesign failed');
      if (args.at(-1).endsWith('.app') && failFinalVerify) throw new Error('codesign failed');
    }
    if (binary === 'codesign' && args.includes('-dvv')) return { stdout: '', stderr: 'TeamIdentifier=TEAM123' };
    if (binary === 'xcrun' && args[0] === 'notarytool') return { stdout: JSON.stringify({ status: notaryStatus, id: 'request-id' }), stderr: '' };
    if (binary === 'ditto') writeFileSync(args.at(-1), 'zip');
    return { stdout: '', stderr: '' };
  };
}

const options = app => ({ app, identity: 'A'.repeat(40), keychain: null, profile: 'asc-notary', notarize: false, archive: null });
const appReceipt = app => JSON.parse(readFileSync(join(app, 'Contents/Resources/app-build.json')));

test('signs an app-owned Node derivative and preserves original hashes and source receipt fields', () => {
  const { app, backend, nativeBuild, sdkBuild } = fixture();
  const node = readFileSync(join(backend, 'runtime/bin/node'));
  const result = signMacosApp(options(app), { run: runner() });
  assert.equal(result.signedForDistribution, true);
  assert.notDeepEqual(readFileSync(join(backend, 'runtime/bin/node')), node);
  const nodeRecord = appReceipt(app).signingDerivative.files.find(file => file.before.path.endsWith('/runtime/bin/node'));
  assert.equal(nodeRecord.before.sha256, hash(node));
  assert.equal(nodeRecord.after.sha256, hash(readFileSync(join(backend, 'runtime/bin/node'))));
  const native = JSON.parse(readFileSync(join(backend, 'package/native/build.json')));
  const sdk = JSON.parse(readFileSync(join(backend, 'package/gateway-sdk/build.json')));
  assert.deepEqual(Object.fromEntries(Object.keys(nativeBuild).map(key => [key, native[key]])), nativeBuild);
  assert.deepEqual(Object.fromEntries(Object.keys(sdkBuild).filter(key => key !== 'binarySha256').map(key => [key, sdk[key]])),
    Object.fromEntries(Object.entries(sdkBuild).filter(([key]) => key !== 'binarySha256')));
  assert.equal(native.originalBinarySha256, hash(bytes('native')));
  assert.notEqual(native.binarySha256, native.originalBinarySha256);
  const release = JSON.parse(readFileSync(join(backend, 'package/release.json')));
  assert.equal(release.reusedComponents.components.gatewaySdk.files.find(file => file.name === 'gateway-codex').sha256, sdk.binarySha256);
  assert.equal(appReceipt(app).signedForDistribution, true);
});

test('uses stable identifiers and explicit Automation and Node entitlements on every release', () => {
  const signatures = [];
  for (let release = 0; release < 2; release++) {
    const { app } = fixture();
    const calls = [];
    signMacosApp(options(app), { run: (binary, args) => {
      if (binary === 'codesign' && args.includes('--sign')) calls.push(args);
      return runner()(binary, args);
    } });
    const node = calls.find(args => args.at(-1).endsWith('/runtime/bin/node'));
    const updater = calls.find(args => args.at(-1).endsWith('/GatewayUpdateInstaller'));
    assert.ok(node);
    assert.ok(updater);
    const identifier = node[node.indexOf('--identifier') + 1];
    assert.equal(identifier, 'com.edihasaj.harness-gateway.node');
    assert.equal(updater[updater.indexOf('--identifier') + 1], 'com.edihasaj.harness-gateway.updater');
    const nodeEntitlements = readFileSync(node[node.indexOf('--entitlements') + 1], 'utf8');
    assert.match(nodeEntitlements, /com\.apple\.security\.automation\.apple-events/);
    assert.match(nodeEntitlements, /com\.apple\.security\.cs\.allow-jit/);
    assert.doesNotMatch(nodeEntitlements, /get-task-allow/);
    for (const args of calls) {
      assert.ok(args.includes('--identifier'));
      assert.match(readFileSync(args[args.indexOf('--entitlements') + 1], 'utf8'),
        /com\.apple\.security\.automation\.apple-events/);
    }
    signatures.push(calls.map(args => args[args.indexOf('--identifier') + 1]));
  }
  assert.deepEqual(signatures[0], signatures[1]);
});

test('refuses dirty production sources and mismatched update policy before signing', () => {
  const source = 'a'.repeat(40);
  const { app } = fixture();
  const receiptPath = join(app, 'Contents/Resources/app-build.json');
  writeFileSync(receiptPath, JSON.stringify({
    appVersion: '1.2.3', backendVersion: '1.2.3', source, sourceBranch: 'production',
    sourceModified: false, production: true, backendSha256: 'b'.repeat(64), signedForDistribution: false,
  }));
  write(join(app, 'Contents/Resources/update-policy.json'), JSON.stringify({
    schemaVersion: 1, version: '1.2.3', source, branch: 'production',
    backendAsset: 'harness-gateway-1.2.3-macos-arm64.tar.gz', backendSha256: 'b'.repeat(64),
  }));
  const calls = [];
  assert.throws(() => signMacosApp(options(app), {
    run: (binary, args) => { calls.push([binary, args]); return runner()(binary, args); },
    runGit: args => args[0] === 'branch' ? 'production\n' : args[0] === 'status' ? ' M file\n' : `${source}\n`,
  }), /clean matching production/);
  assert.equal(calls.length, 0);
  write(join(app, 'Contents/Resources/update-policy.json'), JSON.stringify({
    schemaVersion: 1, version: '1.2.3', source, branch: 'production',
    backendAsset: 'harness-gateway-1.2.3-macos-arm64.tar.gz', backendSha256: 'c'.repeat(64),
  }));
  assert.throws(() => signMacosApp(options(app), {
    run: runner(),
    runGit: args => args[0] === 'branch' ? 'production\n' : args[0] === 'status' ? '' : `${source}\n`,
  }), /does not match/);
});

test('does not falsely claim signing when the final app signing or verification fails', () => {
  for (const result of [runner({ failFinalSign: true }), runner({ failFinalVerify: true })]) {
    const { app } = fixture();
    assert.throws(() => signMacosApp(options(app), { run: result }), /codesign failed/);
    assert.equal(appReceipt(app).signedForDistribution, false);
  }
});

test('rejects a malformed reused receipt before changing any owned binary', () => {
  const { app, backend } = fixture();
  const releasePath = join(backend, 'package/release.json');
  const release = JSON.parse(readFileSync(releasePath));
  release.reusedComponents.components.gatewaySdk.files[1].sha256 = '0'.repeat(64);
  writeFileSync(releasePath, JSON.stringify(release));
  refreshChecksums(backend);
  const calls = [];
  assert.throws(() => signMacosApp(options(app), { run: (binary, args) => { calls.push([binary, args]); return runner()(binary, args); } }),
    /does not match/);
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(join(backend, 'package/native/gateway-native-relay'), 'utf8'), 'native');
});

test('requires the Apple Developer ID trust requirement rather than authority display text', () => {
  const { app } = fixture();
  assert.throws(() => signMacosApp(options(app), { run: runner({ failTrust: true }) }), /codesign failed/);
  assert.equal(appReceipt(app).signedForDistribution, false);
});

test('writes an external false notarization receipt at the normalized default archive path', () => {
  const { app } = fixture();
  assert.throws(() => signMacosApp({ ...options(app), notarize: true, archive: true }, { run: runner({ notaryStatus: 'Invalid' }) }), /not accepted/);
  const receiptPath = join(dirname(app), 'Harness Gateway.zip.notarization.json');
  const receipt = JSON.parse(readFileSync(receiptPath));
  assert.equal(receipt.notarized, false);
  assert.equal(appReceipt(app).signedForDistribution, true);
});

test('rejects malformed, symlinked, and bundle-internal output inputs before signing', () => {
  assert.throws(() => parseArgs(['--app', 'relative.app', '--identity', 'A'.repeat(40)]), /absolute/);
  assert.throws(() => parseArgs(['--app', '/tmp/test.app', '--identity', 'not-a-sha']), /SHA-1/);
  const { app } = fixture();
  const linkedParent = join(dirname(app), 'linked-parent');
  symlinkSync(dirname(app), linkedParent);
  assert.throws(() => signMacosApp(options(join(linkedParent, 'Harness Gateway.app')), { run: runner() }), /symbolic links/);
  assert.throws(() => signMacosApp({ ...options(app), archive: join(app, 'inside.zip') }, { run: runner() }), /inside the app/);
  assert.throws(() => signMacosApp({ ...options(app), archive: join(app, '..release.zip') }, { run: runner() }), /inside the app/);
});

test('canonicalizes namespace aliases before bundle containment checks', () => {
  const { app } = fixture();
  const aliasedInside = join(realpathSync(app), 'Contents', 'Resources', 'escape.zip');
  assert.throws(() => signMacosApp({ ...options(app), archive: aliasedInside }, { run: runner() }), /inside the app/);
});

test('rejects dangling and existing output links without following or overwriting them', () => {
  const { app } = fixture();
  const archive = join(dirname(app), 'download.zip');
  symlinkSync(join(dirname(app), 'missing.zip'), archive);
  assert.throws(() => signMacosApp({ ...options(app), archive }, { run: runner() }), /overwrite existing output/);
  const receipt = `${archive}.notarization.json`;
  assert.equal(existsSync(receipt), false);
});

test('does not overwrite an output raced during notarization and records unpublished acceptance', () => {
  const { app } = fixture();
  const archive = join(dirname(app), 'raced.zip');
  const base = runner({ notaryStatus: 'Accepted' });
  const raced = (binary, args) => {
    if (binary === 'xcrun' && args[0] === 'notarytool') writeFileSync(archive, 'other-publisher');
    return base(binary, args);
  };
  assert.throws(() => signMacosApp({ ...options(app), notarize: true, archive }, { run: raced }), /Output publication failed/);
  assert.equal(readFileSync(archive, 'utf8'), 'other-publisher');
  const receipt = JSON.parse(readFileSync(`${archive}.notarization.json`));
  assert.equal(receipt.notarized, true);
  assert.equal(receipt.published, false);
  assert.equal(receipt.actualStatus, 'Accepted');
  assert.equal(receipt.submissionId, 'request-id');
});

test('does not publish a partial ZIP when ditto fails', () => {
  const { app } = fixture();
  const archive = join(dirname(app), 'partial.zip');
  const base = runner({ notaryStatus: 'Accepted' });
  const failingArchive = (binary, args) => {
    if (binary === 'ditto' && args.at(-1).endsWith('archive.zip')) {
      writeFileSync(args.at(-1), 'partial');
      throw new Error('ditto failed');
    }
    return base(binary, args);
  };
  assert.throws(() => signMacosApp({ ...options(app), notarize: true, archive }, { run: failingArchive }), /ditto failed/);
  assert.equal(existsSync(archive), false);
  const receipt = JSON.parse(readFileSync(`${archive}.notarization.json`));
  assert.equal(receipt.notarized, true);
  assert.equal(receipt.published, false);
});
