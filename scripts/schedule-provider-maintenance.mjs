#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = 'com.edihasaj.harness-gateway-provider-maintenance';
const root = fileURLToPath(new URL('..', import.meta.url));
const state = join(root, '.state/provider-maintenance'); const agents = join(homedir(), 'Library/LaunchAgents');
const path = join(agents, `${label}.plist`); const target = `gui/${process.getuid?.()}/${label}`;
const launchctl = args => execFileSync('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
const command = process.argv[2] ?? 'status';
if (process.platform !== 'darwin') throw Error('Local provider maintenance scheduling requires the Apple Silicon build host');
if (command === 'status') {
  let loaded = false; try { launchctl(['print', target]); loaded = true; } catch {}
  console.log(JSON.stringify({ installed: existsSync(path), loaded, schedule: loaded ? 'legacy-daily' : 'manual', log: join(state, 'latest.json') }));
} else if (command === 'install') {
  throw Error('Standalone provider-build schedules are disabled. Keep one app-owned background item; run npm run providers:update manually.');
} else if (command === 'uninstall') {
  try { launchctl(['bootout', target]); } catch {}
  if (existsSync(path)) execFileSync('trash', [path], { stdio: 'ignore' });
  console.log(JSON.stringify({ installed: false }));
} else throw Error('Use install, status or uninstall');
