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
