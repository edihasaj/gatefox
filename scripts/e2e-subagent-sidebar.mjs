// Real SDK delegation and desktop-shaped child resumes against a local mock provider.
// All homes, ownership records and inference are private to the fixture.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
const { values } = parseArgs({ options: { package: { type: 'string' }, code: { type: 'string' },
  root: { type: 'string' }, private: { type: 'boolean' }, openai: { type: 'boolean' }, baseline: { type: 'boolean' },
  cold: { type: 'boolean' }, 'mixed-identity': { type: 'boolean' }, 'config-override': { type: 'boolean' },
  v2: { type: 'boolean' }, managed: { type: 'boolean' }, 'child-status': { type: 'boolean' }, 'expect-status-unavailable': { type: 'boolean' }, accounts: { type: 'boolean' }, 'role-fork': { type: 'boolean' }, 'expect-payload-loss': { type: 'boolean' } } });
assert.ok(values.package && values.root, 'Pass --package SDK_PACKAGE --root EVIDENCE_DIRECTORY');
assert.ok(!values.managed || values.v2 && !values.accounts && !values.baseline && !values.private, '--managed requires shared --v2 and excludes private/accounts/baseline');
assert.ok(!values['child-status'] || values.v2, '--child-status requires --v2');
assert.ok(!values['expect-status-unavailable'] || values['child-status'], '--expect-status-unavailable requires --child-status');
assert.ok(!values['role-fork'] || values.v2, '--role-fork requires --v2');
if (values['role-fork']) assert.ok(!values.accounts && !values.baseline, '--role-fork is incompatible with --accounts and --baseline');
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
const { responsesInputToMessages } = await load('protocol/request');
setExecutionHostRootForTests(join(fixture, 'x'));
setNativeOwnerRootForTests(join(fixture, 'n'));
setNativeRuntimeRootForTests(join(fixture, 'r'));
setSdkSocketRootForTests();
setOwnPidForTests(process.pid + 1_000_000);
const runtime = await gatewaySdkRuntime(pkg);
assert.ok(runtime?.executorIdentity, 'Use a verified installed gateway SDK');
const sdk = runtime.executable, alias = 'fixture/parent', nativeModel = 'gpt-6.1-sol', childModel = values.managed ? 'managed/routine' : nativeModel;
const role = 'role_fork_fixture', rolePath = join(native, 'role-fork.toml');
const configPath = join(fixture, 'gateway.json');
const config = { version: 1, port: 0, stateDirectory: state, timeoutMs: 30_000,
  ...(values.openai ? { chatIdentity: 'openai' } : {}),
  providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'FIXTURE_ONLY_KEY',
    baseUrl: 'http://127.0.0.1:1', models: { [alias]: 'mock-parent' },
    modelMetadata: { [alias]: { contextWindow: 100_000, reasoningEfforts: ['low', 'ultra'],
      multiAgentVersion: values.v2 ? 'v2' : 'v1', multiAgentReasoningEffort: 'low' } } }] };
let availability;
if (values.managed) {
  const { AvailabilityService } = await load('availability/service');
  availability = new AvailabilityService({ probe: async () => ({ status: 'healthy', observedAt: Date.now(), endpoints: { healthy: 1, total: 1 }, servedModels: ['mock-child'], missingModels: [] }), accountEmail: async () => undefined, balance: async () => undefined });
  config.providers.push({ id: 'local', type: 'chat-completions-api', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FIXTURE_ONLY_KEY', models: { 'local/worker': 'mock-child' }, modelMetadata: { 'local/worker': { contextWindow: 100_000, reasoningEfforts: ['low', 'high'] } } },
    { id: 'subscription', type: 'codex-subscription', credentialFile: join(state, 'unused.json'), models: { 'subscription/worker': 'unused' }, modelMetadata: { 'subscription/worker': { contextWindow: 100_000, reasoningEfforts: ['low', 'high'] } } });
  config.managedRouting = { routes: { [childModel]: { purpose: 'routine', candidates: ['local/worker', 'subscription/worker'], maxContextBytes: 262144, contextWindow: 32768, minRemainingPercent: 2, allowPaid: false } } };
}
const serverConfig = structuredClone(config);
if (values.accounts) {
  for (const id of ['other', 'selected']) serverConfig.providers.push({ id, type: 'codex-subscription',
    credentialFile: join(state, id + '.json'), defaultForBareModels: id === 'selected', models: { [id + '/' + childModel]: childModel } });
} else if (!values.managed) serverConfig.providers[0].models[childModel] = 'mock-child';
const until = async (check, label, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(25); }
  throw Error(label + ' timed out');
};
let calls = 0, childCalls = 0, spawned = false, gateway, host, phase = 'setup', parentOperation, nativeConfig;
const clients = [];
const evidence = { fixture, shared: !values.private, identity: values.openai ? 'openai' : 'subscription_gateway',
  realGatewaySdk: true, paidInferenceRequests: 0, collaborationVersion: values.v2 ? 'v2' : 'v1',
  ...(values.accounts ? { codexAccounts: 2, childAccount: 'selected' } : {}), passed: false };
if (values['role-fork']) Object.assign(evidence, { mode: 'role-fork', fullHistoryFork: true,
  parentModel: alias, defaultSubagentModel: alias, roleConfigPath: rolePath, roleModel: childModel,
  roleReasoningEffort: 'high' });
const taskProof = 'TASK_' + randomUUID(), fileProof = 'FILE_' + randomUUID();
const statusProof = 'STATUS_' + randomUUID(), statusCallId = 'fixture_child_status';
// A marker written only into the parent's own turn text, so its presence in a child inference
// proves the full-history fork actually carried the parent turn.
const forkMarker = values['role-fork'] ? 'FORK_HISTORY_' + randomUUID() : undefined;
let requiredProof = taskProof, childCallId = 'fixture_child_read', queuedProof;
const taskFile = join(work, 'delegation-proof.txt');
await writeFile(taskFile, fileProof, { mode: 0o600 });
const toolsFor = request => {
  const declared = [...(request.tools ?? []), ...(request.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools ?? [])];
  return declared.flatMap(tool => tool.type === 'namespace'
    ? tool.tools.map(child => ({ name: child.name, namespace: tool.name === 'functions' ? undefined : tool.name }))
    : [{ name: tool.name ?? tool.function?.name }]);
};
const callFor = (tool, id, args) => ({ type: 'tool', call: { type: 'function', id,
  responseTool: { type: 'function', name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}) },
  function: { name: tool.namespace ? `${tool.namespace}.${tool.name}` : tool.name, arguments: JSON.stringify(args) } } });
try {
  gateway = await startGateway(serverConfig, provider => ({
    async *infer(request) {
      calls++;
      if (values['child-status'] && request.model === 'mock-parent' && JSON.stringify(request.input).includes(statusProof)) evidence.parentReceivedChildStatus = true;
      const childRequest = request.model === (values.accounts ? childModel : 'mock-child');
      if (childRequest) {
        childCalls++;
        if (values.managed) assert.equal(provider.id, 'local', 'The hidden worker policy must resolve to the local candidate');
        if (values['role-fork']) {
          evidence.observedChildUpstreamModel = request.model;
          evidence.observedChildReasoningEffort = request.reasoning?.effort;
          assert.equal(request.reasoning?.effort, 'high', 'Every child inference must use the role reasoning effort');
        }
        if (values.accounts) assert.equal(provider.id, 'selected', 'Every bare-model child inference uses the designated account');
      }
      if (request.model === 'mock-parent' && parentOperation) {
        const operation = parentOperation; parentOperation = undefined;
        const tool = toolsFor(request).find(tool => tool.name === operation.name);
        assert.ok(tool, 'The parent must expose ' + operation.name);
        yield callFor(tool, 'fixture_' + operation.name, operation.args);
      } else if (request.model === 'mock-parent' && !spawned) {
        spawned = true;
        const tools = toolsFor(request);
        const tool = tools.find(tool => tool.name === 'spawn_agent');
        evidence.delegationExposed = !!tool;
        assert.ok(tool, 'The real SDK exposes its delegation tool');
        const spawnArgs = { task_name: 'sidebar_fixture',
          message: values.v2 ? `Read ${taskFile} using exec_command. Return its value and ${taskProof}.` : 'Return the fixture marker.',
          ...(values['role-fork'] ? { agent_type: role, fork_turns: 'all' }
            : { model: childModel, reasoning_effort: 'high', fork_turns: 'none' }) };
        if (values['role-fork']) {
          evidence.spawnModelOverride = Object.hasOwn(spawnArgs, 'model');
          assert.equal(evidence.spawnModelOverride, false, 'The role must select the model without a spawn override');
        }
        yield callFor(tool, 'fixture_spawn', spawnArgs);
      } else if (childRequest && values.v2) {
        const messages = responsesInputToMessages(request.input);
        if (forkMarker && requiredProof === taskProof) {
          evidence.parentHistoryInherited = messages.some(message => typeof message.content === 'string' && message.content.includes(forkMarker));
          assert.ok(evidence.parentHistoryInherited, 'The child inference must contain the parent-only history marker');
        }
        const delivered = messages.some(message => typeof message.content === 'string' && message.content.includes(requiredProof));
        evidence[requiredProof === taskProof ? 'taskPayloadDelivered' : 'followupPayloadDelivered'] = delivered;
        if (queuedProof) evidence.queuedMessagePayloadDelivered = messages.some(message => typeof message.content === 'string' && message.content.includes(queuedProof));
        const statusResult = messages.find(message => message.role === 'tool' && message.tool_call_id === statusCallId);
        if (values['child-status'] && statusResult) {
          evidence.childStatusUnavailable = statusResult.content.includes('unsupported call:');
          assert.equal(evidence.childStatusUnavailable, !!values['expect-status-unavailable']);
        }
        if (!delivered) yield { type: 'text', text: 'EMPTY_TASK_PAYLOAD' };
        else if (values['child-status'] && requiredProof === taskProof && !statusResult) {
          const tool = toolsFor(request).find(tool => tool.name === 'send_message');
          evidence.childStatusAdvertised = !!tool;
          assert.equal(!!tool, !values['expect-status-unavailable'], 'Child capability controls its actual collaboration registry');
          // The baseline reproduces a historical call from inherited parent declarations.
          yield callFor(tool ?? { name: 'send_message', namespace: 'collaboration' }, statusCallId, { target: '/root', message: statusProof });
        } else {
          const output = messages.find(message => message.role === 'tool' && message.tool_call_id === childCallId);
          if (!output) {
            const tool = toolsFor(request).find(tool => tool.name === 'exec_command');
            assert.ok(tool, 'The child must have an executable command tool');
            yield callFor(tool, childCallId, { cmd: `cat ${taskFile}` });
          } else {
            assert.ok(output.content.includes(fileProof), 'The real child command must return the file proof');
            if (requiredProof === taskProof) evidence.childToolExecuted = true;
            else evidence.followupToolExecuted = true;
            yield { type: 'text', text: 'SIDEBAR_FIXTURE_COMPLETE ' + requiredProof + ' ' + fileProof };
          }
        }
      } else yield { type: 'text', text: 'SIDEBAR_FIXTURE_COMPLETE' };
      yield { type: 'done', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
      if (childRequest) evidence.childInferenceFinished = true;
    },
  }), undefined, { copilotTempBase: join(fixture, 'provider-tmp'), ...(availability ? { availability } : {}) });
  config.port = gateway.address().port;
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, 'service-plan.json'), { version: 1, config: configPath, sharedExecutors: !values.private,
    components: [{ id: 'native', kind: 'native', command: sdk,
      args: ['--codex', sdk, '--native-home', native], log: join(state, 'native.log') }] });
  const rows = modelCatalog(config).models;
  if (values.managed) {
    const hidden = rows.find(row => row.slug === childModel);
    assert.equal(hidden?.visibility, 'hide');
    const { gatewayModelList } = await load('app-server-model-list');
    const visible = await gatewayModelList({}, async () => ({ data: [], nextCursor: null }), new Set(), rows, undefined);
    assert.ok(!visible.data.some(row => row.model === childModel));
    evidence.managedHiddenFromPicker = true;
  }
  const nativeRow = { ...rows[0], slug: nativeModel, multi_agent_version: values['child-status'] && !values['expect-status-unavailable'] ? 'v2' : undefined, default_reasoning_level: 'low',
    supported_reasoning_levels: ['low', 'high'].map(effort => ({ effort, description: effort })) };
  await writePrivateJson(join(native, 'models.json'), { models: [nativeRow] });
  nativeConfig = `model = "${nativeModel}"\nmodel_catalog_json = ${JSON.stringify(join(native, 'models.json'))}\nweb_search = "disabled"\n[features]\nremote_control = false\n[analytics]\nenabled = false\n`;
  if (values['role-fork']) {
    await writeFile(rolePath, `name = "${role}"\ndescription = "Fixture worker"\nmodel = "${childModel}"\nmodel_reasoning_effort = "high"\n`, { mode: 0o600 });
    nativeConfig += `\n[agents]\ndefault_subagent_model = "${alias}"\n[agents.${role}]\ndescription = "Fixture worker"\nconfig_file = ${JSON.stringify(rolePath)}\n`;
    assert.notEqual(childModel, alias, 'The role model must differ from both parent and default child models');
  }
  await writeFile(join(native, 'config.toml'), nativeConfig, { mode: 0o600 });
  const snapshot = { revision: 'a'.repeat(64), models: rows };
  const catalogPath = join(state, 'fixture-catalog.json');
  await writePrivateJson(catalogPath, { models: [nativeRow, ...rows] });
  const catalog = { current: () => snapshot, refresh: async () => snapshot,
    combined: value => ({ models: [nativeRow, ...value.models] }), nativeSlugs: new Set([nativeModel]),
    isNative: model => model === nativeModel };
  if (!values.private) host = await startExecutionHost({ config, configPath, nativeHome: native, codex: sdk, gatewayRuntime: async () => runtime });
  const overrides = { name: 'Fixture', base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 30_000,
    'auth.command': process.execPath, 'auth.args': [join(code, 'dist/cli.js'), 'token', '--config', configPath] };
  async function client(name) {
    const events = [];
    const backend = await AppServerBackends.create(sdk, ['app-server', '--listen', 'stdio://'], config, values.managed ? { web_search: 'disabled' } : {}, overrides, catalog,
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
    config: { model_reasoning_effort: 'ultra', ...(values.managed ? { web_search: 'disabled' } : {}) } });
  await writer.router.request('turn/start', { threadId: parent.thread.id, effort: 'ultra',
    input: [{ type: 'text', text: 'Spawn the fixture child.' + (forkMarker ? ' ' + forkMarker : '') }] });
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
    const workFinished = values.v2 && !values['expect-payload-loss'] ? evidence.childToolExecuted : evidence.childInferenceFinished;
    return workFinished && thread.status.type !== 'active';
  }, 'Child completion');
  if (values.v2) {
    assert.equal(evidence.taskPayloadDelivered, !values['expect-payload-loss'], 'The child must receive the plaintext task');
    assert.equal(evidence.childToolExecuted === true, !values['expect-payload-loss'], 'The child must do actual tool work');
    const history = await writer.router.request('thread/read', { threadId: id, includeTurns: true });
    const items = history.thread.turns.flatMap(turn => turn.items);
    const commands = items.filter(item => item.type === 'commandExecution');
    evidence.childHistoryItems = items.length;
    if (values['child-status']) evidence.childStatusItems = items.filter(item => /collab|subagent/i.test(item.type)).map(({type,tool,status,kind,agentPath,agentThreadId}) => ({type,tool,status,kind,agentPath,agentThreadId}));
    evidence.childCommandItems = commands.length;
    if (!values['expect-payload-loss']) {
      assert.ok(commands.length > 0, 'The opened child history must contain its command execution');
      assert.ok(items.some(item => item.type === 'agentMessage' && item.text?.includes(fileProof)));
      evidence.fullChildHistoryReadable = true;
    }
  }
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
  if (values.v2 && values.cold) {
    // Codex v2 restores the agent tree through its parent; clients may inspect
    // a saved child with thread/read without starting that child themselves.
    await reader.router.request('thread/resume', { threadId: parent.thread.id });
  }
  const read = await reader.router.request('thread/read', { threadId: id, includeTurns: false });
  assert.equal(read.thread.model, childModel);
  if (values.managed) {
    const { readActivity } = await load('activity');
    const activity = await readActivity(configPath, state, { nativeHome: native });
    const row = activity.rows.find(row => row.threadId === id);
    assert.equal(row?.model, 'local/worker');
    assert.equal(row?.requestedModel, childModel);
    evidence.selectedWorkerModel = row.model;
  }
  if (values['role-fork']) evidence.observedChildModel = read.thread.model;
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
    if (values.v2) {
      const controller = values.cold ? reader : writer;
      if (values.cold) await controller.router.request('thread/resume', { threadId: parent.thread.id });
      queuedProof = 'QUEUED_' + randomUUID();
      const beforeMessage = childCalls;
      parentOperation = { name: 'send_message', args: { target: 'sidebar_fixture', message: 'Keep this queued proof for the next task: ' + queuedProof } };
      const queued = await controller.router.request('turn/start', { threadId: parent.thread.id,
        input: [{ type: 'text', text: 'Queue a child message.' }] });
      await until(() => controller.events.find(event => event.method === 'turn/completed' && event.params.turn.id === queued.turn.id), 'Queued message');
      assert.equal(childCalls, beforeMessage, 'A queued message must not wake an idle child');
      evidence.queuedMessageDidNotWakeChild = true;
      const previous = calls;
      requiredProof = 'FOLLOWUP_' + randomUUID(); childCallId = 'fixture_child_followup_read';
      evidence.childInferenceFinished = false; evidence.followupToolExecuted = false;
      parentOperation = { name: 'followup_task', args: { target: 'sidebar_fixture', message: 'Read the proof file again and return ' + requiredProof } };
      await controller.router.request('turn/start', { threadId: parent.thread.id,
        input: [{ type: 'text', text: 'Send the next child task.' }] });
      await until(async () => {
        if (calls <= previous || !evidence.childInferenceFinished) return false;
        if (!values['expect-payload-loss'] && !evidence.followupToolExecuted) return false;
        const { thread } = await controller.router.request('thread/read', { threadId: id, includeTurns: true });
        const last = thread.turns.at(-1);
        return last?.status === 'completed' && (values['expect-payload-loss'] || last.items.some(item =>
          item.type === 'agentMessage' && item.text?.includes(requiredProof) && item.text?.includes(fileProof)));
      }, 'Child followup');
      assert.equal(evidence.followupPayloadDelivered, !values['expect-payload-loss'], 'The parent followup must reach its child');
      assert.equal(evidence.queuedMessagePayloadDelivered, !values['expect-payload-loss'], 'The queued message must accompany the followup');
      evidence.childContinued = !values['expect-payload-loss'];
    } else {
      const turn = await reader.router.request('turn/start', { threadId: id, model: childModel,
        input: [{ type: 'text', text: 'Continue the fixture.' }] });
      const done = await until(() => reader.events.find(event => event.method === 'turn/completed' && event.params.turn.id === turn.turn.id), 'Child continuation');
      assert.equal(done.params.turn.status, 'completed');
      evidence.childContinued = true;
    }
    const persisted = await reader.backend.native.request('thread/read', { threadId: id, includeTurns: false });
    assert.equal(persisted.thread.modelProvider, evidence.identity, 'The child keeps its saved provider on disk');
    if (values['role-fork']) assert.equal(persisted.thread.model, childModel, 'Followup keeps the role model on disk');
    evidence.savedIdentityPreserved = true;
    if (values['child-status']) {
      assert.equal(evidence.childStatusUnavailable, !!values['expect-status-unavailable']);
      assert.equal(evidence.parentReceivedChildStatus === true, !values['expect-status-unavailable'], 'The parent must receive the child status payload');
    }
    evidence.passed = true;
  } else assert.ok(evidence.baselineRejection, 'Baseline must reproduce the original rejection');
  assert.equal(await readFile(join(native, 'config.toml'), 'utf8'), nativeConfig);
  if (values.accounts) {
    assert.ok(childCalls >= 2, 'The real SDK child must infer and execute its tool through the selected account');
    evidence.childAccountVerified = true;
  }
} catch (error) {
  evidence.phase = phase;
  evidence.error = error.message;
  throw error;
} finally {
  availability?.stop();
  await Promise.allSettled(clients.map(client => client.stop()));
  await host?.close();
  await gateway?.close();
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
