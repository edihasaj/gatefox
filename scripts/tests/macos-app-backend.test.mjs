import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { copyVerifiedBackend, digest, verifiedBackend } from '../macos-app-backend.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gateway-app-backend-'));
  const files = {
    install: '#!/bin/sh\n',
    'package/package.json': JSON.stringify({ name: '@edihasaj/harness-gateway', version: '0.4.1' }),
    'package/release.json': JSON.stringify({ version: '0.4.1', source: 'a'.repeat(40), node: '24.21.0' }),
    'package/LICENSE': 'MIT license',
    'package/dist/cli.js': 'console.log("gateway")',
    'runtime/bin/node': 'mock runtime',
    'runtime/LICENSE': 'Node license',
  };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  const manifest = Object.entries(files).map(([path, bytes]) => `${digest(bytes)}  ${path}`).join('\n') + '\n';
  writeFileSync(join(root, 'checksums.txt'), manifest);
  return { root, manifest };
}

test('verified bundle includes the runtime license and excludes installation state', () => {
  const { root } = fixture();
  writeFileSync(join(root, '.gateway-release'), '0.4.1');
  writeFileSync(join(root, 'local-secret'), 'not part of a release');
  const backend = verifiedBackend(root);
  assert.equal(backend.version, '0.4.1');
  assert(backend.files.includes('runtime/LICENSE'));
  assert(!backend.files.includes('local-secret'));
});

test('rejects modified payloads and unlisted package files', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'package/dist/cli.js'), 'modified');
  assert.throws(() => verifiedBackend(root), /checksum mismatch/);
  const second = fixture();
  writeFileSync(join(second.root, 'package/credentials.json'), 'private');
  assert.throws(() => verifiedBackend(second.root), /unlisted file/);
});

test('rejects traversal, duplicate paths and symlinked ancestors', () => {
  for (const path of ['../outside', 'package/../outside', '/absolute', 'package//bad', 'install']) {
    const { root, manifest } = fixture();
    writeFileSync(join(root, 'checksums.txt'), manifest + `${digest('x')}  ${path}\n`);
    assert.throws(() => verifiedBackend(root), /Unsafe or duplicate/);
  }
  const { root } = fixture();
  symlinkSync(tmpdir(), join(root, 'package/linked'));
  assert.throws(() => verifiedBackend(root), /symbolic links/);
});

test('rejects missing runtime, foreign packages and mismatched release versions', () => {
  const { root, manifest } = fixture();
  writeFileSync(join(root, 'checksums.txt'), manifest.split('\n').filter(line => !line.endsWith('runtime/bin/node')).join('\n'));
  assert.throws(() => verifiedBackend(root), /missing runtime/);
  const second = fixture();
  const path = join(second.root, 'package/package.json');
  const bytes = JSON.stringify({ name: '@unrelated/package', version: '0.4.1' });
  writeFileSync(path, bytes);
  writeFileSync(join(second.root, 'checksums.txt'), second.manifest.replace(
    /^[a-f0-9]{64}  package\/package.json$/m, `${digest(bytes)}  package/package.json`));
  assert.throws(() => verifiedBackend(second.root), /Not a supported/);
});

test('requires gateway and component licenses', () => {
  const { root, manifest } = fixture();
  writeFileSync(join(root, 'checksums.txt'), manifest.split('\n').filter(line => !line.endsWith('package/LICENSE')).join('\n'));
  assert.throws(() => verifiedBackend(root), /missing package\/LICENSE/);
  const second = fixture();
  mkdirSync(join(second.root, 'package/native'));
  writeFileSync(join(second.root, 'package/native/gateway-native-relay'), 'binary');
  writeFileSync(join(second.root, 'checksums.txt'), second.manifest +
    `${digest('binary')}  package/native/gateway-native-relay\n`);
  assert.throws(() => verifiedBackend(second.root), /Incomplete backend component or licenses/);
});

test('copy checks the exact bytes again after source verification', () => {
  const { root } = fixture();
  const backend = verifiedBackend(root);
  const destination = mkdtempSync(join(tmpdir(), 'gateway-app-copy-'));
  copyVerifiedBackend(backend, destination);
  assert.equal(verifiedBackend(destination).version, backend.version);
  writeFileSync(join(root, 'package/dist/cli.js'), 'changed after verification');
  assert.throws(() => copyVerifiedBackend(backend, mkdtempSync(join(tmpdir(), 'gateway-app-copy-'))),
    /changed after verification/);
});
