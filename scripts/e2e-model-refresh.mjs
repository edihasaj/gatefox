import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const { values: v } = parseArgs({ options: { config: { type: 'string' }, codex: { type: 'string' }, 'native-home': { type: 'string' }, 'work-dir': { type: 'string' }, output: { type: 'string' }, model: { type: 'string', default: 'claude/claude-sonnet-5-5' }, 'new-model': { type: 'string', default: 'claude/catalog-refresh-test' } } });
for (const key of ['config', 'codex', 'native-home', 'work-dir', 'output']) if (!v[key]) throw new Error(`Missing --${key}`);
const work = resolve(v['work-dir']); mkdirSync(work, { recursive: true });
const proof = randomUUID(); const sample = resolve(work, 'sample.txt'); writeFileSync(sample, `proof=${proof}\n`);
writeFileSync(resolve(work, 'AGENTS.md'), 'Use only this test fixture. No network actions, delegation, or goals. Read files with supplied tools.\n');
execFileSync('git', ['init', '--quiet', work]);
const configFile = resolve(v['native-home'], 'config.toml'); const digest = () => createHash('sha256').update(readFileSync(configFile)).digest('hex'); const before = digest();
const child = spawn(process.execPath, [resolve('dist/cli.js'), 'codex-shim', '--config', resolve(v.config), '--codex', resolve(v.codex), '--', 'app-server', '--listen', 'stdio://'], { env: { ...process.env, CODEX_HOME: resolve(v['native-home']) }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'] });
const pending = new Map(); const events = []; const final = new Map(); let sequence = 0; const results = [];
const record = (name, data) => { const row = { name, ...data }; results.push(row); writeFileSync(resolve(v.output), JSON.stringify({ results }, null, 2)); console.log(JSON.stringify(row)); };
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 120000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  const m = JSON.parse(line); const p = pending.get(m.id);
  if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
  else if (m.method && m.id !== undefined) child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'No test approval handler' } }) + '\n');
  else if (m.method) { events.push(m); if (m.method === 'turn/completed') final.set(m.params.turn.id, m.params.turn); }
});
async function until(check, label, timeout = 120000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100); } throw new Error(`${label} timed out`); }
const pids = () => execFileSync('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(m => m && +m[2] === child.pid && m[3].endsWith('/codex')).map(m => +m[1]);
async function turn(threadId, text, model, effort = 'low') {
  const offset = events.length; const started = await rpc('turn/start', { threadId, model, effort, input: [{ type: 'text', text }] });
  const completed = await until(() => final.get(started.turn.id), 'turn completion'); assert.equal(completed.status, 'completed', completed.error?.message);
  const own = events.slice(offset).filter(event => event.params?.threadId === threadId);
  return { text: own.filter(event => event.method === 'item/agentMessage/delta').map(event => event.params.delta).join(''), events: own };
}
try {
  await rpc('initialize', { clientInfo: { name: 'gateway_refresh_verification', version: '0.1.0' } }); child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const nativePids = pids(); assert.equal(nativePids.length, 1);
  const old = await rpc('thread/start', { model: v.model, cwd: work, approvalPolicy: 'never', sandbox: 'workspace-write' }); assert.ok(['openai', 'gatefox', 'subscription_gateway'].includes(old.modelProvider));
  const read = await turn(old.thread.id, `Read ${sample} with a tool and give its proof value.`, v.model); assert.ok(read.text.includes(proof)); assert.ok(read.events.some(event => event.method === 'item/completed' && event.params.item.type === 'commandExecution'));
  const oldPids = pids(); assert.equal(oldPids.length, 2);
  const offset = events.length; const active = await rpc('turn/start', { threadId: old.thread.id, model: v.model, effort: 'low', input: [{ type: 'text', text: 'Use exec_command to run sleep 30 with yield_time_ms 30000. Wait for its result, then reply exactly: old-done.' }] });
  await until(() => events.slice(offset).some(event => event.method === 'item/started' && event.params.item.type === 'commandExecution'), 'old command start'); assert.ok(!final.has(active.turn.id));
  record('await-catalog-addition', { oldTurnActive: true, nativePids, oldPids });
  await until(async () => (await rpc('model/list')).data.some(model => model.model === v['new-model']), 'catalog addition', 60000);
  assert.ok(!final.has(active.turn.id), 'Old stream ended before the live addition check');
  const fresh = await rpc('thread/start', { model: v['new-model'], cwd: work, approvalPolicy: 'never', sandbox: 'read-only' }); assert.ok(['openai', 'gatefox', 'subscription_gateway'].includes(fresh.modelProvider));
  const newPids = pids(); assert.equal(newPids.length, 3); assert.ok(oldPids.every(pid => newPids.includes(pid)));
  const answer = await turn(fresh.thread.id, 'Reply exactly: new-catalog-ok. Do not use tools.', v['new-model']); assert.equal(answer.text.trim(), 'new-catalog-ok');
  const windows = answer.events.filter(event => event.method === 'thread/tokenUsage/updated').map(event => event.params.tokenUsage.modelContextWindow);
  assert.ok(windows.some(window => window === 196608 || window === 176947), `New metadata not applied: ${windows.join(',')}`);
  record('new-model-live', { passed: true, oldEnginesPreserved: true, nativeEnginePreserved: true, newPids, modelContextWindows: windows, temporaryAliasOfExistingSonnet: true });
  const at = Date.now(); await rpc('turn/interrupt', { threadId: old.thread.id, turnId: active.turn.id }); const interrupted = await until(() => final.get(active.turn.id), 'old cancellation'); assert.equal(interrupted.status, 'interrupted');
  record('old-tool-turn-cancelled', { passed: true, acknowledgementMs: Date.now() - at });
  const listed = await rpc('thread/list', { modelProviders: [old.modelProvider], limit: 100 }); assert.ok(listed.data.some(thread => thread.id === old.thread.id));
  await rpc('thread/unsubscribe', { threadId: old.thread.id }); await delay(200);
  const resumed = await rpc('thread/resume', { threadId: old.thread.id, model: v['new-model'], cwd: work, approvalPolicy: 'never', sandbox: 'read-only' }); assert.equal(resumed.modelProvider, old.modelProvider);
  const follow = await turn(old.thread.id, 'Give only the proof value you read earlier. Do not use tools.', v['new-model']); assert.ok(follow.text.includes(proof));
  assert.equal(digest(), before); record('saved-history-and-config', { passed: true, sharedThreadList: true, nativeConfigUnchanged: true, proofRetained: true });
  const reasonOffset = events.length;
  const thought = await rpc('turn/start', { threadId: old.thread.id, model: 'codex/gpt-6.1-sol', effort: 'high', input: [{ type: 'text', text: 'Find all positive integers n such that n squared plus 1 divides n factorial. Think carefully about necessity and sufficiency. Do not use tools.' }] });
  await until(() => events.slice(reasonOffset).some(event => /reasoning.*delta/i.test(event.method) && event.params.delta?.length), 'Codex public reasoning');
  await rpc('turn/interrupt', { threadId: old.thread.id, turnId: thought.turn.id });
  assert.equal((await until(() => final.get(thought.turn.id), 'reasoning cancellation')).status, 'interrupted');
  const reasoning = events.slice(reasonOffset).filter(event => /reasoning.*delta/i.test(event.method));
  record('codex-reasoning', { passed: true, deltaCount: reasoning.length, characterCount: reasoning.reduce((sum,event)=>sum+(event.params.delta?.length||0),0), cancelledAfterPublicReasoning: true });
  record('verification', { passed: true });
} catch (error) { record('verification', { passed: false, error: error.message }); process.exitCode = 1; }
finally { child.stdin.end(); child.kill('SIGTERM'); lines.close(); for (const entry of pending.values()) clearTimeout(entry.timer); }
