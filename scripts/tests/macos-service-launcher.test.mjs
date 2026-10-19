import assert from 'node:assert/strict';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const source = join(repo, 'native/macos/Sources/GatewayService/main.c');
const scratch = mkdtempSync(join(tmpdir(), 'gateway-service-launcher-'));
const template = join(scratch, 'GatewayService-template');
const sharedDylib = join(scratch, `libnode.${process.versions.modules}.dylib`);
const failure = 'Gateway service launcher failed\n';
const sentinel = 'sentinel value: $not-expanded';

test.before(() => {
  const compile = spawnSync('/usr/bin/xcrun', [
    'clang', '-std=c17', '-Wall', '-Wextra', '-Werror', source, '-o', template,
  ], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr);
  const dylib = join(dirname(realpathSync(process.execPath)), '..', 'lib', basename(sharedDylib));
  if (existsSync(dylib)) copyFileSync(dylib, sharedDylib);
});

test.after(() => rmSync(scratch, { recursive: true, force: true }));

const cliScript = (marker) => `
const fs = require('fs');
fs.writeFileSync(process.env.GATEWAY_TEST_RECORD, JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  argv: process.argv,
  argvReal: [fs.realpathSync(process.argv[0]), fs.realpathSync(process.argv[1])],
  execPath: process.execPath,
  execPathReal: fs.realpathSync(process.execPath),
  childNode: require('node:child_process').spawnSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
  }).stdout.trim(),
  env: {
    command: process.env.GATEWAY_COMMAND,
    installed: process.env.GATEWAY_INSTALLED,
    sentinel: process.env.GATEWAY_SERVICE_TEST_SENTINEL,
    path: process.env.PATH,
  },
  marker: '${marker}',
}));
console.log('cli stdout: ' + '${marker}');
process.exit(Number(process.env.GATEWAY_TEST_EXIT || 0));
`;

function environment() {
  const root = mkdtempSync(join(scratch, 'case-'));
  const prefix = join(root, 'prefix');
  const app = join(root, 'Harness Gateway.app');
  const service = join(app, 'Contents/MacOS/GatewayService');
  const node = join(app, 'Contents/Resources/backend/runtime/bin/node');
  const command = join(prefix, 'bin/gateway');
  const current = join(prefix, 'share/subscription-gateway/current');
  const record = join(root, 'record.json');
  const executed = join(root, 'wrapper-executed');

  mkdirSync(dirname(service), { recursive: true });
  copyFileSync(template, service);
  chmodSync(service, 0o755);
  mkdirSync(dirname(node), { recursive: true });
  copyFileSync(process.execPath, node);
  chmodSync(node, 0o755);
  if (existsSync(sharedDylib)) {
    const target = join(dirname(node), '..', 'lib', basename(sharedDylib));
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(sharedDylib, target);
  }

  mkdirSync(dirname(command), { recursive: true });
  writeFileSync(command,
    '#!/bin/sh\n# Managed by subscription-gateway installer\n' +
    `printf executed > "${executed}"\nexit 99\n`);
  chmodSync(command, 0o700);

  release(current, '1.0.0');
  return { root, prefix, app, service, node, command, current, record, executed };
}

function release(current, version) {
  const cli = join(dirname(current), 'releases', version, 'package', 'dist');
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, 'cli.js'), cliScript(version));
  chmodSync(join(cli, 'cli.js'), 0o600);
  if (!existsSync(current)) symlinkSync(join('releases', version), current);
  return join(cli, 'cli.js');
}

function relink(context, version) {
  rmSync(context.current);
  return release(context.current, version);
}

function launch(context, options = {}, extraEnv = {}) {
  rmSync(options.record ?? context.record, { force: true });
  return spawnSync(options.binary ?? context.service, options.args ?? ['serve'], {
    argv0: options.argv0 ?? context.command,
    cwd: context.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin:/fixture/tools',
      GATEWAY_TEST_RECORD: options.record ?? context.record,
      GATEWAY_SERVICE_TEST_SENTINEL: sentinel,
      ...extraEnv,
    },
    timeout: 10_000,
    ...(options.spawn ?? {}),
  });
}

function readRecord(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertFailed(result, context) {
  assert.equal(result.status, 78, result.stderr);
  assert.equal(result.stderr, failure);
  assert.equal(existsSync(context.executed), false, 'installer wrapper must never execute');
}

test('execs the app-bundled Node with the current installed CLI', () => {
  const context = environment();
  const cli = join(context.prefix, 'share/subscription-gateway/current/package/dist/cli.js');
  const result = launch(context, { args: ['serve', '--literal', 'two words', '$unchanged'] });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(context.executed), false, 'installer wrapper must never execute');
  assert.match(result.stdout, /cli stdout: 1\.0\.0/);

  const record = readRecord(context.record);
  assert.equal(record.pid, result.pid);
  assert.equal(realpathSync(record.cwd), realpathSync(context.root));
  assert.deepEqual(record.argv.slice(2), ['serve', '--literal', 'two words', '$unchanged']);
  assert.equal(record.argv.length, 6);
  assert.deepEqual(record.argvReal, [realpathSync(context.node), realpathSync(cli)]);
  assert.equal(record.execPathReal, realpathSync(context.node));
  assert.equal(realpathSync(record.childNode), realpathSync(context.node));
  assert.match(record.execPath.replace(/\/$/, ''), /\/Contents\/Resources\/backend\/runtime\/bin\/node$/);
  assert.equal(record.env.command, context.command);
  assert.equal(record.env.installed, '1');
  assert.equal(record.env.sentinel, sentinel);
  assert.equal(record.env.path, `${dirname(realpathSync(context.node))}:/usr/bin:/bin:/fixture/tools`);
});

test('preserves a large argument list', () => {
  const context = environment();
  const args = ['serve', ...Array.from({ length: 300 }, (_, index) => `literal-${index}`)];
  const result = launch(context, { args });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readRecord(context.record).argv.slice(2), args);
});

test('accepts daemon mode', () => {
  const context = environment();
  const result = launch(context, { args: ['daemon'] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRecord(context.record).argv[2], 'daemon');
});

test('propagates the CLI exit code, not the wrapper exit code', () => {
  const context = environment();
  const result = launch(context, {}, { GATEWAY_TEST_EXIT: '3' });
  assert.equal(result.status, 3);
});

test('ignores a bogus runtime environment override', () => {
  const context = environment();
  const result = launch(context, {}, { GATEWAY_NODE_PATH: join(context.root, 'not-really-node') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readRecord(context.record).execPathReal, realpathSync(context.node));
});

test('follows the current link: code changes while the Node path stays constant', () => {
  const context = environment();
  const first = launch(context, {});
  assert.equal(first.status, 0, first.stderr);
  const before = readRecord(context.record);

  relink(context, '1.0.1');
  const second = launch(context, {});
  assert.equal(second.status, 0, second.stderr);
  const after = readRecord(context.record);

  assert.equal(after.marker, '1.0.1');
  assert.equal(after.argvReal[0], before.argvReal[0]);
  assert.equal(after.execPathReal, before.execPathReal);
  assert.equal(after.childNode, before.childNode);
  assert.notEqual(after.argvReal[1], before.argvReal[1]);
});

test('rejects a missing mode', () => {
  const context = environment();
  assertFailed(launch(context, { args: [] }), context);
});

test('rejects a FIFO without blocking', () => {
  const context = environment();
  const fifo = join(context.root, 'launcher-fifo');
  const create = spawnSync('/usr/bin/mkfifo', [fifo], { encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  assertFailed(launch(context, { argv0: fifo }), context);
});

for (const [name, prepare] of [
  ['missing marker', (c) => {
    writeFileSync(c.command, '#!/bin/sh\n# not installer managed\nexit 99\n');
    chmodSync(c.command, 0o700);
  }],
  ['partial marker', (c) => {
    writeFileSync(c.command, '#!/bin/sh\n# Managed by subscription-gateway installer extra\nexit 99\n');
    chmodSync(c.command, 0o700);
  }],
  ['symlink command', (c) => {
    const target = join(c.root, 'real-command');
    writeFileSync(target, readFileSync(c.command, 'utf8'));
    chmodSync(target, 0o700);
    rmSync(c.command);
    symlinkSync(target, c.command);
  }],
  ['group-writable command', (c) => chmodSync(c.command, 0o720)],
  ['missing owner execute permission', (c) => chmodSync(c.command, 0o600)],
  ['oversize command', (c) => {
    writeFileSync(c.command, `${readFileSync(c.command, 'utf8')}${'x'.repeat(65_537)}`);
    chmodSync(c.command, 0o700);
  }],
  ['invalid mode', (c) => { c.args = ['start']; }],
  ['relative argv0', (c) => { c.argv0 = basename(c.command); }],
  ['direct invocation', (c) => { c.argv0 = c.service; }],
  ['unknown command name', (c) => {
    const other = join(c.prefix, 'bin', 'other');
    copyFileSync(c.command, other);
    chmodSync(other, 0o700);
    c.argv0 = other;
  }],
  ['command outside a bin directory', (c) => {
    const other = join(c.prefix, 'gateway');
    copyFileSync(c.command, other);
    chmodSync(other, 0o700);
    c.argv0 = other;
  }],
  ['missing current link', (c) => rmSync(c.current)],
  ['current link to a missing release', (c) => {
    rmSync(c.current);
    symlinkSync(join('releases', '9.9.9'), c.current);
  }],
  ['missing bundled node', (c) => rmSync(c.node)],
  ['bundled node replaced by a directory', (c) => { rmSync(c.node); mkdirSync(c.node); }],
  ['group-writable bundled node', (c) => chmodSync(c.node, 0o720)],
  ['bundled node without execute permission', (c) => chmodSync(c.node, 0o600)],
  ['missing CLI', (c) => rmSync(join(c.current, 'package/dist/cli.js'))],
  ['CLI replaced by a symlink', (c) => {
    const cli = join(c.current, 'package/dist/cli.js');
    const elsewhere = join(c.root, 'elsewhere.js');
    copyFileSync(cli, elsewhere);
    rmSync(cli);
    symlinkSync(elsewhere, cli);
  }],
  ['group-writable CLI', (c) => chmodSync(join(c.current, 'package/dist/cli.js'), 0o664)],
]) {
  test(`rejects ${name}`, () => {
    const context = environment();
    prepare(context);
    const options = { argv0: context.argv0 ?? context.command, args: context.args ?? ['serve'] };
    assertFailed(launch(context, options), context);
  });
}
