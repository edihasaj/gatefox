// Drops only a shared gateway SDK client socket during real SDK inference.
// The provider, homes, credentials and ownership roots belong to this fixture.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { package: { type: 'string' }, code: { type: 'string' }, root: { type: 'string' } } });
assert.ok(values.package && values.root, 'Pass --package SDK_PACKAGE --root EVIDENCE_DIRECTORY');
const code = resolve(values.code ?? new URL('..', import.meta.url).pathname);
const root = resolve(values.root), fixture = await mkdtemp('/tmp/gw-reconnect-');
const native = join(fixture, 'native'), state = join(fixture, 'state'), work = join(fixture, 'work');
for (const folder of [root, native, state, work, join(fixture, 'home')]) await mkdir(folder, { recursive: true, mode: 0o700 });
process.env.HOME = join(fixture, 'home');
process.env.CODEX_HOME = native;
process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
process.env.GATEWAY_TELEMETRY = 'off';
process.env.GATEWAY_ERROR_REPORTS = 'off';
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_GATEWAY_EXECUTOR', 'GATEFOX_EXECUTOR']) delete process.env[key];
const load = name => import(pathToFileURL(join(code, 'dist', name + '.js')));
const [{ AppServerBackends }, { AppServerRouter }, { startExecutionHost }, storage,
  { setNativeOwnerRootForTests }, { setNativeRuntimeRootForTests }, { setOwnPidForTests },
  { gatewaySdkRuntime }, { modelCatalog }, { startGateway }, { writePrivateJson }] = await Promise.all([
  load('app-server-backends'), load('app-server-router'), load('execution-host'), load('execution-host-storage'),
  load('native-execution-host-storage'), load('native-runtime-status'), load('boot-identity'),
  load('gateway-sdk-runtime'), load('catalog'), load('server'), load('config'),
]);
storage.setExecutionHostRootForTests(join(fixture, 'x'));
storage.setSdkSocketRootForTests();
setNativeOwnerRootForTests(join(fixture, 'n'));
setNativeRuntimeRootForTests(join(fixture, 'r'));
setOwnPidForTests(process.pid + 1_000_000);
const runtime = await gatewaySdkRuntime(resolve(values.package));
assert.ok(runtime?.executorIdentity, 'Use a verified gateway SDK package');
const alias = 'fixture/reconnect', configPath = join(fixture, 'gateway.json');
const config = { version: 1, port: 0, stateDirectory: state, timeoutMs: 60_000,
  providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'FIXTURE_ONLY_KEY',
    baseUrl: 'http://127.0.0.1:1', models: { [alias]: 'mock-reconnect' },
    modelMetadata: { [alias]: { contextWindow: 100_000, reasoningEfforts: ['low'] } } }] };
const evidence = { realGatewaySdk: true, paidInferenceRequests: 0, passed: false, scenarios: [] };
const until = async (check, name, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(20); }
  throw Error(name + ' timed out');
};
let host, gateway, backend, held, callCount = 0, phase = 'setup', approvalRequested = false;
let prefixEmitted = false;
const counter = join(work, 'command-count');
const toolRows = tools => (tools ?? []).flatMap(tool => tool.type === 'namespace'
  ? toolRows(tool.tools).map(child => ({ ...child, namespace: tool.name === 'functions' ? undefined : tool.name }))
  : [{ name: tool.name ?? tool.function?.name }]);
try {
  gateway = await startGateway(config, () => ({ async *infer(request) {
    callCount++;
    if (phase === 'approval') {
      if (!approvalRequested) {
        approvalRequested = true;
        const tool = toolRows(request.tools).find(tool => tool.name === 'exec_command');
        assert.ok(tool, 'Real gateway SDK must expose its command tool');
        yield { type: 'tool', call: { type: 'function', id: 'fixture_command_once',
          responseTool: { type: 'function', name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) },
          function: { name: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name,
            arguments: JSON.stringify({ cmd: `printf x >> '${counter}'`, sandbox_permissions: 'require_escalated',
              justification: 'Owned fixture command replay counter', yield_time_ms: 1000, max_output_tokens: 20 }) } } };
        yield { type: 'done', endTurn: false, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      } else {
        assert.equal(await readFile(counter, 'utf8'), 'x', 'Command must execute exactly once');
        yield { type: 'text', text: 'APPROVAL_RECONNECT_COMPLETE' };
        yield { type: 'done', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
      }
      return;
    }
    // Keep the provider busy until the test has observed automatic reattachment.
    let release, partial;
    const wait = new Promise(resolve => { release = resolve; });
    const prefix = new Promise(resolve => { partial = resolve; });
    held = { release, partial };
    await prefix;
    yield { type: 'text', text: 'EARLY_TEXT_DURING_DISCONNECT ' };
    prefixEmitted = true;
    await wait;
    yield { type: 'text', text: 'RECONNECT_FIXTURE_COMPLETE' };
    yield { type: 'done', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  } }), undefined, { copilotTempBase: join(fixture, 'provider-tmp') });
  config.port = gateway.address().port;
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, 'service-plan.json'), { version: 1, config: configPath, sharedExecutors: true,
    components: [{ id: 'native', kind: 'native', command: runtime.executable,
      args: ['--codex', runtime.executable, '--native-home', native], log: join(state, 'native.log') }] });
  const rows = modelCatalog(config).models;
  const nativeRow = { ...rows[0], slug: 'native-fixture' };
  const catalogPath = join(state, 'models.json');
  await writePrivateJson(catalogPath, { models: [nativeRow, ...rows] });
  await writePrivateJson(join(native, 'models.json'), { models: [nativeRow] });
  await writeFile(join(native, 'config.toml'), `model = "native-fixture"\nmodel_catalog_json = ${JSON.stringify(join(native, 'models.json'))}\nweb_search = "disabled"\n[features]\nremote_control = false\nplugins = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  const snapshot = { revision: 'b'.repeat(64), models: rows };
  const catalog = { current: () => snapshot, refresh: async () => snapshot,
    combined: value => ({ models: [nativeRow, ...value.models] }), nativeSlugs: new Set(['native-fixture']), isNative: model => model === 'native-fixture' };
  host = await startExecutionHost({ config, configPath, nativeHome: native, codex: runtime.executable, gatewayRuntime: async () => runtime });
  const overrides = { name: 'Fixture', base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 60_000,
    'auth.command': process.execPath, 'auth.args': [join(code, 'dist/cli.js'), 'token', '--config', configPath] };
  const events = [];
  backend = await AppServerBackends.create(runtime.executable, ['app-server', '--listen', 'stdio://'], config,
    { features: { plugins: false } }, overrides, catalog, async message => { events.push(message); }, () => {}, configPath);
  backend.resolveRuntime = async () => runtime;
  const router = new AppServerRouter(config, (method, params, hint) => backend.request(method, params, hint), catalogPath, catalog, native, backend.identity);
  await router.initialize();
  await router.request('initialize', { clientInfo: { name: 'gateway_reconnect_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  backend.notify({ method: 'initialized', params: {} });
  for (const scenario of ['running', 'completed-while-disconnected']) {
    phase = scenario;
    held = undefined;
    const chat = await router.request('thread/start', { model: alias, cwd: work, approvalPolicy: 'never', sandbox: 'read-only', historyMode: 'paginated' });
    const id = chat.thread.id;
    const started = await router.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Return the fixture marker.' }] });
    const turnId = started.turn.id;
    await until(() => held, 'Held provider request');
    const recordedItems = await backend.request('thread/items/list', { threadId: id, turnId, limit: 100 });
    assert.ok(Array.isArray(recordedItems.data), 'Real gateway SDK must expose authoritative item lifecycle entries');
    const before = callCount;
    // Private fixture introspection deliberately targets only the adapter's SDK
    // client. It cannot stop or replace the real gateway SDK process.
    const old = backend.bindings.get(id);
    assert.ok(old?.shared && old.active.get(id) === turnId);
    const receiptBefore = JSON.parse(await readFile(join(storage.executionHostHome(configPath, native), 'owner.json'), 'utf8'));
    const pidBefore = receiptBefore.generations.find(g => g.revision === old.revision).pid;
    // Delay only this fixture's recovery entry until an actual provider delta
    // was emitted with no frontend attached. Production timing stays untouched.
    const reconnect = backend.reattach.bind(backend);
    let allowReconnect;
    const reconnectGate = new Promise(resolve => { allowReconnect = resolve; });
    backend.reattach = async (...args) => { await reconnectGate; return reconnect(...args); };
    old.connection.stop();
    prefixEmitted = false;
    held.partial();
    await until(() => prefixEmitted, 'Text emitted while disconnected');
    if (scenario === 'completed-while-disconnected') held.release();
    await delay(100);
    allowReconnect();
    const current = await until(() => {
      const current = backend.bindings.get(id);
      return current && current !== old && !current.connection.closed && current.threads.has(id) ? current : undefined;
    }, 'Automatic chat reconnect without a frontend request');
    backend.reattach = reconnect;
    if (scenario === 'running') {
      await until(() => current.active.get(id) === turnId, 'Recovered active turn identity');
      assert.equal(callCount, before, 'Reconnect must not issue another inference request');
      held.release();
    }
    await until(() => events.some(e => e.method === 'turn/completed' && e.params?.turn?.id === turnId), 'Authoritative terminal event');
    await delay(100);
    const terminals = events.filter(e => e.method === 'turn/completed' && e.params?.turn?.id === turnId);
    assert.equal(terminals.length, 1, 'A completion racing reconnect must reach the frontend once');
    assert.equal(terminals[0].params.turn.status, 'completed');
    assert.ok(events.some(e => e.method === 'item/completed' && e.params?.threadId === id
        && JSON.stringify(e.params.item).includes('RECONNECT_FIXTURE_COMPLETE')),
    'The actual final answer must reach the frontend item handler (it ignores turn.items)');
    assert.ok(events.some(e => e.method === 'item/completed' && e.params?.threadId === id
        && JSON.stringify(e.params.item).includes('EARLY_TEXT_DURING_DISCONNECT')),
    'Text emitted while disconnected must be recovered too');
    assert.ok(!events.some(e => e.method === 'error' && e.params?.threadId === id), 'Recoverable disconnect must not show an error');
    assert.equal(callCount, before, 'Recovery must not replay the prompt');
    const receiptAfter = JSON.parse(await readFile(join(storage.executionHostHome(configPath, native), 'owner.json'), 'utf8'));
    assert.equal(receiptAfter.generations.find(g => g.revision === current.revision).pid, pidBefore, 'Reconnect must reuse the owning SDK');
    evidence.scenarios.push({ name: scenario, sameSdk: true, sameTurn: true, completionCount: 1, promptReplayed: false, errorShown: false });
  }
  for (const approvalScenario of ['pending-approval', 'uncertain-approval-answer']) {
  phase = 'approval'; approvalRequested = false;
  await writeFile(counter, '', { mode: 0o600 });
  const chat = await router.request('thread/start', { model: alias, cwd: work, approvalPolicy: 'on-request', sandbox: 'read-only', historyMode: 'paginated' });
  const id = chat.thread.id;
  const started = await router.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'Run the fixture command.' }] });
  const turnId = started.turn.id;
  const pending = await until(() => events.find(e => e.id !== undefined && e.method === 'item/commandExecution/requestApproval'
    && e.params?.threadId === id), 'Owned fixture command approval');
  const before = callCount, old = backend.bindings.get(id);
  assert.equal(await readFile(counter, 'utf8').catch(() => ''), '');
  if (approvalScenario === 'uncertain-approval-answer') {
    // The frontend answered, but that write never reached the SDK. Recovery must
    // expose the genuine still-pending request again under its original id.
    const send = old.connection.send.bind(old.connection);
    old.connection.send = () => {};
    assert.equal(backend.reply({ id: pending.id, result: { decision: 'accept' } }), true);
    old.connection.send = send;
  }
  old.connection.stop();
  const recovered = await until(() => {
    const current = backend.bindings.get(id);
    return current && current !== old && !current.connection.closed && current.active.get(id) === turnId ? current : undefined;
  }, 'Approval chat automatic reconnect');
  await until(() => backend.approvals.get(pending.id)?.connection === recovered.connection, 'Original approval callback mapping');
  if (approvalScenario === 'uncertain-approval-answer') {
    await until(() => events.filter(e => e.method === pending.method && e.params?.threadId === id).length >= 2,
      'Still-pending approval must become visible to the frontend again');
  }
  const replayed = events.filter(e => e.method === pending.method && e.params?.threadId === id);
  assert.deepEqual([...new Set(replayed.map(e => e.id))], [pending.id], 'Approval must retain its frontend identity');
  assert.equal(await readFile(counter, 'utf8').catch(() => ''), '', 'Reconnection must not approve the command');
  assert.equal(callCount, before, 'Waiting approval must not trigger inference');
  assert.equal(backend.reply({ id: pending.id, result: { decision: 'accept' } }), true, 'Original approval reply must reach recovered owner');
  await until(() => events.find(e => e.method === 'turn/completed' && e.params?.turn?.id === turnId), 'Approved command completion');
  assert.equal(await readFile(counter, 'utf8'), 'x');
  assert.equal(callCount, before + 1, 'Only the genuine command result may trigger follow-up inference');
  assert.ok(!events.some(e => e.method === 'error' && e.params?.threadId === id));
  evidence.scenarios.push({ name: approvalScenario, originalApprovalId: true, automaticApproval: false, commandExecutions: 1, promptReplayed: false });
  }
  evidence.passed = true;
} catch (error) {
  evidence.failedPhase = phase;
  // Only a fixed failure category is written; no SDK or provider payloads.
  evidence.failure = error instanceof assert.AssertionError ? 'assertion' : 'fixture_failed';
  throw error;
} finally {
  held?.partial(); held?.release();
  await backend?.stop();
  await host?.close();
  await gateway?.close();
  evidence.mockProviderRequests = callCount;
  await writeFile(join(root, 'gateway-reconnect.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
