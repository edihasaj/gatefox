// Check the packaged supervisor's own release report after current moves, without a real service or provider.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { nextReleaseVersion } from './release-version.mjs';

const { values } = parseArgs({ options: { package: { type: 'string' } } });
assert.ok(values.package, 'Pass --package with a compiled release');
const source = resolve(values.package);
const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version;
const next = nextReleaseVersion(version);
const root = await mkdtemp('/tmp/gw-release-');
const pkg = join(root, 'releases', version, 'package'), state = join(root, 'state');
await mkdir(pkg, { recursive: true, mode: 0o700 }); await mkdir(state, { mode: 0o700 });
// Copy public runtime code only. No SDK, user configuration, authentication, or provider calls are needed.
for (const name of ['dist', 'node_modules', 'package.json']) await cp(join(source, name), join(pkg, name), { recursive: true });
await symlink('releases/' + version, join(root, 'current'));
const { ServiceSupervisor } = await import(pathToFileURL(join(pkg, 'dist/service-supervisor.js')).href);
const { runHealth } = await import(pathToFileURL(join(pkg, 'dist/health.js')).href);
const { serviceStatusPath } = await import(pathToFileURL(join(pkg, 'dist/service-plan.js')).href);
const config = join(root, 'gateway.json');
await writeFile(config, JSON.stringify({ version: 1, port: 3457, clientOnly: true, providers: [], stateDirectory: state }), { mode: 0o600 });
const supervisor = new ServiceSupervisor({ version: 1, config, components: [] }, state);
try {
  await supervisor.start();
  const before = JSON.parse(await readFile(serviceStatusPath(state), 'utf8'));
  assert.equal(before.runningRelease, version);
  await mkdir(join(root, 'releases', next), { mode: 0o700 });
  await symlink('releases/' + next, join(root, 'current.next')); await rename(join(root, 'current.next'), join(root, 'current'));
  let after;
  for (let attempt = 0; attempt < 160; attempt++) {
    after = JSON.parse(await readFile(serviceStatusPath(state), 'utf8'));
    if (after.updatedAt !== before.updatedAt) break;
    await delay(50);
  }
  assert.notEqual(after.updatedAt, before.updatedAt, 'Observe a real heartbeat after current changes');
  assert.equal(after.runningRelease, version, 'The supervisor must retain its own loaded release');
  const now = Date.now();
  const report = await runHealth({ stateDirectory: state, port: 3457, clientOnly: true }, {
    now: () => now, exists: async () => false, readPlan: async () => undefined, telemetry: async () => [],
    versions: async () => ({ installed: next, lagging: 0, processes: [{ role: 'service', pid: process.pid,
      startedAt: new Date(now - process.uptime() * 1000).toISOString(), release: next }] }),
    switchedAt: async () => now - 61 * 60_000,
  });
  assert.deepEqual(report.components.stale, ['service@' + version], 'The frozen report must override a falsely current inventory');
  console.log(JSON.stringify({ result: 'pass', loadedRelease: version, installedRelease: next,
    heartbeatPreservedLoadedRelease: true, staleServiceDetected: true, inferenceRequests: 0 }));
} finally { await supervisor.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
