// Two clients of real gateway SDKs: listing must expose a running chat without
// resuming it, and the list client must receive the SDK's eventual idle status.
// All state and inference stay in this fixture. No account or paid inference.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chatStateUpstream } from './chat-state-upstream.mjs';

const { values } = parseArgs({ options: { package: { type: 'string' }, root: { type: 'string' },
  native: { type: 'boolean', default: false }, private: { type: 'boolean', default: false }, code: { type: 'string' },
  unread: { type: 'boolean', default: false }, activity: { type: 'boolean', default: false }, 'native-engine': { type: 'string' },
  'executor-diagnostics': { type: 'boolean', default: false }, 'restart-discovery': { type: 'boolean', default: false },
  'delayed-discovery': { type: 'boolean', default: false }, 'replay-completion': { type: 'boolean', default: false }, 'truncated-upstream': { type: 'boolean', default: false } } });
assert.ok(!values['truncated-upstream'] || values.activity && !values.native && !values.private, '--truncated-upstream requires shared gateway --activity');
assert.ok(!values['delayed-discovery'] || values['restart-discovery'], '--delayed-discovery requires --restart-discovery');
assert.ok(values.package && values.root, 'Pass --package INSTALLED_PACKAGE --root EVIDENCE_DIRECTORY');
const source = resolve(values.code ?? fileURLToPath(new URL('..', import.meta.url))), pkg = resolve(values.package);
const root = resolve(values.root);
await mkdir(root, { recursive: true, mode: 0o700 });
const fixture = await mkdtemp(join(root, 'fixture-'));
const native = join(fixture, 'native'), state = join(fixture, 'state'), work = join(fixture, 'work');
for (const folder of [native, state, work]) await mkdir(folder, { recursive: true, mode: 0o700 });
// These changes apply only to this fixture process and its own SDK children.
process.env.CODEX_HOME = native;
process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
process.env.GATEWAY_TELEMETRY = values['executor-diagnostics'] ? 'on' : 'off';
process.env.GATEWAY_ERROR_REPORTS = 'off';
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_GATEWAY_EXECUTOR', 'GATEFOX_EXECUTOR']) delete process.env[key];
const load = name => import(pathToFileURL(join(source, 'dist', name + '.js')));
const { AppServerBackends } = await load('app-server-backends');
const { AppServerRouter } = await load('app-server-router');
const { startExecutionHost } = await load('execution-host');
const { setExecutionHostRootForTests, setSdkSocketRootForTests } = await load('execution-host-storage');
const { setNativeOwnerRootForTests } = await load('native-execution-host-storage');
// The source bridge is optional on the baseline, so the same fixture reproduces its absence.
const nativeStatus = await load('native-runtime-status').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined;
  throw error;
});
nativeStatus?.setNativeRuntimeRootForTests(join(fixture, 'r'));
const { setOwnPidForTests } = await load('boot-identity');
const { gatewaySdkRuntime } = await load('gateway-sdk-runtime');
const { modelCatalog } = await load('catalog');
const { startGateway } = await load('server');
const { writePrivateJson } = await load('config');
const { configureTelemetry, flushTelemetry, readTelemetry } = await load('telemetry');
const { ProviderError } = await load('providers/provider');
const { CompletionReplay, completionReplayStorage } = await load('completion-replay');
const { gatewayClientDevice } = await load('shim-session');
if (values['executor-diagnostics']) configureTelemetry(state, 'fixture');
setExecutionHostRootForTests(join(fixture, 'x'));
setNativeOwnerRootForTests(join(fixture, 'n'));
// The real SDK owns its protected rendezvous; receipts and all chat paths are isolated.
setSdkSocketRootForTests();
setOwnPidForTests(process.pid + 1_000_000);
const runtime = await gatewaySdkRuntime(pkg);
assert.ok(runtime?.executorIdentity, 'A verified gateway SDK is required');
const sdk = runtime.executable, configPath = join(fixture, 'gateway.json'), alias = 'fixture/chat-state';
const config = { version: 1, port: 0, stateDirectory: state, timeoutMs: 30_000,
  providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'GATEWAY_CHAT_STATE_FIXTURE_KEY',
    baseUrl: 'http://127.0.0.1:1', models: { [alias]: 'mock-model' },
    modelMetadata: { [alias]: { contextWindow: 32_768, reasoningEfforts: ['low'] } } }] };
const until = async (check, name, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(25); }
  throw Error(name + ' timed out');
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let gate, calls = 0, host, gateway, failNext = false, upstream;
let phase = 'server';
const clients = [];
const evidence = { fixture, engine: values.native ? 'native' : values.private ? 'private-gateway' : 'shared-gateway',
  realGatewaySdk: true, paidInferenceRequests: 0, passed: false };
try {
  if (values['truncated-upstream']) {
    upstream = await chatStateUpstream({ currentCall: () => calls, gate: () => gate?.promise, fail: () => { const failed = failNext; failNext = false; return failed; } });
    config.providers[0].baseUrl = upstream.baseUrl;
    process.env.GATEWAY_CHAT_STATE_FIXTURE_KEY = 'synthetic-local-fixture';
  }
  const { ResponsesAPI } = await load('providers/responses-api');
  gateway = await startGateway(config, provider => values['truncated-upstream'] ? {
    async *infer(request, signal, context) { calls++; yield* new ResponsesAPI(provider).infer(request, signal, context); },
  } : ({
    async *infer(_request, signal) {
      calls++;
      if (gate) await Promise.race([gate.promise, new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Error('Fixture cancelled')), { once: true });
      })]);
      if (failNext) { failNext = false; throw new ProviderError('usage_limit', 'Synthetic subscription usage limit reached', 429); }
      yield { type: 'text', text: 'Fixture answer.' };
      yield { type: 'done', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
    },
  }), undefined, { copilotTempBase: join(fixture, 'provider-tmp') });
  config.port = gateway.address().port;
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, 'service-plan.json'), { version: 1, config: configPath, sharedExecutors: !values.private,
    components: [{ id: 'native', kind: 'native', command: sdk,
      args: ['--codex', sdk, '--native-home', native], log: join(state, 'native.log') }] });
  const rows = modelCatalog(config).models;
  const nativeCatalog = join(native, 'models.json');
  await writePrivateJson(nativeCatalog, { models: [{ ...rows[0], slug: 'native-fixture' }] });
  const nativeModel = values.native ? alias : 'native-fixture';
  const nativeProvider = values.native ? 'fixture_native' : 'openai';
  // A native engine can use the fixture HTTP transport without becoming a gateway executor.
  const nativeRoute = values.native ? `\n[model_providers.fixture_native]\nname = "Fixture native"\nbase_url = "http://127.0.0.1:${config.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[model_providers.fixture_native.auth]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([join(source, 'dist/cli.js'), 'token', '--config', configPath])}\n` : '';
  if (values.native) await writePrivateJson(nativeCatalog, { models: rows });
  const nativeConfig = `model = ${JSON.stringify(nativeModel)}\nmodel_provider = ${JSON.stringify(nativeProvider)}\nmodel_catalog_json = ${JSON.stringify(nativeCatalog)}\nweb_search = "disabled"\n[features]\nremote_control = false\n[analytics]\nenabled = false\n${nativeRoute}`;
  await writeFile(join(native, 'config.toml'), nativeConfig, { mode: 0o600 });
  const snapshot = { revision: 'a'.repeat(64), models: rows };
  await writePrivateJson(join(state, 'fixture-catalog.json'), { models: rows });
  const catalog = { current: () => snapshot, refresh: async () => snapshot,
    combined: value => ({ models: value.models }), nativeSlugs: new Set(['native-fixture']) };
  phase = 'host';
  if (!values.private) host = await startExecutionHost({ config, configPath, nativeHome: native, codex: sdk, gatewayRuntime: async () => runtime });
  const overrides = { name: 'Fixture', base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 30_000,
    'auth.command': process.execPath, 'auth.args': [join(source, 'dist/cli.js'), 'token', '--config', configPath] };
  async function client(name, device) {
    phase = name + ':initialize';
    const events = [], methods = [];
    let replay;
    const backend = await AppServerBackends.create(values['native-engine'] ?? sdk, ['app-server', '--listen', 'stdio://'], config, {}, overrides, catalog,
      async message => { if (!replay || !replay.forward(message)) return; events.push(message); await replay.written(message); }, () => {}, configPath);
    backend.resolveRuntime = async () => runtime;
    const router = new AppServerRouter(config, (method, params, hint) => {
      methods.push(method); return backend.request(method, params, hint);
    }, join(state, 'fixture-catalog.json'), undefined, native, backend.identity);
    replay = new CompletionReplay({ storage: completionReplayStorage(state), request: (method, params) => router.request(method, params), emit: async message => { events.push(message); }, awaitClient: true });
    const first = device ? { method: 'gateway/client', params: { device } } : { id: 1, method: 'initialize', params: {} };
    const identified = gatewayClientDevice(first, true, false);
    if (identified) replay.setDevice(identified); else replay.settleDevice();
    clients.push(backend);
    await router.initialize();
    await router.request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } });
    backend.notify({ method: 'initialized', params: {} });
    return { backend, router, events, methods, replay };
  }
  const replayDevices = ['1'.repeat(32), '2'.repeat(32)];
  const writer = await client('chat_state_writer', replayDevices[0]);
  const writerRpc = values.native ? (method, params) => writer.backend.native.request(method, params)
    : (method, params) => writer.router.request(method, params);
  phase = 'chat:start';
  const started = await writerRpc('thread/start', { model: alias, cwd: work, sandbox: 'read-only', approvalPolicy: 'never' });
  const id = started.thread.id;
  phase = 'chat:seed';
  const seed = await writerRpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'Seed fixture history.' }] });
  await until(() => writer.events.find(message => message.method === 'turn/completed' && message.params.turn.id === seed.turn.id), 'Seed turn');
  const sleepingSecond = values['replay-completion'] ? await client('completion_replay_sleeping_second', replayDevices[1]) : undefined;
  if (sleepingSecond) await sleepingSecond.router.request('thread/resume', {threadId: id});
  gate = deferred();
  phase = 'chat:active';
  const active = await writerRpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'Hold this fixture turn.' }] });
  await until(() => calls === 2, 'Running inference');
  if (values['restart-discovery']) {
    assert.ok(!values.private && !values.native && !values.unread && !values['executor-diagnostics'], 'Restart fixture requires shared gateway execution');
    await writer.backend.stop();
    evidence.previousApplicationClientDisconnected = true;
  }
  if (values['replay-completion']) {
    assert.ok(!values.private && !values.native && !values.unread && !values['restart-discovery'] && !values['executor-diagnostics'], 'Completion replay requires shared gateway execution');
    await until(() => sleepingSecond.events.some(message => message.method === 'turn/started' && message.params.threadId === id && message.params.turn.id === active.turn.id), 'Second device follows active turn');
    await Promise.all([writer.replay.settled(), sleepingSecond.replay.settled()]); await Promise.all([writer.backend.stop(), sleepingSecond.backend.stop()]); evidence.previousApplicationClientDisconnected = true;
    phase = 'replay:offline-completion'; gate.resolve();
    const readers = await Promise.all(replayDevices.map((device, index) => client(`completion_replay_reader_${index + 1}`, device)));
    await until(async () => (await readers[0].router.request('thread/turns/list', {threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'})).data[0]?.status === 'completed', 'Offline completion');
    // This fixture owns the router directly instead of shimSession's JSON pipe;
    // awaiting its RPC is the same successful reply boundary before the shared
    // CompletionReplay instance runs, without adding a second app-server layer.
    const resume = async reader => { await reader.router.request('thread/resume', {threadId: id}); await reader.replay.resume(id); };
    phase = 'replay:resume'; await Promise.all(readers.map(resume));
    await until(() => readers.every(reader => reader.events.filter(message => message.method === 'turn/completed' && message.params.threadId === id && message.params.turn.id === active.turn.id).length === 1), 'One replayed completion per device');
    await Promise.all(readers.map(resume));
    assert.ok(readers.every(reader => reader.events.filter(message => message.method === 'turn/completed' && message.params.threadId === id && message.params.turn.id === active.turn.id).length === 1), 'A second resume must not replay');
    assert.equal(calls, 2, 'Replay must not start inference');
    evidence.replayedCompletionTurnId = active.turn.id;
    evidence.replayedCompletionStatus = 'completed';
    evidence.replayedCompletionEvents = 2;
  } else {
  const phone = await client('chat_state_list_client');
  let restoreDiscovery;
  if (values['delayed-discovery']) {
    // Test seam: the host remains alive, but the first list cannot discover its generations.
    const original = phone.backend.chatListSources.bind(phone.backend);
    phone.backend.chatListSources = async () => undefined;
    restoreDiscovery = () => { phone.backend.chatListSources = original; };
  }
  phase = 'chat:list';
  const stored = await phone.backend.native.request('thread/list', { modelProviders: [], limit: 100 });
  assert.equal(stored.data.find(thread => thread.id === id).status.type, 'notLoaded');
  evidence.nativeListWasNotLoaded = true;
  const listed = await phone.router.request('thread/list', { limit: 100, useStateDbOnly: values['restart-discovery'] });
  const row = listed.data.find(thread => thread.id === id);
  if (values['delayed-discovery']) {
    assert.equal(row?.status.type, 'notLoaded', 'The first native-only list reproduces the cold startup gap');
    phase = 'restart:delayed-discovery'; restoreDiscovery();
    await until(() => phone.events.some(message => message.method === 'thread/status/changed' &&
      message.params.threadId === id && message.params.status.type === 'active'), 'Automatic rediscovery without another list', 12_000);
    evidence.activeStatusRecoveredWithoutAnotherList = true;
  } else {
    assert.equal(row?.status.type, 'active', 'The list must read the owning gateway engine');
    assert.equal(row.model, alias);
  }
  assert.equal(phone.methods.includes('thread/resume'), false);
  assert.equal(calls, 2, 'Listing must not start inference');
  evidence.runningVisibleWithoutResume = true;
  if (values['restart-discovery']) {
    assert.equal(phone.methods.filter(method => method === 'thread/list').length, 1);
    assert.equal(phone.methods.includes('thread/loaded/list'), false, 'Discovery matches the desktop thread/list bootstrap');
    const snapshot = await phone.router.request('thread/read', {threadId: id, includeTurns: true});
    assert.equal(snapshot.thread.turns.at(-1).id, active.turn.id, 'Reconnect preserves the actual running turn');
    assert.equal(snapshot.thread.turns.at(-1).status, 'inProgress');
    evidence.sameRunningTurnRestored = true;
  }
  const loaded = await phone.router.request('thread/loaded/list', { limit: 100 });
  assert.ok(loaded.data.includes(id), 'The loaded list must include gateway chats');
  evidence.loadedListIncludesGateway = true;
  if (values.activity) {
    const { readActivity } = await load('activity');
    const report = await readActivity(configPath, state, { nativeHome: native });
    const row = report.rows.find(row => row.threadId === id);
    assert.equal(row?.state, 'running');
    assert.equal(row.turn.id, active.turn.id);
    evidence.gatewayActivityVerifiedRunning = true;
  }
  const offset = phone.events.length;
  phase = 'chat:completion';
  gate.resolve();
  if (values['restart-discovery']) {
    await until(async () => {
      const reply = await phone.router.request('thread/read', {threadId: id, includeTurns: true});
      return reply.thread.turns.at(-1).id === active.turn.id && reply.thread.turns.at(-1).status === 'completed';
    }, 'Persisted completion after client restart');
  } else {
    await until(() => writer.events.find(message => message.method === 'turn/completed' && message.params.turn.id === active.turn.id), 'Writer completion');
  }
  await until(() => phone.events.slice(offset).find(message => message.method === 'thread/status/changed' &&
    message.params.threadId === id && message.params.status.type === 'idle'), 'List client idle event');
  assert.equal(phone.events.some(message => message.method === 'item/agentMessage/delta' || message.method === 'turn/completed'), false,
    'A passive list client must not subscribe to turn content');
  assert.equal(calls, 2);
  assert.equal(await readFile(join(native, 'config.toml'), 'utf8'), nativeConfig);
  evidence.completionStatusDelivered = true;
  evidence.passiveClientReceivedNoTurnContent = true;
  evidence.nativeConfigurationUnchanged = true;
  if (values.activity) {
    assert.ok(!values.native && !values.private && !values.unread && !values['executor-diagnostics'], 'Activity uses a shared gateway fixture');
    const { readActivity } = await load('activity');
    let report = await readActivity(configPath, state, { nativeHome: native });
    assert.equal(report.rows.find(row => row.threadId === id)?.state, 'completed');
    gate = deferred();
    const activityWriter = values['restart-discovery'] ? await client('activity_rejoined_writer') : writer;
    if (activityWriter !== writer) await activityWriter.router.request('thread/resume', { threadId: id });
    const offline = await activityWriter.router.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Synthetic offline completion for Gateway activity.' }] });
    await until(() => calls === 3, 'Held activity completion request');
    if (upstream) await upstream.truncated;
    await phone.backend.stop(); await activityWriter.backend.stop();
    gate.resolve();
    await until(async () => {
      const snapshot = await readActivity(configPath, state, { nativeHome: native });
      return snapshot.rows.some(row => row.threadId === id && row.turn?.id === offline.turn.id && row.state === 'completed');
    }, 'Gateway activity sees completion after both clients disappear');
    evidence.gatewayActivityOfflineCompletion = true;
    if (upstream) {
      assert.equal(upstream.stats.truncatedFrames, 1); assert.equal(upstream.stats.prematureDisconnects, 0);
      assert.equal(upstream.stats.requests, 4, 'One pre-output provider recovery, without a new SDK inference request');
      evidence.offlineTruncatedStreamRecovered = true;
    }
    const controller = await client('activity_failure_controller');
    await controller.router.request('thread/resume', { threadId: id });
    gate = deferred(); failNext = true;
    const failed = await controller.router.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Synthetic offline failure for Gateway activity.' }] });
    await until(() => calls === 4, 'Held activity failure request');
    await controller.backend.stop();
    gate.resolve();
    report = await until(async () => {
      const snapshot = await readActivity(configPath, state, { nativeHome: native });
      return snapshot.rows.some(row => row.threadId === id && row.turn?.id === failed.turn.id && row.state === 'failed') ? snapshot : undefined;
    }, 'Gateway activity sees failure after all app clients disappear');
    assert.equal(report.rows.find(row => row.threadId === id).turn.errorClass, 'usage_limit');
    report = await readActivity(configPath, state, { nativeHome: native });
    assert.equal(report.rows.find(row => row.threadId === id).state, 'failed', 'Refreshing does not hide a persisted failure');
    assert.equal(calls, 4, 'Activity never starts or retries inference');
    assert.equal(await readFile(join(native, 'config.toml'), 'utf8'), nativeConfig);
    evidence.gatewayActivityOfflineFailure = true;
    evidence.gatewayActivityNoInferenceOrClientMutation = true;
    if (upstream) {
      phase = 'explicit:stop';
      const stopper = await client('offline_recovery_stop_controller');
      await stopper.router.request('thread/resume', { threadId: id });
      gate = deferred();
      const stopped = await stopper.router.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Hold this synthetic request until explicit Stop.' }] });
      await until(() => calls === 5 && upstream.stats.requests === 6, 'Explicit Stop fixture reaches provider');
      await stopper.router.request('turn/interrupt', { threadId: id, turnId: stopped.turn.id });
      await until(async () => (await stopper.router.request('thread/read', { threadId: id, includeTurns: true })).thread.turns.find(turn => turn.id === stopped.turn.id)?.status === 'interrupted', 'Explicit Stop remains authoritative');
      await until(() => upstream.stats.prematureDisconnects === 1, 'Explicit Stop cancels upstream inference');
      assert.equal(calls, 5); assert.equal(upstream.stats.requests, 6);
      evidence.explicitStopPreserved = true;
      evidence.upstreamRequests = upstream.stats.requests;
    }
  }
  if (values['executor-diagnostics']) {
    assert.ok(!values.private && !values.native && !values.unread, 'Diagnostics fixture requires shared gateway execution');
    phase = 'diagnostics:initial-census';
    const settled = async () => {
      await flushTelemetry();
      return (await readTelemetry(state, 0)).filter(event => event.event === 'executor_turn_settled');
    };
    await until(async () => (await settled()).some(event => event.turnId === active.turn.id), 'Automatic executor census', 45_000);
    gate = deferred(); failNext = true;
    const failed = await writerRpc('turn/start', {threadId: id, input: [{type: 'text', text: 'Synthetic offline failure.'}]});
    await until(() => calls === 3, 'Held failure request');
    // Both application clients disappear. The host and its inference turn continue.
    await phone.backend.stop(); await writer.backend.stop();
    phase = 'diagnostics:offline-failure';
    gate.resolve();
    const recorded = await until(async () => (await settled()).find(event => event.turnId === failed.turn.id), 'Offline failure telemetry', 45_000);
    assert.equal(recorded.errorClass, 'usage_limit');
    assert.equal(recorded.engine, 'gateway');
    const reconnected = await client('diagnostics_reconnected');
    const reply = await reconnected.router.request('thread/turns/list', {threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded'});
    assert.equal(reply.data[0].id, failed.turn.id);
    assert.equal(recorded.status, reply.data[0].status);
    assert.equal((await settled()).filter(event => event.turnId === failed.turn.id).length, 1);
    evidence.offlineFailureRecorded = true;
    evidence.offlineFailureClass = recorded.errorClass;
    evidence.offlineFailureStatus = recorded.status;
    evidence.bothApplicationClientsDisconnected = true;
  }
  if (values.unread) {
    assert.equal(values.private, false, 'Offline unread check requires a shared executor');
    const { installReadStateBridge } = await import(pathToFileURL(join(source, 'scripts/codex-unread-trial/read-state-bridge.mjs')));
    const saved = new Map(), loadedUi = new Map(), listeners = new Set();
    const store = { has: id => saved.get(id), isReady: () => true,
      set(id, unread) { saved.set(id, unread); },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
    const connection = { sendRequest: (method, params, ...rest) => phone.router.request(method, params, ...rest) };
    const notify = (id, unread) => loadedUi.set(id, unread);
    let bridge = installReadStateBridge({client: connection, saved: store, notify});
    try {
      await connection.sendRequest('thread/list', {limit: 100});
      assert.equal(store.has(id), true, 'Existing completion is unread before an explicit read');
      const latest = await connection.sendRequest('thread/turns/list', {threadId: id, limit: 1, sortDirection: 'desc', itemsView: 'full'});
      // This fixture supplies a hydrated view; native-window hydration still needs separate verification.
      const view = {visible: true, history: {isComplete: true, turns: latest.data.map(turn => ({turnId: turn.id, status: turn.status}))}};
      assert.equal(await bridge.readVisible(id, () => view, () => {
        store.set(id, false); loadedUi.set(id, false); bridge.mark(id, false);
      }), true, 'A matching hydrated view permits the guarded acknowledgement');
      await until(async () => (await writerRpc('thread/read', {threadId: id})).readState?.firstUnread === null, 'Durable read acknowledgement');
      bridge.dispose();
      await phone.backend.stop();
      gate = deferred();
      const offline = await writerRpc('turn/start', {threadId: id, input: [{type: 'text', text: 'Finish while fixture reader is offline.'}]});
      await until(() => calls === 3, 'Offline inference');
      gate.resolve();
      await until(() => writer.events.some(message => message.method === 'turn/completed' && message.params.turn.id === offline.turn.id), 'Offline completion');
      const reconnected = await client('unread_reconnected');
      connection.sendRequest = (method, params, ...rest) => reconnected.router.request(method, params, ...rest);
      loadedUi.clear();
      bridge = installReadStateBridge({client: connection, saved: store, notify});
      const result = await connection.sendRequest('thread/list', {limit: 100});
      assert.equal(result.readStates[id].firstUnread.turnId, offline.turn.id);
      assert.equal(store.has(id), true, 'Reconnect receipt restores the unread boolean');
      assert.equal(loadedUi.get(id), true, 'The client receives an explicit UI state update');
      assert.equal(reconnected.events.some(message => message.method === 'turn/completed'), false, 'No synthetic terminal replay');
      assert.equal(await bridge.readVisible(id, () => view, () => {
        throw Error('An old transcript must never reach the semantic read action');
      }), false, 'Newly completed offline work is not cleared by the older loaded transcript');
      view.history.turns = [{turnId: offline.turn.id, status: 'completed'}];
      assert.equal(await bridge.readVisible(id, () => view, () => {
        store.set(id, false); loadedUi.set(id, false); bridge.mark(id, false);
      }), true, 'Hydrating the offline completion permits a fresh guarded read');
      await until(async () => (await writerRpc('thread/read', {threadId: id})).readState?.firstUnread === null, 'Reconnect read acknowledgement');
      await connection.sendRequest('thread/list', {limit: 100});
      assert.equal(store.has(id), false, 'A later refresh does not resurrect already-read attention');
      evidence.offlineUnreadReceiptApplied = true;
      evidence.oldTranscriptDidNotClearNewWork = true;
      evidence.guardedHydratedReadPersisted = true;
      evidence.explicitReadPersisted = true;
      evidence.readRefreshStayedRead = true;
      evidence.terminalReplayEvents = reconnected.events.filter(message => message.method === 'turn/completed').length;
    } finally { bridge.dispose(); }
  }
  }
  evidence.mockInferenceRequests = calls;
  evidence.passed = true;
} catch (error) {
  evidence.failedDuring = phase;
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  gate?.resolve();
  await Promise.allSettled(clients.map(client => client.stop()));
  await host?.close();
  if (gateway) { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)); }
  await upstream?.close();
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
