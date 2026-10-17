// The native relay end to end, against the real signed app engine and mock upstreams only. A localhost mock plays the
// ChatGPT backend and the phone: it hands out the server token, accepts the relay's websocket, and sends remote-control
// envelopes as the mobile app would. Each stream reaches the gateway's app-server router (`gateway codex-shim`) in the
// relay's session child, which runs the real engine for native chats and gateway executors for gateway chats; both
// infer from the same mock. Every home is a fresh folder under --root with fake ChatGPT tokens, and on macOS the run
// re-executes itself in a sandbox that refuses every connection off this machine. Nothing is registered or activated.
//
//   node scripts/e2e-native-relay.mjs --root /tmp/gwrl-1 [--relay PATH] [--codex PATH] [--gateway dist/cli.js]
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

const app = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const { values: v } = parseArgs({ options: { root: { type: 'string' }, relay: { type: 'string', default: '.state/native-relay-build/artifact/gateway-native-relay' },
  codex: { type: 'string', default: app }, gateway: { type: 'string', default: 'dist/cli.js' }, 'expect-unfiltered-gateway-listing': { type: 'boolean' },
  'no-sandbox': { type: 'boolean' } } });
assert.ok(v.root, 'Missing --root');
// Outbound connections are refused off this machine for the whole run, children included.
if (process.platform === 'darwin' && !v['no-sandbox'] && process.env.GATEWAY_E2E_SANDBOXED !== '1') {
  const profile = '(version 1)(allow default)(deny network-outbound (remote ip))(allow network-outbound (remote ip "localhost:*"))';
  const run = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, GATEWAY_E2E_SANDBOXED: '1' } });
  process.exit(run.status ?? 1);
}
const root = resolve(v.root), relayBinary = resolve(v.relay), codex = resolve(v.codex), gatewayCli = resolve(v.gateway);
for (const native of [join(homedir(), '.codex'), join(homedir(), '.local/state'), process.env.CODEX_HOME].filter(Boolean)) {
  assert.ok(root !== resolve(native) && !root.startsWith(resolve(native) + sep), 'Use a root outside native and gateway homes');
}
const engineVersion = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim();
await mkdir(root, { mode: 0o700 }); // Refuses a reused root.
const nativeHome = join(root, 'native'), relayHome = join(root, 'r'), state = join(root, 'state'), fakeHome = join(root, 'home'), work = join(root, 'work'), bin = join(root, 'bin');
for (const dir of [nativeHome, state, fakeHome, work, bin]) await mkdir(dir, { mode: 0o700 });
assert.ok(Buffer.byteLength(join(relayHome, 'app-server-control/app-server-control.sock')) < 100, 'Use a shorter --root: the relay socket path must fit in 104 bytes');

// ---- The mock: ChatGPT backend endpoints, the remote-control websocket, and the inference upstream. ----
const evidence = { refresh: [], enroll: 0, websocket: [], backendPaths: {}, inference: [] };
const markers = { gateway: 'RELAY_GATEWAY_OK', native: 'RELAY_NATIVE_OK' };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const mock = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const path = new URL(req.url, 'http://127.0.0.1').pathname, text = Buffer.concat(chunks).toString();
  if (req.method === 'POST' && path === '/backend-api/wham/remote/control/server/refresh') {
    const body = JSON.parse(text);
    evidence.refresh.push({ serverId: body.server_id, installationIdMatches: body.installation_id === installationId,
      bearer: req.headers.authorization === `Bearer ${accessToken}`, account: req.headers['chatgpt-account-id'] ?? null });
    return json(res, 200, { server_id: body.server_id, environment_id: 'env-relay-e2e', remote_control_token: serverToken, expires_at: new Date(Date.now() + 3600e3).toISOString() });
  }
  if (path === '/backend-api/wham/remote/control/server/enroll') { evidence.enroll++; return json(res, 403, { detail: 'enrollment is not offered' }); }
  if (req.method === 'POST' && /\/responses$/.test(path)) {
    const body = JSON.parse(text), kind = body.model === 'mock-gateway' ? 'gateway' : 'native';
    const input = JSON.stringify(body.input); evidence.inference.push({ kind, model: body.model, history: (input.match(new RegExp(markers[kind], 'g')) || []).length });
    const reply = `${markers[kind]} ${evidence.inference.length}`;
    const item = { id: 'msg_' + evidence.inference.length, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply, annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\n');
    return res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_' + evidence.inference.length, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 7 } } }) + '\n\n');
  }
  // Anything else the engines ask the backend for is counted by path only and refused.
  evidence.backendPaths[`${req.method} ${path}`] = (evidence.backendPaths[`${req.method} ${path}`] || 0) + 1;
  json(res, 404, { detail: 'not part of this fixture' });
});
await new Promise(done => mock.listen(0, '127.0.0.1', done));
const port = mock.address().port, base = `http://127.0.0.1:${port}/backend-api/`, websocketUrl = `ws://127.0.0.1:${port}/backend-api/wham/remote/control/server`;

// ---- Fake ChatGPT identity and the original machine registration, as the desktop app would have left them. ----
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = claims => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 30 * 86400, ...claims })}.fixture`;
const account = 'acct-relay-e2e', installationId = randomUUID(), serverToken = 'rc-fixture-' + randomUUID(), serverName = 'relay-e2e-mac';
const auth = { 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_user_id: 'user-relay-e2e', chatgpt_account_id: account } };
const accessToken = jwt(auth);
await writeFile(join(nativeHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: new Date().toISOString(),
  tokens: { id_token: jwt({ email: 'relay-e2e@example.invalid', ...auth }), access_token: accessToken, refresh_token: 'refresh-fixture', account_id: account } }), { mode: 0o600 });
await writeFile(join(nativeHome, 'installation_id'), installationId + '\n', { mode: 0o600 });

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|HARNESS|ANTHROPIC|CLAUDE)/.test(key)));
Object.assign(env, { HOME: fakeHome, RELAY_FIXTURE_KEY: 'fixture-only', GATEWAY_ERROR_REPORTS: 'off', GATEWAY_E2E_SANDBOXED: process.env.GATEWAY_E2E_SANDBOXED ?? '0',
  CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${port}/oauth/token`, CODEX_REVOKE_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${port}/oauth/revoke` });
const reservation = createServer(); await new Promise(done => reservation.listen(0, '127.0.0.1', done));
const servePort = reservation.address().port; await new Promise(done => reservation.close(done));
const serverConfig = join(root, 'server.json'), clientConfig = join(root, 'client.json');
await writeFile(serverConfig, JSON.stringify({ version: 1, port: servePort, stateDirectory: state, timeoutMs: 20000, providers: [{ id: 'fixture', type: 'responses-api',
  baseUrl: `http://127.0.0.1:${port}`, apiKeyEnv: 'RELAY_FIXTURE_KEY', models: { 'fixture/gateway': 'mock-gateway' }, modelMetadata: { 'fixture/gateway': { contextWindow: 32768, reasoningEfforts: ['low'] } } }] }), { mode: 0o600 });
await writeFile(clientConfig, JSON.stringify({ version: 1, port: servePort, stateDirectory: state, clientOnly: true, providers: [] }), { mode: 0o600 });
// A sandboxed process may not run the setuid /bin/ps, so `ps` answers as if a start time were unreadable, which every
// gateway caller already handles; nothing here depends on process start times.
if (process.env.GATEWAY_E2E_SANDBOXED === '1') { await writeFile(join(bin, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o700 }); env.PATH = `${bin}:${env.PATH}`; }
const gateway = join(bin, 'gateway');
await writeFile(gateway, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(gatewayCli)} "$@"\n`, { mode: 0o700 });
const catalog = JSON.parse(execFileSync(process.execPath, [gatewayCli, 'catalog', '--config', serverConfig], { env, encoding: 'utf8' }));
const row = slug => ({ ...catalog.models[0], slug, display_name: slug, additional_speed_tiers: [], service_tiers: [], default_service_tier: null });
await writeFile(join(nativeHome, 'models.json'), JSON.stringify({ models: [row('native-fixture')] }), { mode: 0o600 });
await writeFile(join(nativeHome, 'config.toml'), ['model = "native-fixture"', 'model_provider = "mock"', `model_catalog_json = ${JSON.stringify(join(nativeHome, 'models.json'))}`,
  `chatgpt_base_url = ${JSON.stringify(base)}`, 'cli_auth_credentials_store = "file"', 'mcp_oauth_credentials_store = "file"', 'web_search = "disabled"',
  '[analytics]', 'enabled = false', '[model_providers.mock]', 'name = "Mock native"', `base_url = "http://127.0.0.1:${port}/v1"`, 'env_key = "RELAY_FIXTURE_KEY"',
  'wire_api = "responses"', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0'].join('\n') + '\n', { mode: 0o600 });

const owned = new Set();
const start = (command, args, options = {}) => { const child = spawn(command, args, { env, detached: true, ...options }); owned.add(child); return child; };
async function stop(child, signal = 'SIGTERM', grace = 5000) {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'close'); child.kill(signal);
    if (!await Promise.race([exit.then(() => true), delay(grace).then(() => false)])) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await exit; }
  }
  owned.delete(child);
  return { code: child.exitCode, signal: child.signalCode };
}
async function until(check, label, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); }
  throw Error(label + ' timed out');
}
const result = { checkedAt: new Date().toISOString(), engineVersion, relay: relayBinary, sandboxed: process.env.GATEWAY_E2E_SANDBOXED === '1', paidInferenceRequests: 0, checks: [], passed: false };
const check = (name, details = {}) => { result.checks.push({ name, ...details }); console.log(JSON.stringify({ check: name, ...details })); };
let phase = 'setup', relay, serving;

/** The relay with the given app CLI: `--check` mode resolves everything up to the websocket and prints readiness. */
async function relayCheck(cli) {
  const run = spawnSync(relayBinary, ['--native-home', nativeHome, '--relay-home', relayHome, '--gateway', gateway, '--gateway-config', clientConfig, '--codex', cli, '--check'],
    { env, encoding: 'utf8', timeout: 60000 });
  return { code: run.status, ready: run.status === 0 ? JSON.parse(run.stdout.trim().split('\n').at(-1)) : undefined };
}
const fakeCli = async version => { const path = join(bin, 'codex-' + version.replace(/\W/g, '_')); await writeFile(path, `#!/bin/sh\necho ${JSON.stringify(version)}\n`, { mode: 0o700 }); return path; };

/** One phone stream over the backend websocket: numbered client envelopes, acknowledged server envelopes. */
function phoneStream(socket, inbox, clientId, streamId) {
  let seq = 0, id = 0; const pending = new Map(), events = [];
  const send = event => socket.send(JSON.stringify({ ...event, client_id: clientId, stream_id: streamId, seq_id: ++seq }));
  inbox.set(streamId, message => {
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id); if (!entry) return; pending.delete(message.id); clearTimeout(entry.timer);
      message.error ? entry.reject(Object.assign(Error(`${entry.method} rejected: ${message.error.message}`), { code: message.error.code })) : entry.resolve(message.result);
    } else if (message.method !== undefined && message.id !== undefined) send({ type: 'client_message', message: { id: message.id, error: { code: -32601, message: 'No handler in this fixture' } } });
    else events.push(message);
  });
  const rpc = (method, params = {}) => new Promise((done, fail) => {
    const key = ++id, timer = setTimeout(() => { pending.delete(key); fail(Error(method + ' timed out')); }, 90000);
    pending.set(key, { resolve: done, reject: fail, timer, method }); send({ type: 'client_message', message: { id: key, method, params } });
  });
  const notify = (method, params = {}) => send({ type: 'client_message', message: { method, params } });
  const turn = async (threadId, kind) => {
    const offset = events.length, started = await rpc('turn/start', { threadId, input: [{ type: 'text', text: `Reply with the ${kind} relay marker.` }] });
    const done = await until(() => events.slice(offset).find(event => event.method === 'turn/completed' && event.params.turn.id === started.turn.id), `${kind} turn`, 90000);
    assert.equal(done.params.turn.status, 'completed', `${kind} turn status`);
    const text = events.slice(offset).filter(event => event.method === 'item/completed' && event.params.item.type === 'agentMessage').map(event => event.params.item.text).join(' ');
    assert.ok(text.includes(markers[kind]), `${kind} reply reached the phone`);
    return text;
  };
  return { rpc, notify, turn, events, close: () => send({ type: 'client_closed' }) };
}

try {
  // The SDK creates the native state database; the desktop's registration row is then written into it, as the app does.
  phase = 'native-database';
  const seed = start(codex, ['app-server', '--listen', 'stdio://'], { env: { ...env, CODEX_HOME: nativeHome, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'] });
  const seedLines = createInterface({ input: seed.stdout }); const seedReplies = new Map();
  seedLines.on('line', line => { const message = JSON.parse(line); if (message.id !== undefined) seedReplies.set(message.id, message); });
  seed.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'relay-e2e-seed', version: '1' } } }) + '\n');
  await until(() => seedReplies.get(1), 'engine initialize');
  seed.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n' + JSON.stringify({ id: 2, method: 'thread/list', params: {} }) + '\n');
  await until(() => seedReplies.get(2), 'engine thread/list');
  seed.stdin.end(); await stop(seed); seedLines.close();
  const database = join(nativeHome, 'state_5.sqlite'); await stat(database);
  execFileSync('/usr/bin/sqlite3', [database, `INSERT INTO remote_control_enrollments (websocket_url, account_id, app_server_client_name, server_id, environment_id, server_name, updated_at, remote_control_enabled) VALUES ('${websocketUrl}', '${account}', 'Codex Desktop', 'srv-relay-e2e', 'env-relay-e2e', '${serverName}', strftime('%s','now'), 1);`]);

  phase = 'cli-versions';
  const checks = { real: await relayCheck(codex), app162: await relayCheck(await fakeCli('codex-cli 0.162.0-alpha.17.2')),
    app164: await relayCheck(await fakeCli('codex-cli 0.164.0')), near: await relayCheck(await fakeCli('codex-cli 0.163.0-alpha.10')) };
  assert.equal(checks.real.code, 0); assert.equal(checks.real.ready.ready, true); assert.equal(checks.real.ready.existingMachine, true); assert.equal(checks.real.ready.environmentId, 'env-relay-e2e');
  assert.equal(checks.app162.code, 0, 'a Mac still on the 0.162 app keeps its relay');
  assert.equal(checks.app164.code, 1, 'an unverified app engine stops the relay'); assert.equal(checks.near.code, 1);
  check('relay_cli_versions', { real: engineVersion, accepted: ['0.163.0-alpha.10.2', '0.162.0-alpha.17.2'], refused: ['0.164.0', '0.163.0-alpha.10'] });

  phase = 'serve';
  serving = start(process.execPath, [gatewayCli, 'serve', '--config', serverConfig], { stdio: 'ignore' });
  await until(() => fetch(`http://127.0.0.1:${servePort}/health`).then(res => res.ok).catch(() => false), 'gateway serve');

  phase = 'relay-connect';
  const phone = { connected: undefined, inbox: new Map(), chunks: new Map() };
  const wss = new WebSocketServer({ noServer: true });
  mock.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path !== '/backend-api/wham/remote/control/server') { socket.destroy(); return; }
    evidence.websocket.push({ serverId: req.headers['x-codex-server-id'], name: Buffer.from(String(req.headers['x-codex-name']), 'base64').toString(),
      protocol: req.headers['x-codex-protocol-version'], bearer: req.headers.authorization === `Bearer ${serverToken}`, installationIdMatches: req.headers['x-codex-installation-id'] === installationId });
    wss.handleUpgrade(req, socket, head, ws => {
      phone.connected = ws;
      ws.on('message', data => {
        const envelope = JSON.parse(data.toString());
        if (envelope.type === 'server_message' || envelope.type === 'server_message_chunk') ws.send(JSON.stringify({ type: 'ack', client_id: envelope.client_id, stream_id: envelope.stream_id, seq_id: envelope.seq_id,
          ...(envelope.type === 'server_message_chunk' ? { segment_id: envelope.segment_id } : {}) }));
        let message = envelope.message;
        if (envelope.type === 'server_message_chunk') {
          const key = `${envelope.stream_id}:${envelope.seq_id}`, parts = phone.chunks.get(key) || []; parts[envelope.segment_id] = envelope.message_chunk_base64; phone.chunks.set(key, parts);
          if (parts.filter(Boolean).length < envelope.segment_count) return;
          phone.chunks.delete(key); message = JSON.parse(Buffer.concat(parts.map(part => Buffer.from(part, 'base64'))).toString());
        }
        if (message) phone.inbox.get(envelope.stream_id)?.(message);
      });
    });
  });
  // As the service runs it: a daemon with no stdin, whose stdout carries only status notifications.
  relay = start(relayBinary, ['--native-home', nativeHome, '--relay-home', relayHome, '--gateway', gateway, '--gateway-config', clientConfig, '--codex', codex, '--daemon'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const relayOut = []; createInterface({ input: relay.stdout }).on('line', line => relayOut.push(JSON.parse(line)));
  const relayLog = []; createInterface({ input: relay.stderr }).on('line', line => relayLog.push(line));
  await until(() => relayOut.find(message => message.method === 'remoteControl/status/changed' && message.params?.status === 'connected'), 'relay connected');
  const status = JSON.parse(await readFile(join(relayHome, 'status.json'), 'utf8'));
  assert.equal(status.status, 'connected'); assert.equal(status.environmentId, 'env-relay-e2e');
  assert.equal(evidence.enroll, 0, 'the relay never enrolls a new machine');
  assert.ok(evidence.refresh.length >= 1 && evidence.refresh.every(row => row.serverId === 'srv-relay-e2e' && row.installationIdMatches && row.bearer));
  assert.ok(evidence.websocket.length >= 1 && evidence.websocket.every(row => row.serverId === 'srv-relay-e2e' && row.name === serverName && row.bearer && row.installationIdMatches));
  check('relay_connected_with_existing_registration', { refreshes: evidence.refresh.length, websockets: evidence.websocket.length, protocol: evidence.websocket[0].protocol, enrollments: evidence.enroll });

  // Stream A: the phone opens the Mac, lists models and chats, and runs a gateway and a native chat.
  phase = 'phone-stream-a';
  const clientId = 'phone-' + randomUUID();
  const a = phoneStream(phone.connected, phone.inbox, clientId, 'a-' + randomUUID());
  const initialized = await a.rpc('initialize', { clientInfo: { name: 'Codex iOS', version: 'relay-e2e' }, capabilities: { experimentalApi: true } });
  a.notify('initialized');
  assert.ok(String(initialized.userAgent ?? '').includes('0.163.0-alpha.10.2') || engineVersion !== 'codex-cli 0.163.0-alpha.10.2', 'the session runs the real 0.163 engine');
  const relayStatus = await a.rpc('remoteControl/status/read');
  assert.equal(relayStatus.status, 'connected'); assert.equal(relayStatus.environmentId, 'env-relay-e2e');
  const models = await a.rpc('model/list', {});
  assert.ok(models.data.some(model => model.id === 'fixture/gateway' || model.model === 'fixture/gateway'), 'the router adds gateway models to the phone list');
  check('router_answers_phone', { userAgentEngine: String(initialized.userAgent ?? '').match(/\d+\.\d+\.\d+[^\s;)]*/)?.[0] ?? null, models: models.data.length });
  const gatewayChat = (await a.rpc('thread/start', { model: 'fixture/gateway', cwd: work, approvalPolicy: 'never', sandbox: 'read-only' })).thread;
  await a.turn(gatewayChat.id, 'gateway');
  const nativeChat = (await a.rpc('thread/start', { model: 'native-fixture', cwd: work, approvalPolicy: 'never', sandbox: 'read-only' })).thread;
  await a.turn(nativeChat.id, 'native');
  assert.deepEqual(evidence.inference.map(row => row.model), ['mock-gateway', 'native-fixture']);
  check('gateway_and_native_turns_through_relay', { gatewayProvider: gatewayChat.modelProvider, nativeProvider: nativeChat.modelProvider });
  const everything = await a.rpc('thread/list', { modelProviders: [] });
  assert.ok(everything.data.some(thread => thread.id === gatewayChat.id) && everything.data.some(thread => thread.id === nativeChat.id), 'thread/list through the relay lists both chats');
  const unfiltered = await a.rpc('thread/list', {});
  const unfilteredListsGatewayChat = unfiltered.data.some(thread => thread.id === gatewayChat.id);
  if (v['expect-unfiltered-gateway-listing']) assert.ok(unfilteredListsGatewayChat, 'the router lists gateway chats when the phone names no provider');
  check('thread_list_through_relay', { allProviders: everything.data.length, unfilteredListsGatewayChat });
  a.close();

  // Stream B: the phone comes back later and continues the gateway chat with its history.
  phase = 'phone-stream-b';
  const b = phoneStream(phone.connected, phone.inbox, clientId, 'b-' + randomUUID());
  await b.rpc('initialize', { clientInfo: { name: 'Codex iOS', version: 'relay-e2e' }, capabilities: { experimentalApi: true } }); b.notify('initialized');
  const resumed = await b.rpc('thread/resume', { threadId: gatewayChat.id, cwd: work });
  assert.equal(resumed.thread.id, gatewayChat.id); assert.equal(resumed.model, 'fixture/gateway');
  await b.turn(gatewayChat.id, 'gateway');
  const last = evidence.inference.at(-1); assert.equal(last.model, 'mock-gateway'); assert.ok(last.history >= 1, 'the continued turn carried the earlier reply');
  check('gateway_chat_continued_on_new_stream', { model: resumed.model, historyMarkers: last.history });
  b.close();

  phase = 'relay-stop';
  await until(() => relayLog.filter(line => line.includes('"event":"session_ended"')).length >= 2, 'both sessions ended', 20000);
  const stopping = Date.now(); const stopped = await stop(relay, 'SIGTERM', 15000); relay = undefined;
  await writeFile(join(root, 'relay.log'), relayLog.join('\n') + '\n', { mode: 0o600 });
  assert.deepEqual(stopped, { code: 0, signal: null }, 'the relay stops cleanly on SIGTERM');
  result.relayStopMs = Date.now() - stopping;
  const records = relayLog.filter(line => line.startsWith('gateway: {')).map(line => JSON.parse(line.slice(9)));
  const leaked = relayLog.filter(line => [accessToken, serverToken, installationId, 'refresh-fixture'].some(secret => line.includes(secret)));
  assert.equal(leaked.length, 0, 'relay records carry no token or installation id');
  check('relay_records', { records: records.length, sessions: records.filter(record => record.event === 'session_started').length, leakedSecrets: leaked.length });
  result.backendPaths = evidence.backendPaths; result.inference = evidence.inference;
  result.passed = true;
} catch (error) { result.failure = { phase, message: String(error?.message).slice(0, 500) }; process.exitCode = 1; }
finally {
  for (const child of [...owned]) await stop(child);
  mock.closeAllConnections(); await new Promise(done => mock.close(done));
}
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ passed: result.passed, failure: result.failure, result: join(root, 'result.json') }));
