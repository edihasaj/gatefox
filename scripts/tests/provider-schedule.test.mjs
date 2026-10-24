import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import test from 'node:test';

test('provider-build scheduling cannot create another macOS background job', { skip: process.platform !== 'darwin' }, () => {
  const home = mkdtempSync('/tmp/gateway-provider-schedule-');
  const result = spawnSync(process.execPath, ['scripts/schedule-provider-maintenance.mjs', 'install'], {
    encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: home }, timeout: 5_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Standalone provider-build schedules are disabled/);
  assert.deepEqual(readdirSync(home), [], 'refusal must happen before any registration or state write');
});
