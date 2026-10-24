// A native scheduled task on a gateway model, as the desktop scheduler sends it: projectless
// automations name the home folder as the exact `~` workspace root. With the real gateway SDK
// this proves the raw shape is refused (the 2026-10-24 `relative_path` failure) and that the
// same request through the adapter's router starts and completes a turn. Mock inference only;
// all state stays in a private fixture. No account, schedule or paid inference is used.
// node scripts/e2e-scheduler-roots.mjs --package INSTALLED_PACKAGE --root EVIDENCE_DIRECTORY [--private]
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: { package: { type: 'string' }, root: { type: 'string' },
  private: { type: 'boolean', default: false }, code: { type: 'string' } } });
assert.ok(values.package && values.root, 'Pass --package INSTALLED_PACKAGE --root EVIDENCE_DIRECTORY');
const source = resolve(values.code ?? fileURLToPath(new URL('..', import.meta.url))), pkg = resolve(values.package);
const root = resolve(values.root), fixture = await mkdtemp('/tmp/gw-scheduler-roots-');
const native = join(fixture, 'native'), state = join(fixture, 'state'), work = join(fixture, 'work');
for (const folder of [root, native, state, work]) await mkdir(folder, { recursive: true, mode: 0o700 });
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
(await load('native-runtime-status').catch(() => undefined))?.setNativeRuntimeRootForTests(join(fixture, 'r'));
const { setOwnPidForTests } = await load('boot-identity');
const { gatewaySdkRuntime } = await load('gateway-sdk-runtime');
const { modelCatalog } = await load('catalog');
const { startGateway } = await load('server');
const { writePrivateJson } = await load('config');
setExecutionHostRootForTests(join(fixture, 'x'));
setNativeOwnerRootForTests(join(fixture, 'n'));
setSdkSocketRootForTests();
setOwnPidForTests(process.pid + 1_000_000);
const runtime = await gatewaySdkRuntime(pkg);
assert.ok(runtime?.executorIdentity, 'A verified gateway SDK is required');
const sdk = runtime.executable, configPath = join(fixture, 'gateway.json'), alias = 'fixture/scheduled';
const config = { version: 1, port: 0, stateDirectory: state, timeoutMs: 30_000,
  providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'GATEWAY_SCHEDULER_FIXTURE_KEY',
    baseUrl: 'http://127.0.0.1:1', models: { [alias]: 'mock-model' },
    modelMetadata: { [alias]: { contextWindow: 32_768, reasoningEfforts: ['low'] } } }] };
const until = async (check, name, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const result = await check(); if (result) return result; await delay(25); }
  throw Error(name + ' timed out');
};
// The scheduler's projectless shape: the saved `cwds = ["~"]` reaches the engine as this exact sentinel.
const scheduled = extra => ({ ...extra, runtimeWorkspaceRoots: ['~'] });
const turnPolicy = { type: 'workspaceWrite', writableRoots: ['~'], networkAccess: false };
let calls = 0, host, gateway, backend, phase = 'server';
const evidence = { fixture, engine: values.private ? 'private-gateway' : 'shared-gateway', realGatewaySdk: true,
  paidInferenceRequests: 0, passed: false };
try {
  gateway = await startGateway(config, () => ({
    async *infer() {
      calls++;
      yield { type: 'text', text: 'HG_SCHEDULED_FIXTURE_OK' };
      yield { type: 'done', usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } };
    },
  }), undefined, { copilotTempBase: join(fixture, 'provider-tmp') });
  config.port = gateway.address().port;
  await writePrivateJson(configPath, config);
  await writePrivateJson(join(state, 'service-plan.json'), { version: 1, config: configPath, sharedExecutors: !values.private,
    components: [{ id: 'native', kind: 'native', command: sdk, args: ['--codex', sdk, '--native-home', native], log: join(state, 'native.log') }] });
  const rows = modelCatalog(config).models;
  const nativeCatalog = join(native, 'models.json');
  await writePrivateJson(nativeCatalog, { models: [{ ...rows[0], slug: 'native-fixture' }] });
  await writeFile(join(native, 'config.toml'), `model = "native-fixture"\nmodel_catalog_json = ${JSON.stringify(nativeCatalog)}\n[features]\nremote_control = false\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  const snapshot = { revision: 'b'.repeat(64), models: rows };
  await writePrivateJson(join(state, 'fixture-catalog.json'), { models: rows });
  const catalog = { current: () => snapshot, refresh: async () => snapshot,
    combined: value => ({ models: value.models }), nativeSlugs: new Set(['native-fixture']) };
  phase = 'host';
  if (!values.private) host = await startExecutionHost({ config, configPath, nativeHome: native, codex: sdk, gatewayRuntime: async () => runtime });
  const overrides = { name: 'Fixture', base_url: `http://127.0.0.1:${config.port}/v1`, wire_api: 'responses',
    requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 30_000,
    'auth.command': process.execPath, 'auth.args': [join(source, 'dist/cli.js'), 'token', '--config', configPath] };
  phase = 'initialize';
  const events = [];
  backend = await AppServerBackends.create(sdk, ['app-server', '--listen', 'stdio://'], config, {}, overrides, catalog,
    async message => { events.push(message); }, () => {}, configPath);
  backend.resolveRuntime = async () => runtime;
  const router = new AppServerRouter(config, (method, params, hint) => backend.request(method, params, hint),
    join(state, 'fixture-catalog.json'), undefined, native, backend.identity);
  await router.initialize();
  await router.request('initialize', { clientInfo: { name: 'gateway_scheduler_roots_e2e', version: '1' }, capabilities: { experimentalApi: true } });
  backend.notify({ method: 'initialized', params: {} });

  phase = 'thread:start';
  const started = await router.request('thread/start', scheduled({ model: alias, cwd: work, sandbox: 'workspace-write', approvalPolicy: 'never' }));
  const id = started.thread.id;
  evidence.threadStarted = true;

  // Baseline: the raw scheduler turn sent straight to the gateway SDK, bypassing the router.
  phase = 'turn:baseline';
  const raw = { threadId: id, input: [{ type: 'text', text: 'Scheduled fixture run.' }], cwd: work, sandboxPolicy: turnPolicy };
  // turn/start follows the chat's own engine binding, so this reaches the gateway SDK.
  const refused = await backend.request('turn/start', scheduled(raw)).then(() => undefined, error => error);
  assert.ok(refused, 'The raw `~` root must be refused by the gateway SDK');
  assert.match(String(refused.message), /runtimeWorkspaceRoots|relative|absolute/i);
  assert.equal(calls, 0);
  evidence.rawSchedulerShapeRefused = true;

  phase = 'turn:routed';
  const turn = await router.request('turn/start', scheduled(raw));
  const done = await until(() => events.find(message => message.method === 'turn/completed' && message.params.turn.id === turn.turn.id), 'Scheduled turn');
  assert.equal(done.params.turn.status, 'completed');
  assert.ok(events.some(message => message.method === 'item/completed' && message.params.item?.type === 'agentMessage' &&
    String(message.params.item.text).includes('HG_SCHEDULED_FIXTURE_OK')), 'The scheduled turn must deliver its answer');
  evidence.routedTurnCompleted = true;
  evidence.homeRoot = homedir() === '~' ? 'unexpected' : 'absolute';
  evidence.mockInferenceRequests = calls;
  evidence.passed = true;
} catch (error) {
  evidence.failedDuring = phase;
  evidence.error = error.message;
  process.exitCode = 1;
} finally {
  await backend?.stop();
  await host?.close();
  if (gateway) { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)); }
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
