#!/usr/bin/env node
// Proves the tool search bridge (`"toolSearch": "bridge"`) end to end through the gateway's own Codex provider code:
//   round 1: the model is offered only Codex's `tool_search`; the client must receive one `tool_search_call`.
//   round 2: that call and a `tool_search_output` loading a fixture tool are replayed; the model must call the loaded tool.
// Each round runs twice: with the tool at the top level and inside a Responses lite `additional_tools` item (how Sol sends it).
// --dry-run answers from a scripted backend instead, with no network and no credentials, and checks the outgoing shape.
// Live mode uses real inference on the Codex subscription (four short requests) and never refreshes the login: send one
// gateway request first if the token is stale. Output holds only item types, fixture tool names, statuses and fixed error
// codes: never the token, the account id, a request body or model text.
// Usage: node scripts/probe-tool-search-bridge.mjs [--dry-run] [--config GATEWAY_JSON] [--alias codex/gpt-6.1-sol] [--output FILE]
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: { config: { type: 'string' }, alias: { type: 'string', default: 'codex/gpt-6.1-sol' },
  output: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } } });
const dry = options['dry-run'];
const dist = name => new URL(`../dist/${name}`, import.meta.url);
const [{ ResponsesAPI }, { accessToken }, { userConfigPath }] = await Promise.all([import(dist('providers/responses-api.js')), import(dist('auth/chatgpt.js')), import(dist('paths.js'))]);

// The exact tool shape native Codex sends (codex-rs/core/src/tools/handlers/tool_search_spec.rs at the pinned revision).
const searchTool = { type: 'tool_search', execution: 'client',
  description: '# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\n',
  parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Maximum number of tools to return. Defaults to 8.' },
    query: { type: 'string', description: 'Search query for deferred tools.' } }, required: ['query'], additionalProperties: false } };
const weather = { type: 'namespace', name: 'mcp__fixture_weather__', description: 'Fixture weather server.', tools: [{ type: 'function', name: 'current_weather', defer_loading: true,
  description: 'Returns the current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } }] };
const instructions = 'You are a tool discovery probe. Your visible tools do not include a weather tool. Use tool_search to find one, then call the tool it loads. Do not answer in text.';
const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Tirana right now? Find a weather tool first.' }] };

let provider, scripted;
let model = 'gpt-6.1-sol';
const scratch = dry ? await mkdtemp(join(tmpdir(), 'gw-bridge-dry-')) : undefined;
try {
  if (dry) {
    const credentialFile = join(scratch, 'registration.json');
    await writeFile(credentialFile, JSON.stringify({ access_token: 'dry-run-only', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
    provider = new ResponsesAPI({ id: 'codex', type: 'codex-subscription', credentialFile, toolSearch: 'bridge', models: { [options.alias]: model } });
    scripted = [];
    const sse = items => [...items.map((item, index) => ({ type: 'response.output_item.done', output_index: index, item })),
      { type: 'response.completed', response: { id: 'r', status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init.body)); scripted.push(body);
      // The scripted backend answers as the real one would: round 1 calls the bridge function, round 2 the loaded tool.
      const replayed = body.input.some(item => item.type === 'function_call_output');
      const gateway = body.tools.find(tool => tool.name === 'gateway');
      const top = gateway?.tools?.find(tool => tool.name?.startsWith('tool_search'));
      const lite = body.input.flatMap(item => item.type === 'additional_tools' ? item.tools : []).find(tool => tool.name?.startsWith('tool_search'));
      const item = replayed ? { type: 'function_call', id: 'fc_2', call_id: 'call_w1', name: 'current_weather', namespace: weather.name, arguments: '{"city":"Tirana"}', status: 'completed' }
        : { type: 'function_call', id: 'fc_1', call_id: 'call_s1', name: (top || lite).name, ...(top ? { namespace: 'gateway' } : {}), arguments: '{"query":"weather"}', status: 'completed' };
      return new Response(sse([item]), { headers: { 'Content-Type': 'text/event-stream' } });
    };
  } else {
    const configPath = resolve(options.config || userConfigPath(homedir(), 'darwin'));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const source = (config.providers || []).find(entry => entry.type === 'codex-subscription' && entry.models && Object.hasOwn(entry.models, options.alias));
    if (!source?.credentialFile) throw Error(`No codex-subscription provider serves ${options.alias}`);
    const credentialFile = resolve(dirname(configPath), source.credentialFile);
    // Never refresh here: the refresh token is single-use and belongs to the running gateway.
    await accessToken(credentialFile, { refresh: false }).catch(() => { throw Error('The login needs a refresh; send one gateway request first, then rerun'); });
    model = source.models[options.alias];
    provider = new ResponsesAPI({ ...source, credentialFile, toolSearch: 'bridge' });
  }

  async function round(request) {
    const events = [];
    try { for await (const event of provider.infer(request, new AbortController().signal)) events.push(event); }
    catch (error) { return { error: typeof error?.code === 'string' ? error.code : 'other', upstream: typeof error?.upstream?.code === 'string' ? error.upstream.code : undefined }; }
    const natives = events.filter(event => event.type === 'native-item').map(event => event.item);
    const tools = events.filter(event => event.type === 'tool').map(event => event.call.responseTool);
    return { natives, tools, text: events.some(event => event.type === 'text' || event.type === 'text-delta') };
  }
  const results = [];
  for (const shape of ['top', 'lite']) {
    const declare = shape === 'lite' ? { tools: [], input: [{ type: 'additional_tools', role: 'developer', tools: [searchTool] }, user] } : { tools: [searchTool], input: [user] };
    const base = { model, stream: true, instructions, tool_choice: 'auto', parallel_tool_calls: false, reasoning: { effort: 'low' } };
    const first = await round({ ...base, tools: declare.tools, input: declare.input });
    // The backend checks tool types before the account's allowance, so a request refused only for the usage limit already
    // passed the tool check (`toolCheckPassed`); a refused tool type fails with a 400 instead.
    // Over the allowance, round 2 still runs with a stand-in call, so its replay shape (and the loaded tools) meet the tool check too.
    const call = first.error ? { type: 'tool_search_call', call_id: `call_probe_${shape}`, status: 'completed', execution: 'client', arguments: { query: 'weather' } }
      : first.natives.find(item => item.type === 'tool_search_call');
    const row = { shape, round1: first.error ? { ...first, toolCheckPassed: first.error === 'usage_limit' } : { searchCalls: first.natives.filter(item => item.type === 'tool_search_call').length,
      queryIsText: typeof call?.arguments?.query === 'string', dispatchedTools: first.tools.length, text: first.text } };
    if (call) {
      // Codex replays its own call, then the definitions its local search returned.
      const output = { type: 'tool_search_output', call_id: call.call_id, status: 'completed', execution: 'client', tools: [weather] };
      const second = await round({ ...base, tools: declare.tools, input: [...declare.input, call, output] });
      row.round2 = second.error ? { ...second, toolCheckPassed: second.error === 'usage_limit' } : { searchCalls: second.natives.filter(item => item.type === 'tool_search_call').length,
        loadedToolCalls: second.tools.filter(tool => tool.namespace === weather.name && tool.name === 'current_weather').length, otherTools: second.tools.length, text: second.text };
    }
    row.passed = row.round1.searchCalls === 1 && row.round1.dispatchedTools === 0 && row.round2?.loadedToolCalls === 1;
    results.push(row);
  }
  // Dry run only: what the gateway actually put on the wire (types and fixture names, never text).
  const wire = scripted?.map(body => ({
    refusedTypeSent: /"type":"tool_search/.test(JSON.stringify(body)),
    tools: body.tools.map(tool => tool.type === 'namespace' ? `${tool.name}{${tool.tools.map(entry => entry.name).join(',')}}` : `${tool.type}:${tool.name}`),
    input: body.input.map(item => item.type === 'additional_tools' ? `additional_tools{${item.tools.map(entry => entry.name).join(',')}}` : item.type),
    deferLoadingSent: JSON.stringify(body).includes('defer_loading') }));
  const report = { mode: dry ? 'dry-run' : 'live', alias: options.alias, at: new Date().toISOString(), results, ...(wire ? { wire } : {}),
    passed: results.length === 2 && results.every(row => row.passed) && (!wire || wire.every(body => !body.refusedTypeSent && !body.deferLoadingSent)) };
  if (options.output) await writeFile(resolve(options.output), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report, null, 1));
  if (!report.passed) process.exitCode = 1;
} finally { if (scratch) await rm(scratch, { recursive: true, force: true }); }
