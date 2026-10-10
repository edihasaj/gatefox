#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, writePrivateJson } from '../dist/config.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'codex-home': { type: 'string' }, app: { type: 'string', default: '/Applications/ChatGPT.app' } } });
if (process.platform !== 'darwin' || !values.config) throw new Error('Use on macOS: node scripts/launch-desktop.mjs --config PATH [--codex-home ISOLATED_PATH]');
const configPath = resolve(values.config); const config = await loadConfig(configPath);
const app = resolve(values.app); const binary = resolve(app, 'Contents/MacOS/ChatGPT');
const wrapper = fileURLToPath(new URL('./codex-desktop-shim', import.meta.url));
await access(binary); await access(wrapper);
const running = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' }).split('\n').some(command => command.trim() === binary);
if (running) throw new Error('Quit ChatGPT normally with Command-Q before activating the adapter. This launcher never stops a running app.');
const env = { ...process.env, CODEX_CLI_PATH: wrapper, CODEX_APP_SERVER_FORCE_CLI: '1', GATEWAY_CONFIG: configPath, GATEWAY_NODE_PATH: process.execPath,
  GATEWAY_CODEX_PATH: resolve(app, 'Contents/Resources/codex-cli/bin/codex'), ...(values['codex-home'] ? { CODEX_HOME: resolve(values['codex-home']) } : {}) };
const child = spawn(binary, [], { env, detached: true, stdio: 'ignore' });
let failure; child.once('error', error => { failure = error; }); child.unref();
await delay(2000);
if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error('Desktop launch failed or another instance received the request. No native settings were changed.');
await writePrivateJson(resolve(config.stateDirectory, 'desktop-launch.json'), { startedAt: new Date().toISOString(), pid: child.pid, adapter: wrapper, isolatedNativeHome: !!values['codex-home'] });
console.log(JSON.stringify({ launched: true, pid: child.pid, adapterConfigured: true, renderedPickerVerified: false }));
