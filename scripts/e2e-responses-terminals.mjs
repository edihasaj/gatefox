#!/usr/bin/env node
// Signed SDK conformance against localhost mocks; no real credentials or inference.
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

const { values: options } = parseArgs({ options: { package: { type: 'string' }, codex: { type: 'string' }, root: { type: 'string' } } });
assert.ok(options.package && options.root, 'Usage: --package PATH --root NEW_PRIVATE_PATH [--codex SIGNED_MACHO]');
const fixtureKey = 'GATEWAY_TERMINALS_UPSTREAM_FIXTURE_KEY', clientKey = 'GATEWAY_TERMINALS_CLIENT_FIXTURE_KEY';
const maxBytes = 10 * 1024 * 1024, pinnedVersion = 'codex-cli 0.162.0-alpha.17.2';
async function canonical(value) {
  try { return await realpath(value); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return join(await canonical(dirname(value)), basename(value));
}
const root = await canonical(resolve(options.root));
for (const value of [join(homedir(), '.codex'), process.env.CODEX_HOME].filter(Boolean)) {
  const protectedHome = await canonical(resolve(value));
  assert.ok(root !== protectedHome && !root.startsWith(protectedHome + sep), 'Use an isolated fixture home');
}
assert.ok(!Object.hasOwn(process.env, fixtureKey), 'Fixture must not replace an existing export');
await mkdir(dirname(root), { recursive: true, mode: 0o700 });
await mkdir(root, { mode: 0o700 }); // Exclusive creation refuses existing homes and registrations.
const home = join(root, 'native'), work = join(root, 'work');
await mkdir(home, { mode: 0o700 }); await mkdir(work, { mode: 0o700 });
const authAbsent = () => access(join(home, 'auth.json')).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
const configDigest = async () => createHash('sha256').update(await readFile(join(home, 'config.toml'))).digest('hex');
const childEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'SystemRoot', 'WINDIR']
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
childEnv.CODEX_HOME = home; childEnv.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = '1';
// A separate fixture repository prevents trust discovery from selecting our source repo.
assert.equal(spawnSync('git', ['-c', 'init.defaultBranch=fixture', 'init', '-q', work], {
  env: { ...childEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, timeout: 10000,
}).status, 0);
const sdk = await realpath(resolve(options.codex || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'));
assert.equal(process.platform, 'darwin', 'This fixture verifies the actual signed macOS SDK');
assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--strict', sdk], { env: childEnv, timeout: 10000 }).status, 0);
const signing = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', sdk], { env: childEnv, encoding: 'utf8', timeout: 10000 });
assert.equal(signing.status, 0); assert.match(signing.stderr, /^TeamIdentifier=2DC432GLL2$/m);
const version = spawnSync(sdk, ['--version'], { env: childEnv, encoding: 'utf8', timeout: 10000 });
assert.equal(version.status, 0); assert.equal(version.stdout.trim(), pinnedVersion);

let phase = 'setup', transportFailure, gateway, sdkProcess, lines, childClosed, originalDigest;
let current, rpcSequence = 0, passed = false, stopped = false, groupStopped = false;
const pending = new Map(), events = [], results = [], requestMetadata = [], publicWire = [];
const message = (id, text, status = 'completed', actualPhase = 'final_answer') => ({ id, type: 'message', role: 'assistant', status,
  phase: actualPhase, content: [{ type: 'output_text', text }] });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function commandTool(tools) {
  for (const tool of tools || []) {
    if (tool.type === 'namespace') { const found = commandTool(tool.tools); if (found) return { ...found, namespace: tool.name }; }
    else if (tool.type === 'function' && (tool.name || tool.function?.name) === 'exec_command') return { name: 'exec_command' };
  }
}
function terminal(type, output, extra = {}) {
  return { type, response: { id: 'fixture-response-' + current.name + '-' + current.calls, status: type === 'response.incomplete' ? 'incomplete' : 'completed',
    output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, ...extra } };
}
function toolFrames(tool) {
  return [{ type: 'response.output_item.added', output_index: 0, item: { ...tool, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: 0, delta: tool.arguments },
    { type: 'response.output_item.done', output_index: 0, item: tool }];
}
const upstream = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/responses'); assert.ok(current); let raw = '';
    for await (const bytes of request) { raw += bytes; assert.ok(raw.length <= maxBytes); }
    const body = JSON.parse(raw); raw = ''; assert.equal(body.model, 'fixture-upstream'); current.calls++;
    assert.ok(current.calls <= 2, 'Unexpected provider replay');
    const assistant = body.input.filter(item => item.type === 'message' && item.role === 'assistant');
    const outputs = body.input.filter(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
    requestMetadata.push({ scenario: current.name, request: current.calls, assistantMessageCount: assistant.length,
      commentaryCarried: assistant.some(item => item.phase === 'commentary'),
      interruptedTextCarried: assistant.some(item => JSON.stringify(item.content).includes('INTERRUPTED_FIXTURE')),
      toolResults: outputs.length, matchingCompletedToolResults: outputs.filter(item => item.call_id === 'fixture-call-complete').length,
      partialToolReplayed: body.input.some(item => item.call_id === 'fixture-call-partial') });
    const final = message('fixture-final', 'FINAL_FIXTURE'); let frames = [];
    const first = current.calls === 1, isTool = ['interrupted_tool', 'tool_once', 'tool_eof'].includes(current.name);
    if (first && isTool) {
      const command = commandTool(body.tools); assert.ok(command);
      const tool = { type: 'function_call', id: 'fixture-function-complete', call_id: 'fixture-call-complete', ...command,
        status: 'completed', arguments: JSON.stringify({ cmd: '/bin/echo TOOL_ONCE >> ' + quote(current.counter), max_output_tokens: 20, yield_time_ms: 1000 }) };
      frames = toolFrames(tool);
      if (current.name === 'interrupted_tool') frames.push(terminal('response.incomplete', [tool], { end_turn: false, incomplete_details: { reason: 'interrupted' } }));
      else if (current.name === 'tool_once') frames.push(terminal('response.completed', [tool], { end_turn: false }));
    } else if (first && current.name === 'interrupted_partial') {
      const item = message('fixture-commentary', 'INTERRUPTED_FIXTURE', 'incomplete', 'commentary');
      const command = commandTool(body.tools); assert.ok(command);
      const partial = { type: 'function_call', id: 'fixture-function-partial', call_id: 'fixture-call-partial', ...command,
        status: 'incomplete', arguments: '{"cmd":"/usr/bin/true"' };
      frames = [{ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'INTERRUPTED_' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.output_item.added', output_index: 1, item: { ...partial, status: 'in_progress', arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: partial.id, output_index: 1, delta: partial.arguments },
        { type: 'response.output_item.done', output_index: 1, item: partial },
        terminal('response.incomplete', [item, partial], { end_turn: false, incomplete_details: { reason: 'interrupted' } })];
    } else if (current.name === 'partial_eof') {
      frames = [{ type: 'response.output_item.added', output_index: 0, item: { ...final, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', item_id: final.id, output_index: 0, content_index: 0, delta: 'UNFINISHED_FIXTURE' }];
    } else if (current.name === 'empty_eof' || (first && current.name === 'empty_eof_recovery')) {
      frames = []; // No InferenceEvent published: one classified gateway retry is allowed.
    } else {
      const completion = terminal('response.completed', [final], { end_turn: true });
      if (current.name === 'minimal_completed') { delete completion.response.status; delete completion.response.end_turn; }
      frames = [completion];
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const frame of frames) response.write('data: ' + JSON.stringify(frame) + '\n\n'); response.end();
  } catch { transportFailure = 'mock_upstream_failed'; response.writeHead(500); response.end(); }
});
// Retain only public lifecycle metadata; discard prompts, tool arguments, and raw text.
const observer = createServer(async (request, response) => {
  try {
    const scenario = current.name; let raw = '';
    for await (const bytes of request) { raw += bytes; assert.ok(raw.length <= maxBytes); }
    const actual = await fetch('http://127.0.0.1:' + gateway.address().port + request.url, { method: request.method,
      headers: { 'Content-Type': 'application/json', Authorization: request.headers.authorization }, body: raw, redirect: 'error' });
    raw = ''; response.writeHead(actual.status, { 'Content-Type': actual.headers.get('content-type') || 'text/event-stream' });
    let data = ''; for await (const bytes of actual.body) { data += Buffer.from(bytes).toString('utf8'); assert.ok(data.length <= maxBytes); response.write(bytes); }
    const frames = data.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    publicWire.push({ scenario, terminals: frames.filter(frame => ['response.completed', 'response.incomplete', 'response.failed'].includes(frame.type)).map(frame => ({
      type: frame.type, status: frame.response.status, reason: frame.response.incomplete_details?.reason, endTurn: frame.response.end_turn,
      assistantMessageStatuses: (frame.response.output || []).filter(item => item.type === 'message').map(item => item.status),
      toolOutputCount: (frame.response.output || []).filter(item => ['function_call', 'custom_tool_call'].includes(item.type)).length })),
      toolDispatchFrames: frames.filter(frame => frame.type === 'response.output_item.done' && ['function_call', 'custom_tool_call'].includes(frame.item?.type)).length });
    data = ''; response.end();
  } catch { transportFailure = 'public_observer_failed'; response.destroy(); }
});
function clearPending() {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('Fixture SDK closed')); } pending.clear();
}
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Fixture RPC timed out')); }, 15000);
    pending.set(id, { resolve, reject, timer }); sdkProcess.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (transportFailure) throw Error('Fixture transport failed'); const value = check(); if (value) return value; await delay(25); }
  throw Error('Fixture notification timed out');
}
async function closeServer(server) {
  if (!server?.listening) return; server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
async function waitChild(timeout) {
  let timer; try { await Promise.race([childClosed, new Promise(resolve => { timer = setTimeout(resolve, timeout); })]); } finally { clearTimeout(timer); }
}
async function counterLines(file) {
  try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).length; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}
try {
  const { startGateway } = await import(pathToFileURL(join(resolve(options.package), 'dist/server.js')));
  const { modelCatalog } = await import(pathToFileURL(join(resolve(options.package), 'dist/catalog.js')));
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); process.env[fixtureKey] = 'fixture-only';
  const config = { version: 1, port: 0, stateDirectory: join(root, 'state'), maxConcurrent: 1, timeoutMs: 15000,
    providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: fixtureKey, baseUrl: 'http://127.0.0.1:' + upstream.address().port,
      models: { 'fixture/model': 'fixture-upstream' }, modelMetadata: { 'fixture/model': { contextWindow: 32768, reasoningEfforts: ['low', 'medium', 'high'] } } }] };
  gateway = await startGateway(config, undefined, undefined, { heartbeatMs: 100 });
  await new Promise(resolve => observer.listen(0, '127.0.0.1', resolve));
  childEnv[clientKey] = (await readFile(join(config.stateDirectory, 'client-token'), 'utf8')).trim();
  await writeFile(join(home, 'models.json'), JSON.stringify(modelCatalog(config)), { mode: 0o600 });
  await writeFile(join(home, 'config.toml'), [
    'model = "fixture/model"', 'model_provider = "subscription_gateway"', 'model_catalog_json = ' + JSON.stringify(join(home, 'models.json')),
    'model_reasoning_summary = "auto"', 'web_search = "disabled"', '[model_providers.subscription_gateway]',
    'name = "Subscription Gateway Fixture"', 'base_url = "http://127.0.0.1:' + observer.address().port + '/v1"',
    'env_key = "' + clientKey + '"', 'wire_api = "responses"', 'supports_websockets = false',
    'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 5000',
    '[projects.' + JSON.stringify(work) + ']', 'trust_level = "trusted"',
  ].join('\n') + '\n', { mode: 0o600 });
  originalDigest = await configDigest(); assert.equal(await authAbsent(), true);
  sdkProcess = spawn(sdk, ['app-server', '--listen', 'stdio://'], { cwd: work, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  childClosed = new Promise(resolve => sdkProcess.once('close', resolve));
  sdkProcess.once('error', () => { transportFailure = 'sdk_spawn_failed'; clearPending(); });
  sdkProcess.once('exit', clearPending); sdkProcess.stdin.on('error', clearPending);
  lines = createInterface({ input: sdkProcess.stdout });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line), entry = pending.get(value.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(value.id); value.error ? entry.reject(Error('Fixture RPC failed')) : entry.resolve(value.result); }
      else if (value.method && value.id !== undefined) sdkProcess.stdin.write(JSON.stringify({ id: value.id, error: { code: -32601, message: 'No fixture approval handler' } }) + '\n');
      else if (value.method) { assert.ok(events.length < 8192); events.push(value); }
    } catch { transportFailure = 'sdk_protocol_failed'; clearPending(); }
  });
  phase = 'initialize'; await rpc('initialize', { clientInfo: { name: 'gateway_responses_terminal_fixture', version: '1' } });
  sdkProcess.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  for (const name of ['interrupted_partial', 'interrupted_tool', 'minimal_completed', 'partial_eof', 'tool_eof', 'empty_eof_recovery', 'empty_eof', 'tool_once']) {
    phase = name; current = { name, calls: 0, counter: join(work, name + '.counter') }; const offset = events.length;
    const started = await rpc('thread/start', { model: 'fixture/model', cwd: work, approvalPolicy: 'never', sandbox: 'danger-full-access', ephemeral: true });
    assert.equal(started.modelProvider, 'subscription_gateway');
    const acknowledged = await rpc('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Run the isolated localhost terminal conformance fixture.' }] });
    const completed = await until(() => events.slice(offset).find(event => event.method === 'turn/completed' && event.params.turn.id === acknowledged.turn.id));
    const failed = ['partial_eof', 'tool_eof', 'empty_eof'].includes(name), expectedCalls = ['interrupted_partial', 'interrupted_tool', 'tool_once', 'empty_eof_recovery', 'empty_eof'].includes(name) ? 2 : 1;
    assert.equal(completed.params.turn.status, failed ? 'failed' : 'completed'); assert.equal(current.calls, expectedCalls);
    const own = events.slice(offset).filter(event => event.params?.threadId === started.thread.id);
    assert.equal(own.filter(event => event.method === 'turn/started').length, 1);
    assert.equal(own.filter(event => event.method === 'turn/completed').length, 1);
    const publicCount = ['interrupted_partial', 'interrupted_tool', 'tool_once'].includes(name) ? 2 : 1;
    await until(() => publicWire.filter(row => row.scenario === name).length === publicCount);
    const wire = publicWire.filter(row => row.scenario === name), terminalTypes = wire.flatMap(row => row.terminals.map(event => event.type));
    assert.deepEqual(terminalTypes, failed ? ['response.failed'] : name.startsWith('interrupted_') ? ['response.incomplete', 'response.completed'] : name === 'tool_once' ? ['response.completed', 'response.completed'] : ['response.completed']);
    const executions = own.filter(event => event.method === 'item/completed' && event.params.item.type === 'commandExecution');
    const writes = await counterLines(current.counter), dispatchFrames = wire.reduce((sum, row) => sum + row.toolDispatchFrames, 0);
    if (name.startsWith('interrupted_')) {
      assert.equal(wire[0].terminals[0].reason, 'interrupted'); assert.equal(wire[0].terminals[0].endTurn, false);
    }
    if (['interrupted_tool', 'tool_once'].includes(name)) {
      assert.equal(executions.length, 1); assert.equal(executions[0].params.item.exitCode, 0); assert.equal(writes, 1); assert.equal(dispatchFrames, 1);
      const next = requestMetadata.find(row => row.scenario === name && row.request === 2);
      assert.equal(next.matchingCompletedToolResults, 1); assert.equal(next.toolResults, 1);
    } else if (name === 'tool_eof') { assert.ok(executions.length <= 1 && writes <= 1); assert.equal(dispatchFrames, 1); }
    else { assert.equal(executions.length, 0); assert.equal(writes, 0); assert.equal(dispatchFrames, 0); }
    if (name === 'interrupted_partial') {
      const next = requestMetadata.find(row => row.scenario === name && row.request === 2);
      assert.ok(next.commentaryCarried && next.interruptedTextCarried); assert.equal(next.partialToolReplayed, false); assert.equal(next.toolResults, 0);
      assert.deepEqual(wire[0].terminals[0].assistantMessageStatuses, ['incomplete']);
      const messages = own.filter(event => event.method === 'item/completed' && event.params.item.type === 'agentMessage').map(event => event.params.item);
      assert.deepEqual(messages.map(item => item.text), ['INTERRUPTED_FIXTURE', 'FINAL_FIXTURE']);
      assert.deepEqual(messages.map(item => item.phase), ['commentary', 'final_answer']);
    }
    results.push({ scenario: name, passed: true, upstreamRequests: current.calls, publicRequests: publicCount,
      sdkTurnStarted: 1, sdkTurnCompleted: 1, sameAcknowledgedTurn: completed.params.turn.id === acknowledged.turn.id,
      sdkStatus: completed.params.turn.status, publicTerminalTypes: terminalTypes, commandExecutions: executions.length, counterWrites: writes, toolDispatchFrames: dispatchFrames });
    await rpc('thread/unsubscribe', { threadId: started.thread.id });
  }
  phase = 'isolation'; assert.equal(await configDigest(), originalDigest); assert.equal(await authAbsent(), true); passed = true;
} catch { passed = false; }
finally {
  clearPending(); lines?.close(); sdkProcess?.stdin.end();
  if (sdkProcess) {
    await waitChild(1000);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-sdkProcess.pid, signal); } catch (error) { if (error.code !== 'ESRCH') transportFailure ||= 'owned_group_stop_failed'; }
      if (sdkProcess.exitCode === null && sdkProcess.signalCode === null) await waitChild(1500);
    }
    stopped = sdkProcess.exitCode !== null || sdkProcess.signalCode !== null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { process.kill(-sdkProcess.pid, 0); } catch (error) { if (error.code === 'ESRCH') { groupStopped = true; break; } throw error; }
      await delay(25);
    }
  }
  for (const value of [observer, gateway, upstream]) await closeServer(value);
  delete process.env[fixtureKey];
}
const fixtureConfigUnchanged = originalDigest ? await configDigest() === originalDigest : true;
const result = { passed: passed && stopped && groupStopped && !transportFailure && fixtureConfigUnchanged && await authAbsent(), sdkVersion: version.stdout.trim(),
  signatureVerified: true, zeroPaidProviderCalls: true, nativeConfigReadOrWritten: false, nativeAuthCopied: false,
  fixtureConfigUnchanged, ownedSdkStopped: stopped, ownedProcessGroupStopped: groupStopped, pendingRpcTimers: pending.size, results, requestMetadata, publicWire,
  ...(!passed || transportFailure ? { failedPhase: phase, failure: transportFailure || 'fixture_assertion_failed' } : {}) };
await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ ...result, requestMetadata: undefined, publicWire: undefined }));
if (!result.passed) process.exitCode = 1;
