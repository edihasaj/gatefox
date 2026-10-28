import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const { values: options } = parseArgs({ options: {
  code: { type: 'string', default: '.' }, root: { type: 'string' },
  codex: { type: 'string', default: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' },
} });
assert(options.root && resolve(options.root).startsWith('/tmp/'), 'Use a task-specific --root under /tmp');
const code = resolve(options.code);
const { AppServerConnection } = await import(pathToFileURL(join(code, 'dist/app-server-connection.js')).href);
const { modelCatalog } = await import(pathToFileURL(join(code, 'dist/catalog.js')).href);
await mkdir(resolve(options.root), { recursive: true, mode: 0o700 });
const run = await mkdtemp(join(resolve(options.root), 'fixture-'));
const originalCwd = process.cwd(); const defaultFolder = join(run, 'default-cwd');
await mkdir(join(defaultFolder, '.codex'), { recursive: true });
await writeFile(join(defaultFolder, '.codex/config.toml'), 'model = "trust-project-fixture"\n', { mode: 0o600 });
process.chdir(defaultFolder);
const home = join(run, 'home'), nativeHome = join(home, '.codex'), state = join(run, 'state');
for (const folder of [home, nativeHome, state]) await mkdir(folder, { mode: 0o700 });
let unexpectedRequests = 0, mockTurns = 0;
let publicCatalog = { models: [] };
const server = createServer((req, res) => {
  if (req.url === '/v1/responses') {
    mockTurns++; req.resume();
    const item = { id: 'msg_' + mockTurns, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'TRUST_FIXTURE_OK', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\n');
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_' + mockTurns, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } }) + '\n\n');
    return;
  }
  res.setHeader('content-type', 'application/json');
  if (req.url !== '/v1/model-catalog') { unexpectedRequests++; res.writeHead(404); res.end('{}'); return; }
  res.end(JSON.stringify(publicCatalog));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
const modelsPath = join(nativeHome, 'models.json');
const models = modelCatalog({ version: 1, port, stateDirectory: state, providers: [{
  id: 'fixture', type: 'responses-api', baseUrl: `http://127.0.0.1:${port}/v1`, models: { 'trust-fixture': 'trust-fixture' },
}] });
models.models.push({ ...models.models[0], slug: 'trust-project-fixture' });
await writeFile(modelsPath, JSON.stringify(models), { mode: 0o600 });
const nativeConfig = [
  'model = "trust-fixture"', 'model_provider = "fixture"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"',
  'model_catalog_json = ' + JSON.stringify(modelsPath), 'web_search = "disabled"',
  '[model_providers.fixture]', 'name = "Isolated trust fixture"', `base_url = "http://127.0.0.1:${port}/v1"`,
  'wire_api = "responses"', 'env_key = "GATEWAY_TRUST_FIXTURE_KEY"', '',
].join('\n');
await writeFile(join(nativeHome, 'config.toml'), nativeConfig, { mode: 0o600 });
await writeFile(join(state, 'client-token'), 'fixture-token-' + 'x'.repeat(40), { mode: 0o600 });
const configPath = join(run, 'gateway.json');
const configuration = { version: 1, port, stateDirectory: state, providers: [{
  id: 'fixture', type: 'responses-api', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'GATEWAY_TRUST_FIXTURE_KEY', models: { 'fixture/gateway': 'trust-fixture' },
}] };
publicCatalog = modelCatalog(configuration);
await writeFile(configPath, JSON.stringify(configuration), { mode: 0o600 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|ANTHROPIC|CLAUDE)/.test(key)));
env.HOME = home; env.CODEX_HOME = nativeHome; env.TMPDIR = run;
env.GATEWAY_TRUST_FIXTURE_KEY = 'fixture-only'; env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
const connections = new Set();
async function connect() {
  const events = [];
  const c = new AppServerConnection(process.execPath, [join(code, 'dist/cli.js'), 'codex-shim', '--config', configPath, '--codex', resolve(options.codex), '--', 'app-server'], async event => { events.push(event); }, () => {}, env);
  c.fixtureEvents = events;
  connections.add(c);
  await c.request('initialize', { clientInfo: { name: 'codex_chatgpt_android_remote', version: 'trust-fixture' }, capabilities: { experimentalApi: true } });
  c.send({ method: 'initialized' }); return c;
}
async function close(c) { c.stop(); await c.exited; connections.delete(c); }
const read = (c, cwd) => c.request('config/read', { cwd, includeLayers: true });
function verify(r, cwd) {
  assert.equal(r.config.projects[cwd].trust_level, 'trusted');
  assert.equal(r.layers.find(l => l.name.type === 'user').config.projects[cwd].trust_level, 'trusted');
  assert.equal(r.config.approval_policy, 'on-request'); assert.equal(r.config.sandbox_mode, 'read-only');
}
try {
  const first = join(run, 'existing'); await mkdir(first);
  await mkdir(join(first, '.codex'));
  await writeFile(join(first, '.codex/config.toml'), 'model_reasoning_summary = "detailed"\n', { mode: 0o600 });
  const disabled = await connect(); const unchanged = await read(disabled, first);
  assert.equal(unchanged.config.projects?.[first], undefined);
  assert(unchanged.layers.some(l => l.name.type === 'project' && l.disabledReason != null));
  assert.equal(await readFile(join(nativeHome, 'config.toml'), 'utf8'), nativeConfig);
  await disabled.request('config/value/write', { keyPath: 'projects.' + JSON.stringify(await realpath(defaultFolder)) + '.trust_level', value: 'untrusted', mergeStrategy: 'replace' });
  await close(disabled);
  configuration.trustAllProjects = true; await writeFile(configPath, JSON.stringify(configuration));
  const enabled = await connect(); const trusted = await read(enabled, first); verify(trusted, first);
  assert.equal(trusted.config.model_reasoning_summary, 'detailed');
  assert(trusted.layers.some(l => l.name.type === 'project' && l.disabledReason == null));
  const canonicalFirst = await realpath(first);
  await enabled.request('config/value/write', { keyPath: 'projects.' + JSON.stringify(canonicalFirst) + '.trust_level', value: 'untrusted', mergeStrategy: 'replace' });
  const aliasTrusted = await read(enabled, first);
  verify(aliasTrusted, canonicalFirst); assert.equal(aliasTrusted.config.model_reasoning_summary, 'detailed');
  const defaultChat = await enabled.request('thread/start', { approvalPolicy: 'on-request', sandbox: 'read-only' });
  assert.equal(defaultChat.model, 'trust-project-fixture', 'The initial default-folder load must see its trusted project model');
  await enabled.request('thread/unsubscribe', { threadId: defaultChat.thread.id });
  const second = join(run, 'created-after-connect'); await mkdir(second);
  await enabled.request('project/create', { name: 'Trust fixture', roots: [{ path: second }], idempotencyKey: randomUUID() });
  verify(await read(enabled, second), second);
  const third = join(run, 'brand-new-chat'); await mkdir(third);
  const started = await enabled.request('thread/start', { cwd: third, approvalPolicy: 'on-request', sandbox: 'read-only' });
  assert.equal(started.thread.cwd, third); verify(await read(enabled, third), third);
  const turn = await enabled.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Return the fixture marker.' }] });
  const deadline = Date.now() + 30000;
  while (!enabled.fixtureEvents.some(e => e.method === 'turn/completed' && e.params.turn.id === turn.turn.id) && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
  assert.equal(enabled.fixtureEvents.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.turn.id)?.params.turn.status, 'completed');
  await enabled.request('config/value/write', { keyPath: 'projects.' + JSON.stringify(third) + '.trust_level', value: 'untrusted', mergeStrategy: 'replace' });
  const continued = await enabled.request('thread/resume', { threadId: started.thread.id });
  assert.equal(continued.thread.cwd, await realpath(third)); verify(await read(enabled, null), continued.thread.cwd);
  const fourth = join(run, 'gateway-chat'); await mkdir(fourth);
  const gateway = await enabled.request('thread/start', { cwd: fourth, model: 'fixture/gateway', approvalPolicy: 'on-request', sandbox: 'read-only' });
  verify(await enabled.request('config/read', { threadId: gateway.thread.id, cwd: fourth, includeLayers: true }), fourth);
  await enabled.request('thread/unsubscribe', { threadId: gateway.thread.id });
  await enabled.request('thread/unsubscribe', { threadId: started.thread.id });
  await close(enabled);
  const resumed = await connect();
  for (const cwd of [first, second, third]) verify(await read(resumed, cwd), cwd);
  await close(resumed);
  assert.equal(unexpectedRequests, 0, 'No unexpected network request was made'); assert.equal(mockTurns, 1);
  const receipt = { checkedAt: new Date().toISOString(), status: 'passed', defaultOff: true, newWorkingDirectory: true,
    newProject: true, newChat: true, defaultCwdBeforeInitialLoad: true, savedCwdResume: true, gatewayExecutor: true, freshConnection: true, genuineUserLayer: true, projectLayerActivated: true, permissionsPreserved: true, localMockTurns: mockTurns, externalProviderInferenceRequests: 0 };
  await writeFile(join(resolve(options.root), 'project-trust-e2e.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  process.chdir(originalCwd);
  for (const c of connections) await close(c);
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
