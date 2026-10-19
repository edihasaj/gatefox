import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const { values } = parseArgs({ options: { config: { type: 'string' }, model: { type: 'string' }, 'switch-model': { type: 'string' }, codex: { type: 'string' }, 'work-dir': { type: 'string' }, output: { type: 'string' }, shim: { type: 'boolean' }, workspace: { type: 'string' }, 'skip-native-inference': { type: 'boolean' } } });
if (!values.config || !values.model || !values['work-dir'] || !values.output) throw new Error('Required: --config --model --work-dir --output');
const directory = resolve(values['work-dir']); const fixture = resolve(directory, 'fixture'); const home = resolve(directory, 'codex-home');
mkdirSync(fixture, { recursive: true }); mkdirSync(home, { recursive: true });
if (!values.workspace) execFileSync('git', ['init', '--quiet', fixture]);
const workspace = values.workspace ? resolve(values.workspace) : fixture;
const sample = resolve(fixture, 'sample.txt');
const proof = randomUUID();
writeFileSync(resolve(fixture, 'sample.txt'), `proof=${proof}\nquantity=7\nstatus=pending\n`);
writeFileSync(resolve(fixture, 'AGENTS.md'), 'Work only in this fixture. No network, delegation, or goals. Use supplied tools for file reads and edits. Never claim a tool action succeeded without its result.\n');
const cli = resolve('dist/cli.js');
if (!values.shim) {
  const configuration = execFileSync(process.execPath, [cli, 'codex-config', '--config', resolve(values.config), '--model', values.model], { encoding: 'utf8' });
  writeFileSync(resolve(home, 'config.toml'), configuration); // Thread policy is explicit below.
}
if (values.shim && !values.codex) throw new Error('--shim requires an explicit --codex executable');
const nativeConfig = resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'config.toml');
const configDigest = () => createHash('sha256').update(readFileSync(nativeConfig)).digest('hex');
const beforeConfig = values.shim ? configDigest() : null;
const results = []; const output = resolve(values.output);
const save = () => writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), model: values.model, fixture, results }, null, 2));
const record = (name, data) => { results.push({ name, ...data }); save(); console.log(JSON.stringify(name === 'native-model-list' ? { name, passed: data.passed, count: data.models.length } : { name, ...data })); };
const child = values.shim
  ? spawn(process.execPath, [cli, 'codex-shim', '--config', resolve(values.config), '--codex', resolve(values.codex), '--', 'app-server', '--listen', 'stdio://'], { cwd: workspace, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(values.codex || 'codex', ['app-server', '--listen', 'stdio://'], { cwd: workspace, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', data => appendFileSync(resolve(directory, 'codex.stderr'), data));
const notifications = []; const pending = new Map(); const completed = new Map(); const waiters = new Map();
let sequence = 0; let interruptOnDelta;
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 120000);
    pending.set(id, { resolve, reject, timeout }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const lines = createInterface({ input: child.stdout });
lines.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  appendFileSync(resolve(directory, 'rpc.jsonl'), JSON.stringify({ id: message.id, method: message.method, errorCode: message.error?.code }) + '\n');
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timeout);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
  } else if (message.id !== undefined && message.method) {
    child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unsupported test-client request' } }) + '\n');
  } else if (message.method) {
    notifications.push({ at: Date.now(), ...message });
    if (interruptOnDelta && (interruptOnDelta.onReasoning ? /reasoning.*delta/i.test(message.method) : message.method === 'item/agentMessage/delta')) {
      const context = interruptOnDelta; interruptOnDelta = undefined;
      context.sentAt = Date.now();
      request('turn/interrupt', { threadId: context.threadId, turnId: context.turnId }).then(() => { context.ack = true; }, error => { context.error = error.message; });
    }
    if (message.method === 'turn/completed') {
      const turn = message.params.turn; completed.set(turn.id, turn); waiters.get(turn.id)?.(turn);
    }
  }
});
async function turn(threadId, prompt, name, { cancel = false, effort, model = values.model } = {}) {
  const offset = notifications.length; const start = Date.now();
  const started = await request('turn/start', { threadId, model, input: [{ type: 'text', text: prompt }], ...(effort ? { effort } : {}) });
  const id = started.turn.id; const context = { threadId, turnId: id, ack: false, onReasoning: cancel === 'reasoning' };
  if (cancel) interruptOnDelta = context;
  const final = completed.get(id) || await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { request('turn/interrupt', { threadId, turnId: id }).catch(() => {}); reject(new Error(`${name} timeout`)); }, 120000);
    waiters.set(id, result => { clearTimeout(timeout); resolve(result); });
  });
  const events = notifications.slice(offset);
  const deltas = events.filter(event => event.method === 'item/agentMessage/delta');
  const items = events.filter(event => event.method === 'item/completed').map(event => event.params.item);
  const text = deltas.map(event => event.params.delta).join('');
  const reasoning = events.filter(event => /reasoning.*delta/i.test(event.method));
  record(name, { status: final.status, error: final.error, durationMs: Date.now() - start,
    firstDeltaMs: deltas.length ? deltas[0].at - start : null, deltaCount: deltas.length,
    reasoningDeltaCount: reasoning.length, reasoningCharacterCount: reasoning.reduce((count, event) => count + (event.params?.delta?.length || 0), 0), text, toolTypes: items.filter(item => ['commandExecution', 'fileChange'].includes(item.type)).map(item => item.type),
    ...(cancel ? { interruptAck: context.ack, interruptMs: context.sentAt ? Date.now() - context.sentAt : null } : {}),
  });
  return { final, items, text, deltas, reasoning, context };
}
try {
  await request('initialize', { clientInfo: { name: 'edi_gateway_e2e', title: 'Gateway verification', version: '0.1.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const catalog = await request('model/list', {});
  const listed = catalog.data || catalog.models || [];
  assert.ok(listed.some(model => model.model === values.model || model.id === values.model));
  record('native-model-list', { passed: true, models: listed.map(model => ({ model: model.model, displayName: model.displayName, reasoning: model.supportedReasoningEfforts })) });
  if (values.shim) {
    const config = await request('config/read', {});
    assert.ok(!config.config.model_provider || config.config.model_provider === 'openai');
    record('native-provider-preserved', { passed: true, provider: config.config.model_provider || 'openai' });
    const nativeModel = listed.find(item => !item.model.startsWith('codex/') && !item.model.startsWith('claude'));
    assert.ok(nativeModel);
    if (values['skip-native-inference']) record('native-inference', { verified: false, reason: 'Explicitly omitted on an isolated test home without a native subscription login' });
    else {
      const native = await request('thread/start', { model: nativeModel.model, cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
      assert.equal(native.modelProvider, 'openai');
      const smoke = await turn(native.thread.id, 'Reply exactly: native-shim-ok. Do not use tools.', 'native-shim-request', { effort: 'low', model: nativeModel.model });
      assert.equal(smoke.final.status, 'completed'); assert.equal(smoke.text.trim(), 'native-shim-ok');
    }
  }
  const started = await request('thread/start', { model: values.model, modelProvider: values.shim ? 'openai' : 'subscription_gateway', cwd: workspace,
    developerInstructions: `Work only with the fixture file ${sample}. Do not modify other files, run network actions, delegate or create goals.`,
    approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: true });
  // 0.4.6 records new gateway chats as openai by default (docs/harness-identity.md).
  assert.ok(['openai', 'subscription_gateway'].includes(started.modelProvider));
  const id = started.thread.id;
  const streamed = await turn(id, 'Count from one to twenty, one number per line. Do not use tools.', 'streaming');
  assert.equal(streamed.final.status, 'completed'); assert.ok(streamed.deltas.length >= 2);
  const read = await turn(id, `Read ${sample} using a tool and return its proof value. Do not guess.`, 'file-read');
  assert.equal(read.final.status, 'completed'); assert.ok(read.text.includes(proof)); assert.ok(read.items.some(item => item.type === 'commandExecution' && item.exitCode === 0 && item.aggregatedOutput.includes(proof)));
  const edit = await turn(id, `Use apply_patch to change quantity=7 to quantity=11 in ${sample}, preserving all other lines. Verify with a tool.`, 'freeform-file-edit');
  assert.equal(edit.final.status, 'completed'); assert.ok(edit.items.some(item => item.type === 'fileChange' && item.status === 'completed'));
  assert.equal(readFileSync(resolve(fixture, 'sample.txt'), 'utf8'), `proof=${proof}\nquantity=11\nstatus=pending\n`);
  const follow = await turn(id, 'What proof value did you read earlier? Reply only with that value; do not use tools.', 'follow-up');
  assert.equal(follow.final.status, 'completed'); assert.ok(follow.text.includes(proof)); assert.equal(follow.items.some(item => item.type === 'commandExecution'), false);
  const supportedEfforts = listed.find(model => model.model === values.model || model.id === values.model)?.supportedReasoningEfforts || [];
  const supportsReasoning = supportedEfforts.some(level => !['none'].includes(level.reasoningEffort));
  let reasoningExposed = false;
  if (supportsReasoning) {
    const thought = await turn(id, 'Work out 1234567 squared carefully, then give the number and a short check. Do not use tools.', 'reasoning', { effort: 'high' });
    assert.equal(thought.final.status, 'completed'); reasoningExposed = thought.reasoning.length > 0;
  } else record('reasoning', { verified: false, supported: false, reason: 'The model catalog exposes no reasoning effort' });
  if (supportsReasoning && !reasoningExposed) {
    const probe = await turn(id, 'Find all positive integers n such that n squared plus 1 divides n factorial. Think carefully about necessity and sufficiency. Do not use tools.', 'reasoning-stream-and-interrupt', { effort: 'high', cancel: 'reasoning' });
    assert.equal(probe.final.status, 'interrupted'); assert.ok(probe.reasoning.length > 0);
    reasoningExposed = true;
    await delay(1500);
  }
  if (values['switch-model']) {
    const switched = await turn(id, 'Give the proof value you read earlier, then check 1234567 squared carefully. Do not use tools.', 'switch-provider', { model: values['switch-model'], effort: 'high' });
    assert.equal(switched.final.status, 'completed'); assert.ok(switched.text.includes(proof));
    const returned = await turn(id, 'Return only the proof value you read earlier. Do not use tools.', 'switch-back');
    assert.equal(returned.final.status, 'completed'); assert.ok(returned.text.includes(proof));
  }
  const cancelled = await turn(id, 'Write 300 numbered paragraphs about trees. Begin immediately and continue through all 300. Do not use tools.', 'cancellation', { cancel: true });
  assert.equal(cancelled.final.status, 'interrupted');
  await delay(1500);
  const config = JSON.parse(readFileSync(resolve(values.config), 'utf8'));
  const health = await (await fetch(`http://127.0.0.1:${config.port}/health`)).json();
  assert.equal(health.active, 0); record('cancelled-worker-cleanup', { passed: true, active: health.active });
  const recovered = await turn(id, 'Reply exactly: recovery-ok. Do not use tools.', 'recovery');
  assert.equal(recovered.final.status, 'completed'); assert.match(recovered.text.trim(), /^recovery-ok[.!]?$/);
  if (values.shim) { assert.equal(configDigest(), beforeConfig); record('native-config-unchanged', { passed: true }); }
  record('verification', { passed: true, reasoningExposed });
} catch (error) { record('verification', { passed: false, error: error.message }); process.exitCode = 1; }
finally { child.stdin.end(); child.kill('SIGTERM'); lines.close(); for (const entry of pending.values()) clearTimeout(entry.timeout); }
