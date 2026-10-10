#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { access, open, readFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, writePrivateJson } from '../dist/config.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'codex-home': { type: 'string' }, app: { type: 'string', default: '/Applications/ChatGPT.app' } } });
if (process.platform !== 'darwin' || !values.config) throw new Error('Use on macOS: node scripts/launch-desktop.mjs --config PATH [--codex-home ISOLATED_PATH]');
const configPath = resolve(values.config); const config = await loadConfig(configPath);
const app = resolve(values.app); const binary = resolve(app, 'Contents/MacOS/ChatGPT');
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const codex = resolve(app, 'Contents/Resources/codex-cli/bin/codex');
await access(binary); await access(cli); await access(codex);
const running = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').some(command => command.trim() === binary);
if (running) throw new Error('Quit ChatGPT normally with Command-Q before activating the adapter. This launcher never stops a running app.');
const quoted = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = [process.execPath, cli, 'codex-shim', '--config', configPath, '--codex', codex, '--'].map(quoted).join(' ');
const content = '#!/bin/sh\n# Subscription Gateway desktop adapter.\nexec ' + command + ' "$@"\n';
const wrapper = resolve(config.stateDirectory, `desktop-wrapper-${createHash('sha256').update(content).digest('hex').slice(0,16)}`);
try {
  const file = await open(wrapper, 'wx', 0o700);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
} catch (error) {
  if (error.code !== 'EEXIST' || await readFile(wrapper, 'utf8') !== content) throw new Error('Generated adapter path is occupied by another file');
}
await chmod(wrapper, 0o700);
const env = { ...process.env, CODEX_CLI_PATH: wrapper, CODEX_APP_SERVER_FORCE_CLI: '1', GATEWAY_CONFIG: configPath, GATEWAY_NODE_PATH: process.execPath,
  GATEWAY_CODEX_PATH: codex, ...(values['codex-home'] ? { CODEX_HOME: resolve(values['codex-home']) } : {}) };
const child = spawn(binary, [], { env, detached: true, stdio: 'ignore' });
let failure; child.once('error', error => { failure = error; }); child.unref();
await delay(2000);
if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error('Desktop launch failed or another instance received the request. No native settings were changed.');
await writePrivateJson(resolve(config.stateDirectory, 'desktop-launch.json'), { startedAt: new Date().toISOString(), pid: child.pid, adapter: wrapper, isolatedNativeHome: !!values['codex-home'] });
console.log(JSON.stringify({ launched: true, pid: child.pid, adapterConfigured: true, renderedPickerVerified: false }));
