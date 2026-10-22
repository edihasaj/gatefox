// Proves a built gateway SDK runs Code Mode: `gateway-codex` starts its packaged `codex-code-mode-host`, a V8 cell runs
// and calls a nested shell tool, and the cell's output returns to the provider. The same executable without the host must
// fail closed. Private CODEX_HOME, local mock Responses provider, no real inference, no copied authentication.
// Usage: node scripts/e2e-code-mode-host.mjs --artifact .state/gateway-sdk-build/artifact --catalog ~/.codex/models_cache.json
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { artifact: { type: 'string' }, catalog: { type: 'string' }, model: { type: 'string', default: 'gpt-6.1-sol' } } });
if (!values.artifact || !values.catalog) throw Error('Usage: e2e-code-mode-host.mjs --artifact DIR --catalog NATIVE_MODELS_CACHE');
const artifact = resolve(values.artifact);
const cache = JSON.parse(await readFile(resolve(values.catalog), 'utf8'));
const base = (cache.models ?? cache).find(row => row.slug === values.model);
if (!base) throw Error(`The native catalog has no ${values.model} row`);
// A code_mode_only row makes Codex offer only `exec`/`wait`, so a passing cell must have run in the host.
const row = { ...base, slug: 'code-mode-probe', display_name: 'code-mode-probe', tool_mode: 'code_mode_only', supports_search_tool: false };
const cell = 'text("CM_" + (6 * 7)); const r = await tools.exec_command({ cmd: "printf HOST_RAN_SHELL" }); text(typeof r === "string" ? r : JSON.stringify(r));';

async function run(executable) {
  const scratch = await mkdtemp(join(tmpdir(), 'gw-code-mode-')); const home = join(scratch, 'home'), work = join(scratch, 'work');
  execFileSync('mkdir', ['-m', '700', home, work]);
  await writeFile(join(home, 'models.json'), JSON.stringify({ models: [row] }), { mode: 0o600 });
  const requests = [];
  const sse = (res, events) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (!req.url.endsWith('/responses')) { res.writeHead(404); return res.end(); }
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const id = `resp_${requests.length}`;
    const item = requests.length === 1
      ? { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', namespace: 'functions', input: cell, status: 'completed' }
      : { type: 'message', role: 'assistant', id: `msg_${requests.length}`, content: [{ type: 'output_text', text: 'DONE' }] };
    sse(res, [{ type: 'response.created', response: { id } }, { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { id, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }]);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await writeFile(join(home, 'config.toml'), `model = "code-mode-probe"\nmodel_provider = "mock"\nmodel_catalog_json = ${JSON.stringify(join(home, 'models.json'))}\n` +
    `[features]\ncode_mode_host = true\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\n`, { mode: 0o600 });
  const child = spawn(executable, ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', work, 'Run the probe.'],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CODEX_HOME: home }, stdio: ['ignore', 'ignore', 'ignore'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try { await once(child, 'exit'); } finally { clearTimeout(timer); server.close(); await rm(scratch, { recursive: true, force: true }); }
  const output = requests.flatMap(request => (request.input || []).filter(item => item.type === 'custom_tool_call_output'))
    .map(item => typeof item.output === 'string' ? item.output : JSON.stringify(item.output)).join('\n');
  return { requests: requests.length, ranCell: output.includes('CM_42'), ranNestedTool: output.includes('HOST_RAN_SHELL'), hostMissing: output.includes('failed to spawn code-mode host') };
}

const withHost = await run(join(artifact, 'gateway-codex'));
console.log(JSON.stringify({ phase: 'packaged-host', ...withHost }));
// The control copies only the executable (an APFS clone), so Codex finds no host beside it.
const control = await mkdtemp(join(tmpdir(), 'gw-code-mode-control-'));
try {
  execFileSync('cp', ['-c', join(artifact, 'gateway-codex'), control]);
  const withoutHost = await run(join(control, 'gateway-codex'));
  console.log(JSON.stringify({ phase: 'no-host-control', ...withoutHost }));
  assert.ok(withHost.ranCell && withHost.ranNestedTool && !withHost.hostMissing, 'The packaged host did not run the Code Mode cell');
  assert.ok(withoutHost.hostMissing && !withoutHost.ranCell, 'The control without a host did not fail closed');
} finally { await rm(control, { recursive: true, force: true }); }
console.log(JSON.stringify({ passed: true }));
