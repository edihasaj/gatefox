#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = 'com.edihasaj.harness-gateway-provider-maintenance';
const root = fileURLToPath(new URL('..', import.meta.url));
const state = join(root, '.state/provider-maintenance'); const agents = join(homedir(), 'Library/LaunchAgents');
const path = join(agents, `${label}.plist`); const target = `gui/${process.getuid?.()}/${label}`;
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const launchctl = args => execFileSync('/bin/launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
const command = process.argv[2] ?? 'status';
if (process.platform !== 'darwin') throw Error('Local provider maintenance scheduling requires the Apple Silicon build host');
if (command === 'status') {
  let loaded = false; try { launchctl(['print', target]); loaded = true; } catch {}
  console.log(JSON.stringify({ installed: existsSync(path), loaded, schedule: 'daily', log: join(state, 'latest.json') }));
} else if (command === 'install') {
  if (!existsSync(join(root, 'dist/private-file-lock.js'))) throw Error('Run npm run build before installing the provider maintenance schedule');
  mkdirSync(state, { recursive: true, mode: 0o700 }); mkdirSync(agents, { recursive: true, mode: 0o700 });
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const args = ['/usr/bin/env', 'node', join(root, 'scripts/provider-maintenance.mjs'), '--apply', '--commit', '--branch', branch];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')}</string></dict>
<key>StartInterval</key><integer>86400</integer>
<key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/>
<key>StandardOutPath</key><string>${xml(join(state, 'schedule.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, 'schedule.log'))}</string>
</dict></plist>\n`;
  writeFileSync(path, plist, { mode: 0o600 });
  try { launchctl(['bootout', target]); } catch {}
  launchctl(['bootstrap', `gui/${process.getuid?.()}`, path]);
  console.log(JSON.stringify({ installed: true, schedule: 'daily', hostedCI: false, restartsRunningChats: false }));
} else if (command === 'uninstall') {
  try { launchctl(['bootout', target]); } catch {}
  if (existsSync(path)) execFileSync('trash', [path], { stdio: 'ignore' });
  console.log(JSON.stringify({ installed: false }));
} else throw Error('Use install, status or uninstall');
