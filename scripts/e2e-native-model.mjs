// A native chat keeps its own model across a desktop engine restart and a fork, through the adapter exactly as
// straight to the signed SDK. Uses the desktop's own request shapes, isolated homes and a localhost mock upstream:
// no authentication, no native state and no paid inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values: v } = parseArgs({ options: { gateway: { type: 'string' }, root: { type: 'string' },
  codex: { type: 'string', default: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' } } });
for (const key of ['gateway', 'root']) assert.ok(v[key], `Missing --${key}`);
const gateway = resolve(v.gateway), sdk = await realpath(resolve(v.codex)), root = resolve(v.root);
for (const native of [join(homedir(), '.codex'), process.env.CODEX_HOME].filter(Boolean)) assert.ok(root !== resolve(native) && !root.startsWith(resolve(native) + sep), 'Use a root outside native Codex homes');
execFileSync('/usr/bin/codesign', ['--verify', '--strict', sdk], { stdio: 'pipe' });
const signing = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', sdk], { encoding: 'utf8', timeout: 10000 });
assert.match(signing.stderr, /^TeamIdentifier=2DC432GLL2$/m, 'Use the first-party signed SDK');
const sdkVersion = execFileSync(sdk, ['--version'], { encoding: 'utf8' }).trim();
// The app's signed engine: 0.162 on a Mac not yet updated, 0.163 from the 0.4.7 relay pin (as e2e-native-relay accepts).
assert.ok(['codex-cli 0.162.0-alpha.17.2', 'codex-cli 0.163.0-alpha.10.2'].includes(sdkVersion), 'Pass the pinned signed Mach-O, not its shell launcher');
await mkdir(root, { mode: 0o700 }); // Refuses a reused root.

const wire = []; let phase = 'setup';
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); chunks.length = 0;
  wire.push({ phase, model: body.model, effort: body.reasoning?.effort ?? null });
  const item = { id: 'msg_' + wire.length, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NATIVE_MODEL_OK', annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\n');
  res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_' + wire.length, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 7 } } }) + '\n\n');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const servePort = reservation.address().port; await new Promise(r => reservation.close(r));
const state = join(root, 'state'), serverConfig = join(root, 'server.json'), clientConfig = join(root, 'client.json'), fakeHome = join(root, 'home');
for (const dir of [state, fakeHome]) await mkdir(dir, { mode: 0o700 });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|HARNESS|ANTHROPIC|CLAUDE)/.test(key)));
Object.assign(env, { HOME: fakeHome, NATIVE_MODEL_FIXTURE_KEY: 'fixture-only', CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' });
await writeFile(serverConfig, JSON.stringify({ version: 1, port: servePort, stateDirectory: state, timeoutMs: 15000,
  providers: [{ id: 'fixture', type: 'responses-api', baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKeyEnv: 'NATIVE_MODEL_FIXTURE_KEY',
    models: { 'fixture/gateway': 'mock-gateway' }, modelMetadata: { 'fixture/gateway': { contextWindow: 32768, reasoningEfforts: ['low'] } } }] }), { mode: 0o600 });
await writeFile(clientConfig, JSON.stringify({ version: 1, port: servePort, stateDirectory: state, clientOnly: true, providers: [] }), { mode: 0o600 });
const command = (args, options) => spawn(gateway.endsWith('.js') ? process.execPath : gateway, gateway.endsWith('.js') ? [gateway, ...args] : args, options);
const catalog = JSON.parse(execFileSync(gateway.endsWith('.js') ? process.execPath : gateway, [...(gateway.endsWith('.js') ? [gateway] : []), 'catalog', '--config', serverConfig], { env, encoding: 'utf8' }));
const levels = ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort, description: effort }));
const row = (slug, def) => ({ ...catalog.models[0], slug, display_name: slug, supported_reasoning_levels: levels, default_reasoning_level: def,
  additional_speed_tiers: [], service_tiers: [], default_service_tier: null });

const owned = new Set();
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'close'); child.kill('SIGTERM');
    if (!await Promise.race([exit.then(() => true), delay(4000).then(() => false)])) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await exit; }
  }
  owned.delete(child);
}
async function until(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); }
  throw Error(label + ' timed out');
}
const serving = command(['serve', '--config', serverConfig], { env, stdio: 'ignore', detached: true }); owned.add(serving);

// ChatGPT 26.1007.71326 (app.asar webview bundle): the renderer's resume after an engine restart, its side chat,
// and "Fork into local", which names the chat's latest model and effort.
const desktopConfig = { 'apps.connector_openai_pages.tools': { 'chatgpt_space.create_presentation': { enabled: false } } };
const shapes = work => ({
  resume: (threadId, path) => ({ threadId, history: null, path, model: null, modelProvider: null, cwd: work, personality: null, excludeTurns: true, config: desktopConfig }),
  fork: (threadId, extra) => ({ threadId, path: null, cwd: work, runtimeWorkspaceRoots: [work], threadSource: 'user', excludeTurns: true, ...extra }),
});
async function scenario(mode) {
  const home = join(root, mode, 'native'), work = join(root, mode, 'work');
  for (const dir of [home, work]) await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'models.json'), JSON.stringify({ models: [row('gpt-6-astra', 'low'), row('gpt-6.1-sol', 'medium')] }), { mode: 0o600 });
  const nativeConfig = ['model = "gpt-6-astra"', 'model_provider = "mock"', 'model_catalog_json = ' + JSON.stringify(join(home, 'models.json')), 'web_search = "disabled"',
    '[model_providers.mock]', 'name = "Mock native"', `base_url = "http://127.0.0.1:${upstream.address().port}/v1"`, 'env_key = "NATIVE_MODEL_FIXTURE_KEY"',
    'wire_api = "responses"', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0', '[features]', 'remote_control = false'].join('\n') + '\n';
  await writeFile(join(home, 'config.toml'), nativeConfig, { mode: 0o600 });
  const open = async () => {
    const options = { env: { ...env, CODEX_HOME: home }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'], detached: true };
    const child = mode === 'adapter' ? command(['codex-shim', '--config', clientConfig, '--codex', sdk, '--', 'app-server', '--listen', 'stdio://'], options)
      : spawn(sdk, ['app-server', '--listen', 'stdio://'], options);
    owned.add(child);
    const events = [], pending = new Map(); let sequence = 0;
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    createInterface({ input: child.stdout }).on('line', line => {
      const message = JSON.parse(line), entry = pending.get(message.id);
      if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Error(entry.method + ' rejected: ' + message.error.code)) : entry.resolve(message.result); }
      else if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Fixture has no handler' } });
      else if (message.method) events.push(message);
    });
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 30000);
      pending.set(id, { resolve, reject, timer, method }); send({ id, method, params });
    });
    await rpc('initialize', { clientInfo: { name: 'Codex Desktop', version: '26.1007.71326' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const turn = async (threadId, name, params = {}) => {
      phase = mode + ':' + name; const start = wire.length, offset = events.length;
      const t = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Reply with the fixture marker.' }], ...params });
      const done = await until(() => events.slice(offset).find(event => event.method === 'turn/completed' && event.params.turn.id === t.turn.id), phase);
      assert.equal(done.params.turn.status, 'completed', phase);
      return wire.slice(start).map(({ model, effort }) => ({ model, effort })).at(-1);
    };
    return { rpc, turn, close: async () => { child.stdin.end(); await stop(child); } };
  };
  const { resume, fork } = shapes(work), out = {};
  // Engine 1: native chats on gpt-6.1-sol with one real (mock) turn at high effort.
  let engine = await open(); const chats = {};
  for (const name of ['resume', 'effort', 'fork']) {
    const started = await engine.rpc('thread/start', { model: 'gpt-6.1-sol', cwd: work, approvalPolicy: 'never', sandbox: 'read-only' });
    chats[name] = started.thread; assert.deepEqual(await engine.turn(started.thread.id, 'setup-' + name, { effort: 'high' }), { model: 'gpt-6.1-sol', effort: 'high' });
  }
  await engine.close();
  // Engine 2: the restart. The desktop resumes with its own shape; the direct run also sends the effort 0.4.0 added.
  engine = await open();
  const pick = async (name, result, threadId) => ({ model: result.model, modelProvider: result.modelProvider, next: await engine.turn(threadId ?? result.thread.id, name) });
  out.resume = await pick('resume', await engine.rpc('thread/resume', resume(chats.resume.id, chats.resume.path)));
  if (mode === 'direct') {
    const params = resume(chats.effort.id, chats.effort.path); params.config = { ...params.config, model_reasoning_effort: 'high' };
    out.resumeWithAddedEffort = await pick('resume-effort', await engine.rpc('thread/resume', params));
  }
  await engine.close();
  // Engine 3: forks of the unloaded parent.
  engine = await open();
  out.forkIntoLocal = await pick('fork-local', await engine.rpc('thread/fork', fork(chats.fork.id, { model: 'gpt-6.1-sol', config: { ...desktopConfig, model_reasoning_effort: 'high' } })));
  out.forkNamedModelNoEffort = await pick('fork-named', await engine.rpc('thread/fork', fork(chats.fork.id, { model: 'gpt-6.1-sol', config: desktopConfig })));
  out.sideChat = await pick('fork-side', await engine.rpc('thread/fork', fork(chats.fork.id, { config: desktopConfig, developerInstructions: 'side chat', ephemeral: true })));
  if (mode === 'direct') out.sideChatWithAddedEffort = await pick('fork-side-effort', await engine.rpc('thread/fork', fork(chats.fork.id, { config: { ...desktopConfig, model_reasoning_effort: 'high' }, developerInstructions: 'side chat', ephemeral: true })));
  await engine.close();
  assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), nativeConfig);
  return out;
}

const result = { checkedAt: new Date().toISOString(), sdkVersion, gateway, paidInferenceRequests: 0, passed: false };
try {
  await until(() => fetch('http://127.0.0.1:' + servePort + '/health').then(res => res.ok).catch(() => false), 'Fixture gateway serve');
  const direct = await scenario('direct'), adapter = await scenario('adapter');
  Object.assign(result, { direct, adapter });
  // The SDK's own rules: the desktop's resume restores the chat's model, an added effort blocks that restore,
  // and a fork that names no model runs the configured default with or without an effort.
  assert.equal(direct.resume.model, 'gpt-6.1-sol'); assert.deepEqual(direct.resume.next, { model: 'gpt-6.1-sol', effort: 'high' });
  assert.equal(direct.resumeWithAddedEffort.model, 'gpt-6-astra');
  assert.equal(direct.sideChat.model, 'gpt-6-astra'); assert.equal(direct.sideChatWithAddedEffort.model, 'gpt-6-astra');
  // The adapter gives every desktop shape the model the SDK gives it directly.
  for (const name of ['resume', 'forkIntoLocal', 'forkNamedModelNoEffort', 'sideChat']) {
    assert.equal(adapter[name].model, direct[name].model, name); assert.equal(adapter[name].modelProvider, direct[name].modelProvider, name);
    assert.equal(adapter[name].next.model, direct[name].next.model, name);
  }
  // Efforts match too: the adapter adds nothing to a native request, so a fork that names the chat's own model
  // without an effort gets the engine's own effort, exactly as it does directly.
  for (const name of ['resume', 'forkIntoLocal', 'forkNamedModelNoEffort', 'sideChat']) assert.equal(adapter[name].next.effort, direct[name].next.effort, name);
  result.passed = true;
} catch (error) { result.failure = { phase, message: String(error?.message).slice(0, 500) }; process.exitCode = 1; }
finally {
  for (const child of [...owned]) await stop(child);
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
}
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result));
