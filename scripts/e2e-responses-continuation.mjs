import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, access, realpath } from 'node:fs/promises';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const { values: v } = parseArgs({ options: { package: { type: 'string' }, codex: { type: 'string' }, root: { type: 'string' }, 'native-config': { type: 'string' } } });
for (const key of ['package', 'codex', 'root']) assert.ok(v[key], 'Missing --' + key);
const pinnedVersion = 'codex-cli 0.162.0-alpha.17.2', fixtureKey = 'GATEWAY_CONTINUATION_UPSTREAM_FIXTURE_KEY';
async function canonical(path) {
  try { return await realpath(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return join(await canonical(dirname(path)), basename(path));
}
const root = await canonical(resolve(v.root));
for (const protectedPath of [join(homedir(), '.codex'), process.env.CODEX_HOME].filter(Boolean)) {
  const protectedHome = await canonical(resolve(protectedPath));
  assert.ok(root !== protectedHome && !root.startsWith(protectedHome + sep), 'Fixture root must be outside native Codex homes');
}
assert.ok(!Object.hasOwn(process.env, fixtureKey), 'Fixture export must not replace an existing value');
await mkdir(root, { mode: 0o700 }); // Refuse reuse, symlinks, and existing registrations.
const home = join(root, 'native'), work = join(root, 'work');
await mkdir(home, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
const authAbsent = () => access(join(home, 'auth.json')).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
assert.equal(await authAbsent(), true);
const nativeConfig = resolve(v['native-config'] || join(homedir(), '.codex/config.toml'));
const digest = async () => {
  try { return createHash('sha256').update(await readFile(nativeConfig)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const before = await digest();
// Explicit runtime allowlist: no inherited API keys, auth exports, gateway routes,
// proxy credentials, NODE_OPTIONS, or telemetry headers enter the signed SDK.
const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'SystemRoot', 'WINDIR']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
childEnv.CODEX_HOME = home; childEnv.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
const sdk = await realpath(resolve(v.codex));
if (process.platform === 'darwin') {
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', sdk], { env: childEnv, timeout: 10000, maxBuffer: 65536 });
  assert.equal(verify.status, 0, 'Pass the signed SDK Mach-O executable, rather than its shell launcher');
  const signing = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', sdk], { env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.equal(signing.status, 0); assert.match(signing.stderr, /^TeamIdentifier=2DC432GLL2$/m, 'Use the first-party signed SDK');
}
const version = spawnSync(sdk, ['--version'], { env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
assert.equal(version.status, 0, 'SDK version check failed'); const sdkVersion = version.stdout.trim();
assert.equal(sdkVersion, pinnedVersion, 'Use the pinned first-party SDK');

let scenario = 'false', inference = 0, phase = 'setup', failure, server, child, lines, childClosed;
const events = [], pending = new Map(), requestMetadata = [], results = []; let sequence = 0;
const message = (id, text, actualPhase) => ({ id, type: 'message', role: 'assistant', status: 'completed', phase: actualPhase, content: [{ type: 'output_text', text }] });
function fixtureCommand(tools) {
  for (const tool of tools || []) {
    if (tool.type === 'namespace') { const found = fixtureCommand(tool.tools); if (found) return { ...found, namespace: tool.name }; }
    else if (tool.type === 'function' && (tool.name || tool.function?.name) === 'exec_command') return { name: 'exec_command' };
  }
}
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/responses'); let raw = '';
    for await (const bytes of req) { raw += bytes; assert.ok(raw.length <= 10 * 1024 * 1024); }
    const body = JSON.parse(raw); raw = ''; assert.equal(body.model, 'fixture-upstream'); inference++;
    const carried = body.input.filter(item => item.type === 'message' && item.role === 'assistant');
    requestMetadata.push({ scenario, inference, itemCount: body.input.length, assistantMessageCount: carried.length,
      commentaryCarried: carried.some(item => item.phase === 'commentary'),
      commentaryTextCarried: carried.some(item => JSON.stringify(item.content).includes('CONTINUATION_FIXTURE')),
      toolResultCarried: body.input.some(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type)) });
    assert.ok(inference <= 2);
    const firstContinued = scenario === 'false' && inference === 1, firstTool = scenario === 'tool_false' && inference === 1;
    const command = firstTool ? fixtureCommand(body.tools) : undefined; if (firstTool) assert.ok(command);
    const item = firstTool ? { type: 'function_call', id: 'fixture-function-1', call_id: 'fixture-call-1', ...command,
      arguments: JSON.stringify({ cmd: '/usr/bin/true', max_output_tokens: 20, yield_time_ms: 1000 }) }
      : message('upstream-message-' + inference, firstContinued ? 'CONTINUATION_FIXTURE' : 'FINAL_FIXTURE', firstContinued ? 'commentary' : 'final_answer');
    const frames = firstContinued ? [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', phase: undefined, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'CONTINUATION_' },
      { type: 'response.output_item.done', output_index: 0, item },
    ] : [];
    const completed = { status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
    if (scenario !== 'absent') completed.end_turn = !(firstContinued || firstTool);
    frames.push({ type: 'response.completed', response: completed });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const frame of frames) res.write('data: ' + JSON.stringify(frame) + '\n\n'); res.end();
  } catch {
    failure = 'mock_upstream_failed'; res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'fixture_assertion', message: 'Fixture assertion failed' } }));
  }
});
function clearPending(reason) {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(reason)); } pending.clear();
}
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Fixture RPC timed out')); }, 15000);
  pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
});
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (failure) throw Error('Fixture transport failed'); const value = check(); if (value) return value; await delay(25); }
  throw Error('Fixture notification timed out');
}
async function closeServer(value) {
  if (!value?.listening) return; value.closeAllConnections(); await new Promise(resolve => value.close(resolve));
}
async function waitForChild(timeoutMs) {
  let timer;
  try { await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
let passed = false, cleanupComplete = false;
try {
  const { startGateway } = await import(pathToFileURL(join(resolve(v.package), 'dist/server.js')));
  const { modelCatalog } = await import(pathToFileURL(join(resolve(v.package), 'dist/catalog.js')));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); process.env[fixtureKey] = 'fixture-only';
  const config = { version: 1, port: 0, stateDirectory: join(root, 'state'), maxConcurrent: 1, timeoutMs: 15000,
    providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: fixtureKey, baseUrl: 'http://127.0.0.1:' + upstream.address().port,
      models: { 'fixture/model': 'fixture-upstream' }, modelMetadata: { 'fixture/model': { contextWindow: 32768, reasoningEfforts: ['low', 'medium', 'high'] } } }] };
  server = await startGateway(config, undefined, undefined, { heartbeatMs: 100 });
  childEnv.GATEWAY_CONTINUATION_CLIENT_FIXTURE_KEY = (await readFile(join(config.stateDirectory, 'client-token'), 'utf8')).trim();
  await writeFile(join(home, 'models.json'), JSON.stringify(modelCatalog(config)), { mode: 0o600 });
  await writeFile(join(home, 'config.toml'), [
    'model = "fixture/model"', 'model_provider = "subscription_gateway"', 'model_catalog_json = ' + JSON.stringify(join(home, 'models.json')),
    'model_reasoning_summary = "auto"', 'web_search = "disabled"', '[model_providers.subscription_gateway]',
    'name = "Subscription Gateway Fixture"', 'base_url = "http://127.0.0.1:' + server.address().port + '/v1"',
    'env_key = "GATEWAY_CONTINUATION_CLIENT_FIXTURE_KEY"', 'wire_api = "responses"', 'supports_websockets = false',
    'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 5000', '[features]', 'remote_control = false',
  ].join('\n') + '\n', { mode: 0o600 });
  assert.equal(await authAbsent(), true);
  child = spawn(sdk, ['app-server', '--listen', 'stdio://'], { cwd: work, env: childEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  childClosed = new Promise(resolve => child.once('close', resolve));
  child.once('error', () => { failure = 'sdk_spawn_failed'; clearPending('Fixture SDK failed'); });
  child.once('exit', () => { clearPending('Fixture SDK exited'); });
  child.stdin.on('error', () => { failure = 'sdk_input_closed'; clearPending('Fixture SDK input closed'); });
  lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line), entry = pending.get(value.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(value.id); value.error ? entry.reject(Error('Fixture RPC failed')) : entry.resolve(value.result); }
      else if (value.method && value.id !== undefined) child.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: 'Fixture has no approval handler' } }) + '\n');
      else if (value.method) { assert.ok(events.length < 4096); events.push(value); }
    } catch { failure = 'sdk_protocol_failed'; clearPending('Fixture SDK protocol failed'); }
  });
  phase = 'initialize'; await rpc('initialize', { clientInfo: { name: 'gateway_responses_continuation_fixture', version: '1' } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  for (scenario of ['false', 'absent', 'true', 'tool_false']) {
    phase = scenario; inference = 0; const offset = events.length;
    const started = await rpc('thread/start', { model: 'fixture/model', cwd: work, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    assert.equal(started.modelProvider, 'subscription_gateway');
    const turn = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Run the local continuation fixture.' }] });
    const done = await until(() => events.slice(offset).find(event => event.method === 'turn/completed' && event.params.turn.id === turn.turn.id));
    assert.equal(done.params.turn.status, 'completed'); assert.equal(inference, ['false', 'tool_false'].includes(scenario) ? 2 : 1);
    const messages = events.slice(offset).filter(event => event.method === 'item/completed' && event.params?.item?.type === 'agentMessage').map(event => event.params.item);
    assert.deepEqual(messages.map(item => item.text), scenario === 'false' ? ['CONTINUATION_FIXTURE', 'FINAL_FIXTURE'] : ['FINAL_FIXTURE']);
    assert.deepEqual(messages.map(item => item.phase), scenario === 'false' ? ['commentary', 'final_answer'] : ['final_answer']);
    if (scenario === 'false') { const continued = requestMetadata.find(row => row.scenario === scenario && row.inference === 2); assert.ok(continued.commentaryTextCarried && continued.commentaryCarried); }
    if (scenario === 'tool_false') {
      assert.equal(requestMetadata.find(row => row.scenario === scenario && row.inference === 2).toolResultCarried, true);
      const commands = events.slice(offset).filter(event => event.method === 'item/completed' && event.params?.item?.type === 'commandExecution');
      assert.equal(commands.length, 1); assert.equal(commands[0].params.item.exitCode, 0);
    }
    results.push({ upstreamEndTurn: scenario, inferenceRequests: inference, completed: true, assistantMessages: messages.length,
      messagePhases: messages.map(item => item.phase), nestedTextRetained: true, duplicatedText: false });
    await rpc('thread/unsubscribe', { threadId: started.thread.id });
  }
  phase = 'native_config_check'; assert.equal(await digest(), before); assert.equal(await authAbsent(), true); passed = true;
} catch { passed = false; }
finally {
  clearPending('Fixture shutdown'); lines?.close(); child?.stdin.end();
  if (child && child.exitCode === null && child.signalCode === null) {
    await waitForChild(1000);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await waitForChild(2000); }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await waitForChild(2000); }
  }
  await closeServer(server); await closeServer(upstream); delete process.env[fixtureKey];
  cleanupComplete = !child || child.exitCode !== null || child.signalCode !== null;
}
const nativeConfigUnchanged = await digest() === before, nativeAuthCopied = !(await authAbsent());
const result = { passed: passed && cleanupComplete && nativeConfigUnchanged && !nativeAuthCopied, sdkVersion, signatureVerified: process.platform === 'darwin', zeroPaidProviderCalls: true,
  nativeConfigUnchanged, nativeAuthCopied,
  ownedSdkStopped: cleanupComplete, pendingRpcTimers: pending.size, results, requestMetadata,
  ...(!passed ? { failedPhase: phase, failure: failure || 'fixture_assertion_failed' } : {}) };
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1;
