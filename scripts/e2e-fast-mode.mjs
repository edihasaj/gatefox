import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, access, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values: v } = parseArgs({ options: { gateway: { type: 'string' }, package: { type: 'string' }, root: { type: 'string' },
  codex: { type: 'string', default: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' },
  transports: { type: 'string', default: 'stdio,unix' } } });
for (const key of ['gateway', 'package', 'root']) assert.ok(v[key], `Missing --${key}`);
const root = resolve(v.root), gateway = resolve(v.gateway), sdk = resolve(v.codex);
assert.ok(root !== resolve(homedir(), '.codex') && !root.startsWith(resolve(homedir(), '.codex') + '/'));
const transports = v.transports.split(','); assert.ok(transports.every(value => ['stdio', 'unix'].includes(value)));
if (process.platform === 'darwin') execFileSync('/usr/bin/codesign', ['--verify', '--strict', sdk], { stdio: 'pipe' });
const sdkVersion = execFileSync(sdk, ['--version'], { encoding: 'utf8' }).trim();
// The native engine is the app's own signed CLI, whatever version the app ships; gateway chats run the package's pinned SDK.
assert.match(sdkVersion, /^codex-cli \d+\.\d+\.\d+/);
const { WebSocket } = createRequire(join(resolve(v.package), 'package.json'))('ws');
const owned = new Set(), servers = new Set(), clients = new Set();
let runFolder, closing = false, stopping;
const signalGroup = (child, signal) => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH' && error.code !== 'EPERM') throw error; }
};
async function stop(child) {
  if (!child) return;
  try {
    // Every child leads a process group of its own, and the engine's own children (git, in particular) live in that
    // group: signal the group, not just the child, and sweep it once the child is gone, so nothing outlives this script.
    if (child.exitCode !== null || child.signalCode !== null) return signalGroup(child, 'SIGKILL');
    const exit = once(child, 'close').catch(() => {}); signalGroup(child, 'SIGTERM');
    const closed = await Promise.race([exit.then(() => true), delay(3000).then(() => false)]);
    signalGroup(child, 'SIGKILL');
    if (!closed) await exit;
  } finally { owned.delete(child); }
}
// One teardown for both endings: the finally below and the stopped-by-signal path. The check starts its
// children in groups of their own, so every one of them must be stopped here or it outlives this script.
// Once it starts nothing new may be spawned, and it repeats until nothing is left that the main flow added meanwhile.
const cleanup = async () => {
  if (stopping) return stopping;
  closing = true;
  stopping = (async () => {
    await Promise.allSettled([...clients].map(client => client.close()));
    while (owned.size) await Promise.allSettled([...owned].map(stop));
    for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    const run = await runFolder?.catch(() => undefined);
    if (run) await rm(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  })();
  return stopping;
};
// Installed before anything is created, so a signal at any moment leaves nothing behind.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  void cleanup().catch(() => {}).then(() => process.exit(1));
});
await mkdir(root, { recursive: true, mode: 0o700 });
// macOS Unix socket names have a small limit; keep the private fixture path short.
runFolder = mkdtemp('/tmp/gw-fast-');
const run = await runFolder;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX|OPENAI|GATEWAY|SUBSCRIPTION_GATEWAY|ANTHROPIC|CLAUDE)/.test(key)));
env.GATEWAY_FAST_FIXTURE_KEY = 'fixture-only'; env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
const results = [], wire = [], returned = [];
let phase = 'setup', failedPhase, responseTier = 'priority';
// Every row says where the check had got to; the failure names the phase it stopped in, and the
// watchdog reads that one field and nothing else.
const save = async row => {
  results.push(row);
  await writeFile(join(root, 'result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), sdkVersion, gateway, failedPhase,
    primaryConfigRead: false, primaryConfigWritten: false, nativeAuthCopied: false, paidInferenceRequests: 0, results, requestedTiers: wire, returnedTiers: returned }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(row));
};
function command(args, extra = {}) { if (closing) throw Error('Fixture is closing'); return spawn(gateway.endsWith('.js') ? process.execPath : gateway,
  gateway.endsWith('.js') ? [gateway, ...args] : args, { env, stdio: ['ignore', 'ignore', 'ignore'], detached: true, ...extra }); }
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(25); }
  throw Error(label + ' timed out');
}
const upstream = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); chunks.length = 0;
  wire.push({ phase, serviceTier: body.service_tier ?? null });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'FAST_FIXTURE_OK' }) + '\n\n');
  res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', service_tier: responseTier,
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } }) + '\n\n');
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); servers.add(upstream);
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const servePort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const serverConfig = join(run, 'server.json'), state = join(run, 'state');
await writeFile(serverConfig, JSON.stringify({ version: 1, port: servePort, stateDirectory: state, timeoutMs: 15000,
  providers: [{ id: 'fixture', type: 'responses-api', baseUrl: 'http://127.0.0.1:' + upstream.address().port, apiKeyEnv: 'GATEWAY_FAST_FIXTURE_KEY',
    models: { 'fixture/fast': 'mock-fast-model' }, modelMetadata: { 'fixture/fast': { contextWindow: 32768, reasoningEfforts: ['low'],
      additionalSpeedTiers: ['fast'], serviceTiers: [{ id: 'priority', name: 'Fast', description: 'Priority routing' }], defaultServiceTier: null } } }] }), { mode: 0o600 });
let proxy;
function clientTransport(child, websocket) {
  const events = [], pending = new Map(); let sequence = 0;
  const send = value => websocket ? websocket.send(JSON.stringify(value)) : child.stdin.write(JSON.stringify(value) + '\n');
  const receive = text => {
    const message = JSON.parse(text), entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(Object.assign(Error('RPC rejected: ' + entry.method), { code: message.error.code,
      fixtureDiagnostic: String(message.error.message).slice(0, 500).replace(/Bearer\s+\S+/gi, 'Bearer <redacted>') })) : entry.resolve(message.result); }
    else if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Fixture has no approval handler' } });
    else if (message.method) events.push(message);
  };
  const lines = websocket ? undefined : createInterface({ input: child.stdout });
  if (websocket) websocket.on('message', data => receive(data.toString())); else lines.on('line', receive);
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timed out')); }, 15000);
    pending.set(id, { resolve, reject, timer, method }); send({ id, method, params });
  });
  const client = { events, rpc, send, close: async () => {
    websocket?.terminate(); lines?.close(); child.stdin?.end();
    for (const entry of pending.values()) clearTimeout(entry.timer); pending.clear(); await stop(child); clients.delete(client);
  } }; clients.add(client); return client;
}
async function initialize(client) { await client.rpc('initialize', { clientInfo: { name: 'gateway_fast_mode_fixture', version: '1' }, capabilities: { experimentalApi: true } }); client.send({ method: 'initialized', params: {} }); }
async function invoke(client, threadId, name, tier, params = {}, actual = 'priority') {
  phase = name; responseTier = actual;
  const start = wire.length, output = returned.length, offset = client.events.length;
  const t = await client.rpc('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text: 'Reply with the fixture marker. Do not use tools.' }], ...params });
  const completed = await until(() => client.events.slice(offset).find(event => event.method === 'turn/completed' && event.params.turn.id === t.turn.id), name);
  assert.equal(completed.params.turn.status, 'completed');
  const text = client.events.slice(offset).filter(event => event.method === 'item/agentMessage/delta').map(event => event.params.delta).join('');
  assert.equal(text, 'FAST_FIXTURE_OK'); assert.equal(wire.length, start + 1); assert.equal(wire[start].serviceTier, tier);
  await until(() => returned.length === output + 1, 'Returned tier frame'); assert.equal(returned[output].serviceTier, actual);
  await save({ phase: name, passed: true, requestedServiceTier: tier, actualReturnedServiceTier: actual });
}
try {
  phase = 'serve';
  owned.add(command(['serve', '--config', serverConfig]));
  await until(() => fetch('http://127.0.0.1:' + servePort + '/health').then(res => res.ok).catch(() => false), 'Fixture CLI serve');
  const token = (await readFile(join(state, 'client-token'), 'utf8')).trim();
  proxy = createServer((req, res) => {
    const requestPhase = phase;
    const forwarded = httpRequest({ host: '127.0.0.1', port: servePort, path: req.url, method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers); let buffer = '';
      incoming.on('data', bytes => {
        buffer += bytes.toString(); assert.ok(buffer.length < 1024 * 1024); let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, at); buffer = buffer.slice(at + 2); const data = frame.match(/^data: (.+)$/m);
          if (data) { const event = JSON.parse(data[1]); if (event.type === 'response.completed') returned.push({ phase: requestPhase, serviceTier: event.response.service_tier ?? null }); }
        }
      }); incoming.pipe(res); res.once('close', () => { if (!res.writableEnded) { incoming.destroy(); forwarded.destroy(); } });
    }); forwarded.on('error', () => { if (!res.destroyed) { res.writeHead(502); res.end(); } }); req.pipe(forwarded);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); servers.add(proxy);
  const clientConfig = join(run, 'client.json');
  await writeFile(clientConfig, JSON.stringify({ version: 1, port: proxy.address().port, stateDirectory: state, clientOnly: true, providers: [] }), { mode: 0o600 });
  phase = 'catalog';
  const catCommand = gateway.endsWith('.js') ? process.execPath : gateway;
  const catalog = JSON.parse(execFileSync(catCommand, [...(gateway.endsWith('.js') ? [gateway] : []), 'catalog', '--config', serverConfig], { env, encoding: 'utf8' }));
  for (const transport of transports) {
    const home = join(run, 'native'), work = join(run, transport, 'work'), proxyHome = join(run, transport, 'proxy');
    await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(work, { recursive: true, mode: 0o700 });
    const nativeModel = { ...catalog.models[0], slug: 'native-fixture', display_name: 'Native fixture', additional_speed_tiers: [], service_tiers: [], default_service_tier: null };
    await writeFile(join(home, 'models.json'), JSON.stringify({ models: [nativeModel] }), { mode: 0o600 });
    const nativeConfig = 'model = "native-fixture"\nmodel_catalog_json = ' + JSON.stringify(join(home, 'models.json')) + '\nweb_search = "disabled"\n[features]\nremote_control = false\nfast_mode = false\nplugins = false\n';
    await writeFile(join(home, 'config.toml'), nativeConfig, { mode: 0o600 });
    // Each transport gets its own private preferences; no live gateway state is reused.
    await writeFile(join(state, 'desktop-preferences.json'), '{}\n', { mode: 0o600 });
    const host = async () => {
      phase = transport + '-host';
      const child = command(['executor-host', '--config', clientConfig, '--codex', sdk, '--native-home', home], { cwd: work, stdio: ['ignore', 'pipe', 'ignore'] });
      owned.add(child); let ready = false;
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => { const value = JSON.parse(line); if (value.executionHome) ready = true; });
      await until(() => ready, 'Fixture shared host'); lines.close(); return child;
    };
    let executorHost = await host();
    const open = async () => {
    phase = transport + '-open';
    let listener, client;
    if (transport === 'stdio') {
      const child = command(['codex-shim', '--config', clientConfig, '--codex', sdk, '--', 'app-server', '--listen', 'stdio://'],
        { env: { ...env, CODEX_HOME: home }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'] }); owned.add(child); client = clientTransport(child);
    } else {
      listener = command(['codex-shim', '--ssh', '--ssh-home', proxyHome, '--config', clientConfig, '--codex', sdk, '--', 'app-server', '--listen', 'unix://'],
        { env: { ...env, CODEX_HOME: home }, cwd: work }); owned.add(listener);
      await until(() => access(join(proxyHome, 'app-server-control/app-server-control.sock')).then(() => true, () => false), 'Private Unix listener');
      if (closing) throw Error('Fixture is closing');
      const child = spawn(sdk, ['app-server', 'proxy'], { env: { ...env, CODEX_HOME: proxyHome }, cwd: work, stdio: ['pipe', 'pipe', 'ignore'], detached: true }); owned.add(child);
      const pipe = Duplex.from({ readable: child.stdout, writable: child.stdin });
      const websocket = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => pipe });
      await once(websocket, 'open', { signal: AbortSignal.timeout(15000) }); client = clientTransport(child, websocket);
    }
    await initialize(client); return { listener, client };
    };
    let { listener, client } = await open();
    phase = transport + '-catalog';
    const listed = await client.rpc('model/list', { limit: 1000 }); const model = listed.data.find(row => row.model === 'fixture/fast'); assert.ok(model);
    assert.deepEqual(model.additionalSpeedTiers, ['fast']); assert.equal(model.serviceTiers[0].id, 'priority'); assert.equal(model.defaultServiceTier, null);
    const nativeView = await client.rpc('config/read', { includeLayers: false });
    assert.equal(nativeView.config.features.fast_mode, false);
    await save({ phase: transport + '-catalog', passed: true, fastMetadataRetained: true, standardDefault: true, nativeFastFeatureFalse: true });
    const start = params => client.rpc('thread/start', { model: 'fixture/fast', cwd: work, approvalPolicy: 'never', sandbox: 'read-only', ...params });
    const standard = await start({});
    await invoke(client, standard.thread.id, transport + '-standard-default', null, {}, 'default');
    await client.rpc('config/batchWrite', { edits: [{ keyPath: 'model', value: 'fixture/fast', mergeStrategy: 'replace' }, { keyPath: 'service_tier', value: 'priority', mergeStrategy: 'replace' }] });
    const fast = await start({}); await invoke(client, fast.thread.id, transport + '-saved-fast-default', 'priority');
    await invoke(client, fast.thread.id, transport + '-null-turn-inherits-fast', 'priority', { serviceTierForTurn: null });
    await invoke(client, fast.thread.id, transport + '-one-turn-standard', null, { serviceTierForTurn: 'default' }, 'default');
    await invoke(client, fast.thread.id, transport + '-follow-up-retains-fast', 'priority');
    await invoke(client, fast.thread.id, transport + '-fast-alias-normalized', 'priority', { serviceTierForTurn: 'fast' });
    await invoke(client, fast.thread.id, transport + '-returned-standard-is-truthful', 'priority', {}, 'default');
    const explicit = await start({ serviceTier: null }); await invoke(client, explicit.thread.id, transport + '-null-thread-standard', null, {}, 'default');
    const parentStandard = await client.rpc('thread/fork', { threadId: explicit.thread.id, model: 'fixture/fast', cwd: work });
    await invoke(client, parentStandard.thread.id, transport + '-fork-preserves-parent-standard', null, {}, 'default');
    const fork = await client.rpc('thread/fork', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work });
    await invoke(client, fork.thread.id, transport + '-fork-inherits-fast', 'priority');
    const forkStandard = await client.rpc('thread/fork', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work, serviceTier: null });
    await invoke(client, forkStandard.thread.id, transport + '-fork-null-standard', null, {}, 'default');
    await client.rpc('thread/unsubscribe', { threadId: fast.thread.id });
    await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work });
    await invoke(client, fast.thread.id, transport + '-resume-restores-fast', 'priority');
    const loaded = await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work, serviceTier: null });
    assert.equal(loaded.serviceTier, 'priority');
    await invoke(client, fast.thread.id, transport + '-loaded-resume-preserves-tier', 'priority');
    // A new-chat default must not change a saved Fast chat across a fresh owner.
    await client.rpc('config/value/write', { keyPath: 'service_tier', value: null, mergeStrategy: 'replace' });
    await client.close(); await stop(listener); await stop(executorHost);
    executorHost = await host(); ({ listener, client } = await open());
    await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work });
    await invoke(client, fast.thread.id, transport + '-cold-fast-survives-standard-newchat-default', 'priority');
    await client.rpc('config/value/write', { keyPath: 'service_tier', value: 'priority', mergeStrategy: 'replace' });
    // A second adapter changes the same SDK session; the older router must see it.
    const peer = await open();
    await peer.client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work });
    const offset = client.events.length;
    await peer.client.rpc('thread/settings/update', { threadId: fast.thread.id, serviceTier: null });
    await until(() => client.events.slice(offset).some(event => event.method === 'thread/settings/updated' && event.params.threadId === fast.thread.id), 'Standard settings notification');
    await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work });
    await invoke(client, fast.thread.id, transport + '-settings-null-standard', null, {}, 'default');
    await peer.client.close(); await stop(peer.listener);
    await client.close(); await stop(listener); await stop(executorHost);
    executorHost = await host(); ({ listener, client } = await open());
    await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work });
    await invoke(client, fast.thread.id, transport + '-cold-resume-preserves-chat-standard', null, {}, 'default');
    await client.close(); await stop(listener); await stop(executorHost);
    executorHost = await host(); ({ listener, client } = await open());
    await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work, serviceTier: 'fast' });
    await invoke(client, fast.thread.id, transport + '-cold-resume-explicit-fast', 'priority');
    await client.close(); await stop(listener); await stop(executorHost);
    executorHost = await host(); ({ listener, client } = await open());
    await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work, serviceTier: null });
    await invoke(client, fast.thread.id, transport + '-cold-resume-null-standard', null, {}, 'default');
    // ChatGPT 26.1013 picks features by the native engine's version and sends 0.163-only tables to every chat. A gateway chat's
    // older pinned SDK rejected the whole configuration ("invalid type: map, expected a boolean in `features`") until 0.4.2.
    await client.close(); await stop(listener); await stop(executorHost);
    executorHost = await host(); ({ listener, client } = await open());
    await client.rpc('thread/resume', { threadId: fast.thread.id, model: 'fixture/fast', cwd: work, serviceTier: null,
      config: { 'features.async_compaction': { enabled: true, threshold: 3 }, 'features.multi_agent_v2.preserve_fork_prefix': true } });
    await invoke(client, fast.thread.id, transport + '-cold-resume-newer-feature-tables', null, {}, 'default');
    const featured = await start({ serviceTier: null, config: { features: { async_compaction: { mode: 'remote' }, multi_agent_v2: { enabled: true, preserve_fork_prefix: true } } } });
    await invoke(client, featured.thread.id, transport + '-start-newer-feature-tables', null, {}, 'default');
    assert.equal(await readFile(join(home, 'config.toml'), 'utf8'), nativeConfig);
    assert.equal(await access(join(home, 'auth.json')).then(() => true, () => false), false);
    await client.close(); await stop(listener); await stop(executorHost);
    await save({ phase: transport + '-isolation', passed: true, nativeFastFeatureRemainsFalse: true, isolatedNativeConfigUnchanged: true, nativeAuthCopied: false });
  }
  await save({ phase: 'verification', passed: true, transports, realSignedSdk: true, paidInferenceRequests: 0,
    renderedDesktopUiTested: false, builtInCloudTransportTested: false });
} catch (error) {
  failedPhase = phase;
  if (!closing) await save({ phase: 'verification', passed: false, failedPhase, errorClass: error?.name || 'Error', code: error?.code,
    check: error?.message?.startsWith('Expected') ? 'Assertion failed' : error?.message, fixtureDiagnostic: error?.fixtureDiagnostic }); process.exitCode = 1;
} finally { await cleanup(); }
