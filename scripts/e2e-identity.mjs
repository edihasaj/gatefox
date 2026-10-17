// End-to-end check of the native chat identity (docs/harness-identity.md) with the real pinned gateway SDK and a mock upstream.
// It proves that a new gateway chat is recorded as `openai` in its rollout and SQLite row, is in the registry when its start
// returns, routes to the gateway on resume from a new connection, compacts locally on the selected model, makes no request to
// the ChatGPT backend with the gateway token, and is listed by a default-provider thread/list; and that a legacy chat is listed
// through the router and keeps `subscription_gateway` when resumed. No paid inference: the only upstream is the mock below.
//
//   node scripts/e2e-identity.mjs --package <dir with dist/, package.json, node_modules and gateway-sdk/> --root <results dir>
//
// Every child runs under a private HOME and CODEX_HOME in a /tmp folder that a passing run removes.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const { values: v } = parseArgs({ options: { package: { type: 'string' }, root: { type: 'string' }, 'keep-fixture': { type: 'boolean', default: false } } });
for (const key of ['package', 'root']) assert.ok(v[key], 'Missing --' + key);
const pkg = resolve(v.package), root = resolve(v.root), gateway = join(pkg, 'dist/cli.js'), sdk = join(pkg, 'gateway-sdk/gateway-codex');
const { gatewaySdkRuntime } = await import(pathToFileURL(join(pkg, 'dist/gateway-sdk-runtime.js')));
const runtime = await gatewaySdkRuntime(pkg);
assert.equal(runtime?.executorIdentity, true, 'The package must ship a gateway SDK built with patch v2');
assert.equal(execFileSync(sdk, ['--version'], { encoding: 'utf8' }).trim(), 'codex-cli 0.162.0-alpha.17.2');
const { readTelemetry } = await import(pathToFileURL(join(pkg, 'dist/telemetry.js')));
await mkdir(root, { recursive: true, mode: 0o700 }); const run = await mkdtemp('/tmp/gw-identity-');
const home = join(run, 'native'), work = join(run, 'work'), isolatedHome = join(run, 'home'), state = join(run, 'state');
for (const path of [home, work, isolatedHome]) await mkdir(path, { mode: 0o700 });
const proof = 'PROOF_' + randomUUID();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|HARNESS|ANTHROPIC|CLAUDE)/.test(key)));
env.HOME = isolatedHome; env.GATEWAY_IDENTITY_KEY = 'fixture-only'; env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
const results = [], requests = [], sink = [], events = [], children = new Set();
let phase = 'setup', mode = 'normal', blockedModel = 'mock-large', token;
const save = async row => { results.push(row); console.log(JSON.stringify(row));
  await writeFile(join(root, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), fixture: run, results, requests, chatgptBackendRequests: sink, paidInferenceRequests: 0 }, null, 2) + '\n', { mode: 0o600 }); };
const until = async (check, name, timeout = 20000) => { const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); } throw Error(name + ' timed out'); };

// The mock upstream speaks Responses SSE. `blocked-old` refuses the previous model, so only selected-model compaction can pass.
const upstream = createServer(async (req, res) => {
  const parts = []; for await (const bytes of req) parts.push(bytes);
  const body = JSON.parse(Buffer.concat(parts).toString()); const text = JSON.stringify(body.input);
  const row = { phase, model: body.model, containsProof: text.includes(proof), compaction: text.includes('CONTEXT CHECKPOINT COMPACTION'), outcome: 'completed' };
  requests.push(row);
  if (mode === 'blocked-old' && body.model === blockedModel) { row.outcome = 'usage_limit'; res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'usage_limit', message: 'Fixture provider quota exhausted' } })); return; }
  const answer = mode === 'seed-high' || row.containsProof || row.compaction ? proof : 'NO_PRIOR_PROOF';
  const usage = mode === 'seed-high' ? 40000 : 20;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: (row.compaction ? 'SUMMARY ' : 'OK ') + answer }) + '\n\n');
  res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: usage, output_tokens: 10, total_tokens: usage + 10 } } }) + '\n\n');
});
// Stands in for the ChatGPT backend (`chatgpt_base_url`): any request there is recorded, with whether it carried the gateway token.
const backend = createServer((req, res) => { sink.push({ phase, method: req.method, path: new URL(req.url, 'http://x').pathname,
  gatewayToken: !!token && req.headers.authorization === 'Bearer ' + token }); req.resume(); res.writeHead(404).end(); });
await Promise.all([upstream, backend].map(server => new Promise(done => server.listen(0, '127.0.0.1', done))));
const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
const port = reservation.address().port; await new Promise(done => reservation.close(done));
const configPath = join(run, 'gateway.json');
const writeConfig = extra => writeFile(configPath, JSON.stringify({ version: 1, port, stateDirectory: state, timeoutMs: 20000, ...extra,
  providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'GATEWAY_IDENTITY_KEY', baseUrl: 'http://127.0.0.1:' + upstream.address().port,
    models: { 'fixture/large': 'mock-large', 'fixture/small': 'mock-small' }, modelMetadata: {
      'fixture/large': { contextWindow: 50000, reasoningEfforts: ['low', 'high'] }, 'fixture/small': { contextWindow: 30000, reasoningEfforts: ['low', 'high'] } } }] }), { mode: 0o600 });

function command(file, args, extra = {}) { const child = spawn(file, args, { env, cwd: work, stdio: ['ignore', 'ignore', 'ignore'], detached: true, ...extra }); children.add(child); return child; }
const groupAlive = child => { try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function stop(child) { if (!child) return;
  const done = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'close');
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  const grace = Date.now() + 5000; while (groupAlive(child) && Date.now() < grace) await delay(25);
  if (groupAlive(child)) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  await done; children.delete(child);
}
/** A JSON-RPC client over a child's stdio, as the desktop or the phone's engine connection uses it. */
function client(child) {
  const pending = new Map(); let sequence = 0;
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line), entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Object.assign(Error(entry.method + ': ' + message.error.message), { code: message.error.code })) : entry.resolve(message.result); }
    else if (message.method && message.id !== undefined) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No approvals in this fixture' } }) + '\n');
    else if (message.method) events.push(message); });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence;
    pending.set(id, { resolve, reject, method, timer: setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 30000) });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
  return { rpc, init: async () => { await rpc('initialize', { clientInfo: { name: 'gateway_identity_e2e', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n'); }, close: () => { child.stdin.end(); return stop(child); } };
}
async function adapter() { const c = client(command(process.execPath, [gateway, 'codex-shim', '--config', configPath, '--codex', sdk, '--', 'app-server', '--listen', 'stdio://'],
  { env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] })); await c.init(); return c; }
async function turn(c, threadId, model, text, expected = 'completed') { const offset = events.length;
  const started = await c.rpc('turn/start', { threadId, model, effort: 'low', input: [{ type: 'text', text }] });
  const done = await until(() => events.slice(offset).find(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id), phase + ' turn');
  assert.equal(done.params.turn.status, expected, phase + ': ' + JSON.stringify(done.params.turn.error ?? null));
  return { offset, turnId: started.turn.id, text: events.slice(offset).filter(e => e.method === 'item/agentMessage/delta' && e.params.turnId === started.turn.id).map(e => e.params.delta).join('') };
}
const start = (c, model) => c.rpc('thread/start', { model, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
const registry = async () => { const folder = join(state, 'gateway-chats'); const name = (await readdir(folder)).find(file => /^[0-9a-f]{16}\.json$/.test(file));
  return JSON.parse(await readFile(join(folder, name), 'utf8')).chats; };
const database = async () => join(home, (await readdir(home)).find(name => /^state_\d+\.sqlite$/.test(name)));
const savedProvider = async id => execFileSync('sqlite3', ['-readonly', await database(), `select model_provider from threads where id = '${id.replace(/'/g, '')}'`], { encoding: 'utf8' }).trim();
const rolloutProvider = async path => JSON.parse((await readFile(path, 'utf8')).split('\n')[0]).payload.model_provider;
const processes = () => execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').map(line => line.trim()).filter(line => line.includes(sdk) && line.includes('app-server'))
  .map(line => ({ pid: Number(line.split(' ')[0]), command: line }));
const environmentOf = pid => execFileSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });

let serving, first, second;
try {
  await writeConfig({ chatIdentity: 'legacy' });
  serving = command(process.execPath, [gateway, 'serve', '--config', configPath]);
  await until(() => fetch('http://127.0.0.1:' + port + '/health').then(r => r.ok).catch(() => false), 'Fixture gateway');
  token = (await readFile(join(state, 'client-token'), 'utf8')).trim();
  const catalog = JSON.parse(execFileSync(process.execPath, [gateway, 'catalog', '--config', configPath], { env, encoding: 'utf8' }));
  await writeFile(join(home, 'models.json'), JSON.stringify({ models: [{ ...catalog.models[0], slug: 'native-fixture' }] }), { mode: 0o600 });
  // The native settings are copied into executor homes, so an analytics opt-in and a ChatGPT backend there reach executors too.
  const nativeConfig = 'model = "native-fixture"\nmodel_catalog_json = ' + JSON.stringify(join(home, 'models.json')) + '\nweb_search = "disabled"\n' +
    'chatgpt_base_url = "http://127.0.0.1:' + backend.address().port + '/backend-api/"\n[analytics]\nenabled = true\n[features]\nremote_control = false\n';
  await writeFile(join(home, 'config.toml'), nativeConfig, { mode: 0o600 });

  phase = 'legacy-chat'; first = await adapter();
  const legacy = await start(first, 'fixture/large'); assert.equal(legacy.modelProvider, 'subscription_gateway');
  assert.ok((await turn(first, legacy.thread.id, 'fixture/large', 'Start the legacy fixture chat.')).text.includes('OK'));
  await first.close(); first = undefined;
  await save({ phase, passed: true, chatIdentity: 'legacy', recordedProvider: 'subscription_gateway' });

  await writeConfig({});
  phase = 'new-chat'; first = await adapter(); mode = 'seed-high';
  const chat = await start(first, 'fixture/large'); const id = chat.thread.id;
  assert.equal(chat.modelProvider, 'openai');
  assert.ok((await registry()).some(entry => entry.id === id && entry.origin === 'start'), 'The new chat is in the registry when its start returns');
  assert.ok((await turn(first, id, 'fixture/large', 'Seed the native identity fixture history.')).text.includes(proof));
  const read = await first.rpc('thread/read', { threadId: id, includeTurns: false });
  assert.equal(await rolloutProvider(read.thread.path), 'openai'); assert.equal(await savedProvider(id), 'openai');
  const executor = processes().find(row => row.command.includes('model_provider="openai"'));
  assert.ok(executor, 'A gateway executor runs with the native identity');
  for (const setting of ['analytics.enabled=false', 'model_providers.subscription_gateway.supports_websockets=false', 'model_providers.subscription_gateway.request_max_retries=2',
    'model_providers.subscription_gateway.stream_idle_timeout_ms=90000', `openai_base_url="http://127.0.0.1:${port}/v1"`]) assert.ok(executor.command.includes(setting), setting);
  assert.match(environmentOf(executor.pid), /HARNESS_GATEWAY_EXECUTOR=1/);
  const native = processes().filter(row => !row.command.includes('model_provider='));
  assert.ok(native.length >= 1 && native.every(row => !/HARNESS_GATEWAY_EXECUTOR/.test(environmentOf(row.pid))), 'Native engines are never marked');
  await save({ phase, passed: true, threadProvider: 'openai', rolloutProvider: 'openai', sqliteProvider: 'openai', registryOrigin: 'start',
    executorAnalyticsOff: true, executorMarked: true, nativeUnmarked: true, websocketOff: true, idleTimeoutMs: 90000, requestRetries: 2 });

  phase = 'selected-model-compaction'; mode = 'blocked-old'; blockedModel = 'mock-large'; const at = requests.length;
  const compacted = await turn(first, id, 'fixture/small', 'Continue on the smaller selected model.');
  assert.ok(compacted.text.includes(proof)); const rows = requests.slice(at);
  assert.equal(rows.length, 2, 'One local compaction request and one answer'); assert.ok(rows.every(row => row.model === 'mock-small' && row.containsProof));
  assert.ok(rows[0].compaction && !rows[1].compaction, 'The SDK compacted with its own prompt through /v1/responses');
  const items = events.slice(compacted.offset).filter(e => e.params?.threadId === id && e.params?.item?.type === 'contextCompaction');
  assert.ok(items.some(e => e.method === 'item/completed') && items.every(e => e.params.turnId === compacted.turnId), 'Compaction inside the selected user turn');
  await save({ phase, passed: true, compactedLocally: true, compactionModel: 'mock-small', previousModelCalls: 0 });

  phase = 'manual-compaction'; mode = 'normal'; const manualAt = requests.length, manualOffset = events.length;
  await first.rpc('thread/compact/start', { threadId: id });
  const manual = await until(() => events.slice(manualOffset).find(e => e.method === 'turn/completed' && e.params.threadId === id), 'Manual compaction');
  assert.equal(manual.params.turn.status, 'completed'); assert.ok(requests.slice(manualAt).some(row => row.compaction && row.model === 'mock-small'));
  await save({ phase, passed: true, compactedLocally: true });
  await first.close(); first = undefined;

  phase = 'resume-new-connection'; second = await adapter(); mode = 'normal';
  const telemetryFrom = Date.now();
  const resumed = await second.rpc('thread/resume', { threadId: id, model: 'fixture/small', cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(resumed.modelProvider, 'openai'); const resumeAt = requests.length;
  assert.ok((await turn(second, id, 'fixture/small', 'Continue after reconnecting.')).text.includes(proof));
  assert.ok(requests.slice(resumeAt).length >= 1 && requests.slice(resumeAt).every(row => row.model === 'mock-small' && row.containsProof), 'Served by the gateway');
  assert.equal(await savedProvider(id), 'openai', 'The resume did not rewrite the chat');
  const classified = (await readTelemetry(state, telemetryFrom)).filter(event => event.event === 'gateway_chat_classified' && event.at >= new Date(telemetryFrom).toISOString());
  await save({ phase, passed: true, routedToGateway: true, sqliteProvider: 'openai', rules: classified.map(event => event.rule) });

  phase = 'legacy-resume'; const legacyAt = requests.length;
  const legacyResumed = await second.rpc('thread/resume', { threadId: legacy.thread.id, model: 'fixture/large', cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(legacyResumed.modelProvider, 'subscription_gateway');
  await turn(second, legacy.thread.id, 'fixture/large', 'Continue the legacy chat.'); assert.ok(requests.slice(legacyAt).every(row => row.model === 'mock-large'));
  const legacyRead = await second.rpc('thread/read', { threadId: legacy.thread.id, includeTurns: false });
  assert.equal(await savedProvider(legacy.thread.id), 'subscription_gateway'); assert.equal(await rolloutProvider(legacyRead.thread.path), 'subscription_gateway');
  await save({ phase, passed: true, sqliteProvider: 'subscription_gateway', rolloutProvider: 'subscription_gateway' });

  phase = 'list-through-router';
  const listed = (await second.rpc('thread/list', { limit: 100 })).data.map(thread => thread.id);
  assert.ok(listed.includes(id), 'The openai gateway chat is listed'); assert.ok(listed.includes(legacy.thread.id), 'The legacy chat is listed through the router');
  await save({ phase, passed: true, openaiChatListed: true, legacyChatListed: true });
  await second.close(); second = undefined;

  // The phone without the relay: a stock engine on the same Codex home answers its own default list.
  phase = 'list-without-router'; const plain = client(command(sdk, ['app-server', '--listen', 'stdio://'], { env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] }));
  await plain.init(); const plainListed = (await plain.rpc('thread/list', { limit: 100 })).data.map(thread => thread.id); await plain.close();
  assert.ok(plainListed.includes(id), 'A stock engine lists the openai gateway chat'); assert.equal(plainListed.includes(legacy.thread.id), false);
  await save({ phase, passed: true, openaiChatListed: true, legacyChatListed: false });

  phase = 'no-chatgpt-backend-token';
  assert.equal(sink.filter(row => row.gatewayToken).length, 0, 'No ChatGPT backend request carried the gateway token');
  assert.equal(sink.filter(row => /analytics/.test(row.path)).length, 0, 'No analytics request');
  assert.equal(await access(join(home, 'auth.json')).then(() => true, () => false), false);
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), nativeConfig);
  await save({ phase, passed: true, chatgptBackendRequests: sink.length, withGatewayToken: 0, analyticsRequests: 0, nativeAuthWritten: false, nativeConfigUnchanged: true });
  await save({ phase: 'verification', passed: true, realGatewaySdk: true, sdkSha256: runtime.binarySha256, paidInferenceRequests: 0 });
} catch (error) {
  await save({ phase: 'verification', passed: false, failedDuring: phase, check: error?.message }); process.exitCode = 1;
} finally {
  await first?.close(); await second?.close();
  await Promise.allSettled([...children].map(stop));
  upstream.closeAllConnections(); backend.closeAllConnections();
  await Promise.all([upstream, backend].map(server => new Promise(done => server.close(done))));
  if (!process.exitCode && !v['keep-fixture']) await rm(run, { recursive: true, force: true });
}
