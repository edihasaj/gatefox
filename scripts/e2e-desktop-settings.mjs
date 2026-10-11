import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const { values: options } = parseArgs({ options: Object.fromEntries([
  'gateway', 'config', 'codex', 'native-home', 'workspace', 'output', 'model',
].map(key => [key, { type: 'string' }])) });
for (const key of ['gateway', 'config', 'codex', 'native-home', 'workspace', 'output']) {
  if (!options[key]) throw new Error(`Missing --${key}`);
}

const nativeHome = realpathSync(resolve(options['native-home']));
const fixture = dirname(nativeHome);
const configPath = realpathSync(resolve(options.config));
const configuration = JSON.parse(readFileSync(configPath, 'utf8'));
const inside = path => path.startsWith(fixture + sep);
const nativeConfig = resolve(nativeHome, 'config.toml');
const primaryHome = resolve(homedir(), '.codex');
if (nativeHome === primaryHome || (existsSync(primaryHome) && nativeHome === realpathSync(primaryHome)) ||
  primaryHome.startsWith(fixture + sep) || existsSync(resolve(nativeHome, 'auth.json')) || !inside(configPath) ||
  configuration.clientOnly !== true || !Array.isArray(configuration.providers) || configuration.providers.length !== 0 ||
  typeof configuration.stateDirectory !== 'string') {
  throw new Error('Use an isolated client-only fixture without copied native or provider credentials');
}
const configuredState = resolve(dirname(configPath), configuration.stateDirectory);
const workspacePath = resolve(options.workspace);
if (!inside(configuredState) || !inside(workspacePath)) throw new Error('Keep gateway state and workspace inside the isolated fixture');
mkdirSync(configuredState, { recursive: true, mode: 0o700 });
mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
const state = realpathSync(configuredState);
const workspace = realpathSync(workspacePath);
if (!inside(state) || !inside(workspace) || state === nativeHome || state.startsWith(nativeHome + sep)) {
  throw new Error('Fixture state and workspace must not resolve to shared native directories');
}
const preferencesPath = resolve(state, 'desktop-preferences.json');
if (existsSync(preferencesPath)) throw new Error('Use a fresh fixture state to test desktop-only preferences before a model is saved');
const output = resolve(options.output);
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
const outputTarget = existsSync(output) ? realpathSync(output) : resolve(realpathSync(dirname(output)), basename(output));
if (outputTarget === configPath || outputTarget.startsWith(nativeHome + sep) || outputTarget.startsWith(primaryHome + sep) ||
  outputTarget === preferencesPath || outputTarget.startsWith(state + sep)) {
  throw new Error('Write verification results outside native configuration and gateway state');
}
const digest = () => createHash('sha256').update(readFileSync(nativeConfig)).digest('hex');
const originalDigest = digest();
const results = [];
let phase = 'initialize';
const record = data => {
  results.push(data);
  writeFileSync(output, JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(data));
};
const check = (condition, message) => assert.ok(condition, `Check failed: ${message}`);
const equal = (actual, expected, message) => assert.deepEqual(actual, expected, `Check failed: ${message}`);

function connect() {
  const child = spawn(resolve(options.gateway), [
    'codex-shim', '--config', configPath, '--codex', resolve(options.codex), '--', 'app-server', '--listen', 'stdio://',
  ], { env: { ...process.env, CODEX_HOME: nativeHome }, cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let closing;
  const lines = createInterface({ input: child.stdout });
  const failed = reason => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(reason)); }
    pending.clear();
  };
  const exit = new Promise(resolve => child.once('close', () => { closed = true; failed('Owned adapter closed'); resolve(); }));
  child.once('error', () => failed('Owned adapter could not start'));
  child.stdin.on('error', () => failed('Owned adapter input closed'));
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { failed('Owned adapter returned invalid JSON-RPC'); return; }
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id); clearTimeout(request.timer);
      message.error ? request.reject(new Error(`${request.method} rejected the test request`)) : request.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No external test tool handler' } }) + '\n');
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Owned adapter is closed')); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 90000);
    pending.set(id, { resolve, reject, timer, method });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const signal = value => {
    try { process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const close = () => closing ??= (async () => {
    if (closed) return;
    child.stdin.end();
    if (!await Promise.race([exit.then(() => true), delay(5000).then(() => false)])) {
      signal('SIGTERM');
      if (!await Promise.race([exit.then(() => true), delay(5000).then(() => false)])) signal('SIGKILL');
      await exit;
    }
    lines.close(); failed('Owned adapter closed');
  })();
  return { rpc, close, notify: (method, params = {}) => child.stdin.write(JSON.stringify({ method, params }) + '\n') };
}
async function initialize(client) {
  await client.rpc('initialize', { clientInfo: { name: 'gateway_desktop_settings_e2e', version: '0.2.8' }, capabilities: { experimentalApi: true } });
  client.notify('initialized');
}

const expected = {
  'enabled-reasoning-efforts': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'show-ultra-in-model-picker-slider': true,
  'reduced-motion-preference': 'system',
  'confirm-before-close': 'keyboardOnly',
  followUpQueueMode: 'queue',
  conversationDetailMode: 'STEPS_PROSE',
};
const verifyDesktop = (settings, native) => {
  for (const [key, value] of Object.entries(expected)) equal(settings.desktop?.[key], value, `saved ${key} is visible`);
  for (const [key, value] of Object.entries(native)) {
    if (!(key in expected)) equal(settings.desktop?.[key], value, 'unrelated native desktop settings survive');
  }
};
const clients = new Set();
const open = async () => { const client = connect(); clients.add(client); await initialize(client); return client; };
try {
  let client = await open();
  const before = (await client.rpc('config/read', { includeLayers: false, cwd: null })).config;
  const nativeDesktop = before.desktop ?? {};
  check(Object.keys(nativeDesktop).some(key => !(key in expected)), 'fixture includes an unrelated native desktop setting');
  phase = 'desktop-only-app-format-write';
  const written = await client.rpc('config/batchWrite', {
    edits: Object.entries(expected).map(([key, value]) => ({ keyPath: `desktop.${key}`, mergeStrategy: 'replace', value })),
  });
  equal(written.status, 'ok', 'desktop-only write is accepted');
  equal(realpathSync(written.filePath), realpathSync(preferencesPath), 'preferences are written in isolated gateway state');
  equal(statSync(preferencesPath).mode & 0o777, 0o600, 'private settings file has owner-only access');
  const saved = JSON.parse(readFileSync(preferencesPath, 'utf8'));
  check(!Object.hasOwn(saved, 'model'), 'desktop settings require no model preference');
  const view = (await client.rpc('config/read', { includeLayers: false, cwd: null })).config;
  verifyDesktop(view, nativeDesktop);
  equal(view.model, before.model, 'desktop-only writes preserve native default model');
  equal(view.model_provider, before.model_provider, 'desktop-only writes preserve native provider');
  equal(digest(), originalDigest, 'native config remains unchanged');
  record({ phase, passed: true, sixEffortsSaved: true, maxEnabledInSavedSettings: true, nativeDesktopMerged: true, noModelRequired: true });

  phase = 'fresh-adapter-reload';
  await client.close(); clients.delete(client); client = await open();
  verifyDesktop((await client.rpc('config/read', { includeLayers: false, cwd: null })).config, nativeDesktop);
  equal(digest(), originalDigest, 'native config remains unchanged after reconnection');
  record({ phase, passed: true, displaySettingsPersisted: true });

  phase = 'concurrent-display-preference-merge';
  const second = await open();
  await Promise.all([
    client.rpc('config/value/write', { keyPath: 'desktop.appearanceTheme', value: 'dark', mergeStrategy: 'replace' }),
    second.rpc('config/value/write', { keyPath: 'desktop.codeFontSize', value: 13, mergeStrategy: 'replace' }),
  ]);
  for (const connection of [client, second]) {
    const current = (await connection.rpc('config/read', { includeLayers: false, cwd: null })).config;
    equal(current.desktop?.appearanceTheme, 'dark', 'both connections see the theme edit');
    equal(current.desktop?.codeFontSize, 13, 'both connections see the font edit');
    verifyDesktop(current, Object.fromEntries(Object.entries(nativeDesktop).filter(([key]) => !['appearanceTheme', 'codeFontSize'].includes(key))));
  }
  record({ phase, passed: true, unrelatedEditsMerged: true, bothConnectionsCurrent: true });

  phase = 'mixed-native-write-rejected-atomically';
  const preferenceDigest = createHash('sha256').update(readFileSync(preferencesPath)).digest('hex');
  let rejected = false;
  try {
    await client.rpc('config/batchWrite', { edits: [
      { keyPath: 'desktop.appearanceTheme', value: 'light', mergeStrategy: 'replace' },
      { keyPath: 'sandbox_mode', value: 'danger-full-access', mergeStrategy: 'replace' },
    ] });
  } catch { rejected = true; }
  check(rejected, 'mixed native batch is rejected');
  equal(createHash('sha256').update(readFileSync(preferencesPath)).digest('hex'), preferenceDigest, 'rejected batch does not alter private settings');
  equal(digest(), originalDigest, 'rejected batch does not alter native config');
  equal((await client.rpc('config/read', {})).config.desktop?.appearanceTheme, 'dark', 'valid edit in rejected batch was not applied');
  record({ phase, passed: true, privateWriteAtomic: true, nativeConfigUnchanged: true });

  if (options.model) {
    phase = 'private-model-and-catalog-default-aligned';
    await client.rpc('config/value/write', { keyPath: 'model', value: options.model, mergeStrategy: 'replace' });
    for (const connection of [client, second]) {
      equal((await connection.rpc('config/read', {})).config.model, options.model, 'both connections return private model preference');
      const models = []; let cursor = null;
      do {
        const page = await connection.rpc('model/list', { includeHidden: true, cursor, limit: 1000 });
        check(Array.isArray(page.data), 'model list returns public model rows');
        models.push(...page.data); cursor = page.nextCursor;
        check(models.length <= 4096, 'model list stays bounded');
      } while (cursor !== null && cursor !== undefined);
      equal(models.filter(row => row.isDefault).map(row => row.model), [options.model], 'catalog default matches private model preference');
    }
    record({ phase, passed: true, singleDefaultModel: true, configAndCatalogAgree: true });
  }
  phase = 'verification';
  equal(digest(), originalDigest, 'native config digest remains unchanged across all checks');
  record({ phase, passed: true, nativeConfigUnchanged: true, inferenceRequests: 0 });
} catch (error) {
  record({ phase, passed: false, error: error instanceof Error && error.message.startsWith('Check failed:') ? error.message : 'JSON-RPC setup or settings check failed' });
  process.exitCode = 1;
} finally {
  await Promise.all([...clients].map(client => client.close()));
}
