// Real Claude CLI, synthetic Anthropic API and virtual MCP results. No account or caller tool execution.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ClaudeRelay } from '../dist/providers/claude-relay.js';
import { claudeCliArgs, claudeMcpCatalog, gatewaySystemPrompt } from '../dist/providers/claude-control.js';
import { claudeNativeToolName, claudeToolName } from '../dist/providers/claude-tool-names.js';

const { values } = parseArgs({ options: { claude: { type: 'string' }, root: { type: 'string' } } });
assert.ok(values.claude && values.root, 'Pass --claude EXECUTABLE --root FRESH_TMP_DIRECTORY');
const root = resolve(values.root);
assert.ok(root.startsWith('/tmp/'), 'Use a private task-specific /tmp directory');
await mkdir(root, { mode: 0o700 });
const version = execFileSync(values.claude, ['--version'], { encoding: 'utf8' }).trim();
const tool = { type: 'function', function: { name: 'probe_read', parameters: { type: 'object', properties: {} },
  responseTool: { type: 'function', name: 'probe_read', namespace: 'functions' } } };
const canonical = claudeNativeToolName(tool), marker = 'SYNTHETIC_RELAY_RESULT';
const cases = [['canonical_mcp', canonical], ['bare_native_name', claudeToolName(tool)],
  ['qualified_caller_alias', 'functions.probe_read'], ['local_caller_alias', 'probe_read']];
const results = [];

for (const [index, [label, name]] of cases.entries()) {
  const directory = join(root, String(index)); await mkdir(directory, { mode: 0o700 });
  const callId = 'toolu_fixture_' + index, socket = join(directory, 'r.sock');
  const key = randomBytes(32).toString('hex');
  const relay = new ClaudeRelay(key, () => {}); await relay.listen(socket);
  relay.expect([{ id: callId, name: claudeToolName(tool) }]);
  relay.deliver(new Map([[callId, [{ type: 'text', text: marker }]]]));
  let requests = 0, relayResultSeen = false, declarationPresent = false, nonGatewayTools = 0, nativeSearchTools = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
    if (!req.url.includes('/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    declarationPresent ||= body.tools?.some(tool => tool.name === canonical) === true;
    nonGatewayTools = Math.max(nonGatewayTools, (body.tools ?? []).filter(tool => tool.name !== canonical).length);
    nativeSearchTools = Math.max(nativeSearchTools, (body.tools ?? []).filter(tool => ['Glob', 'Grep', 'LS'].includes(tool.name)).length);
    relayResultSeen ||= (body.messages ?? []).some(message => Array.isArray(message.content) && message.content.some(block =>
      block.type === 'tool_result' && block.tool_use_id === callId && JSON.stringify(block.content).includes(marker)));
    const first = ++requests === 1;
    const block = first ? { type: 'tool_use', id: callId, name, input: {} } : { type: 'text', text: 'DONE' };
    const stop = first ? 'tool_use' : 'end_turn';
    const message = { id: 'msg_probe_' + requests, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
      content: [block], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: first ? block : { type: 'text', text: '' } });
    if (!first) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'DONE' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', {}); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const catalog = join(directory, 'tools.json'), relayFile = join(directory, 'relay.json'), mcp = join(directory, 'mcp.json'), system = join(directory, 'system.md');
  await writeFile(catalog, JSON.stringify(claudeMcpCatalog([tool])), { mode: 0o600 });
  await writeFile(relayFile, JSON.stringify({ socket, key }), { mode: 0o600 });
  await writeFile(mcp, JSON.stringify({ mcpServers: { gateway: { command: process.execPath,
    args: [fileURLToPath(new URL('../dist/providers/claude-tools.js', import.meta.url)), catalog, relayFile], alwaysLoad: true } } }), { mode: 0o600 });
  await writeFile(system, gatewaySystemPrompt, { mode: 0o600 });
  const args = claudeCliArgs({ mcpPath: mcp, systemPath: system, model: 'claude-sonnet-4-5', fast: false, thinkingDisplay: false });
  const prompt = 'Use the supplied synthetic probe tool, then finish.';
  let diagnostic = '';
  const child = spawn(values.claude, args, { cwd: directory, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'claude'), TMPDIR: directory,
    ANTHROPIC_API_KEY: 'local-synthetic-probe', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
    ENABLE_TOOL_SEARCH: 'false', MCP_CONNECTION_NONBLOCKING: '0' } });
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
  child.stdout.on('data', chunk => { if (requests === 0) diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } }) + '\n');
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 30_000);
  try {
    const [exitCode] = await once(child, 'exit');
    const startupFailure = requests > 0 ? undefined : /unknown option.*restricted/i.test(diagnostic) ? 'unsupported_restricted_flag'
      : /root.*dangerously|dangerously.*root/i.test(diagnostic) ? 'root_permissions'
      : /permission|trust|workspace/i.test(diagnostic) ? 'permission_or_trust'
      : /authentication|login|api.?key/i.test(diagnostic) ? 'authentication' : requests === 0 ? 'unclassified_startup_failure' : undefined;
    const result = { label, requests, declarationPresent, nonGatewayTools, nativeSearchTools, relayResultSeen, exitCode, timedOut, startupFailure };
    results.push(result); console.log(JSON.stringify(result));
  } finally {
    clearTimeout(timer); try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    relay.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
const report = { version, noPaidInference: true, results };
await writeFile(join(root, 'receipt.json'), JSON.stringify(report, null, 2));
assert.ok(results[0].declarationPresent && results[0].relayResultSeen, 'Canonical control must reach the virtual MCP relay');
