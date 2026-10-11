#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { launchDesktop } from '../dist/desktop-launch.js';

const { values } = parseArgs({ options: { config: { type: 'string' }, 'codex-home': { type: 'string' }, app: { type: 'string', default: '/Applications/ChatGPT.app' } } });
if (process.platform !== 'darwin' || !values.config) throw new Error('Use on macOS: node scripts/launch-desktop.mjs --config PATH [--codex-home ISOLATED_PATH]');
console.log(JSON.stringify(await launchDesktop(resolve(values.config), values['codex-home'], values.app)));
