// Prove client-declared deferred tools stay reachable without hosted search. Uses private homes, synthetic tools and a local
// mock provider. It neither creates a real schedule nor reads provider authentication. --baseline expects the old hidden-tool bug.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

process.env.GATEWAY_TELEMETRY = 'off';
process.env.GATEWAY_ERROR_REPORTS = 'off';
const { values } = parseArgs({ options: {
  gateway: { type: 'string' }, native: { type: 'string' }, catalog: { type: 'string' }, root: { type: 'string' }, baseline: { type: 'boolean' },
} });
for (const key of ['gateway', 'catalog', 'root']) assert.ok(values[key] && isAbsolute(values[key]), `Pass an absolute --${key}`);
const repo = resolve(import.meta.dirname, '..');
const { AppServerConnection } = await import(pathToFileURL(join(repo, 'dist/app-server-connection.js')));
const root = resolve(values.root); await mkdir(root, { recursive: true, mode: 0o700 });
const source = JSON.parse(await readFile(values.catalog, 'utf8'));
const base = source.models.find(row => row.slug === 'gpt-6.1-sol') ?? source.models[0];
assert.ok(base, 'A native catalog row is required');
const fixtureToken = 'CLIENT_TOOL_FIXTURE_RESULT';
const declinedToken = 'CLIENT_TOOL_FIXTURE_DECLINED';
async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const flatName = tool => tool.name ?? tool.function?.name;
function toolNames(request) {
  const declarations = [...(request.tools ?? []), ...(request.input ?? [])
    .filter(item => ['additional_tools', 'tool_search_output'].includes(item.type)).flatMap(item => item.tools ?? [])];
  return declarations.flatMap(tool => tool.type === 'namespace'
    ? (tool.tools ?? []).map(child => `${tool.name}.${flatName(child)}`)
    : [flatName(tool) ?? tool.type]);
}
function send(res, item, sequence) {
  const id = `resp_client_tool_fixture_${sequence}`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}
async function run(executable, name, options = {}) {
  const directory = await mkdtemp(join(root, `${name}-`));
  const home = join(directory, 'home'), work = join(directory, 'work'), tmp = join(directory, 'tmp');
  for (const folder of [home, work, tmp]) await mkdir(folder, { mode: 0o700 });
  const mode = options.codeMode ? 'code_mode_only' : 'direct';
  const rows = [false, true].map(search => ({ ...base, slug: search ? 'fixture-search' : 'fixture-direct', display_name: 'client tool fixture',
    tool_mode: mode, supports_search_tool: search, node_repl_disabled: true, visibility: 'list', supported_in_api: true }));
  await writeFile(join(home, 'models.json'), JSON.stringify({ models: rows }), { mode: 0o600 });
  let phase = options.switchModel || options.coldResume ? 'setup' : 'exercise';
  let sequence = 0, clientCalls = 0, delivered = false, searched = false, emittedCell = false, unexpectedCalls = 0;
  const observations = [], completedTools = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; assert.ok(size <= 8 * 1024 * 1024); chunks.push(chunk); }
      if (!req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
      const request = JSON.parse(Buffer.concat(chunks)); const names = toolNames(request);
      delivered ||= (request.input ?? []).some(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type)
        && JSON.stringify(item.output).includes(options.decline ? declinedToken : fixtureToken));
      observations.push({ phase, exposed: names.includes('codex_app.automation_update'), search: names.includes('tool_search') });
      let item = { type: 'message', role: 'assistant', id: `msg_${++sequence}`, content: [{ type: 'output_text', text: 'Fixture complete.' }] };
      if (phase === 'exercise' && !delivered) {
        if (options.codeMode && !emittedCell) {
          emittedCell = true;
          item = { type: 'custom_tool_call', id: 'cell_fixture', call_id: 'cell_fixture', namespace: 'functions', name: 'exec', status: 'completed',
            input: `const selected = ALL_TOOLS.find(t => t.name.endsWith("automation_update")); text({ available: !!selected }); if (selected) text(await tools[selected.name]({}));` };
        } else if (!options.codeMode && names.includes('codex_app.automation_update')) {
          item = { type: 'function_call', id: 'client_fixture', call_id: 'client_fixture', namespace: 'codex_app', name: 'automation_update', arguments: '{}', status: 'completed' };
        } else if (!options.codeMode && names.includes('tool_search') && !searched) {
          searched = true;
          item = { type: 'tool_search_call', call_id: 'search_fixture', status: 'completed', execution: 'client', arguments: { query: 'automation_update' } };
        }
      }
      assert.ok(sequence <= 5, 'The fixture must not loop'); send(res, item, sequence);
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await writeFile(join(home, 'config.toml'), `model = "fixture-direct"\nmodel_provider = "mock"\nmodel_catalog_json = ${JSON.stringify(join(home, 'models.json'))}\n` +
    `[features]\nplugins = false\nhooks = false\ncode_mode_host = true\nstep_model_switching = true\n` +
    `[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  let client, terminal, timer;
  const connect = async () => {
    client = new AppServerConnection(executable, ['app-server', '--listen', 'stdio://'], async message => {
      if (message.method === 'turn/completed') terminal?.(message.params?.turn?.status);
      if (message.method === 'item/completed' && message.params?.item?.type === 'dynamicToolCall') {
        const { status, success } = message.params.item; completedTools.push({ status, success });
      }
      if (message.id === undefined || !message.method) return;
      if (message.method === 'item/tool/call' && message.params?.tool === 'automation_update' && message.params?.namespace === 'codex_app') {
        clientCalls++;
        client.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: options.decline ? declinedToken : fixtureToken }], success: !options.decline } });
      } else { unexpectedCalls++; client.send({ id: message.id, error: { code: -32601, message: 'Unexpected fixture callback refused' } }); }
    }, () => {}, { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, CODEX_HOME: home, TMPDIR: tmp,
      GATEWAY_ERROR_REPORTS: 'off', CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1' });
    await client.request('initialize', { clientInfo: { name: 'client_tool_exposure_fixture', version: '1' }, capabilities: { experimentalApi: true } });
    client.send({ method: 'initialized', params: {} });
  };
  const turn = async (threadId, model) => {
    const completed = new Promise(done => { terminal = done; });
    await client.request('turn/start', { threadId, model, input: [{ type: 'text', text: 'Complete the isolated fixture.' }] });
    assert.equal(await completed, 'completed');
  };
  try {
    return await Promise.race([(async () => {
      await connect();
      const initial = options.search || phase === 'setup' ? 'fixture-search' : 'fixture-direct';
      const started = await client.request('thread/start', { model: initial, modelProvider: 'mock', cwd: work, approvalPolicy: 'never', sandbox: 'read-only',
        dynamicTools: [{ type: 'namespace', name: 'codex_app', description: 'Synthetic fixture tools, not a real scheduling service.', tools: [{ type: 'function', name: 'automation_update',
          description: 'List synthetic fixture schedules.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, deferLoading: options.deferred !== false }] }] });
      await turn(started.thread.id, initial);
      if (phase === 'setup') {
        phase = 'exercise';
        if (options.coldResume) {
          client.stop(); await client.exited; await connect();
          await client.request('thread/resume', { threadId: started.thread.id, model: 'fixture-direct' });
        }
        await turn(started.thread.id, 'fixture-direct');
      }
      const exercise = observations.filter(row => row.phase === 'exercise');
      const result = { name, requests: sequence, exposed: exercise.some(row => row.exposed), searched, clientCalls, resultReturned: delivered,
        codeMode: options.codeMode === true, coldResume: options.coldResume === true, switched: options.switchModel === true, completedTools };
      assert.equal(unexpectedCalls, 0, `${name}: no unexpected client callbacks`);
      if (options.expectedReachable) {
        assert.equal(clientCalls, 1, `${name}: exactly one client tool call`); assert.equal(delivered, true, `${name}: result returned`);
        assert.deepEqual(completedTools, [{ status: options.decline ? 'failed' : 'completed', success: !options.decline }], `${name}: client success status preserved`);
      }
      else { assert.equal(clientCalls, 0, `${name}: unpatched control must remain hidden`); assert.equal(delivered, false); }
      if (options.search) assert.equal(searched, true, `${name}: native deferred discovery is preserved`);
      console.log(JSON.stringify(result)); return result;
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${name}: fixture timed out`)), 60_000); })]);
  } finally { clearTimeout(timer); client?.stop(); await client?.exited; server.closeAllConnections(); await new Promise(done => server.close(done)); }
}

const results = [];
if (values.native) results.push(await run(await realpath(values.native), 'native-no-search-control', { expectedReachable: false }));
const gateway = await realpath(values.gateway), expectedReachable = !values.baseline;
for (const [name, options] of [
  ['gateway-no-search-deferred', {}], ['gateway-no-search-direct', { deferred: false, expectedReachable: true }],
  ['gateway-search-deferred', { search: true, expectedReachable: true }], ['gateway-code-mode-deferred', { codeMode: true, expectedReachable: true }],
  ['gateway-cold-resume-deferred', { coldResume: true }], ['gateway-switch-model-deferred', { switchModel: true }],
  ['gateway-client-decline-direct', { decline: true, deferred: false, expectedReachable: true }],
  ['gateway-client-decline', { decline: true }],
]) results.push(await run(gateway, name, { expectedReachable, ...options }));
await writeFile(join(root, 'client-tool-exposure.json'), JSON.stringify({ passed: true, checkedAt: new Date().toISOString(),
  baseline: values.baseline === true, syntheticToolsOnly: true, externalInferenceRequests: 0,
  gatewaySha256: await sha256(gateway), ...(values.native ? { nativeSha256: await sha256(values.native) } : {}),
  fixtureSha256: await sha256(import.meta.filename), results }, null, 2), { mode: 0o600 });
