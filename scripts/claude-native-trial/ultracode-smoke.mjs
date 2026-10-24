#!/usr/bin/env node
/**
 * Exercise Claude Code's native Ultracode control protocol against a local,
 * credentialed fixture. This is intentionally a disposable CLI process: it
 * never touches a real Claude home, account, provider, or workspace.
 */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startNativePickerFixture } from './fixture.mjs';

const opaqueModel = 'claude-hg-route-107001';
const timeoutMs = 45_000;

function failureCode(value) {
  const message = typeof value === 'string' ? value.toLowerCase() : '';
  if (message.includes('ultracode') && message.includes('not available')) return 'ultracode_unavailable';
  if (message.includes('workflow')) return 'workflows_unavailable';
  if (message.includes('effort')) return 'effort_rejected';
  if (message.includes('auth') || message.includes('credential')) return 'authentication_rejected';
  if (message.includes('initialize')) return 'initialize_rejected';
  if (message.includes('permission')) return 'permission_rejected';
  if (message.includes('model')) return 'model_rejected';
  return message ? 'control_rejected' : 'unknown';
}

function safeEffort(value) {
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(value) ? value : null;
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function toolNames(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.map(tool => {
    if (typeof tool === 'string') return tool;
    if (tool && typeof tool === 'object' && typeof tool.name === 'string') return tool.name;
    return null;
  }).filter(Boolean));
}

function controlResult(frame) {
  const response = frame?.response;
  if (!response || typeof response !== 'object') return null;
  const id = typeof response.request_id === 'string' ? response.request_id : null;
  if (!id) return null;
  return {
    id,
    ok: response.subtype === 'success',
    failure: response.subtype === 'error' ? failureCode(response.error) : null,
  };
}

function initProjection(frame) {
  if (frame?.type !== 'system' || frame.subtype !== 'init') return null;
  const runtime = frame.runtime && typeof frame.runtime === 'object' ? frame.runtime : {};
  const settings = frame.settings && typeof frame.settings === 'object' ? frame.settings : {};
  const tools = toolNames(frame.tools);
  return {
    received: true,
    model: frame.model === opaqueModel ? opaqueModel : null,
    effort: safeEffort(frame.effort ?? runtime.effort ?? settings.effortLevel),
    ultracode: safeBoolean(frame.ultracode ?? runtime.ultracode ?? settings.ultracode),
    ultracodeRequested: safeBoolean(frame.ultracodeRequested ?? runtime.ultracodeRequested ?? settings.ultracodeRequested),
    ultracodeAvailable: safeBoolean(frame.ultracodeAvailable ?? runtime.ultracodeAvailable ?? settings.ultracodeAvailable),
    workflowTools: {
      task: tools.has('Task'),
      agent: tools.has('Agent'),
      todo: tools.has('TodoWrite') || tools.has('Todo'),
      teamCreate: tools.has('TeamCreate'),
    },
  };
}

export function settingsProjection(frame) {
  const response = frame?.response;
  if (response?.subtype !== 'success' || response.request_id !== 'settings') return null;
  const findContainer = (value, wanted, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return null;
    if (Object.hasOwn(value, wanted) && value[wanted] && typeof value[wanted] === 'object') return value[wanted];
    for (const key of ['runtime', 'settings', 'response', 'effective', 'resolved']) {
      const candidate = findContainer(value[key], wanted, depth + 1);
      if (candidate) return candidate;
    }
    return null;
  };
  const project = value => ({
    effort: safeEffort(value?.effort ?? value?.effortLevel),
    ultracode: safeBoolean(value?.ultracode),
    ultracodeRequested: safeBoolean(value?.ultracodeRequested),
    ultracodeAvailable: safeBoolean(value?.ultracodeAvailable),
  });
  const payload = response.response;
  return {
    // `effective` is the merged request. This CLI calls its active session
    // state `applied`; do not treat either one as a model-family claim.
    effective: project(findContainer(payload, 'effective')),
    active: project(findContainer(payload, 'applied')),
  };
}

async function privateDirectory(prefix) {
  const root = await mkdtemp(`/tmp/${prefix}`);
  await chmod(root, 0o700);
  return root;
}

export async function assertNativeCli(cliPath) {
  if (typeof cliPath !== 'string' || !isAbsolute(cliPath)) throw Error('Pass the native CLI as an absolute executable path');
  const nativeCli = resolve(cliPath);
  const info = await lstat(nativeCli);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('The pinned native CLI is not a regular file');
  await access(nativeCli, constants.X_OK);
  return nativeCli;
}

async function writeRuntimeFiles(root, fixture) {
  const home = join(root, 'home');
  const cliHome = join(root, 'cli');
  const workspace = join(root, 'workspace');
  const temporary = join(root, 'tmp');
  for (const directory of [home, cliHome, workspace, temporary]) await mkdir(directory, { mode: 0o700 });
  const helper = join(root, 'fixture-token-helper.mjs');
  // The helper is the only reader of the generated token; the token is never
  // copied into settings, the process environment, a receipt, or program output.
  await writeFile(helper, `#!${process.execPath}\nimport { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(${JSON.stringify(fixture.tokenFile)}, 'utf8').trim());\n`, { mode: 0o700 });
  const settings = join(root, 'settings.json');
  await writeFile(settings, JSON.stringify({
    apiKeyHelper: helper,
    enableWorkflows: true,
    env: {
      ANTHROPIC_BASE_URL: fixture.endpoint,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_ENABLE_TELEMETRY: '0',
    },
  }), { mode: 0o600 });
  return { home, cliHome, workspace, temporary, settings };
}

function inputFrames() {
  return [
    { type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } },
    { type: 'control_request', request_id: 'flags', request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'xhigh', ultracode: true } } },
    { type: 'control_request', request_id: 'settings', request: { subtype: 'get_settings' } },
    // The fixture always returns text. The content is deliberately not retained.
    { type: 'user', message: { role: 'user', content: 'Return the fixture confirmation without tools.' } },
  ];
}

export function smokeAccepted(cli, fixtureReceipt) {
  return cli.ok
    && cli.receipt.settings?.effective.effort === 'xhigh'
    && cli.receipt.settings?.effective.ultracode === true
    && cli.receipt.settings?.active.ultracode === true
    && cli.receipt.settings?.active.ultracodeRequested === true
    && cli.receipt.settings?.active.ultracodeAvailable === true
    && fixtureReceipt?.effort === 'xhigh';
}

export function completedCliRun(exit, oversizedOutput, result, flagsAccepted) {
  return exit.code === 0
    && !oversizedOutput
    && result.observed
    && result.success
    && !result.isError
    && result.fixtureMarker
    && flagsAccepted;
}

async function runCli(nativeCli, paths) {
  const env = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: paths.home,
    TMPDIR: paths.temporary,
    CLAUDE_CONFIG_DIR: paths.cliHome,
    XDG_CONFIG_HOME: paths.home,
    XDG_CACHE_HOME: paths.temporary,
    LANG: 'en_US.UTF-8',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  const args = [
    '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--await-initialize',
    '--model', opaqueModel, '--settings', paths.settings, '--max-turns', '1', '--restricted',
  ];
  const child = spawn(nativeCli, args, { cwd: paths.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const receipt = {
    systemInit: { received: false, model: null, effort: null, ultracode: null, ultracodeRequested: null, ultracodeAvailable: null, workflowTools: { task: false, agent: false, todo: false, teamCreate: false } },
    controls: { initialize: null, flags: null, settings: null },
    settings: null,
    permissionRequestsDenied: 0,
  };
  let stdout = '';
  let exitTimer;
  let oversizedOutput = false;
  const result = { observed: false, success: false, isError: false, fixtureMarker: false };
  const consume = line => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    const init = initProjection(frame);
    if (init) receipt.systemInit = init;
    const control = controlResult(frame);
    if (control && Object.hasOwn(receipt.controls, control.id)) receipt.controls[control.id] = { ok: control.ok, failure: control.failure };
    const runtime = settingsProjection(frame);
    if (runtime) receipt.settings = runtime;
    if (frame?.type === 'control_request' && frame?.request?.subtype === 'can_use_tool' && typeof frame.request_id === 'string' && !child.stdin.destroyed) {
      receipt.permissionRequestsDenied += 1;
      child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: { behavior: 'deny', message: 'Synthetic Ultracode smoke denies all tool permissions.' } } })}\n`);
    }
    if (frame?.type === 'result') {
      result.observed = true;
      result.success ||= frame.subtype === 'success';
      result.isError ||= frame.is_error === true;
      // Compare the known fixture marker without persisting response text.
      result.fixtureMarker ||= frame.result === 'NATIVE_PICKER_OK';
      child.stdin.end();
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > 1_048_576) {
      oversizedOutput = true;
      child.kill('SIGTERM');
      return;
    }
    for (;;) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
      if (line.length > 0) consume(line);
    }
  });
  // Never surface or retain vendor stderr: it can contain diagnostics.
  child.stderr.on('data', () => {});
  child.stdin.write(`${inputFrames().map(JSON.stringify).join('\n')}\n`);
  const exit = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.stdin.end(); child.kill('SIGTERM');
      exitTimer = setTimeout(() => child.kill('SIGKILL'), 3_000);
    }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); if (exitTimer) clearTimeout(exitTimer); finish({ code: null, signal: 'spawn_error' }); });
    // `close`, rather than `exit`, guarantees stdout/stderr streams have
    // drained before the trailing frame buffer is evaluated.
    child.once('close', (code, signal) => { clearTimeout(timer); if (exitTimer) clearTimeout(exitTimer); finish({ code, signal }); });
  });
  if (stdout.length > 0) consume(stdout);
  return { receipt, ok: completedCliRun(exit, oversizedOutput, result, receipt.controls.flags?.ok === true) };
}

async function main(cliPath) {
  const nativeCli = await assertNativeCli(cliPath);
  const root = await privateDirectory('claude-ultracode.');
  const fixture = await startNativePickerFixture(join(root, 'fixture'));
  try {
    const paths = await writeRuntimeFiles(root, fixture);
    const cli = await runCli(nativeCli, paths);
    const first = fixture.requests[0] ?? null;
    const receipt = {
      cli: cli.receipt,
      fixture: first ? { model: first.model, effort: first.effort, tier: first.tier, thinking: first.thinking, stream: first.stream } : null,
    };
    await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = smokeAccepted(cli, first) ? 0 : 1;
  } finally {
    await fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cliPath, ...extra] = process.argv.slice(2);
  if (!cliPath || extra.length > 0) throw Error('Usage: ultracode-smoke.mjs /absolute/path/to/claude');
  await main(cliPath);
}
