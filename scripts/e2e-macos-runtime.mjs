#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Uses only a private installation fixture. It never loads, signals, or rewrites
// the user's service, settings, provider credentials, or privacy preferences.
const app = process.argv[2];
if (process.platform !== 'darwin' || !app || !isAbsolute(app) || !app.endsWith('.app')) {
  throw new Error('Usage: node scripts/e2e-macos-runtime.mjs /absolute/Harness\\ Gateway.app');
}
const run = (binary, args, options = {}) => {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 15_000, ...options });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${binary} failed: ${result.stderr}`);
  return result;
};
const requirement = 'anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${requirement}`, app]);
const node = join(app, 'Contents/Resources/backend/runtime/bin/node');
const helper = join(app, 'Contents/MacOS/GatewayService');
run('/usr/bin/codesign', ['--verify', '--strict',
  `-R=${requirement} and identifier "com.edihasaj.harness-gateway.node"`, node]);
const nodeIdentity = run('/usr/bin/codesign', ['-d', '-r-', node]).stdout.trim();

const { associateAppRuntime, renderInstalledLauncher } = await import(pathToFileURL(
  join(app, 'Contents/Resources/management/dist/app-runtime.js')));
const evidence = realpathSync(mkdtempSync(join(tmpdir(), 'gateway-signed-runtime-')));
chmodSync(evidence, 0o700);
const home = join(evidence, 'home');
const prefix = join(home, '.local');
const root = join(prefix, 'share/subscription-gateway');
const command = join(prefix, 'bin/gateway');
const state = join(home, 'state');
for (const path of [dirname(command), root, state]) mkdirSync(path, { recursive: true, mode: 0o700 });
writeFileSync(join(root, '.gateway-installation'), 'subscription-gateway\n', { mode: 0o600 });
writeFileSync(command, renderInstalledLauncher(root, command), { mode: 0o700 });
assert.equal(await associateAppRuntime({ home, appPath: app, stateDirectory: state, commandPath: command }), true);
assert.equal(await associateAppRuntime({ home, appPath: app, stateDirectory: state, commandPath: command }), false);

const results = [];
for (const version of ['1.0.0', '1.0.1']) {
  const cli = join(root, 'releases', version, 'package/dist/cli.js');
  mkdirSync(dirname(cli), { recursive: true, mode: 0o700 });
  writeFileSync(cli, `
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--child-fixture')) {
  console.log(JSON.stringify({ runtime: process.execPath, args: process.argv.slice(2) }));
} else {
  const child = spawnSync(process.env.GATEWAY_COMMAND, ['--child-fixture', 'two words', '$literal'], {
    env: process.env, encoding: 'utf8',
  });
  if (child.status !== 0) process.exit(2);
  const node = spawnSync('node', ['-p', 'process.execPath'], { env: process.env, encoding: 'utf8' });
  if (node.status !== 0) process.exit(3);
  console.log(JSON.stringify({
    version: ${JSON.stringify(version)}, runtime: process.execPath,
    child: JSON.parse(child.stdout), pathNode: node.stdout.trim(),
    args: process.argv.slice(2), cwd: process.cwd(),
  }));
}
`, { mode: 0o600 });
  const current = join(root, 'current');
  if (existsSync(current)) unlinkSync(current);
  symlinkSync(`releases/${version}`, current);
  const invocation = run(helper, ['serve', '--literal', 'two words', '$literal'], {
    argv0: command, cwd: evidence, env: { HOME: home, PATH: '/usr/bin:/bin' },
  });
  const record = JSON.parse(invocation.stdout);
  assert.equal(record.version, version);
  assert.equal(record.runtime, realpathSync(node));
  assert.equal(record.child.runtime, record.runtime);
  assert.equal(record.pathNode, record.runtime);
  assert.deepEqual(record.args, ['serve', '--literal', 'two words', '$literal']);
  assert.deepEqual(record.child.args, ['--child-fixture', 'two words', '$literal']);
  assert.equal(record.cwd, evidence);
  results.push(record);
}
assert.equal(results[0].runtime, results[1].runtime);
const receipt = resolve(evidence, 'proof.json');
writeFileSync(receipt, `${JSON.stringify({
  passed: true, app, nodeIdentity, results,
  scope: 'Signed launcher, managed wrapper, and PATH child across installed CLI updates; no TCC consent action.',
}, null, 2)}\n`, { mode: 0o600 });
console.log(`Signed runtime update checks passed. Evidence: ${receipt}`);
