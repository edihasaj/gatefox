// Proves that the real pinned gateway SDK keeps saved chats routable while the
// two Codex account IDs are renamed. The upstream is a local mock: no ChatGPT
// login, inherited authentication, or paid inference is used.
//
// node scripts/e2e-codex-account-names.mjs --package INSTALLED_PACKAGE --root RESULTS [--code COMPILED_CHECKOUT] [--planner MANAGER_PLANNER] [--identity openai|legacy] [--switch]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: {
  package: { type: 'string' }, code: { type: 'string' }, root: { type: 'string' }, planner: { type: 'string' }, identity: { type: 'string', default: 'openai' }, switch: { type: 'boolean', default: true },
} });
for (const option of ['package', 'root']) assert.ok(values[option], `Missing --${option}`);
assert.ok(['openai', 'legacy'].includes(values.identity), '--identity must be openai or legacy');

const packageRoot = resolve(values.package);
const codeRoot = resolve(values.code || packageRoot);
const resultsRoot = resolve(values.root);
const fixtureKey = 'GATEWAY_ACCOUNT_NAMES_FIXTURE_TOKEN';
const aliases = {
  oldPrimary: 'codex-main/gpt-6-luna', oldSecondary: 'codex/gpt-6-luna',
  primary: 'codex-primary/gpt-6-luna', secondary: 'codex-secondary/gpt-6-luna',
  other: 'claude-primary/mock',
};
const mappings = { 'codex-main': 'codex-primary', codex: 'codex-secondary' };
const chatIdentity = values.identity === 'openai' ? 'openai' : 'subscription_gateway';

await mkdir(resultsRoot, { recursive: true, mode: 0o700 });
const run = await mkdtemp('/tmp/gw-codex-account-names-');
const home = join(run, 'codex-home'), work = join(run, 'work'), temp = join(run, 'tmp');
const state = join(run, 'state'), configPath = join(run, 'gateway.json'), catalogPath = join(home, 'models.json');
for (const path of [home, work, temp, state]) await mkdir(path, { recursive: true, mode: 0o700 });

const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'SystemRoot', 'WINDIR'].includes(key)));
safeEnv.HOME = join(run, 'home'); safeEnv.CODEX_HOME = home; safeEnv.TMPDIR = temp;
safeEnv.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
safeEnv.HARNESS_GATEWAY_EXECUTOR = '1';
await mkdir(safeEnv.HOME, { recursive: true, mode: 0o700 });

const load = name => import(pathToFileURL(join(codeRoot, 'dist', `${name}.js`)));
const [{ startGateway }, { modelCatalog }, { writePrivateJson }, { gatewaySdkRuntime }, { AppServerBackends }, { AppServerRouter }] = await Promise.all([
  load('server'), load('catalog'), load('config'), load('gateway-sdk-runtime'), load('app-server-backends'), load('app-server-router'),
]);
const runtime = await gatewaySdkRuntime(packageRoot);
assert.ok(runtime?.executorIdentity, 'The installed package must contain the verified gateway SDK');
const sdk = runtime.executable;
assert.equal(execFileSync(sdk, ['--version'], { encoding: 'utf8' }).startsWith('codex-cli '), true, 'The gateway SDK must run');

const baseConfig = (primaryId = 'codex-main', secondaryId = 'codex') => ({
  version: 1, port: 0, stateDirectory: state, timeoutMs: 20_000,
  providers: [
    { id: primaryId, type: 'codex-subscription', credentialFile: join(state, 'primary.json'),
      models: { [aliases.oldPrimary]: 'gpt-6-luna' }, modelMetadata: { [aliases.oldPrimary]: { contextWindow: 32768, reasoningEfforts: ['low'] } } },
    { id: secondaryId, type: 'codex-subscription', credentialFile: join(state, 'secondary.json'),
      models: { [aliases.oldSecondary]: 'gpt-6-luna' }, modelMetadata: { [aliases.oldSecondary]: { contextWindow: 32768, reasoningEfforts: ['low'] } } },
    // This unrelated mock route must stay usable after the account-only rename.
    { id: 'claude-primary', type: 'responses-api', credentialFile: join(state, 'other.json'), baseUrl: 'http://127.0.0.1:1',
      models: { [aliases.other]: 'mock' }, modelMetadata: { [aliases.other]: { contextWindow: 32768, reasoningEfforts: ['low'] } } },
  ],
});
const fallbackPlan = initial => {
  const config = structuredClone(initial);
  for (const provider of config.providers) {
    const oldId = provider.id; const newId = mappings[oldId];
    if (!newId) continue;
    for (const [alias, model] of Object.entries(provider.models)) {
      const canonical = `${newId}${alias.slice(oldId.length)}`;
      provider.models[canonical] = model;
      provider.modelMetadata[canonical] = structuredClone(provider.modelMetadata[alias]);
      provider.modelMetadata[alias] = { ...provider.modelMetadata[alias], pickerHidden: true };
    }
    provider.id = newId;
  }
  return config;
};
const planner = values.planner ? await import(pathToFileURL(resolve(values.planner))) : undefined;
const initial = baseConfig();
const final = planner ? planner.planCodexAccountNames(initial).config : fallbackPlan(initial);
assert.deepEqual(final.providers.map(provider => provider.id), ['codex-primary', 'codex-secondary', 'claude-primary']);
assert.deepEqual(final.providers.find(provider => provider.id === 'claude-primary'), initial.providers.find(provider => provider.id === 'claude-primary'), 'The account planner must not rewrite an unrelated provider');
for (const alias of [aliases.oldPrimary, aliases.oldSecondary]) {
  const provider = final.providers.find(item => Object.hasOwn(item.models, alias));
  assert.notEqual(provider?.modelMetadata?.[alias]?.pickerHidden, true, 'The legacy route must remain visible for loaded SDKs');
}
for (const alias of [aliases.primary, aliases.secondary]) {
  const provider = final.providers.find(item => Object.hasOwn(item.models, alias));
  assert.equal(provider?.modelMetadata?.[alias]?.pickerHidden, true, 'The canonical duplicate must stay hidden until SDKs refresh');
}

let server, child, closed, phase = 'setup', sequence = 0, failed;
const events = [], pending = new Map(), observations = [];
const markers = { primary: 'ACCOUNT_NAMES_PRIMARY_HISTORY', secondary: 'ACCOUNT_NAMES_SECONDARY_HISTORY' };
let heldInference;
const credentials = new Map([
  ['codex-main', join(state, 'primary.json')], ['codex-primary', join(state, 'primary.json')],
  ['codex', join(state, 'secondary.json')], ['codex-secondary', join(state, 'secondary.json')],
  ['claude-primary', join(state, 'other.json')],
]);
const receipt = { checkedAt: new Date().toISOString(), passed: false, realGatewaySdk: true, plannerUsed: !!planner, identity: chatIdentity,
  paidInferenceRequests: 0, aliases: { legacyVisible: false, canonicalHidden: false }, serverRestartedWithoutSdkRestart: false,
  savedModelProviderUnchanged: false, warmContinuation: false, coldContinuation: false, bindings: [], threads: {}, loadedAliases: {},
  switches: { enabled: values.switch }, requestCount: 0 };

const save = async () => writeFile(join(resultsRoot, 'codex-account-names.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const until = async (check, name, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (failed) throw Error(failed); const value = await check(); if (value) return value; await delay(25); }
  throw Error(`${name} timed out`);
};
const inputHas = (input, marker) => JSON.stringify(input).includes(marker);
const mockFactory = provider => ({
  async *infer(request, signal) {
    const marker = inputHas(request.input, markers.primary) ? 'primary' : inputHas(request.input, markers.secondary) ? 'secondary' : 'none';
    observations.push({ phase, provider: provider.id, marker, credentialMatch: provider.credentialFile === credentials.get(provider.id) });
    if (heldInference && phase === 'running-switch') await Promise.race([heldInference.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('fixture inference aborted')), { once: true }))]);
    yield { type: 'text', text: `fixture-${provider.id}-${marker}` };
    yield { type: 'done', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  },
});
const closeServer = async target => {
  if (!target?.listening) return;
  target.closeAllConnections();
  await new Promise((resolve, reject) => target.close(error => error ? reject(error) : resolve()));
};
async function startServer(config) {
  server = await startGateway(config, mockFactory, undefined, { copilotTempBase: temp });
  config.port = server.address().port;
  await writePrivateJson(configPath, config);
  return config.port;
}
function clearPending(reason) {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(reason)); }
  pending.clear();
}
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, 20_000);
  pending.set(id, { resolve, reject, timer, method });
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
async function startSdk(port) {
  safeEnv[fixtureKey] = (await readFile(join(state, 'client-token'), 'utf8')).trim();
  await writeFile(join(home, 'config.toml'), [
    `model = ${JSON.stringify(aliases.oldPrimary)}`, `model_provider = ${JSON.stringify(chatIdentity)}`,
    `model_catalog_json = ${JSON.stringify(catalogPath)}`, 'web_search = "disabled"', '[analytics]', 'enabled = false',
    '[model_providers.subscription_gateway]', 'name = "Account names fixture"', `base_url = "http://127.0.0.1:${port}/v1"`,
    `env_key = "${fixtureKey}"`, 'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
    'request_max_retries = 0', 'stream_max_retries = 0', '[features]', 'remote_control = false',
  ].join('\n') + '\n', { mode: 0o600 });
  child = spawn(sdk, ['app-server', '--listen', 'stdio://'], { cwd: work, env: safeEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  closed = new Promise(resolve => child.once('close', resolve));
  child.once('error', () => { failed = 'sdk_spawn_failed'; clearPending(failed); });
  child.once('exit', () => clearPending('sdk_exited'));
  child.stdin.on('error', () => { failed = 'sdk_input_closed'; clearPending(failed); });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line); const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) {
          const error = Object.assign(Error(typeof message.error.message === 'string' ? message.error.message : `${entry.method} failed`), { code: message.error.code });
          entry.reject(error);
        } else entry.resolve(message.result);
      }
      else if (message.method && message.id !== undefined) child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Fixture declines approvals' } }) + '\n');
      else if (message.method) events.push(message);
    } catch { failed = 'sdk_protocol_failed'; clearPending(failed); }
  });
  await rpc('initialize', { clientInfo: { name: 'codex_account_names_fixture', version: '1' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
}
async function stopSdk() {
  if (!child) return;
  child.stdin.end();
  await Promise.race([closed, delay(5000)]);
  if (child.exitCode === null) child.kill('SIGTERM');
  await Promise.race([closed, delay(5000)]);
  child = undefined;
}
const textFor = (offset, turnId) => events.slice(offset).filter(event => event.method === 'item/agentMessage/delta' && event.params.turnId === turnId).map(event => event.params.delta).join('');
async function turn(threadId, text, label) {
  const offset = events.length;
  const started = await rpc('turn/start', { threadId, input: [{ type: 'text', text }] });
  const complete = await until(() => events.slice(offset).find(event => event.method === 'turn/completed' && event.params.turn.id === started.turn.id), label);
  assert.equal(complete.params.turn.status, 'completed');
  return textFor(offset, started.turn.id);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function startTurn(threadId, text) {
  const offset = events.length;
  const started = await rpc('turn/start', { threadId, input: [{ type: 'text', text }] });
  return { offset, turnId: started.turn.id };
}
async function finishTurn(started, label) {
  const complete = await until(() => events.slice(started.offset).find(event => event.method === 'turn/completed' && event.params.turn.id === started.turnId), label);
  assert.equal(complete.params.turn.status, 'completed');
}
async function create(alias, marker, key) {
  const started = await rpc('thread/start', { model: alias, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(started.modelProvider, chatIdentity);
  await turn(started.thread.id, `Seed ${marker}.`, `seed-${key}`);
  receipt.threads[key] = started.thread.id;
  return started.thread.id;
}
async function savedProvider(threadId) {
  const database = (await readdir(home)).find(name => /^state_\d+\.sqlite$/.test(name));
  assert.ok(database, 'The SDK state database must exist');
  return execFileSync('sqlite3', ['-readonly', join(home, database), `select model_provider from threads where id = '${threadId.replace(/'/g, '')}'`], { encoding: 'utf8' }).trim();
}
function latest() { const value = observations.at(-1); assert.ok(value, 'The mock must receive inference'); return value; }
function verifyBinding(id, marker, provider) {
  const row = latest(); assert.equal(row.marker, marker); assert.equal(row.provider, provider); assert.equal(row.credentialMatch, true);
  receipt.bindings.push(provider);
  return id;
}
async function assertLoadedAlias(stage, key, threadId, alias) {
  const read = await rpc('thread/read', { threadId, includeTurns: false });
  assert.equal(read.thread.model, alias); assert.equal(read.thread.modelProvider, chatIdentity);
  receipt.loadedAliases[stage] ??= {}; receipt.loadedAliases[stage][key] = true;
}
function catalogRows(reply) {
  return new Set((reply.data || []).map(row => row.id ?? row.slug ?? row.model).filter(value => typeof value === 'string'));
}
async function assertCatalog(stage, expectedCanonical) {
  const rows = catalogRows(await rpc('model/list', { includeHidden: true }));
  const canonical = [aliases.primary, aliases.secondary].filter(alias => rows.has(alias)).length;
  const legacy = [aliases.oldPrimary, aliases.oldSecondary].filter(alias => rows.has(alias)).length;
  const other = rows.has(aliases.other);
  assert.equal(canonical === 2, expectedCanonical, `${stage} SDK catalog canonical aliases`);
  assert.equal(legacy, 2, `${stage} SDK catalog legacy aliases`); assert.equal(other, true, `${stage} SDK catalog other alias`);
  receipt.switches.catalog ??= {}; receipt.switches.catalog[stage] = { canonical, legacy, other };
}
async function switchForNextTurn(threadId, target, marker, provider, key) {
  let response;
  try { response = await rpc('thread/settings/update', { threadId, model: target }); }
  catch (error) {
    const text = String(error.message || '');
    assert.ok(text.length > 0 && text.length <= 320 && !Object.values(markers).some(marker => text.includes(marker)), 'SDK switch refusal must contain no history');
    receipt.switches[key] = { refused: true, error: text };
    throw error;
  }
  const status = typeof response.status === 'string' ? response.status : 'unreported';
  assert.ok(['applied', 'queued', 'unreported'].includes(status), `Unexpected SDK switch status: ${status}`);
  await until(async () => (await rpc('thread/read', { threadId, includeTurns: false })).thread.model === target, `${key} settings`);
  receipt.switches[key] = { accepted: true, status, applied: true };
  phase = `switch-${key}`;
  await turn(threadId, `Continue after selecting ${key}.`, phase);
  verifyBinding(threadId, marker, provider);
  await assertLoadedAlias('switch', key, threadId, target);
}
async function switchDuringTurn(threadId, target, marker, provider) {
  phase = 'running-switch'; heldInference = deferred();
  const active = await startTurn(threadId, 'Hold this fixture turn while the next model is selected.');
  await until(() => observations.some(row => row.phase === phase), 'running switch inference');
  let response;
  try { response = await rpc('thread/settings/update', { threadId, model: target }); }
  catch (error) {
    const text = String(error.message || '');
    assert.ok(text.length > 0 && text.length <= 320 && !Object.values(markers).some(marker => text.includes(marker)), 'SDK switch refusal must contain no history');
    receipt.switches.running = { refused: true, error: text }; throw error;
  }
  const status = typeof response.status === 'string' ? response.status : 'unreported';
  assert.ok(['applied', 'queued', 'unreported'].includes(status), `Unexpected SDK running switch status: ${status}`);
  receipt.switches.running = { accepted: true, status, applied: true };
  heldInference.resolve(); heldInference = undefined;
  await finishTurn(active, 'running switch turn');
  await until(async () => (await rpc('thread/read', { threadId, includeTurns: false })).thread.model === target, 'running switch settings');
  phase = 'running-switch-next-turn'; await turn(threadId, 'Use the model selected while the prior turn was active.', phase);
  verifyBinding(threadId, marker, provider);
  await assertLoadedAlias('switch', 'running', threadId, target);
}
async function adapterFrozenCatalogGuard(port) {
  const adapterHome = join(run, 'adapter-native'); const adapterModels = join(adapterHome, 'models.json');
  await mkdir(adapterHome, { recursive: true, mode: 0o700 });
  const nativeRow = { ...modelCatalog(initial).models[0], slug: 'native-fixture', display_name: 'Native fixture', description: 'Native fixture' };
  await writeFile(adapterModels, JSON.stringify({ models: [nativeRow] }), { mode: 0o600 });
  await writeFile(join(adapterHome, 'config.toml'), `model = "native-fixture"\nmodel_provider = "openai"\nmodel_catalog_json = ${JSON.stringify(adapterModels)}\nweb_search = "disabled"\n[analytics]\nenabled = false\n`, { mode: 0o600 });
  const initialSnapshot = { revision: 'initial-catalog', models: modelCatalog(initial).models };
  const refreshedSnapshot = { revision: 'refreshed-catalog', models: modelCatalog(final).models };
  // This is the old broken picker presentation only: canonical rows were shown
  // even though the loaded executor knew only the legacy aliases.
  const brokenSnapshot = { revision: 'broken-picker', models: refreshedSnapshot.models.map(model => ({ ...model,
    visibility: [aliases.oldPrimary, aliases.oldSecondary].includes(String(model.slug)) ? 'hide'
      : [aliases.primary, aliases.secondary].includes(String(model.slug)) ? 'list' : model.visibility,
  })) };
  let snapshot = initialSnapshot, pickerSnapshot = brokenSnapshot;
  const catalog = {
    current: () => snapshot, refresh: async () => snapshot, combined: value => ({ models: value.models }),
    nativeSlugs: new Set(['native-fixture']), isNative: model => model === 'native-fixture',
  };
  const source = {
    nativeSlugs: new Set(['native-fixture']), isNative: model => model === 'native-fixture',
    refresh: async () => ({ models: pickerSnapshot.models }),
  };
  const adapterEvents = []; let backend, router;
  const parentEnv = { ...process.env };
  const parentCwd = process.cwd();
  const adapterEnv = Object.fromEntries(Object.entries(safeEnv).filter(([key]) => key !== fixtureKey && key !== 'HARNESS_GATEWAY_EXECUTOR'));
  adapterEnv.HOME = join(run, 'adapter-home'); adapterEnv.CODEX_HOME = adapterHome; adapterEnv.TMPDIR = temp;
  await mkdir(adapterEnv.HOME, { recursive: true, mode: 0o700 });
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, adapterEnv);
  process.chdir(work);
  try {
    const overrides = { name: 'Account names adapter fixture', base_url: `http://127.0.0.1:${port}/v1`, wire_api: 'responses',
      requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_idle_timeout_ms: 30_000,
      'auth.command': process.execPath, 'auth.args': [join(codeRoot, 'dist/cli.js'), 'token', '--config', configPath] };
    backend = await AppServerBackends.create(sdk, ['app-server', '--listen', 'stdio://'], final, {}, overrides, catalog,
      async message => { await router?.observeNotification({ ...message, emittedAtMs: Date.now() }, 'gateway'); adapterEvents.push(message); }, () => {}, configPath);
    backend.resolveRuntime = async () => runtime;
    router = new AppServerRouter(final, (method, params, hint) => backend.request(method, params, hint), undefined, source, adapterHome, backend.identity);
    await router.initialize();
    await router.request('initialize', { clientInfo: { name: 'codex_account_names_adapter_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    backend.notify({ method: 'initialized', params: {} });
    const started = await router.request('thread/start', { model: aliases.oldPrimary, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
    const threadId = started.thread.id;
    const adapterTurn = async (text, label) => {
      const offset = adapterEvents.length; const turn = await router.request('turn/start', { threadId, input: [{ type: 'text', text }] });
      const done = await until(() => adapterEvents.slice(offset).find(event => event.method === 'turn/completed' && event.params?.turn?.id === turn.turn.id), label);
      assert.equal(done.params.turn.status, 'completed');
    };
    phase = 'adapter-seed'; await adapterTurn(`Seed ${markers.primary}.`, 'adapter seed'); verifyBinding(threadId, 'primary', 'codex-primary');
    snapshot = refreshedSnapshot;
    const brokenRows = catalogRows(await router.request('model/list', {}));
    assert.equal(brokenRows.has(aliases.primary), true); assert.equal(brokenRows.has(aliases.secondary), true);
    assert.equal(brokenRows.has(aliases.oldPrimary), false); assert.equal(brokenRows.has(aliases.oldSecondary), false);
    const exact = 'This loaded gateway chat uses an older catalog. Start a new chat to use a newly added model without interrupting it.';
    for (const [key, alias] of [['canonicalSecondary', aliases.secondary], ['canonicalPrimary', aliases.primary]]) {
      await assert.rejects(router.request('thread/settings/update', { threadId, model: alias }), error => {
        assert.equal(error.message, exact); return true;
      });
      receipt.switches.adapter ??= {}; receipt.switches.adapter[key] = { refused: true, error: exact };
    }
    pickerSnapshot = refreshedSnapshot;
    const repairedRows = catalogRows(await router.request('model/list', {}));
    assert.equal(repairedRows.has(aliases.primary), false); assert.equal(repairedRows.has(aliases.secondary), false);
    assert.equal(repairedRows.has(aliases.oldPrimary), true); assert.equal(repairedRows.has(aliases.oldSecondary), true);
    const stable = async (key, alias, provider) => {
      const response = await router.request('thread/settings/update', { threadId, model: alias });
      const status = typeof response.status === 'string' ? response.status : 'unreported';
      assert.ok(['applied', 'queued', 'unreported'].includes(status), `Unexpected adapter switch status: ${status}`);
      await until(async () => (await router.request('thread/read', { threadId, includeTurns: false })).thread.model === alias, `${key} adapter settings`);
      phase = `adapter-${key}`; await adapterTurn(`Continue after selecting ${key}.`, `${key} adapter turn`); verifyBinding(threadId, 'primary', provider);
      receipt.switches.adapter[key] = { accepted: true, status, applied: true };
    };
    await stable('legacySecondary', aliases.oldSecondary, 'codex-secondary');
    await stable('otherProvider', aliases.other, 'claude-primary');
    await stable('legacyPrimary', aliases.oldPrimary, 'codex-primary');
    receipt.switches.adapterGuard = true;
  } finally {
    await backend?.stop().catch(() => undefined);
    process.chdir(parentCwd);
    for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, parentEnv);
  }
}

let succeeded = false;
try {
  await writeFile(join(state, 'primary.json'), '{"fixture":true}\n', { mode: 0o600 });
  await writeFile(join(state, 'secondary.json'), '{"fixture":true}\n', { mode: 0o600 });
  await writeFile(join(state, 'other.json'), '{"fixture":true}\n', { mode: 0o600 });
  // The running SDK receives only the pre-migration catalog. Updating this file
  // after inference restarts deliberately reproduces a desktop executor that
  // did not restart with the inference child.
  await writeFile(catalogPath, JSON.stringify(modelCatalog(initial)), { mode: 0o600 });
  const migratedCatalog = modelCatalog(final);
  assert.equal(migratedCatalog.models.filter(model => model.visibility === 'hide').length, 2);
  receipt.aliases.legacyVisible = true; receipt.aliases.canonicalHidden = true;

  const firstConfig = structuredClone(initial);
  const port = await startServer(firstConfig);
  await startSdk(port);
  phase = 'legacy-primary'; const oldPrimary = await create(aliases.oldPrimary, markers.primary, 'oldPrimary');
  verifyBinding(oldPrimary, 'primary', 'codex-main');
  phase = 'legacy-secondary'; const oldSecondary = await create(aliases.oldSecondary, markers.secondary, 'oldSecondary');
  verifyBinding(oldSecondary, 'secondary', 'codex');
  await assertLoadedAlias('before', 'oldPrimary', oldPrimary, aliases.oldPrimary);
  await assertLoadedAlias('before', 'oldSecondary', oldSecondary, aliases.oldSecondary);
  assert.equal(await savedProvider(oldPrimary), chatIdentity);
  assert.equal(await savedProvider(oldSecondary), chatIdentity);

  const sdkPid = child.pid;
  await closeServer(server); server = undefined;
  const secondConfig = structuredClone(final); secondConfig.port = port;
  await startServer(secondConfig);
  await writeFile(catalogPath, JSON.stringify(migratedCatalog), { mode: 0o600 });
  assert.equal(child.pid, sdkPid); assert.equal(child.exitCode, null);
  receipt.serverRestartedWithoutSdkRestart = true;
  phase = 'warm-old-primary'; await turn(oldPrimary, 'Continue the primary saved chat.', phase); verifyBinding(oldPrimary, 'primary', 'codex-primary');
  phase = 'warm-old-secondary'; await turn(oldSecondary, 'Continue the secondary saved chat.', phase); verifyBinding(oldSecondary, 'secondary', 'codex-secondary');
  await assertLoadedAlias('warm', 'oldPrimary', oldPrimary, aliases.oldPrimary);
  await assertLoadedAlias('warm', 'oldSecondary', oldSecondary, aliases.oldSecondary);
  receipt.warmContinuation = true;
  if (values.switch) await adapterFrozenCatalogGuard(port);
  assert.equal(await savedProvider(oldPrimary), chatIdentity);
  assert.equal(await savedProvider(oldSecondary), chatIdentity);
  receipt.savedModelProviderUnchanged = true;

  await stopSdk(); await closeServer(server); server = undefined;
  const coldConfig = structuredClone(final); coldConfig.port = port;
  await startServer(coldConfig); await startSdk(port);
  if (values.switch) await assertCatalog('recreated', true);
  phase = 'cold-old-primary'; await rpc('thread/resume', { threadId: oldPrimary, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
  phase = 'cold-old-secondary'; await rpc('thread/resume', { threadId: oldSecondary, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
  phase = 'canonical-primary'; await create(aliases.primary, 'none', 'canonicalPrimary'); verifyBinding('', 'none', 'codex-primary');
  phase = 'canonical-secondary'; await create(aliases.secondary, 'none', 'canonicalSecondary'); verifyBinding('', 'none', 'codex-secondary');
  if (values.switch) {
    phase = 'cold-old-primary'; await turn(oldPrimary, 'Cold continue primary before switching.', phase); verifyBinding(oldPrimary, 'primary', 'codex-primary');
    phase = 'cold-old-secondary'; await turn(oldSecondary, 'Cold continue secondary before switching.', phase); verifyBinding(oldSecondary, 'secondary', 'codex-secondary');
    await switchForNextTurn(oldPrimary, aliases.secondary, 'primary', 'codex-secondary', 'canonicalSecondary');
    await switchForNextTurn(oldPrimary, aliases.primary, 'primary', 'codex-primary', 'canonicalPrimary');
    await switchForNextTurn(oldPrimary, aliases.other, 'primary', 'claude-primary', 'otherProvider');
    await switchDuringTurn(oldSecondary, aliases.primary, 'secondary', 'codex-primary');
  } else {
    phase = 'cold-old-primary'; await turn(oldPrimary, 'Cold continue primary.', phase); verifyBinding(oldPrimary, 'primary', 'codex-primary');
    phase = 'cold-old-secondary'; await turn(oldSecondary, 'Cold continue secondary.', phase); verifyBinding(oldSecondary, 'secondary', 'codex-secondary');
  }
  await assertLoadedAlias('cold', 'oldPrimary', oldPrimary, values.switch ? aliases.other : aliases.oldPrimary);
  await assertLoadedAlias('cold', 'oldSecondary', oldSecondary, values.switch ? aliases.primary : aliases.oldSecondary);
  assert.equal(await savedProvider(oldPrimary), chatIdentity);
  assert.equal(await savedProvider(oldSecondary), chatIdentity);
  receipt.coldContinuation = true; receipt.requestCount = observations.length; receipt.passed = true;
  succeeded = true;
} finally {
  heldInference?.resolve();
  await stopSdk().catch(() => undefined); await closeServer(server).catch(() => undefined);
  receipt.paidInferenceRequests = 0;
  if (succeeded) await rm(run, { recursive: true, force: true });
  await save();
}
