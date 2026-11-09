// Opt-in real Codex subscription check. Private homes and a read-only proof file.
// Only booleans, item counts and provider/model identifiers are recorded.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
const { values } = parseArgs({ options: { package: { type: 'string' }, code: { type: 'string' },
  config: { type: 'string' }, model: { type: 'string' }, root: { type: 'string' } } });
for (const key of ['package', 'config', 'model', 'root']) assert.ok(values[key], 'Pass --' + key);
const code = resolve(values.code ?? new URL('..', import.meta.url).pathname), root = resolve(values.root);
const fixture = await mkdtemp('/tmp/gw-live-agent-'), native = join(fixture, 'native'), work = join(fixture, 'work');
for (const folder of [root, native, work, join(fixture, 'home')]) await mkdir(folder, { recursive: true, mode: 0o700 });
process.env.HOME = join(fixture, 'home'); process.env.CODEX_HOME = native;
process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
process.env.GATEWAY_TELEMETRY = 'off'; process.env.GATEWAY_ERROR_REPORTS = 'off';
for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HARNESS_GATEWAY_EXECUTOR', 'GATEFOX_EXECUTOR']) delete process.env[key];
const load = name => import(pathToFileURL(join(code, 'dist', name + '.js')));
const { loadConfig, writePrivateJson } = await load('config');
const { gatewaySdkRuntime } = await load('gateway-sdk-runtime');
const { AppServerBackends } = await load('app-server-backends');
const { AppServerRouter } = await load('app-server-router');
const { modelCatalog } = await load('catalog');
const { startGateway } = await load('server');
const { setNativeRuntimeRootForTests } = await load('native-runtime-status');
setNativeRuntimeRootForTests(join(fixture, 'runtime'));
const original = await loadConfig(resolve(values.config));
const selected = original.providers.find(provider => provider.type === 'codex-subscription' && provider.models[values.model]);
assert.ok(selected, 'Use a configured Codex subscription model');
const runtime = await gatewaySdkRuntime(resolve(values.package)); assert.ok(runtime?.executorIdentity);
const model = values.model, upstream = selected.models[model], state = join(fixture, 'state'), configPath = join(fixture, 'gateway.json');
const config = { version: 1, port: 0, stateDirectory: state, timeoutMs: 180_000,
  providers: [{ ...selected, models: { [model]: upstream, [upstream]: upstream }, modelMetadata: {
    [model]: { ...selected.modelMetadata?.[model], contextWindow: 100_000, reasoningEfforts: ['low', 'high', 'ultra'],
      multiAgentVersion: 'v2', multiAgentReasoningEffort: 'low', useResponsesLite: true },
    [upstream]: { ...selected.modelMetadata?.[model], contextWindow: 100_000, reasoningEfforts: ['low', 'high'], multiAgentVersion: undefined, useResponsesLite: true },
  } }] };
const clientConfig = { ...config, providers: [{ ...config.providers[0], models: { [model]: upstream },
  modelMetadata: { [model]: config.providers[0].modelMetadata[model] } }] };
const proof = 'PROOF_' + randomUUID(), task = 'TASK_' + randomUUID(), file = join(work, 'proof.txt');
await writeFile(file, proof, { mode: 0o600 });
let gateway, backend, phase = 'setup';
const events = [], evidence = { fixture, model, realProvider: true, passed: false };
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await originalFetch(...args);
  if (!response.ok && String(args[0]).startsWith('https://api.openai.com/')) {
    const body = await response.clone().json().catch(() => ({}));
    const error = body?.error;
    // Validation diagnostics only; request bodies, credentials and arguments
    // are never recorded by this check.
    evidence.upstreamValidation = { status: response.status, code: error?.code, type: error?.type, param: error?.param };
    const message = String(error?.message ?? '');
    evidence.upstreamValidation.keywords = ['encrypted', 'namespace', 'schema', 'parameters', 'unsupported', 'additional_tools', 'defer_loading', 'strict', 'function', 'search', 'required', 'type']
      .filter(word => message.toLowerCase().includes(word));
    if (error?.param === 'tools' && !message.includes(task) && !message.includes(proof) && !message.includes(file)) {
      evidence.upstreamValidation.schemaError = message.slice(0, 600);
    }
  }
  return response;
};
const until = async (check, name) => {
  const end = Date.now() + 240_000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(100); }
  throw Error(name + ' timed out');
};
try {
  gateway = await startGateway(config);
  clientConfig.port = gateway.address().port;
  await writePrivateJson(configPath, clientConfig);
  await writePrivateJson(join(state, 'service-plan.json'), { version: 1, config: configPath, sharedExecutors: false,
    components: [{ id: 'native', kind: 'native', command: runtime.executable, args: ['--codex', runtime.executable, '--native-home', native], log: join(state, 'native.log') }] });
  const row = modelCatalog(clientConfig).models[0], nativeRow = { ...row, slug: upstream, multi_agent_version: undefined };
  const catalogPath = join(state, 'catalog.json');
  await writePrivateJson(catalogPath, { models: [nativeRow, row] });
  await writePrivateJson(join(native, 'models.json'), { models: [nativeRow] });
  await writeFile(join(native, 'config.toml'), `model = ${JSON.stringify(upstream)}\nmodel_catalog_json = ${JSON.stringify(join(native, 'models.json'))}\nweb_search = "disabled"\n[features]\nremote_control = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  const snapshot = { revision: 'b'.repeat(64), models: [row] };
  const catalog = { current: () => snapshot, refresh: async () => snapshot, combined: () => ({ models: [nativeRow, row] }),
    nativeSlugs: new Set([upstream]), isNative: value => value === upstream };
  const overrides = { name: 'Live fixture', base_url: `http://127.0.0.1:${clientConfig.port}/v1`, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0,
    'auth.command': process.execPath, 'auth.args': [join(code, 'dist/cli.js'), 'token', '--config', configPath] };
  backend = await AppServerBackends.create(runtime.executable, ['app-server', '--listen', 'stdio://'], clientConfig, {}, overrides, catalog,
    async message => { events.push(message); }, () => {}, configPath);
  backend.resolveRuntime = async () => runtime;
  const router = new AppServerRouter(clientConfig, (method, params, hint) => backend.request(method, params, hint), catalogPath, catalog, native, backend.identity);
  await router.initialize();
  await router.request('initialize', { clientInfo: { name: 'gateway_live_delegation', version: '1' }, capabilities: { experimentalApi: true } });
  backend.notify({ method: 'initialized' });
  phase = 'delegate';
  const parent = await router.request('thread/start', { model, cwd: work, sandbox: 'read-only', approvalPolicy: 'never', config: { model_reasoning_effort: 'ultra' } });
  const instruction = `Spawn exactly one subagent named proof_reader, using model ${upstream}, fork_turns none. Send this exact task: "Read ${file} with exec_command, then report its complete value and ${task}. Do not edit anything or delegate." Wait for it to finish, then report its result. Do not read the file yourself.`;
  const turn = await router.request('turn/start', { threadId: parent.thread.id, effort: 'ultra', input: [{ type: 'text', text: instruction }] });
  const done = await until(() => events.find(event => event.method === 'turn/completed' && event.params.turn.id === turn.turn.id), 'Parent completion');
  assert.equal(done.params.turn.status, 'completed');
  phase = 'inspect-child';
  const ids = (await router.request('thread/loaded/list', {})).data.filter(id => id !== parent.thread.id);
  let child;
  for (const id of ids) {
    const { thread } = await router.request('thread/read', { threadId: id, includeTurns: true });
    if ((thread.parentThreadId ?? thread.source?.subAgent?.thread_spawn?.parent_thread_id) === parent.thread.id) { child = thread; break; }
  }
  assert.ok(child, 'A real child must exist');
  const items = child.turns.flatMap(turn => turn.items), answers = items.filter(item => item.type === 'agentMessage').map(item => item.text ?? '').join('\n');
  evidence.historyItems = items.length;
  evidence.commandItems = items.filter(item => item.type === 'commandExecution').length;
  evidence.taskReceived = answers.includes(task); evidence.fileRead = answers.includes(proof);
  assert.ok(evidence.commandItems > 0, 'The real subagent must execute a command');
  assert.ok(evidence.taskReceived && evidence.fileRead, 'The child must receive its task and read the unknown proof');
  evidence.passed = true;
} catch (error) { evidence.phase = phase; evidence.error = error.message; throw error; }
finally {
  await backend?.stop(); await gateway?.close();
  globalThis.fetch = originalFetch;
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
