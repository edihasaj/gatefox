import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyCandidate, maintainProviders, promotedFiles } from '../provider-maintenance.mjs';
import { runValidation, validationEnvironment } from '../provider-maintenance-process.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-maintain-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, '.gitignore'), '.state/\n');
  for (const path of promotedFiles) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), 'old'); }
  git(['add', '.']); git(['commit', '-m', 'test: fixture']);
  const candidate = join(root, '.state/candidate'); mkdirSync(candidate, { recursive: true });
  for (const path of promotedFiles) { mkdirSync(dirname(join(candidate, path)), { recursive: true }); writeFileSync(join(candidate, path), 'verified'); }
  return { root, git, candidate, base: git(['rev-parse', 'HEAD']) };
}
test('only generated verified files advance; stale or dirty source refuses promotion', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'user-work.txt'), 'keep');
  assert.throws(() => applyCandidate(f.root, f.candidate, f.base), /Source changed/);
  assert.equal(readFileSync(join(f.root, promotedFiles[0]), 'utf8'), 'old');
  f.git(['add', 'user-work.txt']); f.git(['commit', '-m', 'test: other work']);
  assert.throws(() => applyCandidate(f.root, f.candidate, f.base), /Source changed/);
  applyCandidate(f.root, f.candidate, f.git(['rev-parse', 'HEAD']));
  for (const path of promotedFiles) assert.equal(readFileSync(join(f.root, path), 'utf8'), 'verified');
  assert.equal(readFileSync(join(f.root, 'user-work.txt'), 'utf8'), 'keep');
});
test('incomplete candidates never begin source promotion', t => {
  const f = fixture(t); rmSync(join(f.candidate, promotedFiles.at(-1)));
  assert.throws(() => applyCandidate(f.root, f.candidate, f.base));
  for (const path of promotedFiles) assert.equal(readFileSync(join(f.root, path), 'utf8'), 'old');
});
test('failed official discovery records a safe blocker and preserves source', async t => {
  const f = fixture(t);
  await assert.rejects(maintainProviders({ root: f.root, discover: async () => { throw Error('private upstream response'); } }), /blocked at discovery/);
  const report = readFileSync(join(f.root, '.state/provider-maintenance/latest.json'), 'utf8');
  assert.equal(JSON.parse(report).phase, 'discovery'); assert.ok(!report.includes('private upstream'));
  assert.equal(f.git(['status', '--porcelain']), '');
  // Failure released the lease, so another independent attempt may run.
  await assert.rejects(maintainProviders({ root: f.root, discover: async () => { throw Error(); } }), /discovery/);
});
test('overlapping maintainers refuse without altering the existing lease', async t => {
  const f = fixture(t);
  let entered, finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { finish = resolve; });
  const first = maintainProviders({ root: f.root, discover: async () => { entered(); await hold; throw Error(); } });
  await ready;
  await assert.rejects(maintainProviders({ root: f.root }), /already running/);
  finish(); await assert.rejects(first, /discovery/);
});
test('validators receive a private HOME and no inherited provider or Node injection exports', t => {
  const f = fixture(t); const env = validationEnvironment(join(f.root, '.state/home'));
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'CLAUDECODE']) assert.equal(env[name], undefined);
  assert.equal(env.CODEX_HOME, join(f.root, '.state/home/.codex'));
});
test('hung validators time out and arbitrary diagnostics never enter the error', async () => {
  await assert.rejects(runValidation(process.execPath, ['-e', 'process.stderr.write("secret fixture"); setInterval(()=>{},1000)'],
    { timeoutMs: 50 }), error => error.message === 'Provider candidate validation failed');
});

function validationFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'provider-validation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist/tests'), { recursive: true });
  mkdirSync(join(root, 'scripts/tests'), { recursive: true });
  writeFileSync(join(root, 'dist/tests/failure.test.js'), '');
  writeFileSync(join(root, 'scripts/tests/provider-fixture.test.mjs'), '');
  return root;
}
async function failure(promise) {
  try { await promise; assert.fail('expected validation failure'); } catch (error) { return error; }
}

test('validation failures retain only bounded fixed facts from both streams', async t => {
  const cwd = validationFixture(t);
  const source = [
    'process.stdout.write("PRIVATE_STDOUT\\n# tests 3\\n# fail 1\\ndist/tests/failure.test.js:4:2\\nscripts/tests/provider-fixture.test.mjs:8\\n");',
    'process.stderr.write("PRIVATE_STDERR\\nerror[E");',
    'setTimeout(() => { process.stderr.write("0123]\\nerror TS9999\\nfailureType: testCodeFailure\\nPRIVATE_TITLE\\nexpected: PRIVATE_EXPECTED\\nactual: PRIVATE_ACTUAL\\n"); process.exit(7); }, 10);',
  ].join('');
  const error = await failure(runValidation(process.execPath, ['-e', source], { cwd }));
  assert.equal(error.failureReason, 'nonzero_exit'); assert.equal(error.exitCode, 7);
  assert.deepEqual(error.failureFiles, ['dist/tests/failure.test.js', 'scripts/tests/provider-fixture.test.mjs']);
  assert.deepEqual(error.failureLocations, [
    { file: 'dist/tests/failure.test.js', line: 4, column: 2 },
    { file: 'scripts/tests/provider-fixture.test.mjs', line: 8 },
  ]);
  assert.deepEqual(error.compilerCodes, ['E0123', 'TS9999']);
  assert.deepEqual(error.failureTypes, ['testCodeFailure']); assert.deepEqual(error.testTotals, { tests: 3, fail: 1 });
  const serialized = JSON.stringify(error);
  for (const secret of ['PRIVATE_STDOUT', 'PRIVATE_STDERR', 'PRIVATE_TITLE', 'PRIVATE_EXPECTED', 'PRIVATE_ACTUAL']) assert.ok(!serialized.includes(secret));
});

test('validation records timeout, output limit, cancellation, and spawn failures without diagnostics', async t => {
  const cwd = validationFixture(t);
  const timeout = await failure(runValidation(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, timeoutMs: 30 }));
  assert.equal(timeout.failureReason, 'timeout');
  assert.deepEqual(timeout.failureFiles, []); assert.deepEqual(timeout.compilerCodes, []);
  const overflow = await failure(runValidation(process.execPath, ['-e', 'process.stdout.write("x".repeat(200)); setInterval(()=>{},1000)'],
    { cwd, maximumOutput: 20 }));
  assert.equal(overflow.failureReason, 'output_limit');
  const controller = new AbortController();
  const cancelledRun = failure(runValidation(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, abortSignal: controller.signal }));
  setTimeout(() => controller.abort(), 20);
  assert.equal((await cancelledRun).failureReason, 'cancelled');
  const missing = await failure(runValidation('definitely-not-a-provider-validator', [], { cwd }));
  assert.equal(missing.failureReason, 'spawn_error');
  assert.deepEqual(missing.failureFiles, []); assert.deepEqual(missing.compilerCodes, []);
});

test('validation bounds paths, accepts only real candidate tests, and keeps successful stdout unchanged', async t => {
  const cwd = validationFixture(t);
  for (let index = 0; index < 20; index++) writeFileSync(join(cwd, 'dist/tests', `bounded-${index}.test.js`), '');
  const locations = Array.from({ length: 20 }, (_, index) => `dist/tests/bounded-${index}.test.js:${index + 1}:1`).join('\n');
  const codes = Array.from({ length: 20 }, (_, index) => `error[E${String(1000 + index)}]`).join('\n');
  const source = `process.stderr.write(${JSON.stringify(`${locations}\n${codes}\ndist/tests/../private.test.js:1:1\ndist/tests/missing.test.js:1:1\nℹ pass 20\n`)}); process.exit(1);`;
  const error = await failure(runValidation(process.execPath, ['-e', source], { cwd }));
  assert.equal(error.failureFiles.length, 16); assert.equal(error.failureLocations.length, 16); assert.equal(error.compilerCodes.length, 16);
  assert.ok(error.failureFiles.every(file => /^dist\/tests\/bounded-\d+\.test\.js$/.test(file)));
  assert.deepEqual(error.testTotals, { pass: 20 });
  assert.equal(await runValidation(process.execPath, ['-e', 'process.stdout.write("exact success\\n")'], { cwd }), 'exact success\n');
});

test('validation accepts absolute candidate locations but rejects outside paths with a matching suffix', async t => {
  const cwd = validationFixture(t);
  const inside = join(cwd, 'dist/tests/failure.test.js');
  const fileUrl = `file://${join(cwd, 'scripts/tests/provider-fixture.test.mjs')}`;
  const source = `process.stderr.write(${JSON.stringify(`${inside}:5:6\n/private/outside/dist/tests/failure.test.js:7:8\n${fileUrl}:9:10\n`)}); process.exit(1);`;
  const error = await failure(runValidation(process.execPath, ['-e', source], { cwd }));
  assert.deepEqual(error.failureFiles, ['dist/tests/failure.test.js', 'scripts/tests/provider-fixture.test.mjs']);
  assert.deepEqual(error.failureLocations, [
    { file: 'dist/tests/failure.test.js', line: 5, column: 6 },
    { file: 'scripts/tests/provider-fixture.test.mjs', line: 9, column: 10 },
  ]);
});
