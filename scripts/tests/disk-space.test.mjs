import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFreeSpace, assertFreeSpaceForPaths, freeBytes, gibibyte, releaseFreeSpaceOverride } from '../disk-space.mjs';

test('uses statfs from the nearest existing ancestor', () => {
  const calls = [];
  const bytes = freeBytes('/private/build/missing/target', {
    exists: path => path === '/private/build',
    statfs: path => { calls.push(path); return { bavail: 3, bsize: 4096 }; },
  });
  assert.equal(bytes, 12_288);
  assert.deepEqual(calls, ['/private/build']);
});

test('reports a clear free-space requirement and supports a reviewed override', () => {
  const options = {
    exists: path => path === '/volume',
    statfs: () => ({ bavail: 2, bsize: gibibyte }),
    environment: {},
  };
  assert.throws(() => assertFreeSpace('/volume/build', 4 * gibibyte, 'SDK build', options),
    /SDK build requires free disk space on \/volume: 2\.0 GiB free, 4\.0 GiB required\. Run npm run release:clean/);
  assert.deepEqual(assertFreeSpace('/volume/build', 4 * gibibyte, 'SDK build', {
    ...options, environment: { GATEWAY_RELEASE_MIN_FREE_GIB: '1.5' },
  }), { freeBytes: 2 * gibibyte, requiredBytes: 1.5 * gibibyte, volumePath: '/volume' });
});

test('rejects invalid release-space overrides', () => {
  for (const value of ['', '0', '-1', 'many']) {
    assert.throws(() => releaseFreeSpaceOverride({ GATEWAY_RELEASE_MIN_FREE_GIB: value }), /positive number/);
  }
  assert.equal(releaseFreeSpaceOverride({}), undefined);
});

test('checks a custom Cargo target volume as well as the build root', () => {
  assert.throws(() => assertFreeSpaceForPaths(['/build-root', '/cargo-volume/target'], 4 * gibibyte, 'Relay build', {
    exists: path => path === '/build-root' || path === '/cargo-volume',
    stat: path => ({ dev: path === '/build-root' ? 1 : 2 }),
    statfs: path => path === '/build-root' ? { bavail: 8, bsize: gibibyte } : { bavail: 2, bsize: gibibyte },
    environment: {},
  }), /Relay build requires free disk space on \/cargo-volume: 2\.0 GiB free, 4\.0 GiB required/);
});

test('checks each device once using its largest applicable requirement', () => {
  const calls = [];
  assert.throws(() => assertFreeSpaceForPaths([
    { path: '/same-one/output', requiredBytes: 2 * gibibyte },
    { path: '/same-two/output', requiredBytes: 4 * gibibyte },
  ], 1 * gibibyte, 'Combined build', {
    exists: path => path === '/same-one' || path === '/same-two',
    stat: () => ({ dev: 7 }),
    statfs: path => { calls.push(path); return { bavail: 3, bsize: gibibyte }; },
    environment: {},
  }), /3\.0 GiB free, 4\.0 GiB required/);
  assert.equal(calls.length, 1);
});
