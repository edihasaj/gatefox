import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const { values: v } = parseArgs({ options: { config: { type: 'string' }, codex: { type: 'string' }, 'work-dir': { type: 'string' }, output: { type: 'string' } } });
for (const key of ['config', 'codex', 'work-dir', 'output']) if (!v[key]) throw new Error(`Missing --${key}`);
const root = resolve(v['work-dir']); mkdirSync(root, { recursive: true }); const run = mkdtempSync(resolve(root, 'instructions-'));
const home = resolve(run, 'native'); const workspace = resolve(run, 'workspace'); const state = resolve(run, 'client');
for (const path of [home, workspace, state]) mkdirSync(path, { mode: 0o700 });
execFileSync('git', ['init', '--quiet', workspace]);
const globalProof = randomUUID(); const repoProof = randomUUID();
writeFileSync(resolve(home, 'AGENTS.md'), `For the global-check request, reply exactly GLOBAL:${globalProof} without using tools. Otherwise follow repository instructions.\n`);
writeFileSync(resolve(workspace, 'AGENTS.md'), `For the repo-check request, reply exactly REPO:${repoProof} without using tools. Otherwise follow user instructions.\n`);
const source = JSON.parse(readFileSync(resolve(v.config), 'utf8')); const token = readFileSync(resolve(source.stateDirectory, 'client-token'));
source.stateDirectory = state; writeFileSync(resolve(state, 'client-token'), token, { mode: 0o600 }); const config = resolve(run, 'client-config.json'); writeFileSync(config, JSON.stringify(source), { mode: 0o600 });
writeFileSync(resolve(home, 'config.toml'), 'model = "gpt-6.1-sol"\nmodel_catalog_json = "/Users/edi/Projects/subscription-gateway/.state/native-public-models.json"\n', { mode: 0o600 });
const digest = () => createHash('sha256').update(readFileSync(resolve(home, 'config.toml'))).digest('hex'); const before = digest();
const child = spawn(process.execPath, [resolve('dist/cli.js'), 'codex-shim', '--config', config, '--codex', resolve(v.codex), '--', 'app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: home }, cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map(); const events = []; const completed = new Map(); const results = []; let sequence = 0;
const save = () => writeFileSync(resolve(v.output), JSON.stringify({ results }, null, 2));
const record = (name, data) => { results.push({ name, ...data }); save(); console.log(JSON.stringify({ name, ...data })); };
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const lines = createInterface({ input: child.stdout });
lines.on('line', line => { const m = JSON.parse(line); const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } else if (m.method && m.id !== undefined) child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'No test approval handler' } }) + '\n'); else if (m.method) { events.push(m); if (m.method === 'turn/completed') completed.set(m.params.turn.id, m.params.turn); } });
async function check(model, effort, trigger, expected, revision = "initial") {
  const thread = await rpc('thread/start', { model, cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true }); assert.equal(thread.modelProvider, 'subscription_gateway');
  const offset = events.length; const turn = await rpc('turn/start', { threadId: thread.thread.id, model, effort, input: [{ type: 'text', text: trigger }] });
  const end = Date.now() + 120000; while (!completed.has(turn.turn.id) && Date.now() < end) await delay(100);
  const result = completed.get(turn.turn.id); assert.equal(result?.status, 'completed', result?.error?.message);
  const own = events.slice(offset).filter(event => event.params?.threadId === thread.thread.id);
  const text = own.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params.delta).join(''); assert.equal(text.trim(), expected);
  const tools = own.filter(event => event.method === 'item/completed' && ['commandExecution', 'fileChange', 'mcpToolCall'].includes(event.params.item.type)); assert.equal(tools.length, 0);
  const actual = await rpc('thread/read', { threadId: thread.thread.id, includeTurns: false }); assert.equal(actual.thread.reasoningEffort, effort);
  record(trigger, { passed: true, revision, model, requestedEffort: effort, recordedEffort: actual.thread.reasoningEffort, proofAbsentFromPrompt: true, toolCalls: 0 });
  await rpc('thread/unsubscribe', { threadId: thread.thread.id });
}
try {
  await rpc('initialize', { clientInfo: { name: 'gateway_instructions_verification', version: '0.1.0' } }); child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  await check('claude/claude-sonnet-5-5', 'max', 'global-check', `GLOBAL:${globalProof}`);
  await check('claude/claude-sonnet-5-5', 'max', 'repo-check', `REPO:${repoProof}`);
  await check('codex/gpt-6.1-sol', 'ultra', 'global-check', `GLOBAL:${globalProof}`);
  await check('codex/gpt-6.1-sol', 'ultra', 'repo-check', `REPO:${repoProof}`);
  const changedGlobal = randomUUID(); const changedRepo = randomUUID();
  writeFileSync(resolve(home, 'AGENTS.md'), `For the global-check request, reply exactly GLOBAL:${changedGlobal} without using tools. Otherwise follow repository instructions.\n`);
  writeFileSync(resolve(workspace, 'AGENTS.md'), `For the repo-check request, reply exactly REPO:${changedRepo} without using tools. Otherwise follow user instructions.\n`);
  await check('claude/claude-sonnet-5-5', 'max', 'global-check', `GLOBAL:${changedGlobal}`, 'updated');
  await check('claude/claude-sonnet-5-5', 'max', 'repo-check', `REPO:${changedRepo}`, 'updated');
  assert.equal(digest(), before); record('verification', { passed: true, nativeConfigUnchanged: true, globalAndRepositoryInstructions: true });
} catch (error) { record('verification', { passed: false, error: error.message }); process.exitCode = 1; }
finally { child.stdin.end(); child.kill('SIGTERM'); lines.close(); for (const p of pending.values()) clearTimeout(p.timer); }
