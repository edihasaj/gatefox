#!/usr/bin/env node
// Update check: real Claude Code against a synthetic backend that answers through this checkout's
// own Messages parser and error envelope. No provider, account or paid inference is involved.
// The report holds field names, headers Gateway reads, and counts; never prompts or tool content.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const marker = 'SHAPE_OK';
const openAlias = 'codex/shape-probe';
const declaredWindow = 400000;
// Rejections Claude Code is known to recover from. Anything else is a new shape and blocks the update.
const knownTopLevel = ['safeguards'];
const knownToolFields = ['defer_loading'];
const routeKinds = ['claude-subscription', 'codex-subscription', 'responses-api', 'chat-completions-api', 'anthropic-api'];
const adapterKinds = ['chat-completions-api', 'anthropic-api', 'responses-api'];
// A route's reasoning levels can leave out Claude Code's default, as Qwen's do.
const routeLevels = ['low', 'medium', 'xhigh'];
const scenarioLimitMs = 60_000;

export const scenarios = [
  { name: 'opaque_alias', model: openAlias, window: declaredWindow },
  { name: 'recognized_model', model: 'claude-sonnet-5-5' },
  { name: 'mcp_tools', model: openAlias, mcp: true },
  { name: 'tool_round_trip', model: openAlias, script: 'read' },
  { name: 'subagent', model: openAlias, script: 'agent', expectSubagent: true },
  { name: 'auto_review', model: openAlias, script: 'agent', permissionMode: 'auto' },
];

const sorted = values => [...new Set(values)].sort();

/** One verdict for one captured request, using the checkout's real parser and routing rules. */
export function classifyRequest(body, gateway, agentId, requestClass) {
  // The exact classifier shape goes to a real Claude review. A changed shape falls through, is refused, and blocks the update.
  if (requestClass === 'auxiliary' && gateway.isSupportedClassifierRequest(body)) return { verdict: 'native_review', fields: [] };
  const attempt = candidate => {
    try {
      const request = gateway.messagesToResponses(candidate, { agentId });
      for (const kind of routeKinds) gateway.messagesProviderRequest(request, kind);
      return { accepted: true, request };
    } catch (error) { return { accepted: false, error }; }
  };
  const direct = attempt(body);
  if (direct.accepted) return { verdict: 'accepted', request: direct.request };
  const stripped = { ...body };
  const known = [];
  for (const key of knownTopLevel) if (key in stripped) { delete stripped[key]; known.push(key); }
  if (Array.isArray(stripped.tools)) stripped.tools = stripped.tools.map(tool => {
    const copy = { ...tool };
    for (const key of knownToolFields) if (key in copy) { delete copy[key]; known.push(key); }
    return copy;
  });
  if (known.length && attempt(stripped).accepted) return { verdict: 'known_rejection', error: direct.error, fields: sorted(known) };
  const dropped = Object.keys(body).filter(key => attempt(Object.fromEntries(Object.entries(body).filter(([name]) => name !== key))).accepted);
  return { verdict: 'new_rejection', error: direct.error, fields: sorted(dropped) };
}

function sse(res, model, blocks, stopReason) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send('message_start', { message: { id: `msg_shape${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 2 } });
  send('message_stop', {});
  res.end();
}

const hasToolResult = body => body.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'tool_result'));

/** The answers a provider adapter needs to finish, so that only its own request handling can fail. */
function adapterStub() {
  return createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      if (req.url.endsWith('/chat/completions')) {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      } else if (req.url.endsWith('/messages')) {
        send('message_start', { message: { id: 'msg_stub', type: 'message', role: 'assistant', model: 'stub', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: marker } });
        send('content_block_stop', { index: 0 });
        send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
        send('message_stop', {});
      } else {
        send('response.output_text.delta', { item_id: 'item', output_index: 0, content_index: 0, delta: marker });
        send('response.completed', { response: { id: 'resp_stub', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      }
      res.end();
    });
  });
}

/** Sends one accepted request through each real adapter. Only the caller-visible 4xx refusals count here. */
async function adapterRejection(request, adapters) {
  // The stub answers with text, so a forced tool choice ends in a 5xx after the adapter has checked and sent the request.
  const forced = request.tool_choice && !['auto', 'none'].includes(request.tool_choice);
  for (const { kind, provider } of adapters) {
    try { for await (const event of provider.infer(request, new AbortController().signal, { clientProtocol: 'messages' })) if (event.type === 'done') break; }
    catch (error) {
      if (error.status >= 400 && error.status < 500) return { kind, error };
      if (forced && /required tool/i.test(error.message ?? '') && error.status >= 500) continue;
      throw Object.assign(Error(`Adapter stub failed for ${kind}`), { cause: error });
    }
  }
}

/** Decides the synthetic reply. A scripted scenario makes one tool call, then finishes. */
function reply(state, body, agentId) {
  const text = [{ type: 'text', text: marker }];
  if (agentId || !state.script || hasToolResult(body)) return { blocks: text, stop: 'end_turn' };
  const names = (body.tools || []).map(tool => tool.name);
  if (state.script === 'read') {
    if (!names.includes('Read')) { state.failures.push('read_tool_missing'); return { blocks: text, stop: 'end_turn' }; }
    return { blocks: [{ type: 'tool_use', id: 'toolu_shape_read', name: 'Read', input: { file_path: state.proofFile } }], stop: 'tool_use' };
  }
  const agent = names.find(name => name === 'Agent' || name === 'Task');
  if (!agent) { state.failures.push('agent_tool_missing'); return { blocks: text, stop: 'end_turn' }; }
  return { blocks: [{ type: 'tool_use', id: 'toolu_shape_agent', name: agent, input: { description: 'Shape probe', prompt: `Reply with ${marker}`, subagent_type: 'general-purpose' } }], stop: 'tool_use' };
}

/** The synthetic backend. It records structure only and fails exactly as Gateway would. */
function backend(gateway, state, adapters) {
  return createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const path = new URL(req.url, 'http://probe').pathname;
      if (req.method === 'GET' && path === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); return; }
      if (req.method !== 'POST' || path !== '/v1/messages') { res.writeHead(404); res.end(); return; }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { state.failures.push('invalid_json'); res.writeHead(400); res.end(); return; }
      const agentId = typeof req.headers['x-claude-code-agent-id'] === 'string' ? req.headers['x-claude-code-agent-id'] : undefined;
      const requestClass = req.headers['x-claude-code-request-class'];
      const result = classifyRequest(body, gateway, agentId, requestClass);
      if (result.verdict === 'native_review') {
        state.requests.push({ verdict: 'native_review', fields: [], topLevel: Object.keys(body), toolFields: [], betas: [], requestClass, agent: false });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'msg_review', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: '<severity>0' }], stop_reason: 'stop_sequence', stop_sequence: '</severity>', usage: { input_tokens: 1, output_tokens: 1 } }));
        return;
      }
      if (result.verdict === 'accepted') {
        const refused = await adapterRejection({ ...result.request, model: 'route-model' }, adapters).catch(() => { state.failures.push('adapter_stub_failed'); });
        if (refused) Object.assign(result, { verdict: 'new_rejection', error: refused.error, fields: [`route:${refused.kind}`] });
      }
      state.requests.push({ verdict: result.verdict, fields: result.fields ?? [], topLevel: Object.keys(body), toolFields: (body.tools || []).flatMap(tool => Object.keys(tool)),
        betas: String(req.headers['anthropic-beta'] ?? '').split(',').map(value => value.trim()).filter(Boolean),
        requestClass, agent: agentId !== undefined,
        sessionId: result.request?.client_metadata?.session_id, parentSessionId: gateway.messagesSessionId(body.metadata), toolResult: hasToolResult(body),
        mcpTools: (body.tools || []).filter(tool => tool.name?.startsWith('mcp__stub')).length });
      if (result.verdict !== 'accepted') {
        res.writeHead(result.error.status ?? 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify(gateway.anthropicError(result.error.code, result.error.message, result.error.status)));
        return;
      }
      const { blocks, stop } = reply(state, body, agentId);
      sse(res, body.model, blocks, stop);
    });
  });
}

function runClient(command, args, env, cwd) {
  return new Promise(done => {
    let stdout = '';
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} done({ timedOut: true, stdout }); }, scenarioLimitMs);
    child.stdout.on('data', chunk => { if (stdout.length < 4 * 1024 * 1024) stdout += chunk; });
    child.on('error', () => { clearTimeout(timer); done({ spawnFailed: true, stdout }); });
    child.on('close', code => { clearTimeout(timer); done({ code, stdout }); });
  });
}

function clientResult(stdout) {
  const lines = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('{'));
  for (const line of lines.reverse()) { try { const parsed = JSON.parse(line); if (parsed.type === 'result') return parsed; } catch {} }
  try { const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))); return parsed.type === 'result' ? parsed : undefined; } catch { return undefined; }
}

async function runScenario(scenario, { command, gateway, root }) {
  const home = join(root, scenario.name); const work = join(home, 'work'); mkdirSync(work, { recursive: true, mode: 0o700 });
  const state = { requests: [], failures: [], script: scenario.script, proofFile: join(work, 'proof.txt') };
  writeFileSync(state.proofFile, 'shape probe\n', { mode: 0o600 });
  const stub = adapterStub();
  await new Promise(done => stub.listen(0, '127.0.0.1', done));
  const credentialFile = join(home, 'stub-credential'); writeFileSync(credentialFile, 'stub-credential\n', { mode: 0o600 });
  const adapters = adapterKinds.map(kind => ({ kind, provider: gateway.createProvider({ id: 'route', type: kind, baseUrl: `http://127.0.0.1:${stub.address().port}/v1`, credentialFile,
    models: { route: 'route-model' }, modelMetadata: { route: { reasoningEfforts: routeLevels } } }) }));
  const server = backend(gateway, state, adapters);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  const catalog = { models: [{ slug: scenario.model, display_name: 'Shape · Probe', visibility: 'list', context_window: scenario.window ?? 200000,
    default_reasoning_level: 'medium', supported_reasoning_levels: routeLevels.map(effort => ({ effort })) }] };
  const settings = JSON.parse(gateway.claudeSettings(scenario.model, endpoint, ['--file', join(home, 'unused')], catalog));
  settings.apiKeyHelper = '/bin/echo fixture-token';
  const settingsPath = join(home, 'settings.json'); writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });
  const args = ['-p', `Reply with ${marker}`, '--settings', settingsPath, '--model', scenario.model, '--output-format', 'json', '--allowedTools', 'Read,Agent,Task', '--permission-mode', scenario.permissionMode ?? 'dontAsk'];
  if (scenario.mcp) {
    const stub = join(home, 'mcp-stub.mjs'); writeFileSync(stub, mcpStub);
    const config = join(home, 'mcp.json'); writeFileSync(config, JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [stub] } } }));
    args.push('--mcp-config', config);
  }
  const env = { PATH: process.env.PATH, LANG: 'en_US.UTF-8', HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: join(home, '.claude'),
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  const run = await runClient(command, args, env, work);
  for (const owned of [server, stub]) await new Promise(done => { owned.close(done); owned.closeAllConnections(); });
  return evaluate(scenario, state, run);
}

export function evaluate(scenario, state, run) {
  const failures = [...state.failures];
  const result = clientResult(run.stdout ?? '');
  if (run.timedOut) failures.push('client_timeout');
  if (run.spawnFailed) failures.push('client_spawn');
  if (!run.timedOut && !run.spawnFailed && run.code !== 0) failures.push('client_exit');
  if (!result || result.is_error || !String(result.result ?? '').includes(marker)) failures.push('client_did_not_finish');
  const requests = state.requests; const accepted = requests.filter(request => request.verdict === 'accepted');
  const fresh = requests.filter(request => request.verdict === 'new_rejection');
  if (fresh.length) failures.push('new_rejection');
  if (!accepted.length) failures.push('no_accepted_request');
  if (accepted.some(request => !request.requestClass)) failures.push('request_class_missing');
  if (accepted.some(request => !request.agent && !request.parentSessionId)) failures.push('session_identity_missing');
  if (scenario.mcp && !accepted.some(request => request.mcpTools > 0)) failures.push('mcp_tools_missing');
  if (scenario.permissionMode === 'auto' && !requests.some(request => request.verdict === 'native_review')) failures.push('classifier_missing');
  if (scenario.script === 'read' && !accepted.some(request => request.toolResult)) failures.push('tool_result_missing');
  if (scenario.permissionMode === 'auto' && !accepted.some(request => request.agent)) failures.push('reviewed_action_did_not_run');
  let subagentKey;
  if (scenario.expectSubagent) {
    const agents = accepted.filter(request => request.agent); const main = accepted.find(request => !request.agent);
    if (!agents.length) failures.push('subagent_header_missing');
    subagentKey = agents.length && main ? agents.every(request => request.sessionId && request.sessionId !== main.sessionId) ? 'separate' : 'shared' : 'unknown';
    if (subagentKey !== 'separate') failures.push('subagent_identity_shared');
  }
  const windows = Object.values(result?.modelUsage ?? {}).map(usage => usage?.contextWindow).filter(value => typeof value === 'number');
  if (scenario.window && !windows.includes(scenario.window)) failures.push('context_window_ignored');
  return { name: scenario.name, passed: !failures.length, failures: sorted(failures), requests: requests.length, accepted: accepted.length,
    knownRejections: sorted(requests.filter(request => request.verdict === 'known_rejection').flatMap(request => request.fields)),
    newRejectionFields: sorted(fresh.flatMap(request => request.fields)), newRejectionClasses: sorted(fresh.map(request => request.requestClass ?? 'unknown')), topLevelFields: sorted(requests.flatMap(request => request.topLevel)),
    toolFields: sorted(requests.flatMap(request => request.toolFields)), betas: sorted(requests.flatMap(request => request.betas)),
    requestClasses: sorted(requests.map(request => request.requestClass).filter(Boolean)), ...(subagentKey ? { subagentKey } : {}), ...(scenario.window ? { contextWindow: windows[0] ?? null } : {}) };
}

const mcpStub = `import readline from 'node:readline';
const tools = Array.from({ length: 60 }, (_, i) => ({ name: 't' + i, description: 'stub tool ' + i, inputSchema: { type: 'object', properties: {} } }));
readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); if (m.id === undefined) return;
  const result = m.method === 'initialize' ? { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } : m.method === 'tools/list' ? { tools } : {};
  console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); });
`;

export async function loadGateway(checkout) {
  const load = path => import(pathToFileURL(join(resolve(checkout), 'dist', path)).href);
  const [request, routing, messages, session, config, server] = await Promise.all([load('protocol/messages-request.js'), load('protocol/messages-routing.js'), load('protocol/messages.js'), load('protocol/messages-session.js'), load('claude-config.js'), load('server.js')]);
  const native = await import(pathToFileURL(join(resolve(checkout), 'scripts/claude-desktop-native-messages.mjs')).href);
  return { messagesToResponses: request.messagesToResponses, messagesProviderRequest: routing.messagesProviderRequest, anthropicError: messages.anthropicError, messagesSessionId: session.messagesSessionId, claudeSettings: config.claudeSettings, createProvider: server.createProvider, isSupportedClassifierRequest: native.isSupportedClassifierRequest };
}

/** Runs every scenario and returns the content-free report. `passed` is false on any new shape. */
export async function probeClaudeRequestShape({ command, checkout, root, only = scenarios }) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const gateway = await loadGateway(checkout);
  const results = [];
  for (const scenario of only) results.push(await runScenario(scenario, { command, gateway, root: mkdtempSync(join(root, 'run-')) }));
  const merge = key => sorted(results.flatMap(result => result[key]));
  return { schemaVersion: 1, passed: results.every(result => result.passed), scenarios: results, knownRejections: merge('knownRejections'),
    topLevelFields: merge('topLevelFields'), toolFields: merge('toolFields'), betas: merge('betas'), requestClasses: merge('requestClasses') };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const { values } = parseArgs({ options: { claude: { type: 'string' }, package: { type: 'string' }, root: { type: 'string' }, report: { type: 'string' } } });
  if (!values.claude || !values.package || !values.root) { console.error('usage: claude-request-shape.mjs --claude PATH --package CHECKOUT --root DIRECTORY [--report PATH]'); process.exit(2); }
  const report = await probeClaudeRequestShape({ command: values.claude, checkout: values.package, root: values.root });
  const text = JSON.stringify(report, null, 2) + '\n';
  if (values.report) writeFileSync(values.report, text, { mode: 0o600 });
  process.stdout.write(text);
  process.exitCode = report.passed ? 0 : 1;
}
