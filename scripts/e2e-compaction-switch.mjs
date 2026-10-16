import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { selectedTurnScenarios, verifySelectedTurnRuntime } from './e2e-compaction-selected-turn.mjs';

const { values: v } = parseArgs({ options: { gateway: { type: 'string' }, root: { type: 'string' },
  package: { type: 'string' }, transports: { type: 'string', default: 'stdio,unix' }, expect: { type: 'string', default: 'automatic' },
  shared: { type: 'boolean', default: false }, codex: { type: 'string' } } });
for (const key of ['gateway', 'root']) assert.ok(v[key], 'Missing --' + key);
const gateway = resolve(v.gateway), root = resolve(v.root);
const packageDirectory = resolve(v.package || join(gateway, '../..'));
// The version check below needs the pinned SDK. The machine's ChatGPT app moves on to newer SDKs, so it cannot be the default:
// use the signed gateway SDK the package ships. `--expect baseline` reproduces the failure of the stock SDK and needs that
// stock pinned Mach-O passed explicitly; the patched gateway SDK recovers the switch, so that run would not fail as it expects.
const sdk = resolve(v.codex || join(packageDirectory, 'gateway-sdk/gateway-codex'));
assert.ok(['automatic', 'baseline', 'selected-turn'].includes(v.expect));
const transports = v.expect === 'baseline' ? ['stdio'] : v.transports.split(',');
assert.ok(transports.every(value => ['stdio', 'unix'].includes(value)));
const { WebSocket } = createRequire(join(packageDirectory, 'package.json'))('ws');
assert.ok(!root.startsWith(resolve(homedir(), '.codex')));
if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--verify', '--strict', sdk], { stdio: 'pipe' });
const sdkVersion = execFileSync(sdk, ['--version'], { encoding: 'utf8' }).trim();
assert.equal(sdkVersion, 'codex-cli 0.162.0-alpha.17.2');
await mkdir(root, { recursive: true, mode: 0o700 }); const run = await mkdtemp('/tmp/gw-compact-switch-');
const home = join(run, 'native'), work = join(run, 'work');
await mkdir(home, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
const proof = 'PROOF_' + randomUUID(), steerProof = 'STEER_' + randomUUID();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|ANTHROPIC|CLAUDE)/.test(key)));
env.GATEWAY_COMPACTION_SWITCH_KEY = 'fixture-only'; env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
const results = [], requests = [], events = [], children = new Set(), timers = new Set(), clients = new Set();
const pausedResponses = new Set(); let gatewaySdkReceipt;
let phase = 'setup', mode = 'normal', blockedModel = 'mock-large';
const save = async row => {
  results.push(row); await writeFile(join(root, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), sdkVersion, gateway,
    fixture: run, gatewaySdkReceipt, primaryConfigRead: false, primaryConfigWritten: false, nativeAuthCopied: false, paidInferenceRequests: 0,
    results, requests, tokenUsageEvents: events.filter(e => e.method === 'thread/tokenUsage/updated').map(e => e.params),
    notificationMetadata: events.map(e => ({ method: e.method, emittedAtMs: e.emittedAtMs, threadId: e.params?.threadId, turnId: e.params?.turnId ?? e.params?.turn?.id,
      turnStatus: e.params?.turn?.status, itemType: e.params?.item?.type,
      settings: e.method === 'thread/settings/updated' ? e.params.threadSettings : undefined })) }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(row));
};
const upstream = createServer(async (req, res) => {
  // A client that drops the connection mid-request (a stopped turn, a retry) leaves a short or empty body: ignore it
  // instead of letting an unhandled rejection stop the fixture.
  let body; try { const parts = []; for await (const bytes of req) parts.push(bytes); body = JSON.parse(Buffer.concat(parts).toString()); } catch { res.destroy(); return; }
  const request = { phase, model: body.model, inputItems: body.input.length, inputBytes: Buffer.byteLength(JSON.stringify(body.input)),
    containsProof: JSON.stringify(body.input).includes(proof),
    ...(v.expect === 'selected-turn' ? { containsSteer: JSON.stringify(body.input).includes(steerProof) } : {}),
    reasoningEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(body.reasoning?.effort) ? body.reasoning.effort : null,
    outcome: 'completed' }; requests.push(request);
  if (mode === 'blocked-old' && body.model === blockedModel || mode === 'failed-manual') {
    request.outcome = 'usage_limit'; res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'usage_limit', message: 'Fixture provider quota exhausted' } })); return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
  if (mode === 'pause-manual') {
    request.outcome = 'waiting';
    const timer = setTimeout(() => { timers.delete(timer); if (!res.destroyed) res.end(); }, 15000);
    timers.add(timer); res.once('close', () => { clearTimeout(timer); timers.delete(timer); request.outcome = 'interrupted'; }); return;
  }
  if (mode === 'pause-selected-compact') {
    request.outcome = 'waiting';
    const proceed = await new Promise(resolve => {
      const cleanup = () => { clearTimeout(timer); timers.delete(timer); pausedResponses.delete(release); res.off('close', abort); };
      const release = () => { cleanup(); resolve(true); };
      const abort = () => { cleanup(); request.outcome = 'interrupted'; resolve(false); };
      const timer = setTimeout(() => { res.end(); abort(); }, 15000);
      timers.add(timer); pausedResponses.add(release); res.once('close', abort);
    });
    if (!proceed || res.destroyed) return;
    request.outcome = 'completed';
  }
  // Only a seeded turn can create the marker; later responses require its replay.
  const recalled = mode.startsWith('seed-') || request.containsProof ? proof : 'NO_PRIOR_PROOF';
  const text = mode.startsWith('seed-') ? recalled : phase.includes('manual') ? 'COMPACTED ' + recalled : 'TARGET_OK ' + recalled;
  const count = mode === 'seed-high' ? 40000 : mode === 'seed-overflow' ? 60000 : 20;
  res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: text }) + '\n\n');
  res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: count, output_tokens: 10, total_tokens: count + 10 } } }) + '\n\n');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const configPath = join(run, 'gateway.json'), state = join(run, 'state');
await writeFile(configPath, JSON.stringify({ version: 1, port, stateDirectory: state, timeoutMs: 20000,
  providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'GATEWAY_COMPACTION_SWITCH_KEY', baseUrl: 'http://127.0.0.1:' + upstream.address().port,
    models: { 'fixture/large': 'mock-large', 'fixture/small': 'mock-small' }, modelMetadata: {
      'fixture/large': { contextWindow: 50000, reasoningEfforts: ['low', 'max'] }, 'fixture/small': { contextWindow: 30000, reasoningEfforts: ['low', 'high', 'ultra'] } } }] }), { mode: 0o600 });
function command(args, extra = {}) { const child = spawn(gateway.endsWith('.js') ? process.execPath : gateway, gateway.endsWith('.js') ? [gateway, ...args] : args,
  { env, cwd: work, stdio: ['ignore', 'ignore', 'ignore'], detached: true, ...extra }); children.add(child); return child; }
function groupAlive(child) { try { process.kill(-child.pid, 0); return true; } catch (error) {
  if (error.code === 'ESRCH') return false;
  // macOS may deny group probes during shutdown. Process-table membership
  // independently distinguishes a live group from a disappeared one.
  if (error.code === 'EPERM') return execFileSync('ps', ['-axo', 'pgid='], { encoding: 'utf8' }).split('\n').some(row => Number(row.trim()) === child.pid);
  throw error;
} }
async function stop(child) { if (!child) return;
  const done = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'close');
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const grace = Date.now() + 3000; while (groupAlive(child) && Date.now() < grace) await delay(25);
  if (groupAlive(child)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
    const untilTerm = Date.now() + 3000; while (groupAlive(child) && Date.now() < untilTerm) await delay(25);
    if (groupAlive(child)) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH' && groupAlive(child)) throw error; } }
    await until(() => !groupAlive(child), 'Owned process group cleanup', 3000);
  }
  await done; children.delete(child);
}
async function until(check, name, timeout = 15000) { const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); } throw Error(name + ' timed out'); }
const serving = command(['serve', '--config', configPath]); let client, listener, host;
function transportClient(child, websocket) {
  const pending = new Map(); let sequence = 0;
  const send = message => websocket ? websocket.send(JSON.stringify(message)) : child.stdin.write(JSON.stringify(message) + '\n');
  const receive = text => { const message = JSON.parse(text), entry = pending.get(message.id);
    if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error
      ? entry.reject(Object.assign(Error('SDK RPC rejected: ' + entry.method), { code: message.error.code,
        recoveryReason: [['This chat is busy.', 'busy'], ['Compaction recovery failed', 'failed'], ['Compaction recovery was interrupted', 'interrupted'],
          ['The selected model or idle chat state', 'unconfirmed'], ['This shared chat needs', 'shared'], ['The SDK\'s compaction state', 'reconnect'],
          ['Pause or finish the active goal', 'goal']].find(([prefix]) => String(message.error.message).startsWith(prefix))?.[1] })) : entry.resolve(message.result); }
    else if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Fixture has no tool handler' } });
    else if (message.method) events.push(message);
  };
  const lines = websocket ? undefined : createInterface({ input: child.stdout });
  if (websocket) websocket.on('message', data => receive(data.toString())); else lines.on('line', receive);
  const current = { send, rpc: (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 20000);
    pending.set(id, { resolve, reject, timer, method }); send({ id, method, params });
  }), close: async () => {
    websocket?.terminate(); lines?.close(); child.stdin?.end();
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Fixture connection closed')); }
    pending.clear(); await stop(child); clients.delete(current);
  } }; clients.add(current); return current;
}
const rpc = (method, params = {}) => client.rpc(method, params);
async function open(transport) {
  if (transport === 'stdio') client = transportClient(command(['codex-shim', '--config', configPath, '--codex', sdk, '--', 'app-server', '--listen', 'stdio://'],
    { env: { ...env, CODEX_HOME: home }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'] }));
  else {
    const proxyHome = join(run, 'proxy');
    listener = command(['codex-shim', '--ssh', '--ssh-home', proxyHome, '--config', configPath, '--codex', sdk, '--', 'app-server', '--listen', 'unix://'],
      { env: { ...env, CODEX_HOME: home }, cwd: work });
    await until(() => access(join(proxyHome, 'app-server-control/app-server-control.sock')).then(() => true, () => false), 'Private Unix listener');
    const child = spawn(sdk, ['app-server', 'proxy'], { env: { ...env, CODEX_HOME: proxyHome }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'], detached: true }); children.add(child);
    const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const websocket = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => pipe });
    await once(websocket, 'open', { signal: AbortSignal.timeout(15000) }); client = transportClient(child, websocket);
  }
  await rpc('initialize', { clientInfo: { name: 'gateway_compaction_switch_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  client.send({ method: 'initialized', params: {} });
}
async function closeAdapter() { await client?.close(); client = undefined; await stop(listener); listener = undefined; }
async function turn(id, model, text, expected = 'completed', effort = 'low') { const offset = events.length;
  const started = await rpc('turn/start', { threadId: id, model, effort, input: [{ type: 'text', text }] });
  const done = await until(() => events.slice(offset).find(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id), phase);
  assert.equal(done.params.turn.status, expected);
  return { text: events.slice(offset).filter(e => e.method === 'item/agentMessage/delta' && e.params.turnId === started.turn.id).map(e => e.params.delta).join(''), offset,
    turnId: started.turn.id, status: done.params.turn.status, terminal: done.params.turn };
}
async function manual(id, expected) { const offset = events.length; await rpc('thread/compact/start', { threadId: id });
  const started = await until(() => events.slice(offset).find(e => e.method === 'turn/started' && e.params.threadId === id), 'Manual compact turn start');
  const done = await until(() => events.slice(offset).find(e => e.method === 'turn/completed' && e.params.threadId === id && e.params.turn.id === started.params.turn.id), phase);
  assert.equal(done.params.turn.status, expected); return { offset, status: done.params.turn.status };
}
async function transcriptHasProof(id) { const read = await rpc('thread/read', { threadId: id, includeTurns: true });
  assert.ok(JSON.stringify(read.thread.turns).includes(proof), 'SDK transcript lost proof'); return read.thread; }
const start = model => rpc('thread/start', { model, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
function compactItems(offset, threadId) { return events.slice(offset).filter(e => e.params?.threadId === threadId && e.params?.item?.type === 'contextCompaction'); }
function selectedRequests(offset, model, count) { const rows = requests.slice(offset); assert.equal(rows.length, count); assert.ok(rows.every(row => row.model === model)); return rows; }
// A failed provider response is retried by the SDK itself, so the number of attempts is the SDK's choice: assert only that
// there was one and that every one went to the selected model.
function selectedAttempts(offset, model) { const rows = requests.slice(offset); assert.ok(rows.length >= 1); assert.ok(rows.every(row => row.model === model)); return rows; }
async function seedLarge(name) { phase = name; mode = 'seed-high'; const thread = await start('fixture/large');
  assert.ok((await turn(thread.thread.id, 'fixture/large', 'Seed the fixture history.')).text.includes(proof)); return thread.thread.id; }
async function recoveredTurn(id, name, model = 'fixture/small', wireModel = 'mock-small', effort = 'low', oldModel = 'mock-large', wireEffort = effort) {
  phase = name; mode = 'blocked-old'; blockedModel = oldModel; const at = requests.length, offset = events.length;
  const user = await turn(id, model, 'Continue using the selected target fixture.', 'completed', effort); assert.ok(user.text.includes(proof));
  assert.ok(selectedRequests(at, wireModel, 2).every(row => row.containsProof && row.reasoningEffort === wireEffort)); const items = compactItems(offset, id);
  assert.ok(items.some(e => e.method === 'item/started') && items.some(e => e.method === 'item/completed'));
  const compactId = items.find(e => e.method === 'item/started').params.turnId;
  const sequence = events.slice(offset), compactDone = sequence.findIndex(e => e.method === 'turn/completed' && e.params.threadId === id && e.params.turn.id === compactId && e.params.turn.status === 'completed');
  const userStarted = sequence.findIndex(e => e.method === 'turn/started' && e.params.threadId === id && e.params.turn.id === user.turnId);
  assert.ok(compactDone >= 0 && userStarted > compactDone, 'User turn started before recovery completion');
  const transcript = await transcriptHasProof(id); assert.equal(transcript.reasoningEffort, effort);
  await save({ phase, passed: true, targetCompactedBeforeUserTurn: true, noOldProviderCalls: true,
    targetSelectedReasoningEffort: effort, targetWireReasoningEffortOnBothRequests: wireEffort, historyReplayedIntoBothRequests: true, proofPreserved: true });
}
async function automatic(transport) {
  await open(transport); phase = transport + '-native-passthrough';
  const config = await rpc('config/read', { includeLayers: false }); assert.equal(config.config.model, 'native-fixture');
  const native = await start('native-fixture'); assert.notEqual(native.modelProvider, 'subscription_gateway');
  assert.equal(native.model, 'native-fixture'); assert.equal(requests.filter(row => row.phase === phase).length, 0);
  await save({ phase, passed: true, nativeProviderPreserved: true, nativeInferenceRequests: 0 });
  const short = await start('fixture/large'); phase = transport + '-goal-metadata'; const goalsAt = requests.length;
  assert.equal((await rpc('thread/goal/get', { threadId: short.thread.id })).goal, null); assert.equal(requests.length, goalsAt);
  await save({ phase, passed: true, actualSdkGoalNull: true, metadataInferenceRequests: 0 });
  phase = transport + '-short-seed'; mode = 'normal'; await turn(short.thread.id, 'fixture/large', 'Seed short history.');
  for (const [model, old, wire] of [['fixture/small', 'mock-large', 'mock-small'], ['fixture/large', 'mock-small', 'mock-large']]) {
    phase = transport + '-short-switch-' + wire; mode = 'blocked-old'; blockedModel = old; const at = requests.length, offset = events.length;
    await turn(short.thread.id, model, 'Switch within this short fixture history.'); selectedRequests(at, wire, 1);
    assert.equal(compactItems(offset, short.thread.id).length, 0); await save({ phase, passed: true, noUnnecessaryCompaction: true });
  }
  const long = await seedLarge(transport + '-long-seed'); await recoveredTurn(long, transport + '-automatic-downshift');
  phase = transport + '-same-target-follow-up'; mode = 'normal'; const followAt = requests.length, followEvents = events.length;
  assert.ok((await turn(long, 'fixture/small', 'Follow up after target recovery.')).text.includes(proof));
  assert.ok(selectedRequests(followAt, 'mock-small', 1)[0].containsProof);
  assert.equal(compactItems(followEvents, long).length, 0); await save({ phase, passed: true, noRepeatedCompaction: true });
  const cancelled = await seedLarge(transport + '-interrupt-seed');
  for (let attempt = 0; attempt < 2; attempt++) {
    phase = transport + '-interrupt-recovery-' + attempt; mode = 'pause-manual'; const at = requests.length, offset = events.length;
    const pendingTurn = rpc('turn/start', { threadId: cancelled, model: 'fixture/small', effort: 'low', input: [{ type: 'text', text: 'Queued fixture message.' }] })
      .then(value => ({ value }), error => ({ error }));
    const started = await until(() => compactItems(offset, cancelled).find(e => e.method === 'item/started'), 'Recovery compaction item');
    await until(() => requests.length > at, 'Paused target request');
    await rpc('turn/interrupt', { threadId: cancelled, turnId: started.params.turnId });
    const outcome = await pendingTurn; assert.equal(outcome.error?.code, -32001);
    const completed = await until(() => events.slice(offset).find(e => e.method === 'turn/completed' && e.params.turn.id === started.params.turnId), 'Interrupted recovery');
    assert.equal(completed.params.turn.status, 'interrupted'); await until(() => timers.size === 0, 'Provider cleanup');
    selectedRequests(at, 'mock-small', 1); const transcript = await transcriptHasProof(cancelled);
    assert.ok(!JSON.stringify(transcript.turns).includes('Queued fixture message.'));
    await save({ phase, passed: true, pendingTurnErrorCode: -32001, actualSdkInterrupted: true, userMessageNotSubmitted: true, proofPreserved: true, providerTimers: 0 });
  }
  await recoveredTurn(cancelled, transport + '-interruption-retry-recovery');
  const failedOld = await seedLarge(transport + '-failed-old-seed'); phase = transport + '-old-manual-failure'; mode = 'blocked-old'; blockedModel = 'mock-large';
  await manual(failedOld, 'failed'); const oldFailedThread = await transcriptHasProof(failedOld);
  await save({ phase, passed: true, sdkThreadStatus: oldFailedThread.status?.type, currentModel: oldFailedThread.model, proofPreserved: true });
  await recoveredTurn(failedOld, transport + '-failed-old-target-recovery');
  const failedOnly = await start('fixture/small'); phase = transport + '-low-usage-failure-seed'; mode = 'seed-low';
  await turn(failedOnly.thread.id, 'fixture/small', 'Seed low-usage fixture history.');
  phase = transport + '-low-usage-manual-failure'; mode = 'failed-manual'; await manual(failedOnly.thread.id, 'failed');
  await closeAdapter(); await open(transport); await rpc('thread/resume', { threadId: failedOnly.thread.id, model: 'fixture/small', cwd: work });
  await recoveredTurn(failedOnly.thread.id, transport + '-persisted-failure-only-recovery');
  const unavailable = await seedLarge(transport + '-target-failure-seed'); phase = transport + '-selected-target-failure'; mode = 'failed-manual'; const at = requests.length;
  const failure = await rpc('turn/start', { threadId: unavailable, model: 'fixture/small', effort: 'low', input: [{ type: 'text', text: 'Unsubmitted fixture message.' }] })
    .then(value => ({ value }), error => ({ error }));
  assert.equal(failure.error?.code, -32001); selectedAttempts(at, 'mock-small');
  const retained = await transcriptHasProof(unavailable); assert.ok(!JSON.stringify(retained.turns).includes('Unsubmitted fixture message.'));
  await save({ phase, passed: true, selectedModelFailureReturned: true, noOldProviderCalls: true, userMessageNotSubmitted: true, proofPreserved: true });
  await closeAdapter(); await open(transport); await rpc('thread/resume', { threadId: unavailable, model: 'fixture/small', cwd: work });
  await recoveredTurn(unavailable, transport + '-reconnected-target-recovery');
  const rich = await start('fixture/large'); phase = transport + '-rich-max-seed'; mode = 'seed-high'; const richAt = requests.length;
  await turn(rich.thread.id, 'fixture/large', 'Seed Max reasoning fixture history.', 'completed', 'max');
  assert.equal(selectedRequests(richAt, 'mock-large', 1)[0].reasoningEffort, 'max');
  // The SDK resolves Ultra to the highest offered non-Ultra wire effort.
  await recoveredTurn(rich.thread.id, transport + '-max-to-ultra-downshift', 'fixture/small', 'mock-small', 'ultra', 'mock-large', 'high');
  phase = transport + '-ultra-manual-failure'; mode = 'failed-manual'; await manual(rich.thread.id, 'failed');
  await recoveredTurn(rich.thread.id, transport + '-failed-ultra-to-max-target', 'fixture/large', 'mock-large', 'max', 'mock-small');
  const reverse = await start('fixture/small'); phase = transport + '-reverse-seed'; mode = 'seed-high'; await turn(reverse.thread.id, 'fixture/small', 'Seed reverse fixture history.');
  phase = transport + '-long-upshift'; mode = 'blocked-old'; blockedModel = 'mock-small'; const reverseAt = requests.length;
  await turn(reverse.thread.id, 'fixture/large', 'Switch to the larger healthy fixture.'); selectedRequests(reverseAt, 'mock-large', 1);
  await save({ phase, passed: true, noOldProviderCalls: true }); await closeAdapter();
}
async function sharedCheck() {
  host = command(['executor-host', '--config', configPath, '--codex', sdk, '--native-home', home], { cwd: work, stdio: ['ignore', 'pipe', 'ignore'] });
  let ready = false; const lines = createInterface({ input: host.stdout });
  lines.on('line', line => { if (JSON.parse(line).executionHome) ready = true; });
  await until(() => ready, 'Fixture shared execution host'); lines.close(); await open('stdio');
  const short = await start('fixture/large'); phase = 'shared-short-seed'; mode = 'normal'; await turn(short.thread.id, 'fixture/large', 'Seed short shared history.');
  phase = 'shared-short-switch-passthrough'; const at = requests.length, offset = events.length;
  await turn(short.thread.id, 'fixture/small', 'Switch the short shared fixture.'); selectedRequests(at, 'mock-small', 1);
  assert.equal(compactItems(offset, short.thread.id).length, 0); await save({ phase, passed: true, noRecoveryNeededPassthrough: true });
  const long = await seedLarge('shared-long-seed'); phase = 'shared-long-downshift-refused'; mode = 'blocked-old'; blockedModel = 'mock-large'; const before = requests.length;
  const rejected = await rpc('turn/start', { threadId: long, model: 'fixture/small', effort: 'low', input: [{ type: 'text', text: 'Unsubmitted shared message.' }] })
    .then(value => ({ value }), error => ({ error }));
  assert.equal(rejected.error?.code, -32001); assert.equal(requests.length, before); await transcriptHasProof(long);
  await save({ phase, passed: true, unsupportedSharedRecoveryRefused: true, noHiddenCompaction: true, proofPreserved: true });
  await closeAdapter(); await stop(host); host = undefined;
}
const selectedContext = { requests, events, timers, proof, steerProof, rpc, start, turn, until, save,
  open, closeAdapter, transcriptHasProof, compactItems, selectedRequests,
  setPhaseMode: (nextPhase, nextMode, oldModel = 'mock-large') => { phase = nextPhase; mode = nextMode; blockedModel = oldModel; },
  releasePausedResponses: (nextMode = 'normal', oldModel = blockedModel) => { mode = nextMode; blockedModel = oldModel; for (const release of [...pausedResponses]) release(); } };
try {
  if (v.expect === 'selected-turn') gatewaySdkReceipt = await verifySelectedTurnRuntime(packageDirectory);
  await until(() => fetch('http://127.0.0.1:' + port + '/health').then(r => r.ok).catch(() => false), 'Fixture server');
  const cat = JSON.parse(execFileSync(gateway.endsWith('.js') ? process.execPath : gateway, [...(gateway.endsWith('.js') ? [gateway] : []), 'catalog', '--config', configPath], { env, encoding: 'utf8' }));
  await writeFile(join(home, 'models.json'), JSON.stringify({ models: [{ ...cat.models[0], slug: 'native-fixture' }] }), { mode: 0o600 });
  const originalConfig = 'model = "native-fixture"\nmodel_catalog_json = ' + JSON.stringify(join(home, 'models.json')) + '\nweb_search = "disabled"\n[features]\nremote_control = false\n';
  await writeFile(join(home, 'config.toml'), originalConfig, { mode: 0o600 });
  if (v.expect === 'baseline') {
  await open('stdio');
  const large = await start('fixture/large'); mode = 'seed-high'; phase = 'large-seed';
  assert.ok((await turn(large.thread.id, 'fixture/large', 'Seed the fixture history.')).text.includes(proof));
  await save({ phase, passed: true, emittedInputTokens: 40000, largeWindow: 50000, smallWindow: 30000 });
  mode = 'blocked-old'; phase = 'small-ordinary-control'; const small = await start('fixture/small');
  assert.ok((await turn(small.thread.id, 'fixture/small', 'Verify the target fixture endpoint.')).text.includes('TARGET_OK'));
  await save({ phase, passed: true, targetEndpointHealthy: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    phase = 'downshift-old-model-failure-' + attempt; const at = requests.length;
    await turn(large.thread.id, 'fixture/small', 'Switch to the smaller target fixture.', 'failed');
    assert.ok(requests.slice(at).length && requests.slice(at).every(row => row.model === 'mock-large' && row.outcome === 'usage_limit'));
    await transcriptHasProof(large.thread.id); await save({ phase, passed: true, requestedTarget: 'mock-small', actualCompactionModel: 'mock-large', proofPreserved: true });
  }
  phase = 'target-settings';
  await rpc('thread/settings/update', { threadId: large.thread.id, model: 'fixture/small' });
  await until(() => events.findLast(e => e.method === 'thread/settings/updated' && e.params.threadId === large.thread.id)?.params.threadSettings.model === 'fixture/small', 'Target settings notification');
  phase = 'failed-manual-target-compaction'; mode = 'failed-manual'; const failureAt = requests.length;
  await manual(large.thread.id, 'failed'); assert.ok(requests.slice(failureAt).every(row => row.model === 'mock-small'));
  await transcriptHasProof(large.thread.id); await save({ phase, passed: true, currentTargetUsed: true, proofPreserved: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    phase = 'cancel-manual-compaction-' + attempt; mode = 'pause-manual'; const offset = events.length, at = requests.length;
    await rpc('thread/compact/start', { threadId: large.thread.id });
    const started = await until(() => events.slice(offset).find(e => e.method === 'turn/started'), 'Compaction turn start');
    await until(() => requests.length > at, 'Paused target request');
    await rpc('turn/interrupt', { threadId: large.thread.id, turnId: started.params.turn.id });
    const finished = await until(() => events.slice(offset).find(e => e.method === 'turn/completed' && e.params.turn.id === started.params.turn.id), 'Compaction interruption');
    assert.equal(finished.params.turn.status, 'interrupted'); await until(() => timers.size === 0, 'Provider cleanup');
    await transcriptHasProof(large.thread.id); await save({ phase, passed: true, interrupted: true, proofPreserved: true, providerTimers: 0 });
  }
  phase = 'successful-manual-target-compaction'; mode = 'normal'; const compactAt = requests.length;
  await manual(large.thread.id, 'completed'); assert.ok(requests.slice(compactAt).length && requests.slice(compactAt).every(row => row.model === 'mock-small'));
  phase = 'downshift-recovery-target-only'; const recoveryAt = requests.length;
  assert.ok((await turn(large.thread.id, 'fixture/small', 'Continue after target compaction.')).text.includes(proof));
  assert.ok(requests.slice(recoveryAt).every(row => row.model === 'mock-small'));
  await save({ phase, passed: true, noOldProviderCalls: true, proofPreserved: true });
  await rpc('thread/unsubscribe', { threadId: large.thread.id }); await rpc('thread/resume', { threadId: large.thread.id, model: 'fixture/small', cwd: work });
  phase = 'resumed-target-follow-up'; const resumeAt = requests.length; await turn(large.thread.id, 'fixture/small', 'Follow up from saved fixture history.');
  assert.ok(requests.slice(resumeAt).every(row => row.model === 'mock-small')); await transcriptHasProof(large.thread.id);
  await save({ phase, passed: true, noOldProviderCalls: true, proofPreserved: true });
  const reverse = await start('fixture/small'); mode = 'seed-high'; phase = 'reverse-small-seed'; await turn(reverse.thread.id, 'fixture/small', 'Seed reverse fixture history.');
  mode = 'blocked-old'; blockedModel = 'mock-small'; phase = 'upshift-target-only'; const reverseAt = requests.length;
  assert.ok((await turn(reverse.thread.id, 'fixture/large', 'Switch to the larger healthy fixture.')).text.includes(proof));
  assert.ok(requests.slice(reverseAt).every(row => row.model === 'mock-large')); await save({ phase, passed: true, oldSmallProviderNotCalled: true });
  await closeAdapter();
  } else if (v.expect === 'selected-turn') {
    for (const transport of transports) await selectedTurnScenarios({ ...selectedContext, transport });
    if (v.shared) {
      host = command(['executor-host', '--config', configPath, '--codex', sdk, '--native-home', home], { cwd: work, stdio: ['ignore', 'pipe', 'ignore'] });
      let ready = false; const lines = createInterface({ input: host.stdout });
      lines.on('line', line => { if (JSON.parse(line).executionHome) ready = true; });
      await until(() => ready, 'Selected-turn shared execution host'); lines.close();
      await selectedTurnScenarios({ ...selectedContext, transport: 'stdio', label: 'shared-stdio' });
      await stop(host); host = undefined;
    }
  } else {
    for (const transport of transports) await automatic(transport);
    if (v.shared) await sharedCheck();
  }
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), originalConfig);
  assert.equal(await access(join(home, 'auth.json')).then(() => true, () => false), false);
  await save({ phase: 'verification', passed: true, expectation: v.expect, transports, actualSignedSdk: true, primaryConfigRead: false, nativeConfigIsolated: true,
    nativeAuthCopied: false, paidInferenceRequests: 0, renderedDesktopUiTested: false, builtInCloudTransportTested: false,
    ...(v.expect === 'selected-turn' ? { verifiedGatewaySdk: true, sameUserTurnCompaction: true } : {}) });
} catch (error) { await save({ phase: 'verification', passed: false, failedDuring: phase, errorClass: error?.name || 'Error', code: error?.code,
  recoveryReason: error?.recoveryReason, check: error?.message?.startsWith('Expected') ? 'Assertion failed' : error?.message }); process.exitCode = 1;
} finally {
  await Promise.allSettled([...clients].map(client => client.close()));
  const cleanup = await Promise.allSettled([...children].map(stop)); for (const timer of timers) clearTimeout(timer); timers.clear();
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  const clean = cleanup.every(row => row.status === 'fulfilled') && children.size === 0 && pausedResponses.size === 0;
  await save({ phase: 'fixture-cleanup', passed: clean, ownedProcessGroups: children.size, providerTimers: timers.size,
    ...(v.expect === 'selected-turn' ? { pausedProviderResponses: pausedResponses.size } : {}) });
  if (!clean) process.exitCode = 1;
}
