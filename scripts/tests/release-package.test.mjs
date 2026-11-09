import assert from 'node:assert/strict';
import test from 'node:test';
import { packReleasePackage } from '../release-package.mjs';

const required = ['dist/cli.js', 'dist/cli-main.js', 'dist/token-command.js', 'dist/native-auth-compat.js', 'dist/config.js', 'dist/catalog.js', 'dist/server.js', 'dist/app-management.js'];
function fixture({ dirty = false, missing, failBuild = false } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'run') { if (failBuild) throw new Error('compile failed'); return ''; }
    if (command === 'git') return dirty ? ' M src/generated.ts\n' : '';
    return JSON.stringify([{ filename: 'package.tgz', files: required.filter(path => path !== missing).map(path => ({ path })) }]);
  };
  return { calls, run };
}
test('a clean checkout is compiled before packing and its entry points are required', () => {
  const f = fixture();
  assert.equal(packReleasePackage('/tmp/release-fixture', { run: f.run }).filename, 'package.tgz');
  assert.deepEqual(f.calls, [['npm', 'run', 'build'], ['git', 'status', '--porcelain'], ['npm', 'pack', '--json', '--pack-destination', '/tmp/release-fixture']]);
});
test('a failed build never packs', () => {
  const f = fixture({ failBuild: true });
  assert.throws(() => packReleasePackage('/tmp/release-fixture', { run: f.run }), /compile failed/);
  assert.equal(f.calls.length, 1);
});
test('generated source drift refuses a production package before packing', () => {
  const f = fixture({ dirty: true });
  assert.throws(() => packReleasePackage('/tmp/release-fixture', { run: f.run }), /changed tracked source/);
  assert.equal(f.calls.length, 2);
});
test('allow-dirty is explicit and never skips the build', () => {
  const f = fixture({ dirty: true });
  packReleasePackage('/tmp/release-fixture', { run: f.run, allowDirty: true });
  assert.deepEqual(f.calls.map(call => call.slice(0, 2)), [['npm', 'run'], ['npm', 'pack']]);
});
for (const missing of required) test(`packing without ${missing} is refused`, () => {
  const f = fixture({ missing });
  assert.throws(() => packReleasePackage('/tmp/release-fixture', { run: f.run }), /Release package is missing/);
});
