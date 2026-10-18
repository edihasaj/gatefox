// Real SDK delegation and desktop-shaped child resumes against a local mock provider.
// All homes, ownership records and inference are private to the fixture.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const { values } = parseArgs({ options: { package: { type: 'string' }, code: { type: 'string' },
  root: { type: 'string' }, private: { type: 'boolean' }, openai: { type: 'boolean' }, baseline: { type: 'boolean' },
  cold: { type: 'boolean' }, 'mixed-identity': { type: 'boolean' }, 'config-override': { type: 'boolean' } } });
assert.ok(values.package && values.root, 'Pass --package SDK_PACKAGE --root EVIDENCE_DIRECTORY');
const code = resolve(values.code ?? new URL('..', import.meta.url).pathname);
const pkg = resolve(values.package), root = resolve(values.root), fixture = await mkdtemp('/tmp/gw-child-');
const native = join(fixture, 'native'), state = join(fixture, 'state'), work = join(fixture, 'work');
for (const folder of [root, native, state, work, join(fixture, 'home')]) await mkdir(folder, { recursive: true, mode: 0o700 });
process.env.HOME = join(fixture, 'home');
process.env.CODEX_HOME = native;
process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
process.env.GATEWAY_TELEMETRY = 'off';
process.env.GATEWAY_ERROR_REPORTS = 'off';
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_GATEWAY_EXECUTOR']) delete process.env[key];
const load = name => import(pathToFileURL(join(code, 'dist', name + '.js')));
const { AppServerBackends } = await load('app-server-backends');
const { AppServerRouter } = await load('app-server-router');
const { startExecutionHost } = await load('execution-host');
const { setExecutionHostRootForTests, setSdkSocketRootForTests } = await load('execution-host-storage');
const { setNativeOwnerRootForTests } = await load('native-execution-host-storage');
const { setNativeRuntimeRootForTests } = await load('native-runtime-status');
const { setOwnPidForTests } = await load('boot-identity');
const { gatewaySdkRuntime } = await load('gateway-sdk-runtime');
const { modelCatalog } = await load('catalog');
const { startGateway } = await load('server');
const { writePrivateJson } = await load('config');
setExecutionHostRootForTests(join(fixture, 'x'));
setNativeOwnerRootForTests(join(fixture, 'n'));
setNativeRuntimeRootForTests(join(fixture, 'r'));
setSdkSocketRootForTests();
setOwnPidForTests(process.pid + 1_000_000);
const runtime = await gatewaySdkRuntime(pkg);
assert.ok(runtime?.executorIdentity, 'Use a verified installed gateway SDK');
const sdk = runtime.executable, alias = 'fixture/parent', childModel = 'gpt-6.1-sol';
const configPath = join(fixture, 'gateway.json');
const config = { version: 1, port: 0, stateDirectory: state, timeoutMs: 30_000,
  ...(values.openai ? { chatIdentity: 'openai' } : {}),
  providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'FIXTURE_ONLY_KEY',
    baseUrl: 'http://127.0.0.1:1', models: { [alias]: 'mock-parent' },
    modelMetadata: { [alias]: { contextWindow: 100_000, reasoningEfforts: ['low', 'ultra'],
      multiAgentVersion: 'v1', multiAgentReasoningEffort: 'low' } } }] };
const serverConfig = structuredClone(config);
serverConfig.providers[0].models[childModel] = 'mock-child';
const until = async (check, label, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(25); }
  throw Error(label + ' timed out');
};
let calls = 0, spawned = false, gateway, host, phase = 'setup';
const clients = [];
const evidence = { fixture, shared: !values.private, identity: values.openai ? 'openai' : 'subscription_gateway',
  realGatewaySdk: true, paidInferenceRequests: 0, passed: false };
try {
  gateway = await startGateway(serverConfig, () => ({
    async *infer(request) {
      calls++;
      const childRequest = request.model === 'mock-child';
      if (request.model === 'mock-parent' && !spawned) {
        spawned = true;
        const declared = [...(request.tools ?? []), ...(request.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])];
        const tools = declared.flatMap(tool => tool.type === 'namespace'
          ? tool.tools.map(child => ({ name: child.name, namespace: tool.name === 'functions' ? undefined : tool.name }))
          : [{ name: tool.name ?? tool.function?.name }]);
        const tool = tools.find(tool => tool.name === 'spawn_agent');
        evidence.delegationExposed = !!tool;
        assert.ok(tool, 'The real SDK exposes its delegation tool');
        yield { type: 'tool', call: { type: 'function', id: 'fixture_spawn',
          responseTool: { type: 'function', name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) },
          function: { name: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name, arguments: JSON.stringify({ task_name: 'sidebar_fixture',
            message: 'Return the fixture marker.', model: childModel, reasoning_effort: 'high', fork_turns: 'none' }) } } };
      } else yield { type: 'text', text: 'SIDEBAR_FIXTURE_COMPLETE' };
      yield { type: 'done', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
      if (childRequest) evidence.childInferenceFinished = true;
    },
  }), undefined, { copilotTempBase: join(fixture, 'provider-tmp') });
  config.port = gateway.address().port;
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, 'service-plan.json'), { version: 1, config: configPath, sharedExecutors: !values.private,
    components: [{ id: 'native', kind: 'native', command: sdk,
      args: ['--codex', sdk, '--native-home', native], log: join(state, 'native.log') }] });
  const rows = modelCatalog(config).models;
  const nativeRow = { ...rows[0], slug: childModel, multi_agent_version: undefined, default_reasoning_level: 'low',
    supported_reasoning_levels: ['low', 'high'].map(effort => ({ effort, description: effort })) };
  await writePrivateJson(join(native, 'models.json'), { models: [nativeRow] });
  await writeFile(join(native, 'config.toml'), `model = "${childModel}"\nmodel_catalog_json = ${JSON.stringify(join(native, 'models.json'))}\nweb_search = "disabled"\n[features]\nremote_control = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  const snapshot = { revision: 'a'.repeat(64), models: rows };
  const catalogPath = join(state, 'fixture-catalog.json');
  await writePrivateJson(catalogPath, { models: [nativeRow, ...rows] });
  const catalog = { current: () => snapshot, refresh: async () => snapshot,
    combined: value => ({ models: [nativeRow, ...value.models] }), nativeSlugs: new Set([childModel]),
    isNative: model => model === childModel };
  if (!values.private) host = await startExecutionHost({ config, configPath, nativeHome: native, codex: sdk, gatewayRuntime: async () => runtime });
  const overrides = { name: 'Fixture', base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 30_000,
    'auth.command': process.execPath, 'auth.args': [join(code, 'dist/cli.js'), 'token', '--config', configPath] };
  async function client(name) {
    const events = [];
    const backend = await AppServerBackends.create(sdk, ['app-server', '--listen', 'stdio://'], config, {}, overrides, catalog,
      async message => {
        events.push(message);
        if (message.method === 'item/completed' || message.method === 'error') {
          const item = message.params?.item;
          (evidence.events ??= []).push({ method: message.method, type: item?.type, status: item?.status,
            receivers: item?.receiverThreadIds, error: message.params?.error?.message });
        }
      }, () => {}, configPath);
    backend.resolveRuntime = async () => runtime;
    const router = new AppServerRouter(config, (method, params, hint) => backend.request(method, params, hint),
      catalogPath, catalog, native, backend.identity);
    clients.push(backend);
    await router.initialize();
    await router.request('initialize', { clientInfo: { name, version: '1' }, capabilities: { experimentalApi: true } });
    backend.notify({ method: 'initialized', params: {} });
    return { backend, router, events };
  }
  phase = 'spawn';
  const writer = await client('subagent_sidebar_writer');
  const parent = await writer.router.request('thread/start', { model: alias, cwd: work, approvalPolicy: 'never', sandbox: 'read-only',
    config: { model_reasoning_effort: 'ultra' } });
  await writer.router.request('turn/start', { threadId: parent.thread.id, effort: 'ultra', input: [{ type: 'text', text: 'Spawn the fixture child.' }] });
  const child = await until(async () => {
    const loaded = await writer.router.request('thread/loaded/list', {});
    for (const id of loaded.data) {
      if (id === parent.thread.id) continue;
      const { thread } = await writer.router.request('thread/read', { threadId: id, includeTurns: false });
      if ((thread.parentThreadId ?? thread.source?.subAgent?.thread_spawn?.parent_thread_id) === parent.thread.id) return thread;
    }
  }, 'Spawned child');
  const id = child.id;
  await until(async () => {
    const { thread } = await writer.router.request('thread/read', { threadId: id, includeTurns: false });
    return evidence.childInferenceFinished && thread.status.type !== 'active';
  }, 'Child completion');
  if (values.cold) {
    phase = 'cold-restart';
    await writer.backend.stop();
    await host?.close(); host = undefined;
    if (values['mixed-identity']) config.chatIdentity = values.openai ? 'legacy' : 'openai';
    if (!values.private) host = await startExecutionHost({ config, configPath, nativeHome: native, codex: sdk, gatewayRuntime: async () => runtime });
    evidence.coldRestart = true;
  }
  phase = 'read';
  const reader = values.private && !values.cold ? writer : await client('subagent_sidebar_reader');
  const read = await reader.router.request('thread/read', { threadId: id, includeTurns: false });
  assert.equal(read.thread.model, childModel);
  assert.equal(read.thread.modelProvider, evidence.identity);
  evidence.childStateReadable = true;
  const before = calls;
  const shape = { threadId: id, history: null, path: null, model: null, modelProvider: null,
    cwd: work, personality: null, excludeTurns: true };
  phase = 'resume-implicit';
  let resumed;
  const initialShape = !values.cold ? shape : values['config-override']
    ? { ...shape, config: { model: null } } : { ...shape, model: childModel };
  try { resumed = await reader.router.request('thread/resume', initialShape); }
  catch (error) {
    if (!values.baseline || !/needs a currently configured model alias/.test(error.message)) throw error;
    evidence.baselineRejection = error.message;
    evidence.passed = true;
  }
  if (!values.baseline) {
    assert.equal(resumed.model, childModel); assert.equal(resumed.modelProvider, evidence.identity);
    phase = 'resume-explicit';
    const explicit = await reader.router.request('thread/resume', { ...shape, model: childModel });
    assert.equal(explicit.model, childModel); assert.equal(explicit.modelProvider, evidence.identity);
    assert.equal(explicit.reasoningEffort, resumed.reasoningEffort, 'An explicit same-model resume must keep saved reasoning');
    assert.equal(explicit.reasoningEffort, 'high', 'A cold resume keeps the saved child effort, not the executor default');
    evidence.savedReasoning = explicit.reasoningEffort;
    await reader.router.request('thread/resume', shape);
    assert.equal(calls, before, 'Reading and opening the child must not start inference');
    evidence.implicitAndExplicitResume = true;
    phase = 'continue';
    const turn = await reader.router.request('turn/start', { threadId: id, model: childModel,
      input: [{ type: 'text', text: 'Continue the fixture.' }] });
    const done = await until(() => reader.events.find(event => event.method === 'turn/completed' && event.params.turn.id === turn.turn.id), 'Child continuation');
    assert.equal(done.params.turn.status, 'completed');
    evidence.childContinued = true;
    const persisted = await reader.backend.native.request('thread/read', { threadId: id, includeTurns: false });
    assert.equal(persisted.thread.modelProvider, evidence.identity, 'The child keeps its saved provider on disk');
    evidence.savedIdentityPreserved = true;
    evidence.passed = true;
  } else assert.ok(evidence.baselineRejection, 'Baseline must reproduce the original rejection');
  assert.equal(await readFile(join(native, 'config.toml'), 'utf8'),
    `model = "${childModel}"\nmodel_catalog_json = ${JSON.stringify(join(native, 'models.json'))}\nweb_search = "disabled"\n[features]\nremote_control = false\n[analytics]\nenabled = false\n`);
} catch (error) {
  evidence.phase = phase;
  evidence.error = error.message;
  throw error;
} finally {
  await Promise.allSettled(clients.map(client => client.stop()));
  await host?.close();
  await gateway?.close();
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
