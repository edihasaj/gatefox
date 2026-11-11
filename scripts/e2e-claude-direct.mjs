#!/usr/bin/env node
// Native Claude client proof for direct serving: the real CLI talks to a real gateway listener, with no adapter,
// and the gateway reaches a synthetic loopback backend. No account or paid inference is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gatewayToken, validateConfig } from '../dist/config.js';
import { buildClaudeDirectProfile, claudeDirectListRows } from '../dist/claude-direct-profile.js';
import { startGateway } from '../dist/server.js';
import { fixtureModels, startNativePickerFixture } from './claude-native-trial/fixture.mjs';

const marker = 'NATIVE_PICKER_OK';
// The gateway offers fewer efforts than the backend model has, so a clamp is visible at the backend.
const routes = { 'synthetic/reasoner': { upstream: fixtureModels[0].slug, efforts: ['low', 'medium', 'high'] },
  'synthetic/standard': { upstream: fixtureModels[1].slug, efforts: ['low', 'high'] } };
const protectedPaths = () => [join(homedir(), '.claude/settings.json'), join(homedir(), '.claude.json'),
  join(homedir(), 'Library/Application Support/Claude-3p/configLibrary/_meta.json')];
const digest = async path => readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'),
  error => { if (error.code === 'ENOENT') return null; throw error; });

async function fixture(root) {
  const backend = await startNativePickerFixture(join(root, 'backend'));
  let gateway;
  try {
    const state = join(root, 'state'); await mkdir(state, { mode: 0o700 });
    gateway = await startGateway(validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{
      id: 'synthetic', type: 'anthropic-api', label: 'Synthetic', baseUrl: `${backend.endpoint}/v1`, credentialFile: backend.tokenFile,
      models: Object.fromEntries(Object.entries(routes).map(([alias, route]) => [alias, route.upstream])),
      modelMetadata: Object.fromEntries(Object.entries(routes).map(([alias, route]) => [alias, { displayName: alias.split('/')[1], reasoningEfforts: route.efforts }])),
    }] }), undefined, undefined, { onFailure() {} });
    const endpoint = `http://127.0.0.1:${gateway.address().port}`;
    const token = await gatewayToken(state);
    const tokenFile = join(state, 'client-token');
    const helper = join(root, 'token-helper.mjs');
    await writeFile(helper, `import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(${JSON.stringify(tokenFile)}, 'utf8').trim());\n`, { mode: 0o600 });
    const list = await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10000) });
    assert.equal(list.status, 200);
    const rows = claudeDirectListRows(await list.json());
    const profile = mode => buildClaudeDirectProfile({}, rows, { endpoint, tokenFile, nativeModelMetadata: mode, credentialHelper: { command: process.execPath, args: [helper] } });
    return { backend, endpoint, helper, rows, bridge: profile(false).inferenceModels, native: profile(true).inferenceModels,
      close: async () => { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)); await backend.close(); } };
  } catch (error) {
    if (gateway) { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)); }
    await backend.close(); throw error;
  }
}

async function runClient(cli, state, root, name, row, effort) {
  const home = join(root, name);
  await mkdir(home, { mode: 0o700 });
  const settings = join(home, 'settings.json');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(settings, JSON.stringify({ apiKeyHelper: `${quote(process.execPath)} ${quote(state.helper)}`,
    modelPicker: { options: [{ model: row.name, label: row.labelOverride, ...(row.behavesAs ? { behavesAs: row.behavesAs } : {}) }] },
    env: { ANTHROPIC_BASE_URL: state.endpoint, DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '0' },
  }), { mode: 0o600 });
  const before = state.backend.requests.length;
  const child = spawn(cli, ['--print', '--model', row.name, '--effort', effort, '--settings', settings,
    '--setting-sources', '', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--tools', '', '--max-turns', '1', '--restricted', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], {
    cwd: home, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: home,
      CLAUDE_CONFIG_DIR: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, LANG: 'en_US.UTF-8' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let pending = ''; let bytes = 0; let result; let timedOut = false; let overflow = false;
  const consume = line => {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    if (frame.type === 'result') result = { success: frame.subtype === 'success' && frame.is_error !== true, marker: frame.result?.trim() === marker };
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1_048_576) { overflow = true; child.kill('SIGTERM'); return; }
    pending += chunk;
    for (;;) { const end = pending.indexOf('\n'); if (end < 0) break; consume(pending.slice(0, end)); pending = pending.slice(end + 1); }
  });
  child.stderr.on('data', () => {}); // Native diagnostics are never retained.
  child.stdin.on('error', () => {});
  child.stdin.end('Return the fixture confirmation without tools.');
  const exit = await new Promise(resolveResult => {
    let killTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); }, 45000);
    const done = code => { clearTimeout(timer); clearTimeout(killTimer); resolveResult(code); };
    child.once('error', () => done(null)); child.once('close', code => done(code));
  });
  if (pending) consume(pending);
  return { name, rowKind: row.behavesAs ? 'opaque+behavesAs' : /\[/.test(row.name) ? 'bridge' : 'opaque', requestedEffort: effort, exit, timedOut, overflow,
    completed: result?.success === true && result.marker, requests: state.backend.requests.slice(before) };
}

async function main() {
  const { values } = parseArgs({ options: { claude: { type: 'string' } } });
  if (!values.claude || !isAbsolute(values.claude)) throw Error('Use --claude /absolute/path/to/claude');
  const before = await Promise.all(protectedPaths().map(digest));
  const root = await mkdtemp('/tmp/claude-direct.');
  const state = await fixture(root);
  try {
    const [reasoner, standard] = Object.keys(routes).map(alias => state.rows.findIndex(row => row.alias === alias));
    // [run name, profile row, effort the client asks for, effort the route may receive]
    const cases = [
      ['bridge-low', state.bridge[reasoner], 'low', 'low'], ['bridge-max-clamped', state.bridge[reasoner], 'max', 'high'],
      ['native-high', state.native[reasoner], 'high', 'high'], ['native-max-clamped', state.native[reasoner], 'max', 'high'],
      ['standard-medium-clamped', state.bridge[standard], 'medium', 'low'],
    ];
    const runs = [];
    for (const [name, row, effort, expected] of cases) {
      const run = await runClient(values.claude, state, root, name, row, effort);
      const upstream = routes[state.rows.find(entry => [entry.id, entry.bridgeId].includes(row.name)).alias].upstream;
      // Every main-turn request reached the alias's own upstream model with an effort that route accepts.
      run.passed = run.exit === 0 && run.completed && run.requests.length > 0
        && run.requests.every(request => request.model === upstream)
        && run.requests.some(request => request.effort === expected && request.thinking === 'adaptive');
      run.expectedEffort = expected; runs.push(run);
    }
    const receipt = { root, syntheticInference: true, adapter: false, rows: state.rows.length, runs,
      nativeConfigurationUnchanged: JSON.stringify(before) === JSON.stringify(await Promise.all(protectedPaths().map(digest))) };
    receipt.passed = receipt.nativeConfigurationUnchanged && runs.every(run => run.passed);
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(receipt));
    process.exitCode = receipt.passed ? 0 : 1;
  } finally { await state.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
