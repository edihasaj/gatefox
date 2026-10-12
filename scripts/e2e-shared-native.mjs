import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { Duplex } from 'node:stream';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values: v } = parseArgs({ options: { gateway: { type: 'string' }, package: { type: 'string' }, root: { type: 'string' },
  transports: { type: 'string', default: 'stdio,unix' },
  'host-capabilities': { type: 'string', default: 'native' },
  codex: { type: 'string', default: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' } } });
for (const key of ['gateway', 'package', 'root']) assert.ok(v[key], 'Missing --' + key);
const gateway = resolve(v.gateway), packagePath = resolve(v.package), root = resolve(v.root), sdk = resolve(v.codex);
assert.ok(root !== resolve(homedir(), '.codex') && !root.startsWith(resolve(homedir(), '.codex') + '/'));
const transports = v.transports.split(','); assert.ok(transports.every(value => ['stdio', 'unix'].includes(value)));
const capabilities = v['host-capabilities'].split(','); assert.ok(capabilities.includes('native') && capabilities.every(value => ['native', 'gateway'].includes(value)));
const sharedGateway = capabilities.includes('gateway');
if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--verify', '--strict', sdk], { stdio: 'pipe' });
const sdkVersion = execFileSync(sdk, ['--version'], { encoding: 'utf8' }).trim(); assert.equal(sdkVersion, 'codex-cli 0.162.0-alpha.17.2');
const { WebSocket } = createRequire(join(packagePath, 'package.json'))('ws');
const module = name => import(pathToFileURL(join(packagePath, 'dist', name + '.js')));
const [{ startExecutionHost, executionHostHome }, { SocketAppServerConnection }, { modelCatalog }, { ResponsesWriter }] = await Promise.all([
  module('execution-host'), module('socket-app-server-connection'), module('catalog'), module('protocol/responses')]);
const runtime = await mkdtemp('/tmp/gw-native-'), home = join(runtime, 'native'), work = join(runtime, 'work'), state = join(runtime, 'state');
await Promise.all([root, home, work, state].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|ANTHROPIC|CLAUDE)/.test(key)));
const results = [], requests = [], owned = new Set(), clients = new Set(), held = new Set(), sdkPids = new Set();
const seed = 'NATIVE_SEED_' + randomUUID(), steer = 'STEER_' + randomUUID();
let phase = 'setup', mode = 'seed', timerCount = 0, modelGets = 0, mockErrors = 0, host, control;
const nativeCatalog = modelCatalog({ providers: [{ id: 'native', type: 'responses-api', models: { 'native-fixture': 'mock-native' },
  modelMetadata: { 'native-fixture': { contextWindow: 50000, reasoningEfforts: ['low'] } } }] });
const save = async row => { results.push(row); await writeFile(join(root, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), sdkVersion,
  gateway, runtime, primaryConfigRead: false, primaryConfigWritten: false, nativeAuthCopied: false, paidInferenceRequests: 0,
  modelGets, mockErrors, results, requests }, null, 2) + '\n', { mode: 0o600 }); console.log(JSON.stringify(row)); };
async function until(check, description, timeout = 15000) { const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(20); } throw Error(description + ' timed out'); }
const fake = createServer((req, res) => { void (async () => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (req.method === 'GET') { if (!['/v1/models', '/models'].includes(pathname)) { res.writeHead(404); res.end(); return; }
    modelGets++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(nativeCatalog)); return; }
  assert.ok(req.method === 'POST' && ['/v1/responses', '/responses'].includes(pathname));
  const chunks = []; let bytes = 0; for await (const chunk of req) { bytes += chunk.length; assert.ok(bytes < 2 * 1024 * 1024); chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString()); chunks.length = 0;
  const input = JSON.stringify(body.input);
  const row = { phase, model: body.model, serviceTier: body.service_tier ?? null, hasSeed: input.includes(seed), hasSteering: input.includes(steer), outcome: 'completed' }; requests.push(row);
  res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
  const writer = new ResponsesWriter(body.model, event => res.write('data: ' + JSON.stringify(event) + '\n\n')); writer.begin();
  if (mode === 'approval' && body.model === 'native-fixture') {
    const find = tools => { for (const tool of tools || []) {
      if (tool.type === 'namespace') { const found = find(tool.tools); if (found) return { ...found, namespace: tool.name }; }
      if (tool.type === 'function' && (tool.name || tool.function?.name) === 'exec_command') return { name: 'exec_command' };
    } };
    const tool = find(body.tools); assert.ok(tool, 'SDK did not offer its command tool'); mode = 'approval-wait';
    writer.accept({ type: 'tool', call: { id: randomUUID(), type: 'function', function: { name: tool.name,
      arguments: JSON.stringify({ cmd: '/usr/bin/true', sandbox_permissions: 'require_escalated', justification: 'Owned fixture approval gate', yield_time_ms: 1000, max_output_tokens: 20 }) },
      responseTool: { type: 'function', name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) } } });
    writer.accept({ type: 'done', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }, endTurn: false }); res.end(); return;
  }
  const complete = () => { if (res.destroyed) return; writer.accept({ type: 'text', text: mode === 'seed' ? seed : row.hasSteering ? 'STEERING_OK ' + seed : 'FOLLOWUP_OK ' + seed });
    writer.accept({ type: 'done', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }, serviceTier: row.serviceTier ?? 'default' }); res.end(); };
  const shouldHold = mode === 'hold' && body.model === 'native-fixture' || mode === 'hold-gateway' && body.model === 'mock-gateway';
  if (!shouldHold) { complete(); return; }
  row.outcome = 'held'; timerCount++;
  const entry = { finish: () => { held.delete(entry); clearTimeout(timer); timerCount--; row.outcome = 'released'; complete(); } };
  const timer = setTimeout(() => { held.delete(entry); timerCount--; row.outcome = 'expired'; res.end(); }, 45000); held.add(entry);
  res.once('close', () => { if (held.delete(entry)) { clearTimeout(timer); timerCount--; row.outcome = 'interrupted'; } });
})().catch(() => { mockErrors++; if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }); if (!res.destroyed) res.end(); }); });
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
const nativeBase = 'http://127.0.0.1:' + fake.address().port + '/v1';
Object.assign(env, { OPENAI_API_KEY: 'sk-owned-native-fixture', OPENAI_BASE_URL: nativeBase, SHARED_NATIVE_PROVIDER_KEY: 'fixture-only', CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' });
const nativeConfig = 'model = "native-fixture"\nmodel_provider = "openai"\nopenai_base_url = ' + JSON.stringify(nativeBase) +
  '\nmodel_catalog_json = ' + JSON.stringify(join(home, 'models.json')) + '\nweb_search = "disabled"\n[features]\nremote_control = false\nresponses_websockets = false\nresponses_websockets_v2 = false\nfast_mode = false\nstep_model_switching = false\n';
await writeFile(join(home, 'models.json'), JSON.stringify(nativeCatalog), { mode: 0o600 });
await writeFile(join(home, 'config.toml'), nativeConfig, { mode: 0o600 });
const configSha = createHash('sha256').update(nativeConfig).digest('hex');
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const configPath = join(runtime, 'gateway.json'), config = { version: 1, port, stateDirectory: state, timeoutMs: 60000,
  providers: [{ id: 'gateway-fixture', type: 'responses-api', apiKeyEnv: 'SHARED_NATIVE_PROVIDER_KEY', baseUrl: nativeBase,
    models: { 'fixture/gateway': 'mock-gateway' }, modelMetadata: { 'fixture/gateway': { contextWindow: 50000, reasoningEfforts: ['low'],
      additionalSpeedTiers: ['fast'], serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority routing' }], defaultServiceTier: null } } }] };
await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
await writeFile(join(state, 'service-plan.json'), JSON.stringify({ version: 1, config: configPath, sharedExecutors: sharedGateway, sharedNativeExecutor: true,
  components: [{ id: 'native-fixture', kind: 'native', command: sdk,
    args: ['--daemon', '--codex', sdk, '--native-home', home, '--relay-home', join(runtime, 'unused-relay')], log: join(runtime, 'unused-native.log') }] }), { mode: 0o600 });
function command(args, options = {}) { const child = spawn(gateway.endsWith('.js') ? process.execPath : gateway, gateway.endsWith('.js') ? [gateway, ...args] : args,
  { env, cwd: work, stdio: ['ignore', 'ignore', 'ignore'], detached: true, ...options }); owned.add(child); return child; }
function groupAlive(child) { try { process.kill(-child.pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false;
  if (error.code === 'EPERM') return execFileSync('ps', ['-axo', 'pgid='], { encoding: 'utf8' }).split('\n').some(row => Number(row.trim()) === child.pid); throw error; } }
async function stop(child) { if (!child) return; const done = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'close');
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const grace = Date.now() + 3000; while (groupAlive(child) && Date.now() < grace) await delay(20);
  if (groupAlive(child)) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH' && groupAlive(child)) throw error; }
    await until(() => !groupAlive(child), 'Owned process group cleanup', 3000); }
  await done; owned.delete(child); }
function adapterClient(child, websocket) { const events = [], pending = new Map(), approvals = []; let sequence = 0;
  const send = value => websocket ? websocket.send(JSON.stringify(value)) : child.stdin.write(JSON.stringify(value) + '\n');
  const receive = raw => { const message = JSON.parse(raw), entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Object.assign(Error('RPC rejected: ' + entry.method), { code: message.error.code })) : entry.resolve(message.result); }
    else if (message.method === 'item/commandExecution/requestApproval' && message.id !== undefined) approvals.push({ id: message.id, method: message.method, threadId: message.params.threadId, turnId: message.params.turnId });
    else if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Fixture has no tool handler' } });
    else if (message.method) events.push(message); };
  const lines = websocket ? undefined : createInterface({ input: child.stdout });
  if (websocket) websocket.on('message', data => receive(data.toString())); else lines.on('line', receive);
  const current = { events, approvals, send, rpc: (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence,
    timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 20000); pending.set(id, { resolve, reject, timer, method }); send({ id, method, params }); }),
    close: async () => { websocket?.terminate(); lines?.close(); child.stdin?.end(); for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Fixture adapter closed')); }
      pending.clear(); await stop(child); clients.delete(current); } }; clients.add(current); return current; }
async function open(transport, suffix) { let listener, client, backendPid;
  if (transport === 'stdio') { const child = command(['codex-shim', '--config', configPath, '--codex', sdk, '--', 'app-server', '--listen', 'stdio://'],
    { env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] }); backendPid = child.pid; client = adapterClient(child); }
  else { const proxyHome = join(runtime, 'proxy-' + suffix);
    listener = command(['codex-shim', '--ssh', '--ssh-home', proxyHome, '--config', configPath, '--codex', sdk, '--', 'app-server', '--listen', 'unix://'], { env: { ...env, CODEX_HOME: home } });
    backendPid = listener.pid;
    await until(() => access(join(proxyHome, 'app-server-control/app-server-control.sock')).then(() => true, () => false), 'Private adapter Unix listener');
    const child = spawn(sdk, ['app-server', 'proxy'], { env: { ...env, CODEX_HOME: proxyHome }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'], detached: true }); owned.add(child);
    const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const websocket = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => pipe }); await once(websocket, 'open'); client = adapterClient(child, websocket); }
  await client.rpc('initialize', { clientInfo: { name: 'gateway_shared_native_fixture', version: '1' }, capabilities: { experimentalApi: true } }); client.send({ method: 'initialized', params: {} });
  return { client, backendPid, close: async () => { await client.close(); await stop(listener); } }; }
async function nativeStatus() { const status = await control.request('execution/status', {}); assert.deepEqual(new Set(status.capabilities), new Set(capabilities));
  assert.ok(status.native && status.native.kind === 'native' && status.native.state === 'running' && status.native.pid > 0);
  assert.match(status.native.revision, /^[a-f0-9]{64}$/); assert.equal(status.native.socketPath, join(executionHostHome(configPath, home), 'native.sock'));
  assert.match(status.native.instanceId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  sdkPids.add(status.native.pid); return Object.fromEntries(['kind', 'revision', 'socketPath', 'pid', 'instanceId', 'state'].map(key => [key, status.native[key]])); }
async function readActive(client, ids, provider = 'openai') { const { thread } = await client.rpc('thread/read', { threadId: ids.threadId, includeTurns: true });
  const turn = thread.turns.find(value => value.id === ids.turnId); assert.ok(turn); assert.equal(thread.status.type, 'active'); assert.equal(turn.status, 'inProgress');
  assert.equal(thread.modelProvider, provider); return { threadStatus: thread.status.type, turnStatus: turn.status }; }
async function complete(client, id, model = 'native-fixture', extra = {}) { const at = client.events.length;
  const started = await client.rpc('turn/start', { threadId: id, model, effort: 'low', input: [{ type: 'text', text: 'Follow up from this fixture history.' }], ...extra });
  await until(() => client.events.slice(at).find(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id && e.params.turn.status === 'completed'), 'Completed fixture turn'); return started.turn.id; }
async function heldTurn(client, id, model = 'native-fixture') { mode = model === 'native-fixture' ? 'hold' : 'hold-gateway'; const before = requests.length;
  const start = await client.rpc('turn/start', { threadId: id, model, effort: 'low', input: [{ type: 'text', text: 'Hold this fixture until its controller acts.' }] });
  await until(() => requests.length > before && held.size === 1, 'Held native inference'); return { threadId: id, turnId: start.turn.id }; }
async function interrupt(actor, observer, ids) { const offset = observer.events.length; await actor.rpc('turn/interrupt', ids);
  await until(() => observer.events.slice(offset).find(e => e.method === 'turn/completed' && e.params.turn.id === ids.turnId && e.params.turn.status === 'interrupted'), 'Real native interruption');
  await until(() => held.size === 0 && timerCount === 0, 'Held provider cleanup'); }
const serving = command(['serve', '--config', configPath]);
const protectedKey = key => /^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|ANTHROPIC|CLAUDE)/.test(key) || key === 'SHARED_NATIVE_PROVIDER_KEY';
const originalEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => protectedKey(key)));
try {
  await until(() => fetch('http://127.0.0.1:' + port + '/health').then(res => res.ok).catch(() => false), 'Gateway HTTP fixture');
  for (const key of Object.keys(process.env)) if (protectedKey(key)) delete process.env[key];
  Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([key]) => protectedKey(key))));
  host = await startExecutionHost({ config, configPath, nativeHome: home, codex: sdk, capabilities, nativeRelayOwnsRegistration: false });
  control = new SocketAppServerConnection(join(executionHostHome(configPath, home), 'host.sock'), async () => {}); await control.ready;
  for (const transport of transports) {
    phase = transport + '-two-native-adapters'; const owner = await open(transport, transport + '-a'), reader = await open(transport, transport + '-b');
    const native = await nativeStatus(); const features = (await owner.client.rpc('config/read', { includeLayers: false })).config.features;
    assert.equal(features.fast_mode, false); assert.equal(features.step_model_switching, false);
    const chat = await owner.client.rpc('thread/start', { model: 'native-fixture', cwd: work, approvalPolicy: 'never', sandbox: 'read-only' }); assert.equal(chat.modelProvider, 'openai');
    mode = 'seed'; await complete(owner.client, chat.thread.id); await reader.client.rpc('thread/resume', { threadId: chat.thread.id });
    const ids = await heldTurn(owner.client, chat.thread.id), ownerView = await readActive(owner.client, ids), readerView = await readActive(reader.client, ids);
    assert.deepEqual(await nativeStatus(), native); await save({ phase, passed: true, sameNativeIdentity: true, owner: ownerView, reader: readerView, originalNativeFlagsPreserved: true });
    phase = transport + '-reader-stop'; await interrupt(reader.client, owner.client, ids); assert.deepEqual(await nativeStatus(), native);
    await save({ phase, passed: true, readerInterruptedRealOwner: true, nativeSdkSurvived: true, providerTimers: 0 });
    phase = transport + '-disconnect-active-owner'; const ongoing = await heldTurn(owner.client, chat.thread.id), before = reader.client.events.length;
    await owner.close(); await readActive(reader.client, ongoing); assert.deepEqual(await nativeStatus(), native); assert.equal(held.size, 1);
    assert.equal((await control.request('native/death', { revision: native.revision, pid: native.pid, instanceId: native.instanceId })).confirmed, false);
    assert.ok(!reader.client.events.slice(before).some(e => e.method === 'turn/completed' && e.params.turn.id === ongoing.turnId));
    await save({ phase, passed: true, activeOwnerNotKilledByAdapterDisconnect: true, noFabricatedTerminal: true, sameNativeSdkPid: true });
    phase = transport + '-reconnect-active'; const reconnected = await open(transport, transport + '-c'); await reconnected.client.rpc('thread/resume', { threadId: chat.thread.id });
    await readActive(reconnected.client, ongoing); assert.deepEqual(await nativeStatus(), native);
    const steering = await reconnected.client.rpc('turn/steer', { threadId: chat.thread.id, expectedTurnId: ongoing.turnId, input: [{ type: 'text', text: steer }] }); assert.equal(steering.turnId, ongoing.turnId);
    const steerAt = requests.length, terminalAt = reader.client.events.length; mode = 'follow-up'; for (const request of [...held]) request.finish();
    await until(() => reader.client.events.slice(terminalAt).find(e => e.method === 'turn/completed' && e.params.turn.id === ongoing.turnId && e.params.turn.status === 'completed'), 'Steered native completion');
    assert.ok(requests.slice(steerAt).some(row => row.hasSteering)); await save({ phase, passed: true, loadedTurnRecovered: true, steeringReachedRealNativeRequest: true, sameNativeSdkPid: true });
    phase = transport + '-native-follow-up'; const followAt = requests.length; await complete(reconnected.client, chat.thread.id);
    const followRequests = requests.slice(followAt); assert.ok(followRequests.length && followRequests.every(row => row.model === 'native-fixture' && row.hasSeed && row.serviceTier !== 'priority'));
    await save({ phase, passed: true, historyReplayed: true, nativeStandardPreserved: true });
    phase = transport + '-gateway-capability-separation'; const gatewayChat = await reader.client.rpc('thread/start', { model: 'fixture/gateway', cwd: work, approvalPolicy: 'never', sandbox: 'read-only', serviceTier: 'priority' });
    assert.equal(gatewayChat.modelProvider, 'subscription_gateway'); const gatewayAt = requests.length; await complete(reader.client, gatewayChat.thread.id, 'fixture/gateway');
    assert.ok(requests.slice(gatewayAt).length && requests.slice(gatewayAt).every(row => row.model === 'mock-gateway' && row.serviceTier === 'priority'));
    const status = await control.request('execution/status', {});
    if (sharedGateway) {
      assert.ok(status.generations.length === 1 && status.generations[0].pid !== native.pid); sdkPids.add(status.generations[0].pid);
      const inspection = new SocketAppServerConnection(status.generations[0].socketPath, async () => {}); await inspection.ready;
      try { await inspection.request('initialize', { clientInfo: { name: 'gateway_capability_inspection', version: '1' }, capabilities: { experimentalApi: true } }); inspection.send({ method: 'initialized', params: {} });
        const gatewayFeatures = (await inspection.request('config/read', { includeLayers: false })).config.features; assert.equal(gatewayFeatures.fast_mode, true); assert.equal(gatewayFeatures.step_model_switching, true);
      } finally { inspection.stop(); await inspection.exited; }
    } else {
      assert.equal(status.generations.length, 0);
      const children = execFileSync('ps', ['-axo', 'pid,ppid'], { encoding: 'utf8' }).split('\n').flatMap(line => {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/); return match && Number(match[2]) === reader.backendPid ? [Number(match[1])] : [];
      }).map(pid => ({ pid, args: execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim() }))
        .filter(row => row.args.includes('model_provider=') && row.args.includes('subscription_gateway'));
      assert.equal(children.length, 1); assert.notEqual(children[0].pid, native.pid); sdkPids.add(children[0].pid);
      assert.ok(children[0].args.includes('features.fast_mode=true') && children[0].args.includes('features.step_model_switching=true'));
    }
    const nativeAgain = (await reader.client.rpc('config/read', { includeLayers: false })).config.features;
    assert.equal(nativeAgain.fast_mode, false); assert.equal(nativeAgain.step_model_switching, false);
    await save({ phase, passed: true, distinctNativeAndGatewaySdkPids: true, nativeFastFalseGatewayFastTrue: true, nativeStepSwitchFalseGatewayTrue: true });
    if (sharedGateway) {
      phase = transport + '-shared-gateway-reader-stop'; const gatewayPid = status.generations[0].pid;
      const gatewayHeld = await heldTurn(reader.client, gatewayChat.thread.id, 'fixture/gateway');
      const gatewayOwnerView = await readActive(reader.client, gatewayHeld, 'subscription_gateway');
      // This client has never resumed/bound this gateway chat. Its read must
      // find the live gateway owner before consulting native saved metadata.
      const gatewayReaderView = await readActive(reconnected.client, gatewayHeld, 'subscription_gateway');
      assert.deepEqual(gatewayReaderView, gatewayOwnerView); assert.deepEqual(await nativeStatus(), native);
      await interrupt(reconnected.client, reader.client, gatewayHeld);
      assert.equal((await control.request('execution/status', {})).generations[0].pid, gatewayPid); assert.deepEqual(await nativeStatus(), native);
      const stopped = await reconnected.client.rpc('thread/read', { threadId: gatewayHeld.threadId, includeTurns: true });
      assert.equal(stopped.thread.turns.find(turn => turn.id === gatewayHeld.turnId).status, 'interrupted');
      await save({ phase, passed: true, unboundReaderFoundRealActiveOwner: true, noNativeInterruptedSnapshot: true,
        readerStoppedRealGatewayTurn: true, sameGatewaySdkPid: true, nativeOwnerUntouched: true });
    }
    phase = transport + '-pending-native-approval'; mode = 'approval';
    const approvalChat = await reconnected.client.rpc('thread/start', { model: 'native-fixture', cwd: work, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
    const approvalOffset = reconnected.client.events.length;
    const approvalTurn = await reconnected.client.rpc('turn/start', { threadId: approvalChat.thread.id, effort: 'low', input: [{ type: 'text', text: 'Request the owned fixture command approval.' }] });
    const pendingApproval = await until(() => reconnected.client.approvals.find(row => row.threadId === approvalChat.thread.id && row.turnId === approvalTurn.turn.id), 'Actual SDK user approval');
    await readActive(reconnected.client, { threadId: approvalChat.thread.id, turnId: approvalTurn.turn.id });
    assert.ok(!reconnected.client.events.slice(approvalOffset).some(e => e.method === 'turn/completed' && e.params.turn.id === approvalTurn.turn.id));
    const warm = await open(transport, transport + '-approval'); await warm.client.rpc('thread/resume', { threadId: approvalChat.thread.id });
    const replayed = await until(() => warm.client.approvals.find(row => row.threadId === pendingApproval.threadId && row.turnId === pendingApproval.turnId), 'Warm approval replay');
    assert.equal(replayed.method, pendingApproval.method); await readActive(warm.client, { threadId: approvalChat.thread.id, turnId: approvalTurn.turn.id });
    await save({ phase, passed: true, actualUserApprovalPending: true, adminDidNotAnswer: true, warmResumeReplayedApproval: true });
    phase = transport + '-cancel-approval-follow-up'; await interrupt(warm.client, reconnected.client, { threadId: approvalChat.thread.id, turnId: approvalTurn.turn.id });
    mode = 'follow-up'; await complete(warm.client, approvalChat.thread.id); assert.deepEqual(await nativeStatus(), native);
    await save({ phase, passed: true, pendingApprovalCancelledByReader: true, finalFollowUpCompleted: true, sameNativeIdentity: true }); await warm.close();
    await reconnected.close(); await reader.close(); assert.deepEqual(await nativeStatus(), native);
  }
  assert.equal(createHash('sha256').update(await readFile(join(home, 'config.toml'))).digest('hex'), configSha);
  assert.equal(await access(join(home, 'auth.json')).then(() => true, () => false), false);
  assert.equal(mockErrors, 0);
  await save({ phase: 'verification', passed: true, transports, capabilities, sharedGateway, nativeFixtureConfigSha256: configSha, nativeConfigurationUnchanged: true,
    nativeAuthCopied: false, paidInferenceRequests: 0, renderedDesktopUiTested: false, builtInCloudTransportTested: false });
} catch (error) { process.exitCode = 1; await save({ phase: 'verification', passed: false, failedDuring: phase, errorClass: error?.name, code: error?.code,
  check: error?.name === 'AssertionError' ? 'Assertion failed' : error?.message });
} finally {
  for (const request of [...held]) request.finish();
  const cleanup = await Promise.allSettled([...clients].map(client => client.close()));
  control?.stop(); if (control) cleanup.push(...await Promise.allSettled([control.exited]));
  if (host) cleanup.push(...await Promise.allSettled([host.close()]));
  const children = await Promise.allSettled([...owned].map(stop)); cleanup.push(...children);
  fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve));
  for (const key of Object.keys(process.env)) if (protectedKey(key)) delete process.env[key]; Object.assign(process.env, originalEnv);
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
  const stopped = await Promise.allSettled([...sdkPids].map(async pid => {
    if (alive(pid)) {
      const parent = Number(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
      assert.equal(parent, process.pid, 'Cannot signal an SDK outside this isolated fixture');
      try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await until(() => !alive(pid), 'Owned SDK process cleanup', 5000);
  })); cleanup.push(...stopped);
  const clean = cleanup.every(row => row.status === 'fulfilled') && owned.size === 0 && held.size === 0 && timerCount === 0;
  await save({ phase: 'fixture-cleanup', passed: clean, ownedProcessGroups: owned.size, remainingSdkPids: [...sdkPids].filter(alive).length,
    heldProviders: held.size, providerTimers: timerCount }); if (!clean) process.exitCode = 1;
}
