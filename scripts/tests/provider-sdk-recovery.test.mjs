import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const original = Buffer.from('use ctor::ctor;\nmod abort_lifecycle;\nmod other;\n');
const reduced = Buffer.from('use ctor::ctor;\nmod compact;\n');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-sdk-recovery-'));
  const runner = join(root, 'scripts/gateway-sdk-test-runner.mjs');
  const sdk = join(root, 'sdk');
  const aggregator = join(sdk, 'codex-rs/core/tests/suite/mod.rs');
  const backup = `${aggregator}.gateway-original`;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'src'), { recursive: true, mode: 0o700 });
  mkdirSync(join(sdk, 'codex-rs/core/tests/suite'), { recursive: true, mode: 0o700 });
  writeFileSync(runner, readFileSync(new URL('../gateway-sdk-test-runner.mjs', import.meta.url)));
  writeFileSync(join(root, 'src/gateway-sdk-pin.json'), JSON.stringify({
    originalAggregatorSha256: digest(original),
    compactionAggregatorSha256: digest(reduced),
  }));
  writeFileSync(aggregator, original);
  return { root, sdk, aggregator, backup, runner };
}

function runFresh({ runner, sdk }, expression) {
  const source = `import { readFileSync } from "node:fs";
import { recoverGatewaySdkCompactionTests, withGatewaySdkCompactionTests } from ${JSON.stringify(pathToFileURL(runner).href)};
${expression}`;
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8' });
}

test('crash recovery restores the pinned original aggregator from an authenticated reduced gate backup', t => {
  const f = fixture(t);
  writeFileSync(f.aggregator, reduced);
  writeFileSync(f.backup, original, { mode: 0o600 });

  const result = runFresh(f, `recoverGatewaySdkCompactionTests(${JSON.stringify(f.sdk)});`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(f.aggregator), original);
  assert.equal(existsSync(f.backup), false);
});

test('crash recovery refuses an unknown aggregator edit and preserves it for inspection', t => {
  const f = fixture(t);
  const changed = Buffer.from('user changed the aggregator\n');
  writeFileSync(f.aggregator, changed);
  writeFileSync(f.backup, original, { mode: 0o600 });

  const result = runFresh(f, `recoverGatewaySdkCompactionTests(${JSON.stringify(f.sdk)});`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SDK test aggregator changed outside the gate/);
  assert.deepEqual(readFileSync(f.aggregator), changed);
  assert.deepEqual(readFileSync(f.backup), original);
});

test('crash recovery refuses an unauthenticated backup when the aggregator is still reduced', t => {
  const f = fixture(t);
  const changedBackup = Buffer.from('tampered backup\n');
  writeFileSync(f.aggregator, reduced);
  writeFileSync(f.backup, changedBackup, { mode: 0o600 });

  const result = runFresh(f, `recoverGatewaySdkCompactionTests(${JSON.stringify(f.sdk)});`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SDK compaction test backup changed/);
  assert.deepEqual(readFileSync(f.aggregator), reduced);
  assert.deepEqual(readFileSync(f.backup), changedBackup);
});

test('an interrupted partial backup is discarded when the original aggregator remained intact', t => {
  const f = fixture(t);
  writeFileSync(f.backup, 'partial backup bytes\n', { mode: 0o600 });

  const result = runFresh(f, `recoverGatewaySdkCompactionTests(${JSON.stringify(f.sdk)});`);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(f.aggregator), original);
  assert.equal(existsSync(f.backup), false);
});

test('a symlinked aggregator is refused without changing its external reduced source', t => {
  const f = fixture(t);
  const external = join(f.root, 'external-mod.rs');
  writeFileSync(external, reduced, { mode: 0o600 });
  unlinkSync(f.aggregator);
  symlinkSync(external, f.aggregator);
  writeFileSync(f.backup, original, { mode: 0o600 });

  const result = runFresh(f, `recoverGatewaySdkCompactionTests(${JSON.stringify(f.sdk)});`);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid SDK test aggregator/);
  assert.equal(lstatSync(f.aggregator).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(external), reduced);
  assert.deepEqual(readFileSync(f.backup), original);
});

test('a successful compaction gate restores the original aggregator and removes its backup', t => {
  const f = fixture(t);
  const result = runFresh(f, `const value = withGatewaySdkCompactionTests(${JSON.stringify(f.sdk)}, () => {
  const text = readFileSync(${JSON.stringify(f.aggregator)}, "utf8");
  if (text !== ${JSON.stringify(reduced.toString('utf8'))}) throw Error("fixture was not reduced");
  return "gate-ran";
});
console.log(value);`);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'gate-ran');
  assert.deepEqual(readFileSync(f.aggregator), original);
  assert.equal(existsSync(f.backup), false);
});
