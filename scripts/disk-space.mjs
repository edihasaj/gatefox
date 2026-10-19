import { existsSync, statfsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const gibibyte = 1024 ** 3;

// These thresholds come from the 2026-10-19 measurements: SDK target 14.4 GiB,
// relay 20.2 + 10.7 GiB, and an app ZIP of 173 MB unpacking to ~1.5 GiB per fixture copy.
export const releaseDiskSpaceRequirements = Object.freeze({
  gatewaySdkTest: 40 * gibibyte,
  gatewaySdkBuild: 25 * gibibyte,
  nativeRelay: 40 * gibibyte,
  buildRelease: 4 * gibibyte,
  releaseMacosApp: 10 * gibibyte,
  appUpdateFixture: 6 * gibibyte,
});

function existingAncestor(path, exists = existsSync) {
  let current = resolve(path);
  for (;;) {
    if (exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing ancestor for ${path}`);
    current = parent;
  }
}

/** Return free bytes on the volume containing a path, even when that path does not exist yet. */
export function freeBytes(path, { exists = existsSync, statfs = statfsSync } = {}) {
  const volumePath = existingAncestor(path, exists);
  return freeBytesAt(volumePath, statfs);
}

export function releaseFreeSpaceOverride(environment = process.env) {
  const value = environment.GATEWAY_RELEASE_MIN_FREE_GIB;
  if (value === undefined) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(value) || Number(value) <= 0 || !Number.isFinite(Number(value))) {
    throw new Error('GATEWAY_RELEASE_MIN_FREE_GIB must be a positive number');
  }
  return Number(value) * gibibyte;
}

/** Refuse a release step before it exhausts the volume it will write to. */
export function assertFreeSpace(path, requiredBytes, step, options = {}) {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0) throw new Error('Required disk space must be a positive number');
  const required = releaseFreeSpaceOverride(options.environment) ?? requiredBytes;
  const volumePath = existingAncestor(path, options.exists);
  return assertVolumeSpace(volumePath, required, step, options.statfs);
}

function assertVolumeSpace(volumePath, required, step, statfs = statfsSync) {
  const free = freeBytesAt(volumePath, statfs);
  if (free < required) {
    throw new Error(`${step} requires free disk space on ${volumePath}: ${formatGib(free)} GiB free, ` +
      `${formatGib(required)} GiB required. Run npm run release:clean, then retry.`);
  }
  return { freeBytes: free, requiredBytes: required, volumePath };
}

/** Check every output path that a release step can write to. */
export function assertFreeSpaceForPaths(paths, requiredBytes, step, options = {}) {
  const override = releaseFreeSpaceOverride(options.environment);
  const volumes = new Map();
  for (const input of paths) {
    const path = typeof input === 'string' ? input : input.path;
    const required = typeof input === 'string' ? requiredBytes : input.requiredBytes ?? input.required ?? requiredBytes;
    if (!Number.isFinite(required) || required <= 0) throw new Error('Required disk space must be a positive number');
    const volumePath = existingAncestor(path, options.exists);
    const device = (options.stat ?? statSync)(volumePath).dev;
    const previous = volumes.get(device);
    if (!previous || required > previous.required) volumes.set(device, { volumePath, required });
  }
  return [...volumes.values()].map(({ volumePath, required }) =>
    assertVolumeSpace(volumePath, override ?? required, step, options.statfs));
}

function freeBytesAt(volumePath, statfs) {
  const stats = statfs(volumePath);
  return Number(BigInt(stats.bavail) * BigInt(stats.bsize));
}

function formatGib(bytes) {
  return (bytes / gibibyte).toFixed(1);
}
