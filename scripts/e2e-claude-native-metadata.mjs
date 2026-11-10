#!/usr/bin/env node
// Native client proof against a synthetic loopback backend. No account or paid inference is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildClaudeDesktopProfile, bridgeRouteName } from '../dist/claude-desktop-profile.js';
import { startAdapter } from './claude-desktop-adapter.mjs';
import { fixtureModels, startNativePickerFixture } from './claude-native-trial/fixture.mjs';

const marker = 'NATIVE_PICKER_OK';
const protectedPaths = () => [join(homedir(), '.claude/settings.json'), join(homedir(), '.claude.json'),
  join(homedir(), 'Library/Application Support/Claude-3p/configLibrary/_meta.json')];
const digest = async path => readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'),
  error => { if (error.code === 'ENOENT') return null; throw error; });

async function fixture(root) {
  const backend = await startNativePickerFixture(join(root, 'backend'));
  let adapter;
  try {
    const helper = join(root, 'token-helper.mjs');
    await writeFile(helper, `import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(${JSON.stringify(backend.tokenFile)}, 'utf8').trim());\n`, { mode: 0o600 });
    const catalog = { models: [{ slug: 'claude/claude-fable-5-1', display_name: 'Fixture Claude' }, ...fixtureModels] };
    const source = { port: Number(new URL(backend.endpoint).port), stateDirectory: join(root, 'backend'), providers: [
      { id: 'claude', type: 'claude-subscription', models: { 'claude/claude-fable-5-1': 'claude-fable-5-1' } },
      { id: 'synthetic', type: 'responses-api', models: Object.fromEntries(fixtureModels.map(row => [row.slug, row.slug])) },
    ] };
    const built = buildClaudeDesktopProfile(source, catalog, {
      deploymentDisplayName: 'GateFox native metadata fixture', inferenceProvider: 'gateway',
      inferenceCredentialKind: 'helper-script', inferenceGatewayAuthScheme: 'bearer',
      isClaudeCodeForDesktopEnabled: true, coworkTabEnabled: false, disableAutoUpdates: true,
      defaultModelEffort: 'medium',
    }, { tokenFile: backend.tokenFile, adapterRoot: root, upstream: backend.endpoint,
      nativeModelMetadata: true, credentialHelper: { command: process.execPath, args: [helper] } });
    adapter = await startAdapter({ config: { ...built.adapterConfig, listenPort: 0, auditFile: undefined } });
    const endpoint = `http://127.0.0.1:${adapter.port}`;
    built.profile.inferenceGatewayBaseUrl = endpoint;
    const rows = built.profile.inferenceModels.filter(row => row.behavesAs);
    assert.equal(rows.length, fixtureModels.length);
    assert.ok(rows.every(row => /^claude-hg-route-\d+$/.test(row.name)));
    return { backend, adapter, built, rows, helper, endpoint, close: async () => {
      adapter.server.closeAllConnections(); await adapter.close(); await backend.close();
    } };
  } catch (error) {
    if (adapter) { adapter.server.closeAllConnections(); await adapter.close(); }
    await backend.close(); throw error;
  }
}

async function runClient(cli, state, root, row, effort, mapped = true) {
  const name = `${mapped ? 'mapped' : 'control'}-${effort}`;
  const home = join(root, name);
  await mkdir(home, { mode: 0o700 });
  const settings = join(home, 'settings.json');
  const command = `'${process.execPath.replaceAll("'", "'\\''")}' '${state.helper.replaceAll("'", "'\\''")}'`;
  await writeFile(settings, JSON.stringify({ apiKeyHelper: command,
    modelPicker: { options: [{ model: row.name, label: row.labelOverride, ...(mapped ? { behavesAs: row.behavesAs } : {}) }] },
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
    if (frame.type === 'result') result = { success: frame.subtype === 'success' && frame.is_error !== true,
      marker: frame.result?.trim() === marker };
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1_048_576) { overflow = true; child.kill('SIGTERM'); return; }
    pending += chunk;
    for (;;) { const end = pending.indexOf('\n'); if (end < 0) break;
      consume(pending.slice(0, end)); pending = pending.slice(end + 1); }
  });
  child.stderr.on('data', () => {}); // Native diagnostics are never retained.
  child.stdin.on('error', () => {});
  child.stdin.end('Return the fixture confirmation without tools.');
  const exit = await new Promise(resolveResult => {
    let killTimer;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000); }, 45000);
    const done = code => { clearTimeout(timer); clearTimeout(killTimer); resolveResult(code); };
    child.once('error', () => done(null)); child.once('close', code => done(code));
  });
  if (pending) consume(pending);
  return { mapped, requestedEffort: effort, exit, timedOut, overflow,
    completed: result?.success === true && result.marker, requests: state.backend.requests.slice(before) };
}

async function main() {
  const { values } = parseArgs({ options: { claude: { type: 'string' }, serve: { type: 'boolean' } } });
  if (!values.claude || !isAbsolute(values.claude)) throw Error('Use --claude /absolute/path/to/claude [--serve]');
  const before = await Promise.all(protectedPaths().map(digest));
  const root = await mkdtemp('/tmp/claude-native-metadata.');
  const state = await fixture(root);
  let retained = false;
  try {
    const runs = [];
    for (const effort of ['low', 'high', 'max']) runs.push(await runClient(values.claude, state, root, state.rows[0], effort));
    const control = await runClient(values.claude, state, root, state.rows[0], 'high', false);
    const alias = fixtureModels[0].slug;
    const legacy = state.built.adapterConfig.models.find(row => row.id === bridgeRouteName(alias));
    const token = (await readFile(state.backend.tokenFile, 'utf8')).trim();
    const legacyReply = await fetch(`${state.endpoint}/v1/messages`, { method: 'POST',
      signal: AbortSignal.timeout(10000), headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({ model: legacy?.id, max_tokens: 32, messages: [{ role: 'user', content: 'Return the fixture confirmation.' }] }),
    });
    const legacyMessage = await legacyReply.json();
    const receipt = { root, syntheticInference: true, runs, control,
      legacyBridgeRetained: legacy?.upstream === alias,
      legacyBridgeCompleted: legacyReply.ok && legacyMessage.content?.some(block => block.type === 'text' && block.text === marker),
      nativeConfigurationUnchanged: JSON.stringify(before) === JSON.stringify(await Promise.all(protectedPaths().map(digest))) };
    receipt.passed = receipt.nativeConfigurationUnchanged && receipt.legacyBridgeRetained && receipt.legacyBridgeCompleted && runs.every(run => run.exit === 0 && run.completed
      && run.requests.some(request => request.model === alias && request.effort === run.requestedEffort && request.thinking === 'adaptive'));
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    await writeFile(join(root, 'desktop-profile.json'), JSON.stringify(state.built.profile, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(receipt));
    process.exitCode = receipt.passed ? 0 : 1;
    if (values.serve) {
      retained = true;
      console.log(JSON.stringify({ serving: true, root, endpoint: state.endpoint }));
      const stop = async () => {
        await writeFile(join(root, 'requests.json'), JSON.stringify(state.backend.requests, null, 2), { mode: 0o600 });
        await state.close(); process.exit(process.exitCode ?? 0);
      };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
    }
  } finally { if (!retained) await state.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
