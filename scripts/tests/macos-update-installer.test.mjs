import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('../..', import.meta.url).pathname;
const bin = execFileSync('swift', ['build', '--package-path', 'native/macos', '--show-bin-path'], {
  cwd: root, encoding: 'utf8',
}).trim();
const installer = join(bin, 'GatewayUpdateInstaller');

function apps() {
  const parent = mkdtempSync(join(tmpdir(), 'gateway-update-installer-'));
  const target = join(parent, 'Harness Gateway.app');
  const stage = join(parent, 'Harness Gateway Update.app');
  for (const [app, marker] of [[target, 'old'], [stage, 'new']]) {
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents/marker'), marker);
  }
  return { parent, target, stage };
}

test('atomically swaps sibling app bundles and retains the old app at stage', () => {
  const { target, stage } = apps();
  execFileSync(installer, [target, stage]);
  assert.equal(readFileSync(join(target, 'Contents/marker'), 'utf8'), 'new');
  assert.equal(readFileSync(join(stage, 'Contents/marker'), 'utf8'), 'old');
});

test('rejects unsafe parents, symlinks, aliases, and non-app paths without deleting either bundle', () => {
  const { parent, target, stage } = apps();
  chmodSync(parent, 0o777);
  let result = spawnSync(installer, [target, stage]);
  assert.notEqual(result.status, 0);
  assert(existsSync(target) && existsSync(stage));
  chmodSync(parent, 0o700);
  chmodSync(stage, 0o777);
  result = spawnSync(installer, [target, stage]);
  assert.notEqual(result.status, 0);
  chmodSync(stage, 0o700);
  const linked = join(parent, 'linked.app');
  symlinkSync(stage, linked);
  result = spawnSync(installer, [target, linked]);
  assert.notEqual(result.status, 0);
  result = spawnSync(installer, [target, join(parent, 'not-an-app')]);
  assert.notEqual(result.status, 0);
  result = spawnSync(installer, [target, target]);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(target, 'Contents/marker'), 'utf8'), 'old');
  assert.equal(readFileSync(join(stage, 'Contents/marker'), 'utf8'), 'new');
});

test('rejects an unsafe ancestor even when the immediate app parent is protected', () => {
  const unsafe = mkdtempSync(join(tmpdir(), 'gateway-update-unsafe-'));
  const parent = join(unsafe, 'protected');
  mkdirSync(parent, { mode: 0o700 });
  const target = join(parent, 'Harness Gateway.app');
  const stage = join(parent, 'Harness Gateway Update.app');
  for (const [app, marker] of [[target, 'old'], [stage, 'new']]) {
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents/marker'), marker);
  }
  chmodSync(unsafe, 0o777);
  const result = spawnSync(installer, [target, stage]);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(target, 'Contents/marker'), 'utf8'), 'old');
  assert.equal(readFileSync(join(stage, 'Contents/marker'), 'utf8'), 'new');
});
