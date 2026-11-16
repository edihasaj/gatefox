// Real unmodified CLI + Gateway provider against a synthetic local API. No account or caller action.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { claude: { type: 'string' }, root: { type: 'string' }, package: { type: 'string' }, 'previous-package': { type: 'string' } } });
assert.ok(values.claude?.startsWith('/') && values.root?.startsWith('/tmp/'), 'Pass --claude EXECUTABLE --root FRESH_TMP_DIRECTORY');
const root = resolve(values.root); await mkdir(root, { mode: 0o700 });
const bin = join(root, 'bin'); await mkdir(bin, { mode: 0o700 });
process.env.HOME = root;
process.env.PATH = bin + delimiter + process.env.PATH;
process.env.TMPDIR = root;
assert.ok(!values.package || values.package.startsWith('/'), '--package must be an absolute package path');
const pkg = values.package || resolve(import.meta.dirname, '..');
const load = name => import(pathToFileURL(join(pkg, 'dist', name)).href);
const { ClaudeSubscription } = await load('providers/claude.js');
const { claudeLive } = await load('providers/claude-live.js');
const { toolCorrectionLimits } = await load('providers/claude-tool-correction.js');
const { configureTelemetry, flushTelemetry } = await load('telemetry.js');
assert.ok(!values['previous-package'] || values['previous-package'].startsWith('/'), '--previous-package must be absolute');
const PreviousProvider = values['previous-package'] ? (await import(pathToFileURL(join(values['previous-package'], 'dist/providers/claude.js')).href)).ClaudeSubscription : undefined;
const tools = [{ type: 'function', name: 'probe_read', parameters: { type: 'object', properties: {} } }];
const native = 'mcp__gateway__probe_read', missing = 'mcp__gateway__not_registered';
const results = [];
configureTelemetry(root, 'probe');

for (const label of ['live_corrects', 'live_after_output', ...(PreviousProvider ? ['adopted_live_after_output'] : []), 'oneshot_corrects', 'live_exhausted', 'mixed_batch', 'native_tool', 'cancel_after_rejection']) {
  let requests = 0, nativeRejections = 0, relayResults = 0, callerDispatches = 0;
  let sent = false; const controller = new AbortController();
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    if (req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
    if (!req.url.includes('/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.ok((body.tools ?? []).every(tool => tool.name === native), 'No native tool can appear');
    const feedback = (body.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []);
    nativeRejections = Math.max(nativeRejections, feedback.filter(block => block.type === 'tool_result' && block.is_error === true).length);
    relayResults = Math.max(relayResults, feedback.filter(block => block.type === 'tool_result' && JSON.stringify(block.content).includes('SYNTHETIC_CALLER_RESULT')).length);
    requests++;
    if (label === 'cancel_after_rejection' && requests === 2) { sent = true; controller.abort(); return; }
    const after = label.endsWith('live_after_output');
    const invalid = label === 'live_exhausted' || requests === (after ? 2 : 1);
    let content = invalid ? [{ type: 'tool_use', id: `toolu_invalid_${requests}`, name: label === 'native_tool' ? 'Bash' : missing, input: {} }]
      : after && requests === 1 ? [{ type: 'tool_use', id: 'toolu_prior', name: native, input: {} }]
      : requests === (after ? 3 : 2) ? [{ type: 'tool_use', id: 'toolu_valid', name: native, input: {} }]
      : [{ type: 'text', text: 'DONE' }];
    if (label === 'mixed_batch') content.unshift({ type: 'tool_use', id: 'toolu_valid_sibling', name: native, input: {} });
    const stop = content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn';
    const message = { id: `msg_${requests}`, type: 'message', role: 'assistant', model: body.model, content,
      stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    send('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    for (const [index, block] of content.entries()) {
      send('content_block_start', { index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
      send('content_block_delta', { index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: '{}' } });
      send('content_block_stop', { index });
    }
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 2 } });
    send('message_stop', {}); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const wrapper = `#!/bin/sh
export HOME=${quote(root)} CLAUDE_CONFIG_DIR=${quote(join(root, 'claude'))}
export ANTHROPIC_API_KEY=synthetic-local-only ANTHROPIC_BASE_URL=http://127.0.0.1:${server.address().port}
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
exec ${quote(values.claude)} "$@"
`;
  await writeFile(join(bin, 'claude'), wrapper, { mode: 0o700 });
  const config = { id: label, type: 'claude-subscription', models: { fixture: 'claude-sonnet-4-5' },
    claudeSessions: { warmup: 0, ...(label === 'oneshot_corrects' ? { mode: 'oneshot' } : {}) } };
  const provider = new ClaudeSubscription(config);
  const previous = label === 'adopted_live_after_output' ? new PreviousProvider(config) : undefined;
  let firstPid, adoptedPid;
  const input = [{ role: 'user', content: 'Use the supplied probe tool, then finish.' }];
  const context = { threadId: label }; const events = []; let error;
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const delivered = new Set();
    for (let round = 0; round < 3; round++) {
      const current = [];
      for await (const event of (round === 0 && previous ? previous : provider).infer({ model: 'claude-sonnet-4-5', input, tools }, controller.signal, context)) { current.push(event); events.push(event); }
      const pid = claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0]?.pid;
      if (round === 0) firstPid = pid;
      if (round === 1) adoptedPid = pid;
      const calls = current.filter(event => event.type === 'tool'); callerDispatches += calls.length;
      if (!calls.length) break;
      assert.equal(calls.length, 1); assert.equal(calls[0].call.function.name, 'probe_read');
      const call = calls[0].call;
      assert.ok(!delivered.has(call.id)); delivered.add(call.id);
      input.push(
        { type: 'function_call', name: 'probe_read', call_id: call.id, arguments: call.function.arguments },
        { type: 'function_call_output', call_id: call.id, output: 'SYNTHETIC_CALLER_RESULT' });
    }
  } catch (caught) { error = caught; }
  finally {
    clearTimeout(timeout); await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await flushTelemetry();
  }
  if (label === 'live_corrects') {
    assert.equal(error, undefined); assert.equal(callerDispatches, 1); assert.equal(requests, 3);
    assert.equal(nativeRejections, 1); assert.equal(relayResults, 1);
    assert.ok(events.some(event => event.type === 'text' && event.text.includes('DONE')));
    assert.equal(events.find(event => event.type === 'done').usage.input_tokens, 20);
    assert.equal(events.find(event => event.type === 'done').usage.output_tokens, 4);
  } else if (label.endsWith('live_after_output')) {
    assert.equal(error, undefined); assert.equal(callerDispatches, 2); assert.equal(requests, 4);
    assert.equal(nativeRejections, 1); assert.equal(relayResults, 2);
    assert.ok(events.some(event => event.type === 'text' && event.text.includes('DONE')));
    assert.ok(firstPid); assert.equal(adoptedPid, firstPid, 'The earlier CLI must be reused');
  } else if (label === 'oneshot_corrects') {
    assert.equal(error, undefined); assert.equal(callerDispatches, 1); assert.ok(nativeRejections >= 1);
  } else {
    assert.ok(error); assert.equal(callerDispatches, 0);
    if (label === 'live_exhausted') { assert.equal(requests, toolCorrectionLimits.attempts + 1); assert.equal(error.upstream?.code, 'unavailable_gateway_tool'); }
    if (label === 'native_tool') { assert.equal(requests, 1); assert.equal(error.upstream?.code, 'native_builtin_tool'); }
    if (label === 'cancel_after_rejection') { assert.ok(sent); assert.equal(requests, 2); assert.equal(error.code, 'cancelled'); }
  }
  const result = { label, requests, nativeRejections, relayResults, callerDispatches, outcome: error ? error.code : 'completed', noPaidInference: true };
  results.push(result); console.log(JSON.stringify(result));
}
await writeFile(join(root, 'receipt.json'), JSON.stringify({ status: 'passed', results }, null, 2));
