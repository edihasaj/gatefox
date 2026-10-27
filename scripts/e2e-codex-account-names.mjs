// Proves that the real pinned gateway SDK keeps saved chats routable while the
// two Codex account IDs are renamed. The upstream is a local mock: no ChatGPT
// login, inherited authentication, or paid inference is used.
//
// node scripts/e2e-codex-account-names.mjs --package INSTALLED_PACKAGE --root RESULTS [--code COMPILED_CHECKOUT] [--planner MANAGER_PLANNER] [--identity openai|legacy]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values } = parseArgs({ options: {
  package: { type: 'string' }, code: { type: 'string' }, root: { type: 'string' }, planner: { type: 'string' }, identity: { type: 'string', default: 'openai' },
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
const [{ startGateway }, { modelCatalog }, { writePrivateJson }, { gatewaySdkRuntime }] = await Promise.all([
  load('server'), load('catalog'), load('config'), load('gateway-sdk-runtime'),
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
assert.deepEqual(final.providers.map(provider => provider.id), ['codex-primary', 'codex-secondary']);
for (const alias of [aliases.oldPrimary, aliases.oldSecondary]) {
  const provider = final.providers.find(item => Object.hasOwn(item.models, alias));
  assert.equal(provider?.modelMetadata?.[alias]?.pickerHidden, true, 'The legacy route must be retained but hidden');
}

let server, child, closed, phase = 'setup', sequence = 0, failed;
const events = [], pending = new Map(), observations = [];
const markers = { primary: 'ACCOUNT_NAMES_PRIMARY_HISTORY', secondary: 'ACCOUNT_NAMES_SECONDARY_HISTORY' };
const credentials = new Map([
  ['codex-main', join(state, 'primary.json')], ['codex-primary', join(state, 'primary.json')],
  ['codex', join(state, 'secondary.json')], ['codex-secondary', join(state, 'secondary.json')],
]);
const receipt = { checkedAt: new Date().toISOString(), passed: false, realGatewaySdk: true, plannerUsed: !!planner, identity: chatIdentity,
  paidInferenceRequests: 0, aliases: { legacyHidden: false, canonicalAdded: false }, serverRestartedWithoutSdkRestart: false,
  savedModelProviderUnchanged: false, warmContinuation: false, coldContinuation: false, bindings: [], threads: {}, loadedAliases: {}, requestCount: 0 };

const save = async () => writeFile(join(resultsRoot, 'codex-account-names.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
const until = async (check, name, timeout = 20_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (failed) throw Error(failed); const value = await check(); if (value) return value; await delay(25); }
  throw Error(`${name} timed out`);
};
const inputHas = (input, marker) => JSON.stringify(input).includes(marker);
const mockFactory = provider => ({
  async *infer(request) {
    const marker = inputHas(request.input, markers.primary) ? 'primary' : inputHas(request.input, markers.secondary) ? 'secondary' : 'none';
    observations.push({ phase, provider: provider.id, marker, credentialMatch: provider.credentialFile === credentials.get(provider.id) });
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
  pending.set(id, { resolve, reject, timer });
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
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Error(`${entry.method || 'rpc'} failed`)) : entry.resolve(message.result); }
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

let succeeded = false;
try {
  await writeFile(join(state, 'primary.json'), '{"fixture":true}\n', { mode: 0o600 });
  await writeFile(join(state, 'secondary.json'), '{"fixture":true}\n', { mode: 0o600 });
  const catalog = modelCatalog(final);
  await writeFile(catalogPath, JSON.stringify(catalog), { mode: 0o600 });
  assert.equal(catalog.models.filter(model => model.visibility === 'hide').length, 2);
  receipt.aliases.legacyHidden = true; receipt.aliases.canonicalAdded = true;

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
  assert.equal(child.pid, sdkPid); assert.equal(child.exitCode, null);
  receipt.serverRestartedWithoutSdkRestart = true;

  phase = 'warm-old-primary'; await turn(oldPrimary, 'Continue the primary saved chat.', phase); verifyBinding(oldPrimary, 'primary', 'codex-primary');
  phase = 'warm-old-secondary'; await turn(oldSecondary, 'Continue the secondary saved chat.', phase); verifyBinding(oldSecondary, 'secondary', 'codex-secondary');
  await assertLoadedAlias('warm', 'oldPrimary', oldPrimary, aliases.oldPrimary);
  await assertLoadedAlias('warm', 'oldSecondary', oldSecondary, aliases.oldSecondary);
  receipt.warmContinuation = true;
  phase = 'canonical-primary'; await create(aliases.primary, 'none', 'canonicalPrimary'); verifyBinding('', 'none', 'codex-primary');
  phase = 'canonical-secondary'; await create(aliases.secondary, 'none', 'canonicalSecondary'); verifyBinding('', 'none', 'codex-secondary');
  assert.equal(await savedProvider(oldPrimary), chatIdentity);
  assert.equal(await savedProvider(oldSecondary), chatIdentity);
  receipt.savedModelProviderUnchanged = true;

  await stopSdk(); await closeServer(server); server = undefined;
  const coldConfig = structuredClone(final); coldConfig.port = port;
  await startServer(coldConfig); await startSdk(port);
  phase = 'cold-old-primary'; await rpc('thread/resume', { threadId: oldPrimary, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
  await turn(oldPrimary, 'Cold continue primary.', phase); verifyBinding(oldPrimary, 'primary', 'codex-primary');
  phase = 'cold-old-secondary'; await rpc('thread/resume', { threadId: oldSecondary, cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
  await turn(oldSecondary, 'Cold continue secondary.', phase); verifyBinding(oldSecondary, 'secondary', 'codex-secondary');
  await assertLoadedAlias('cold', 'oldPrimary', oldPrimary, aliases.oldPrimary);
  await assertLoadedAlias('cold', 'oldSecondary', oldSecondary, aliases.oldSecondary);
  assert.equal(await savedProvider(oldPrimary), chatIdentity);
  assert.equal(await savedProvider(oldSecondary), chatIdentity);
  receipt.coldContinuation = true; receipt.requestCount = observations.length; receipt.passed = true;
  succeeded = true;
} finally {
  await stopSdk().catch(() => undefined); await closeServer(server).catch(() => undefined);
  receipt.paidInferenceRequests = 0;
  if (succeeded) await rm(run, { recursive: true, force: true });
  await save();
}
