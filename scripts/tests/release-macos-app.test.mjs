import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { assertReleaseContext, assertRemoteProduction, assertRemoteTag, assertVersionLockfile, finalJson, inspectFinalZip,
  defaultRun, parseArgs, publishRelease, releaseAssets, releaseMacosApp, scrubFailureTail, validateBackendArchive, verifyUploadedAssets } from '../release-macos-app.mjs';
import { classifyFixtureError, fixtureCommand } from '../e2e-app-updates.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: 'utf8' });
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
const write = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
};

function octal(value, length) {
  const field = Buffer.alloc(length);
  Buffer.from(`${value.toString(8).padStart(length - 2, '0')}\0 `).copy(field);
  return field;
}

function ustarEntry(name, value, directory = false) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const header = Buffer.alloc(512);
  Buffer.from(name).copy(header, 0);
  octal(directory ? 0o755 : 0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108); octal(0, 8).copy(header, 116);
  octal(directory ? 0 : bytes.length, 12).copy(header, 124); octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156); header[156] = directory ? 53 : 48;
  Buffer.from('ustar\0').copy(header, 257); Buffer.from('00').copy(header, 263);
  octal(header.reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([header, directory ? Buffer.alloc(0) : bytes, padding]);
}

function repo() {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-git-'));
  run('git', ['init', '-q', '-b', 'production', directory]);
  run('git', ['-C', directory, 'config', 'user.email', 'test@example.invalid']);
  run('git', ['-C', directory, 'config', 'user.name', 'Test']);
  write(join(directory, 'package.json'), JSON.stringify({ version: '0.5.4' }));
  write(join(directory, 'package-lock.json'), JSON.stringify({ version: '0.5.4', packages: { '': { version: '0.5.4' } } }));
  write(join(directory, '.gitignore'), '.state/\n');
  run('git', ['-C', directory, 'add', '.']);
  run('git', ['-C', directory, 'commit', '-qm', 'production']);
  return directory;
}

function backendArchive(directory, { version = '0.5.4', source = 'a'.repeat(40), components = ['native', 'gateway-sdk'] } = {}) {
  const payload = join(directory, 'payload', `harness-gateway-${version}-macos-arm64`);
  const files = {
    install: '#!/bin/sh\n',
    'package/package.json': JSON.stringify({ name: '@edihasaj/harness-gateway', version }),
    'package/LICENSE': 'license', 'package/dist/cli.js': 'cli',
    'package/release.json': JSON.stringify({ version, source, node: '24.21.0' }),
    'runtime/bin/node': 'node', 'runtime/LICENSE': 'node license',
  };
  for (const component of components) {
    const binary = component === 'native' ? 'gateway-native-relay' : 'gateway-codex';
    for (const name of ['CODEX-LICENSE', 'CODEX-NOTICE', 'NOTICE', 'build.json', 'dependencies.json', binary]) {
      files[`package/${component}/${name}`] = name.endsWith('.json') ? '{}' : name;
    }
  }
  for (const [name, value] of Object.entries(files)) write(join(payload, name), value);
  chmodSync(join(payload, 'install'), 0o700);
  chmodSync(join(payload, 'runtime/bin/node'), 0o700);
  const manifest = Object.keys(files).map(name => `${hash(readFileSync(join(payload, name)))}  ${name}`).join('\n');
  const allFiles = { ...files, 'checksums.txt': `${manifest}\n` };
  write(join(payload, 'checksums.txt'), allFiles['checksums.txt']);
  const archive = join(directory, `harness-gateway-${version}-macos-arm64.tar.gz`);
  const root = basename(payload);
  const directories = new Set([root]);
  for (const name of Object.keys(allFiles)) {
    let current = root;
    for (const part of name.split('/').slice(0, -1)) { current += `/${part}`; directories.add(current); }
  }
  const tar = Buffer.concat([
    ...[...directories].sort((left, right) => left.localeCompare(right)).map(name => ustarEntry(name, '', true)),
    ...Object.entries(allFiles).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => ustarEntry(`${root}/${name}`, value)),
    Buffer.alloc(1024),
  ]);
  writeFileSync(archive, gzipSync(tar));
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

test('selected-machine publication stays prerelease and fails closed if GitHub loses that flag', () => {
  const inputs = ['--backend-archive', '/tmp/backend.tar.gz', '--backend-sha256', 'a'.repeat(64), '--identity', 'A'.repeat(40)];
  assert.throws(() => parseArgs([...inputs, '--prerelease']), /requires --publish/);
  assert.equal(parseArgs([...inputs, '--publish', '--prerelease']).prerelease, true);
  const directory = mkdtempSync(join(tmpdir(), 'gateway-prerelease-'));
  const stage = {};
  for (const name of ['backend', 'app', 'metadata', 'sums']) { stage[name] = join(directory, name); write(stage[name], name); }
  const assets = Object.entries(stage).map(([name, path]) => ({ name, size: readFileSync(path).length, digest: `sha256:${hash(readFileSync(path))}` }));
  for (const retained of [true, false]) {
    let created = false, published = false;
    const fake = (command, args) => {
      assert.equal(command, 'gh');
      if (args[1] === 'view') return { status: created ? 0 : 1, stdout: JSON.stringify({ isDraft: true, isPrerelease: retained, assets }), stderr: '' };
      if (args[1] === 'create' || args[1] === 'edit') {
        assert.ok(args.includes('--prerelease')); assert.ok(args.includes('--latest=false'));
        if (args[1] === 'create') created = true; else published = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      throw Error('Unexpected release operation');
    };
    const publish = () => publishRelease({ version: '1.0.5', head: 'a'.repeat(40), stage, cwd: directory, run: fake, prerelease: true });
    if (retained) assert.doesNotThrow(publish); else assert.throws(publish, /remain a prerelease/);
    assert.equal(published, retained);
  }
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
  assert.equal(validateBackendArchive({ ...fixture, version: '0.5.4', source, directory, run }).version, '0.5.4');
  assert.throws(() => validateBackendArchive({ ...fixture, sha256: '0'.repeat(64), version: '0.5.4', source, directory, run }), /SHA-256/);
  assert.throws(() => validateBackendArchive({ ...fixture, version: '0.5.4', source: 'c'.repeat(40), directory, run }), /source/);
});

test('refuses app distribution archives missing either bundled executor component', () => {
  const source = 'b'.repeat(40);
  for (const components of [[], ['native'], ['gateway-sdk']]) {
    const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-components-'));
    const fixture = backendArchive(directory, { source, components });
    assert.throws(() => validateBackendArchive({ ...fixture, version: '0.5.4', source, directory }), /--with-native --with-gateway-sdk/);
  }
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

test('a failed signed updater fixture prevents every GitHub write', () => {
  const directory = repo();
  const source = assertReleaseContext({ cwd: directory, run });
  const assets = mkdtempSync(join(tmpdir(), 'gateway-app-release-updater-'));
  const fixture = backendArchive(assets, { source });
  const app = appFixture(assets, source, fixture.sha256);
  const previousApp = appFixture(join(assets, 'previous'), source, fixture.sha256);
  const installedRelease = join(assets, 'installed-release');
  mkdirSync(installedRelease);
  let githubWrite = false;
  const fakeRun = (command, args, options = {}) => {
    if (command === process.execPath && args[0] === 'scripts/build-macos-app.mjs') {
      return { status: 0, stdout: `${JSON.stringify({ app, archive: '/tmp/unsigned.zip', backendVersion: '0.5.4', signedForDistribution: false })}\n`, stderr: '' };
    }
    if (command === process.execPath && args[0] === 'scripts/sign-macos-app.mjs') {
      const receiptPath = join(app, 'Contents/Resources/app-build.json');
      const receipt = JSON.parse(readFileSync(receiptPath)); receipt.signedForDistribution = true;
      writeFileSync(receiptPath, JSON.stringify(receipt));
      const archive = args[args.indexOf('--archive') + 1];
      run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
      return { status: 0, stdout: `${JSON.stringify({ app, archive, signedForDistribution: true })}\n`, stderr: '' };
    }
    if (command === process.execPath && args[0] === 'scripts/e2e-macos-runtime.mjs') return { status: 0, stdout: '', stderr: '' };
    if (['codesign', 'spctl', 'xcrun'].includes(command)) return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args.join(' ') === 'rev-parse --verify refs/remotes/origin/production') {
      return { status: 0, stdout: `${source}\n`, stderr: '' };
    }
    if (command === 'git' && args[0] === 'ls-remote') return { status: 0, stdout: '', stderr: '' };
    if (command === 'gh') { githubWrite = true; throw new Error('GitHub must not run'); }
    return run(command, args, options);
  };
  const options = { backendArchive: fixture.archive, backendSha256: fixture.sha256, identity: 'A'.repeat(40),
    profile: 'asc-notary', publish: true, previousApp, installedRelease };
  assert.throws(() => releaseMacosApp(options, { cwd: directory, run: fakeRun, e2e: values => {
    assert.equal(values.appArchive.endsWith('.zip'), true);
    assert.equal(values.backendArchive, fixture.archive);
    assert.equal(values.previousApp, previousApp);
    assert.equal(values.installedRelease, installedRelease);
    throw new Error('updater fixture failed');
  } }), /updater fixture failed/);
  assert.equal(githubWrite, false);
});

test('refuses an existing app release and rejects mismatched draft digests', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-assets-'));
  const stage = {};
  for (const name of ['backend', 'app', 'metadata', 'sums']) {
    stage[name] = join(directory, name);
    write(stage[name], name);
  }
  const assets = Object.entries(stage).map(([name, path]) => ({
    name, size: readFileSync(path).length, digest: `sha256:${hash(readFileSync(path))}`,
  }));
  const fake = (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(0, 3), ['release', 'view', 'app-v0.5.4']);
    return { status: 0, stdout: JSON.stringify({ isDraft: true, assets }), stderr: '' };
  };
  assert.throws(() => releaseAssets(fake, 'app-v0.5.4', directory), /already exists/);
  assert.doesNotThrow(() => verifyUploadedAssets(fake, 'app-v0.5.4', stage, directory));
  for (const bad of ['backend', 'app', 'metadata', 'sums']) {
    const draft = (command, args) => {
      const response = JSON.parse(fake(command, args).stdout);
      response.assets.find(asset => asset.name === bad).digest = 'sha256:wrong';
      return { status: 0, stdout: JSON.stringify(response), stderr: '' };
    };
    assert.throws(() => verifyUploadedAssets(draft, 'app-v0.5.4', stage, directory), /verification failed/);
  }
});

test('reads only the final builder or signer JSON record', () => {
  assert.deepEqual(finalJson('verbose line\n{"answer":42}\n', 'fixture'), { answer: 42 });
  assert.throws(() => finalJson('no result', 'fixture'), /final JSON/);
});

test('includes a scrubbed child-output tail when a release command fails', () => {
  const home = process.env.HOME;
  const output = Array.from({ length: 24 }, (_, index) => `line-${index}`).concat([
    `token=${'x'.repeat(20)}`, `${home}/private-path`, 'z'.repeat(400),
  ]).join('\n');
  assert.throws(() => defaultRun(process.execPath, ['scripts/e2e-app-updates.mjs'], {
    spawn: () => ({ status: 1, signal: null, stdout: output, stderr: '' }),
  }), error => {
    assert.match(error.message, /node scripts\/e2e-app-updates\.mjs failed with exit status 1/);
    assert.doesNotMatch(error.message, /token=/);
    assert.doesNotMatch(error.message, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(error.message, /~\/private-path/);
    assert.ok(error.message.split('\n').some(line => line.length === 300));
    return true;
  });
});

test('drops credential-shaped child output but retains ordinary diagnostics', () => {
  const sensitive = [
    'Cookie: session=synthetic',
    'Set-Cookie: session=synthetic',
    'https://user:pass@example.invalid/path',
    ...['ghp', 'gho', 'ghu', 'ghs', 'ghr', 'github_pat'].map(prefix => `${prefix}_${'a'.repeat(20)}`),
    `sk-${'a'.repeat(20)}`,
    'xoxb-synthetic',
    'AKIA1234567890ABCDEF',
    '-----BEGIN PRIVATE KEY-----',
    `eyJ${'a'.repeat(20)}.signature`,
    'DATABASE_URL=postgres://user:pass@example.invalid/database',
    'export DATABASE_URL=postgres://user:pass@example.invalid/database',
  ];
  const scrubbed = scrubFailureTail(['Compiling gateway v0.5.5', 'test result: ok. 3 passed', ...sensitive].join('\n'), '/private/home');
  assert.equal(scrubbed, 'Compiling gateway v0.5.5\ntest result: ok. 3 passed');
});

test('removes complete and unterminated PEM blocks before taking the output tail', () => {
  const body = Array.from({ length: 25 }, (_, index) => `QUJD+/synthetic-${index}`);
  assert.equal(scrubFailureTail([
    'before', '-----BEGIN OPENSSH PRIVATE KEY-----', ...body, '-----END OPENSSH PRIVATE KEY-----', 'after',
  ].join('\n')), 'before\nafter');
  assert.equal(scrubFailureTail([
    'ordinary-before', '-----BEGIN CERTIFICATE-----', ...body, '-----END CERTIFICATE-----', 'ordinary-after',
  ].join('\n')), 'ordinary-before\nordinary-after');
  assert.equal(scrubFailureTail([
    'ordinary-before', '-----BEGIN RSA PRIVATE KEY-----', ...body,
  ].join('\n')), 'ordinary-before');
  assert.equal(scrubFailureTail([
    'first ordinary line', '-----BEGIN PUBLIC KEY-----', 'QUJD+/synthetic', '-----END PUBLIC KEY-----', 'last ordinary line',
  ].join('\n')), 'first ordinary line\nlast ordinary line');
});

test('classifies updater fixture failures without exposing their messages', () => {
  assert.equal(classifyFixtureError({ code: 'ENOSPC' }), 'ENOSPC');
  assert.equal(classifyFixtureError({ name: 'AssertionError' }), 'assertion');
  assert.equal(classifyFixtureError({ code: 'command_failed' }), 'command_failed');
  assert.equal(classifyFixtureError({ code: 'unexpected' }), 'other');
});

test('classifies a real failed fixture command without retaining its output', async () => {
  const runner = fixtureCommand(async (file, args) => {
    const result = spawnSync(file, args, { encoding: 'utf8' });
    return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  await assert.rejects(runner('/usr/bin/false', []), error => {
    assert.equal(error.code, 'COMMAND_FAILED');
    assert.equal(classifyFixtureError(error), 'command_failed');
    assert.equal(error.message, 'Fixture command failed');
    return true;
  });
});

test('rejects stale remote app tags before publishing', () => {
  const head = 'a'.repeat(40);
  const fake = (_command, _args) => ({ status: 0,
    stdout: `${'b'.repeat(40)}\trefs/tags/app-v0.5.4\n${'c'.repeat(40)}\trefs/tags/app-v0.5.4^{}\n`, stderr: '' });
  assert.throws(() => assertRemoteTag(fake, '/unused', 'app-v0.5.4', head), /does not resolve/);
  const matching = (_command, _args) => ({ status: 0,
    stdout: `${'b'.repeat(40)}\trefs/tags/app-v0.5.4\n${head}\trefs/tags/app-v0.5.4^{}\n`, stderr: '' });
  assert.doesNotThrow(() => assertRemoteTag(matching, '/unused', 'app-v0.5.4', head));
});

test('publishes only after the full draft digest check and preserves failed drafts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-publish-'));
  const stage = {};
  for (const name of ['backend', 'app', 'metadata', 'sums']) {
    stage[name] = join(directory, name);
    write(stage[name], name);
  }
  const assets = Object.entries(stage).map(([name, path]) => ({
    name, size: readFileSync(path).length, digest: `sha256:${hash(readFileSync(path))}`,
  }));
  const events = []; let created = false;
  const publishRun = (command, args) => {
    assert.equal(command, 'gh');
    if (args[0] === 'release' && args[1] === 'view') {
      return created ? { status: 0, stdout: JSON.stringify({ isDraft: true, assets }), stderr: '' } :
        { status: 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'release' && args[1] === 'create') {
      created = true; events.push('draft'); return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'release' && args[1] === 'edit') {
      events.push('publish'); return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected GitHub command: ${args.join(' ')}`);
  };
  publishRelease({ version: '0.5.4', head: 'a'.repeat(40), stage, cwd: directory, run: publishRun,
    beforePublish: () => events.push('verified') });
  assert.deepEqual(events, ['draft', 'verified', 'publish']);

  created = false; events.length = 0; assets[1].digest = 'sha256:wrong';
  assert.throws(() => publishRelease({ version: '0.5.4', head: 'a'.repeat(40), stage, cwd: directory, run: publishRun }),
    /verification failed/);
  assert.deepEqual(events, ['draft']);
});

test('accepts AppleDouble metadata from ditto signed archives', { skip: process.platform !== 'darwin' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-app-release-zip-'));
  const app = join(directory, 'Harness Gateway.app');
  const fixture = join(app, 'Contents/Resources/fixture');
  write(fixture, 'fixture');
  run('xattr', ['-w', 'com.edihasaj.fixture', 'root', app]);
  run('xattr', ['-w', 'com.edihasaj.fixture', 'directory', join(app, 'Contents')]);
  run('xattr', ['-w', 'com.edihasaj.fixture', 'xattr', fixture]);
  const archive = join(directory, 'app.zip');
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
  assert.doesNotThrow(() => inspectFinalZip(archive));
});
