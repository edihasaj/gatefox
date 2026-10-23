// Read-only model discovery against the signed native SDK in an isolated home. No authentication is copied and no turn runs.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  code: { type: 'string' }, catalog: { type: 'string' }, root: { type: 'string' },
  codex: { type: 'string', default: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' },
} });
assert.ok(values.code && values.catalog && values.root, 'Pass --code PACKAGE --catalog NATIVE_MODELS_CACHE --root FRESH_DIRECTORY');
const code = resolve(values.code), sdk = resolve(values.codex), root = resolve(values.root);
assert.ok(root !== homedir() && !root.startsWith(resolve(homedir(), '.codex') + '/') && root !== resolve(homedir(), '.codex'));
await mkdir(root, { mode: 0o700 });
const fixture = await mkdtemp(join(root, 'fixture-'));
const home = join(fixture, 'home'), native = join(home, '.codex'), state = join(fixture, 'state');
for (const path of [home, native, state]) await mkdir(path, { recursive: true, mode: 0o700 });
const source = JSON.parse(await readFile(resolve(values.catalog), 'utf8'));
assert.ok(Array.isArray(source.models));
const catalog = join(fixture, 'public-models.json');
await writeFile(catalog, JSON.stringify({ models: source.models }), { mode: 0o600 });
const catalogBefore = await readFile(catalog, 'utf8');
execFileSync('/usr/bin/codesign', ['--verify', '--strict', sdk], { stdio: 'pipe' });
const signature = execFileSync('/usr/bin/codesign', ['-d', '--verbose=2', sdk], { stdio: ['ignore', 'pipe', 'pipe'] });
// codesign writes identity to stderr; strict verification above authenticates the selected signed executable.
void signature;
const sdkVersion = execFileSync(sdk, ['--version'], { encoding: 'utf8' }).trim();
const env = { HOME: home, CODEX_HOME: native, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: tmpdir(),
  CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: '1', GATEWAY_TELEMETRY: 'off', GATEWAY_ERROR_REPORTS: 'off' };
const child = spawn(sdk, ['app-server', '-c', `model_catalog_json=${JSON.stringify(catalog)}`,
  '-c', 'features.remote_control=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false'],
{ env, cwd: fixture, stdio: ['pipe', 'pipe', 'ignore'] });
let sequence = 0;
const pending = new Map();
const exited = new Promise(resolveExit => child.once('close', resolveExit));
const lines = createInterface({ input: child.stdout });
lines.on('line', text => {
  let message; try { message = JSON.parse(text); } catch { return; }
  if (pending.has(message.id)) {
    const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error('Native discovery RPC failed')) : request.resolve(message.result);
  } else if (message.id !== undefined && message.method) {
    child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Fixture does not execute tools' } }) + '\n');
  }
});
child.once('error', () => { for (const request of pending.values()) request.reject(new Error('Native SDK unavailable')); });
child.once('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Native SDK closed')); } pending.clear(); });
function rpc(method, params) {
  return new Promise((resolveRpc, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Native discovery RPC timed out')); }, 20000);
    pending.set(id, { resolve: resolveRpc, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  await rpc('initialize', { clientInfo: { name: 'gateway_picker_fixture', version: '1.0.0' } });
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const selected = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-6-luna'];
  const baseline = await rpc('model/list', { includeHidden: true, limit: 100 });
  for (const model of selected) assert.ok(baseline.data.some(row => row.model === model && !row.hidden), 'Selected model is absent or vendor-hidden');
  const { AppServerRouter } = await import(pathToFileURL(join(code, 'dist/app-server-router.js')));
  const config = { version: 1, port: 3457, stateDirectory: state, nativeModelPicker: selected,
    providers: [{ id: 'fixture', type: 'responses-api', apiKeyEnv: 'UNUSED_FIXTURE_KEY', baseUrl: 'http://127.0.0.1:1', models: { 'fixture/gateway': 'mock' } }] };
  const router = new AppServerRouter(config, rpc, undefined, undefined, native);
  await router.initialize();
  const visible = await router.request('model/list', { limit: 100 });
  assert.deepEqual(visible.data.filter(row => row.model !== 'fixture/gateway').map(row => row.model).sort(), [...selected].sort());
  assert.equal(visible.data.filter(row => row.model === 'fixture/gateway').length, 1);
  const hidden = await router.request('model/list', { includeHidden: true, limit: 100 });
  for (const row of baseline.data) {
    const projected = hidden.data.find(value => value.model === row.model); assert.ok(projected);
    assert.equal(projected.hidden, selected.includes(row.model) ? row.hidden : true);
  }
  // Placement: first (default), last and hidden against the same signed SDK catalog; presentation only.
  const gatewayRow = row => row.model === 'fixture/gateway';
  const placements = {};
  for (const placement of ['first', 'last', 'hidden']) {
    const placed = new AppServerRouter({ ...config, nativeModelPickerPlacement: placement }, rpc, undefined, undefined, native);
    await placed.initialize();
    const normal = (await placed.request('model/list', { limit: 100 })).data;
    const names = normal.map(row => row.model);
    const chosenNames = names.filter(name => name !== 'fixture/gateway');
    if (placement === 'hidden') assert.deepEqual(names, ['fixture/gateway'], 'Hidden placement leaves only gateway rows');
    else {
      assert.deepEqual([...chosenNames].sort(), [...selected].sort());
      assert.equal(names.indexOf('fixture/gateway'), placement === 'last' ? 0 : names.length - 1, `${placement} places the gateway row ${placement === 'last' ? 'before' : 'after'} the native rows`);
    }
    const all = (await placed.request('model/list', { includeHidden: true, limit: 100 })).data;
    assert.equal(all.filter(gatewayRow).length, 1);
    for (const row of baseline.data) {
      const projected = all.find(value => value.model === row.model); assert.ok(projected, 'Every native row stays listed under includeHidden');
      assert.equal(projected.hidden, placement === 'hidden' ? true : selected.includes(row.model) ? row.hidden : true);
    }
    assert.equal(all.find(gatewayRow).hidden, false);
    placements[placement] = true;
  }
  assert.equal(await readFile(catalog, 'utf8'), catalogBefore);
  await assert.rejects(access(join(native, 'auth.json')));
  const result = { passed: true, sdkVersion, nativePicker: selected, gatewayRowsPreserved: true,
    hiddenRowsPreserved: true, placements: Object.keys(placements), nativeCatalogUnchanged: true, nativeAuthCopied: false, inferenceRequests: 0 };
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  child.stdin.end(); child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  await exited; clearTimeout(kill); lines.close();
}
