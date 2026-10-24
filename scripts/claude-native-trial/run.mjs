import { mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startNativePickerFixture, fixtureModels } from './fixture.mjs';
import { prepareNativeTrial } from './prepare.mjs';
import { signNativeTrial } from './sign.mjs';

const task = resolve(process.argv[2] ?? '');
const flags = process.argv.slice(3);
let signing;
if (flags.length === 1 && flags[0] === '--adhoc-sign') signing = {};
else if (flags.length === 2 && flags[0] === '--developer-id' && /^[A-Fa-f0-9]{40}$/.test(flags[1])) {
  signing = { identity: flags[1], keychain: join(homedir(), 'Library/Keychains/apple-codesign.keychain-db') };
} else if (flags.length) throw Error('Use --adhoc-sign or --developer-id CERTIFICATE_SHA1');
if (!/^\/(?:private\/)?tmp\/claude-native-picker\.[A-Za-z0-9]+$/.test(task)) throw Error('Pass the explicit task-owned /tmp directory');
const taskInfo = await lstat(task);
const canonicalTask = await realpath(task);
if (!taskInfo.isDirectory() || taskInfo.isSymbolicLink() || taskInfo.uid !== process.getuid() || (taskInfo.mode & 0o077) !== 0 || canonicalTask !== task.replace(/^\/tmp\//, '/private/tmp/')) {
  throw Error('Task root must be an owned private directory without symlinks');
}
const trial = join(task, 'trial');
await mkdir(trial, { mode: 0o700 }); // Exclusive: no pre-existing state or symlink tree is accepted.
const fixture = await startNativePickerFixture(join(task, 'fixture'));
const profileId = randomUUID();
const library = join(trial, 'profile-3p', 'configLibrary');
await mkdir(library, { recursive: true, mode: 0o700 });
const profile = {
  deploymentDisplayName: 'Harness Gateway Native Trial', inferenceProvider: 'gateway',
  inferenceCredentialKind: 'helper-script', inferenceGatewayBaseUrl: fixture.endpoint,
  inferenceGatewayAuthScheme: 'bearer', inferenceCredentialHelper: join(homedir(), '.local/bin/gateway'),
  inferenceCredentialHelperArgs: ['token', '--file', fixture.tokenFile],
  modelDiscoveryEnabled: false, alwaysStartWithDefaultModel: true, defaultModelEffort: 'medium',
  isClaudeCodeForDesktopEnabled: true, coworkTabEnabled: false,
  inferenceModels: fixtureModels.map(model => ({ name: model.slug, labelOverride: model.display_name,
    maxEffort: model.supported_reasoning_levels.at(-1).effort })),
};
await writeFile(join(library, '_meta.json'), JSON.stringify({ entries: [{ id: profileId, name: 'Harness Gateway' }], appliedId: profileId }), { flag: 'wx', mode: 0o600 });
await writeFile(join(library, `${profileId}.json`), JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
const prepared = await prepareNativeTrial({ sourceApp: '/Applications/Claude.app',
  copyApp: join(task, 'Claude Native Trial.app'), stateRoot: trial, catalog: { models: fixtureModels } });
if (signing) {
  // Explicit opt-in only: requires owner approval. Never use this path for the installed/source app.
  prepared.signing = await signNativeTrial(prepared.copyApp, signing);
  prepared.resigningPerformed = true;
}
await writeFile(join(task, 'prepared.json'), JSON.stringify(prepared, null, 2), { flag: 'wx', mode: 0o600 });
const env = {};
for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'DISPLAY', '__CF_USER_TEXT_ENCODING']) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
env.TMPDIR = task;
const child = spawn(join(prepared.copyApp, 'Contents/MacOS/Claude'), [`--user-data-dir=${join(trial, 'profile')}`], { env, stdio: ['ignore', 'ignore', 'ignore'] });
let stopped = false;
const save = () => writeFile(join(task, 'requests.json'), JSON.stringify(fixture.requests), { mode: 0o600 });
const timer = setInterval(() => { void save(); }, 500);
const stop = async () => {
  if (stopped) return; stopped = true; clearInterval(timer);
  child.kill('SIGTERM'); await save(); await fixture.close();
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
child.once('error', () => { console.error('Native trial failed to start'); void stop(); process.exitCode = 1; });
child.once('exit', (code, signal) => {
  console.log(JSON.stringify({ event: 'trial_exit', code, signal })); void stop();
});
await writeFile(join(task, 'running.json'), JSON.stringify({ runnerPid: process.pid, appPid: child.pid, endpoint: fixture.endpoint, stateRoot: trial }), { mode: 0o600 });
console.log(JSON.stringify({ event: 'trial_started', appPid: child.pid, officialAppUnchanged: true, isolatedState: true, paidInference: false }));
