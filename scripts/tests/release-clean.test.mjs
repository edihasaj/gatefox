import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { releaseCleanPlan, runReleaseClean } from '../release-clean.mjs';
import { withPrivateFileLock } from '../../dist/private-file-lock.js';
import { cargoTargetLockPaths, withCargoTargetLocks } from '../cargo-target-lock.mjs';

test('plans Cargo target cleanup and retains updater fixtures', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gateway-release-clean-'));
  const gateway = join(cwd, '.state/gateway-sdk-build');
  const relay = join(cwd, '.state/native-relay-build');
  mkdirSync(join(gateway, 'sdk-pin/codex-rs'), { recursive: true });
  mkdirSync(join(gateway, 'target'), { recursive: true });
  writeFileSync(join(gateway, 'sdk-pin/codex-rs/Cargo.toml'), '[workspace]\n');
  writeFileSync(join(gateway, 'target/output'), 'gateway');
  mkdirSync(join(relay, 'build-pin'), { recursive: true });
  mkdirSync(join(relay, 'target'), { recursive: true });
  writeFileSync(join(relay, 'build-pin/Cargo.toml'), '[package]\nname="relay"\nversion="0.0.0"\n');
  writeFileSync(join(relay, 'target/output'), 'relay');
  mkdirSync(join(cwd, '.state/app-update-e2e-retained'), { recursive: true });
  writeFileSync(join(cwd, '.state/app-update-e2e-retained/evidence'), 'fixture');

  const plan = releaseCleanPlan({ cwd });
  assert.equal(plan.entries[0].manifest, join(gateway, 'sdk-pin/codex-rs/Cargo.toml'));
  assert.equal(plan.entries[0].bytes, 7);
  assert.equal(plan.entries[1].manifest, join(relay, 'build-pin/Cargo.toml'));
  assert.equal(plan.entries[1].bytes, 5);
  assert.equal(plan.entries[2].present, false);
  assert.deepEqual(plan.fixtures, [{ path: join(cwd, '.state/app-update-e2e-retained'), bytes: 7 }]);

  const messages = [];
  const original = console.log;
  console.log = message => messages.push(message);
  try { assert.equal(await runReleaseClean({ cwd, dryRun: true }), 12); }
  finally { console.log = original; }
  assert.ok(messages.some(message => message.includes('would run cargo clean')));
  assert.ok(messages.some(message => message.includes('retained fixture')));
  assert.ok(messages.includes('would reclaim 12 bytes'));
});

test('refuses a build lock held for the cleanup root', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gateway-release-clean-lock-'));
  const root = join(cwd, '.state/gateway-sdk-build');
  mkdirSync(root, { recursive: true });
  let release; let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const held = withPrivateFileLock(join(root, 'build'), async () => {
    acquired();
    await new Promise(resolve => { release = resolve; });
  });
  await ready;
  await assert.rejects(runReleaseClean({ cwd, dryRun: true }), /held by live pid/);
  release();
  await held;
});

test('refuses a fresh empty build lock and recovers a stale dead-pid lock', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gateway-release-clean-stale-'));
  const root = join(cwd, '.state/gateway-sdk-build');
  mkdirSync(root, { recursive: true });
  const lock = join(root, 'build.lock');
  writeFileSync(lock, '', { mode: 0o600 });
  chmodSync(lock, 0o600);
  await assert.rejects(runReleaseClean({ cwd, dryRun: true }), /pid is being recorded/);
  writeFileSync(lock, '999999\n');
  await assert.doesNotReject(runReleaseClean({ cwd, dryRun: true }));
});

test('cleanup refuses a maintenance build lock on its shared SDK target', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gateway-release-clean-maintenance-'));
  const target = join(cwd, '.state/gateway-sdk-build/target');
  mkdirSync(dirname(target), { recursive: true });
  let release; let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const held = withCargoTargetLocks([target], async () => {
    acquired();
    await new Promise(resolve => { release = resolve; });
  });
  await ready;
  await assert.rejects(runReleaseClean({ cwd, dryRun: true }), /Cargo target lock .* held by live pid/);
  release();
  await held;
});

test('Cargo target locks serialize writers and use a canonical sorted order', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gateway-cargo-target-lock-'));
  const firstTarget = join(directory, 'z-target');
  const secondTarget = join(directory, 'a-target');
  mkdirSync(firstTarget); mkdirSync(secondTarget);
  const locks = cargoTargetLockPaths([firstTarget, secondTarget, firstTarget]);
  assert.deepEqual(locks, [...locks].sort());
  assert.deepEqual(locks.map(path => basename(path)), ['a-target.cargo-target', 'z-target.cargo-target']);

  const events = [];
  let release; let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const first = withCargoTargetLocks([firstTarget], async () => {
    events.push('first-start'); acquired();
    await new Promise(resolve => { release = resolve; });
    events.push('first-end');
  });
  await ready;
  const second = withCargoTargetLocks([firstTarget], async () => { events.push('second-start'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);
});
