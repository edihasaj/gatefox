import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { assertReleaseContext, assertRemoteProduction, assertVersionLockfile, finalJson, parseArgs,
  releaseAssets, releaseMacosApp, validateBackendArchive, verifyUploadedAssets } from '../release-macos-app.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8' });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};

function repo() {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-git-'));
  run('git', ['init', '-q', '-b', 'production', directory]);
  run('git', ['-C', directory, 'config', 'user.email', 'test@example.invalid']);
  run('git', ['-C', directory, 'config', 'user.name', 'Test']);
  write(join(directory, 'package.json'), JSON.stringify({ version: '0.5.4' }));
  write(join(directory, 'package-lock.json'), JSON.stringify({ version: '0.5.4', packages: { '': { version: '0.5.4' } } }));
  run('git', ['-C', directory, 'add', '.']);
  run('git', ['-C', directory, 'commit', '-qm', 'production']);
  return directory;
}

function backendArchive(directory, { version = '0.5.4', source = 'a'.repeat(40) } = {}) {
  const payload = join(directory, 'payload', `harness-gateway-${version}-macos-arm64`);
  const files = {
    install: '#!/bin/sh\n',
    'package/package.json': JSON.stringify({ name: '@edihasaj/harness-gateway', version }),
    'package/LICENSE': 'license', 'package/dist/cli.js': 'cli',
    'package/release.json': JSON.stringify({ version, source, node: '24.21.0' }),
    'runtime/bin/node': 'node', 'runtime/LICENSE': 'node license',
  };
  for (const [name, value] of Object.entries(files)) write(join(payload, name), value);
  chmodSync(join(payload, 'install'), 0o700);
  chmodSync(join(payload, 'runtime/bin/node'), 0o700);
  const manifest = Object.keys(files).map(name => `${hash(readFileSync(join(payload, name)))}  ${name}`).join('\n');
  write(join(payload, 'checksums.txt'), `${manifest}\n`);
  const archive = join(directory, `harness-gateway-${version}-macos-arm64.tar.gz`);
  run('tar', ['-czf', archive, '-C', join(directory, 'payload'), basename(payload)]);
  return { archive, sha256: hash(readFileSync(archive)) };
}

function appFixture(directory, source, backendSha256) {
  const app = join(directory, 'Harness Gateway.app');
  const resources = join(app, 'Contents/Resources');
  mkdirSync(resources, { recursive: true });
  write(join(resources, 'app-build.json'), JSON.stringify({
    appVersion: '0.5.4', backendVersion: '0.5.4', managementVersion: '0.5.4', source,
    sourceModified: false, sourceBranch: 'production', production: true, signedForDistribution: false,
  }));
  write(join(resources, 'update-policy.json'), JSON.stringify({
    schemaVersion: 1, version: '0.5.4', source, branch: 'production',
    backendAsset: 'harness-gateway-0.5.4-macos-arm64.tar.gz', backendSha256,
  }));
  return app;
}

test('requires absolute production inputs and keeps publishing opt-in', () => {
  assert.equal(parseArgs(['--backend-archive', '/tmp/backend.tar.gz', '--backend-sha256', 'a'.repeat(64),
    '--identity', 'A'.repeat(40)]).publish, false);
  assert.throws(() => parseArgs(['--backend-archive', 'relative.tar.gz', '--backend-sha256', 'a'.repeat(64),
    '--identity', 'A'.repeat(40)]), /absolute path/);
  assert.throws(() => parseArgs(['--backend-archive', '/tmp/backend.tar.gz', '--backend-sha256', 'A'.repeat(64),
    '--identity', 'A'.repeat(40)]), /lowercase/);
});

test('refuses wrong branches, dirty source, and a missing fresh origin production ref', () => {
  const directory = repo();
  const head = assertReleaseContext({ cwd: directory, run });
  const freshRun = (command, args, options) => command === 'git' && args[0] === 'fetch'
    ? { status: 0, stdout: '', stderr: '' } : run(command, args, options);
  assert.throws(() => assertRemoteProduction(freshRun, directory, head), /origin\/production/);
  run('git', ['-C', directory, 'update-ref', 'refs/remotes/origin/production', head]);
  assert.doesNotThrow(() => assertRemoteProduction(freshRun, directory, head));
  write(join(directory, 'dirty'), 'no');
  assert.throws(() => assertReleaseContext({ cwd: directory, run }), /clean/);
  run('git', ['-C', directory, 'checkout', '-qb', 'feature']);
  assert.throws(() => assertReleaseContext({ cwd: directory, run }), /production branch/);
});

test('requires exact package and lockfile versions', () => {
  const directory = repo();
  assert.equal(assertVersionLockfile({ cwd: directory }), '0.5.4');
  write(join(directory, 'package-lock.json'), JSON.stringify({ version: '0.5.3', packages: { '': { version: '0.5.4' } } }));
  assert.throws(() => assertVersionLockfile({ cwd: directory }), /exact supported release version/);
});

test('verifies backend archive hash, payload, version, and production source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-backend-'));
  const source = 'b'.repeat(40);
  const fixture = backendArchive(directory, { source });
  assert.equal(validateBackendArchive({ ...fixture, version: '0.5.4', source, directory, run }).backend.version, '0.5.4');
  assert.throws(() => validateBackendArchive({ ...fixture, sha256: '0'.repeat(64), version: '0.5.4', source, directory, run }), /SHA-256/);
  assert.throws(() => validateBackendArchive({ ...fixture, version: '0.5.4', source: 'c'.repeat(40), directory, run }), /source/);
});

test('stops before publishing when signing fails', () => {
  const directory = repo();
  const source = assertReleaseContext({ cwd: directory, run });
  const assets = mkdtempSync(join(tmpdir(), 'gateway-app-release-sign-'));
  const fixture = backendArchive(assets, { source });
  const app = appFixture(assets, source, fixture.sha256);
  let published = false;
  const fakeRun = (command, args, options = {}) => {
    if (command === process.execPath && args[0] === 'scripts/build-macos-app.mjs') {
      return { status: 0, stdout: `build detail\n${JSON.stringify({ app, archive: '/tmp/unsigned.zip', backendVersion: '0.5.4', signedForDistribution: false })}\n`, stderr: '' };
    }
    if (command === process.execPath && args[0] === 'scripts/sign-macos-app.mjs') {
      throw new Error('signature failed');
    }
    if (command === 'gh') published = true;
    return run(command, args, options);
  };
  assert.throws(() => releaseMacosApp({ backendArchive: fixture.archive, backendSha256: fixture.sha256,
    identity: 'A'.repeat(40), profile: 'asc-notary', publish: true }, { cwd: directory, run: fakeRun }), /signature failed/);
  assert.equal(published, false);
});

test('refuses an existing app release and rejects mismatched draft digests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-assets-'));
  const stage = {};
  for (const name of ['backend', 'app', 'metadata', 'sums']) {
    stage[name] = join(directory, name);
    write(stage[name], name);
  }
  const fake = (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 3), ['release', 'view', 'app-v0.5.4']);
    return { status: 0, stdout: JSON.stringify({ isDraft: true, assets: [
      { name: 'backend', size: 7, digest: 'sha256:wrong' },
      { name: 'app', size: 3, digest: `sha256:${hash(readFileSync(stage.app))}` },
      { name: 'metadata', size: 8, digest: `sha256:${hash(readFileSync(stage.metadata))}` },
      { name: 'sums', size: 4, digest: `sha256:${hash(readFileSync(stage.sums))}` },
    ] }), stderr: '' };
  };
  assert.throws(() => releaseAssets(fake, 'app-v0.5.4', directory), /already exists/);
  assert.throws(() => verifyUploadedAssets(fake, 'app-v0.5.4', stage, directory), /verification failed/);
});

test('reads only the final builder or signer JSON record', () => {
  assert.deepEqual(finalJson('verbose line\n{"answer":42}\n', 'fixture'), { answer: 42 });
  assert.throws(() => finalJson('no result', 'fixture'), /final JSON/);
});
