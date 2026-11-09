import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { extractProductionBackend, productionOptions, removeProductionStage, requireProductionSource, stageProductionBackend } from '../macos-app-production.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = 'a'.repeat(40);
const version = '1.2.3';

function tarEntry(name, bytes = Buffer.alloc(0), type = '0', mode = 0o644) {
  const header = Buffer.alloc(512);
  header.write(name); header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100); header.write('0000000\0', 108);
  header.write('0000000\0', 116); header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
  header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((value, byte) => value + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

const releaseRoot = `gatefox-${version}-macos-arm64`;
const executable = path => path === 'install' || path.endsWith('/node') ||
  path.endsWith('gateway-native-relay') || path.endsWith('gateway-codex');

function releaseFiles(releaseSource = source) {
  const files = {
    install: 'install',
    'package/package.json': JSON.stringify({ name: '@edihasaj/harness-gateway', version }),
    'package/release.json': JSON.stringify({ version, source: releaseSource, node: '24.21.0' }),
    'package/LICENSE': 'license', 'package/dist/cli.js': 'cli',
    'runtime/bin/node': 'node', 'runtime/LICENSE': 'node license',
    'package/native/CODEX-LICENSE': 'license', 'package/native/CODEX-NOTICE': 'notice',
    'package/native/NOTICE': 'notice', 'package/native/build.json': '{}',
    'package/native/dependencies.json': '{}', 'package/native/gateway-native-relay': 'native',
    'package/gateway-sdk/CODEX-LICENSE': 'license', 'package/gateway-sdk/CODEX-NOTICE': 'notice',
    'package/gateway-sdk/NOTICE': 'notice', 'package/gateway-sdk/build.json': '{}',
    'package/gateway-sdk/dependencies.json': '{}', 'package/gateway-sdk/gateway-codex': 'sdk',
  };
  const manifest = Object.entries(files).map(([path, value]) => `${hash(value)}  ${path}`).join('\n') + '\n';
  files['checksums.txt'] = manifest;
  return files;
}

function archive({ releaseSource = source, type = null } = {}) {
  const root = releaseRoot;
  const files = releaseFiles(releaseSource);
  const directories = ['', 'package', 'package/dist', 'package/native', 'package/gateway-sdk', 'runtime', 'runtime/bin'];
  const entries = directories.map(path => tarEntry(`${root}/${path}${path ? '/' : ''}`, Buffer.alloc(0), '5', 0o755));
  for (const [path, value] of Object.entries(files)) {
    entries.push(tarEntry(`${root}/${path}`, Buffer.from(value), '0',
      executable(path) ? 0o755 : 0o644));
  }
  if (type) entries.push(tarEntry(`${root}/bad`, Buffer.alloc(0), type));
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function canonicalTarFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gateway-production-tar-'));
  const release = join(root, releaseRoot);
  for (const [path, value] of Object.entries(releaseFiles())) {
    const destination = join(release, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, value);
    if (executable(path)) chmodSync(destination, 0o755);
  }
  const asset = join(root, 'backend.tar.gz');
  execFileSync('/usr/bin/tar', ['--format=ustar', '-czf', asset, '-C', root, releaseRoot], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = readFileSync(asset);
  return { root, asset, sha256: hash(bytes) };
}

function fixture(options) {
  const root = mkdtempSync(join(tmpdir(), 'gateway-production-test-'));
  const bytes = archive(options);
  const asset = join(root, 'backend.tar.gz');
  writeFileSync(asset, bytes);
  return { root, asset, sha256: hash(bytes) };
}

test('requires exactly the production archive arguments and a clean production source', () => {
  assert.throws(() => productionOptions({ production: true, backend: '/tmp/backend' }), /requires/);
  assert.throws(() => productionOptions({ production: true, 'backend-archive': 'relative', 'backend-sha256': 'a'.repeat(64) }), /absolute/);
  const git = args => args[0] === 'branch' ? 'production\n' : args[0] === 'status' ? '' : `${source}\n`;
  assert.equal(requireProductionSource({ runGit: git, root: '/fixture' }), source);
  assert.throws(() => requireProductionSource({ runGit: () => 'main\n', root: '/fixture' }), /branch/);
  assert.throws(() => requireProductionSource({ runGit: args => args[0] === 'branch' ? 'production\n' : ' M file\n', root: '/fixture' }), /clean/);
});

test('verifies the archive digest and matching version/source before extracting a private backend', () => {
  const good = fixture();
  const destination = join(good.root, 'backend');
  const backend = extractProductionBackend({ archive: good.asset, sha256: good.sha256, version, source, destination });
  assert.equal(backend.version, version);
  assert.equal(JSON.parse(readFileSync(join(destination, 'package/release.json'), 'utf8')).source, source);
  const staged = stageProductionBackend({ archive: good.asset, sha256: good.sha256, version, source });
  assert.equal(staged.backend.root, join(realpathSync(staged.stage), 'backend'));
  assert.notEqual(statSync(join(staged.backend.root, 'package/native/gateway-native-relay')).mode & 0o111, 0);
  assert.notEqual(statSync(join(staged.backend.root, 'package/gateway-sdk/gateway-codex')).mode & 0o111, 0);
  removeProductionStage(staged.stage);
  assert.throws(() => extractProductionBackend({ archive: good.asset, sha256: '0'.repeat(64), version, source, destination: join(good.root, 'wrong-sha') }), /SHA-256/);
  const wrongSource = fixture({ releaseSource: 'b'.repeat(40) });
  assert.throws(() => extractProductionBackend({ archive: wrongSource.asset, sha256: wrongSource.sha256, version, source, destination: join(wrongSource.root, 'backend') }), /version or source/);
});

test('refuses special archive entries before any backend is accepted', () => {
  const unsafe = fixture({ type: '2' });
  assert.throws(() => extractProductionBackend({ archive: unsafe.asset, sha256: unsafe.sha256, version, source, destination: join(unsafe.root, 'backend') }), /link or special/);
});

test('extracts the same deterministic USTAR archive emitted for production', () => {
  const fixture = canonicalTarFixture();
  const backend = extractProductionBackend({
    archive: fixture.asset, sha256: fixture.sha256, version, source, destination: join(fixture.root, 'backend'),
  });
  assert.equal(backend.version, version);
  assert.notEqual(statSync(join(backend.root, 'package/native/gateway-native-relay')).mode & 0o111, 0);
});
