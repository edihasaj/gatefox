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

const { values } = parseArgs({ options: { package: { type: 'string' }, root: { type: 'string' },
  native: { type: 'boolean', default: false }, private: { type: 'boolean', default: false }, code: { type: 'string' },
  unread: { type: 'boolean', default: false }, 'native-engine': { type: 'string' } } });
assert.ok(values.package && values.root, 'Pass --package INSTALLED_PACKAGE --root EVIDENCE_DIRECTORY');
const source = resolve(values.code ?? fileURLToPath(new URL('..', import.meta.url))), pkg = resolve(values.package);
const root = resolve(values.root), fixture = await mkdtemp('/tmp/gw-chat-state-');
const native = join(fixture, 'native'), state = join(fixture, 'state'), work = join(fixture, 'work');
for (const folder of [root, native, state, work]) await mkdir(folder, { recursive: true, mode: 0o700 });
// These changes apply only to this fixture process and its own SDK children.
process.env.CODEX_HOME = native;
process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
process.env.GATEWAY_TELEMETRY = 'off';
process.env.GATEWAY_ERROR_REPORTS = 'off';
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_GATEWAY_EXECUTOR']) delete process.env[key];
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
let gate, calls = 0, host, gateway;
let phase = 'server';
const clients = [];
const evidence = { fixture, engine: values.native ? 'native' : values.private ? 'private-gateway' : 'shared-gateway',
  realGatewaySdk: true, paidInferenceRequests: 0, passed: false };
try {
  gateway = await startGateway(config, () => ({
    async *infer(_request, signal) {
      calls++;
      if (gate) await Promise.race([gate.promise, new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Error('Fixture cancelled')), { once: true });
      })]);
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
  async function client(name) {
    phase = name + ':initialize';
    const events = [], methods = [];
    const backend = await AppServerBackends.create(values['native-engine'] ?? sdk, ['app-server', '--listen', 'stdio://'], config, {}, overrides, catalog,
      async message => { events.push(message); }, () => {}, configPath);
    backend.resolveRuntime = async () => runtime;
    const router = new AppServerRouter(config, (method, params, hint) => {
      methods.push(method); return backend.request(method, params, hint);
    }, join(state, 'fixture-catalog.json'), undefined, native, backend.identity);
    clients.push(backend);
    await router.initialize();
    await router.request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } });
    backend.notify({ method: 'initialized', params: {} });
    return { backend, router, events, methods };
  }
  const writer = await client('chat_state_writer');
  const writerRpc = values.native ? (method, params) => writer.backend.native.request(method, params)
    : (method, params) => writer.router.request(method, params);
  phase = 'chat:start';
  const started = await writerRpc('thread/start', { model: alias, cwd: work, sandbox: 'read-only', approvalPolicy: 'never' });
  const id = started.thread.id;
  phase = 'chat:seed';
  const seed = await writerRpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'Seed fixture history.' }] });
  await until(() => writer.events.find(message => message.method === 'turn/completed' && message.params.turn.id === seed.turn.id), 'Seed turn');
  gate = deferred();
  phase = 'chat:active';
  const active = await writerRpc('turn/start', { threadId: id, input: [{ type: 'text', text: 'Hold this fixture turn.' }] });
  await until(() => calls === 2, 'Running inference');
  const phone = await client('chat_state_list_client');
  phase = 'chat:list';
  const stored = await phone.backend.native.request('thread/list', { modelProviders: [], limit: 100 });
  assert.equal(stored.data.find(thread => thread.id === id).status.type, 'notLoaded');
  evidence.nativeListWasNotLoaded = true;
  const listed = await phone.router.request('thread/list', { limit: 100 });
  const row = listed.data.find(thread => thread.id === id);
  assert.equal(row?.status.type, 'active', 'The list must read the owning gateway engine');
  assert.equal(row.model, alias);
  assert.equal(phone.methods.includes('thread/resume'), false);
  assert.equal(calls, 2, 'Listing must not start inference');
  evidence.runningVisibleWithoutResume = true;
  const loaded = await phone.router.request('thread/loaded/list', { limit: 100 });
  assert.ok(loaded.data.includes(id), 'The loaded list must include gateway chats');
  evidence.loadedListIncludesGateway = true;
  const offset = phone.events.length;
  phase = 'chat:completion';
  gate.resolve();
  await until(() => writer.events.find(message => message.method === 'turn/completed' && message.params.turn.id === active.turn.id), 'Writer completion');
  await until(() => phone.events.slice(offset).find(message => message.method === 'thread/status/changed' &&
    message.params.threadId === id && message.params.status.type === 'idle'), 'List client idle event');
  assert.equal(phone.events.some(message => message.method === 'item/agentMessage/delta' || message.method === 'turn/completed'), false,
    'A passive list client must not subscribe to turn content');
  assert.equal(calls, 2);
  assert.equal(await readFile(join(native, 'config.toml'), 'utf8'), nativeConfig);
  evidence.completionStatusDelivered = true;
  evidence.passiveClientReceivedNoTurnContent = true;
  evidence.nativeConfigurationUnchanged = true;
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
      store.set(id, false); loadedUi.set(id, false); bridge.mark(id, false);
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
      store.set(id, false); loadedUi.set(id, false); bridge.mark(id, false);
      await until(async () => (await writerRpc('thread/read', {threadId: id})).readState?.firstUnread === null, 'Reconnect read acknowledgement');
      await connection.sendRequest('thread/list', {limit: 100});
      assert.equal(store.has(id), false, 'A later refresh does not resurrect already-read attention');
      evidence.offlineUnreadReceiptApplied = true;
      evidence.explicitReadPersisted = true;
      evidence.readRefreshStayedRead = true;
      evidence.terminalReplayEvents = reconnected.events.filter(message => message.method === 'turn/completed').length;
    } finally { bridge.dispose(); }
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
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
