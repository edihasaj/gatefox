import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { withPrivateFileLock } from '../dist/private-file-lock.js';

function canonicalTarget(target) {
  const absolute = resolve(target);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}

export function cargoTargetLockPaths(targets) {
  return [...new Set(targets.map(target => `${canonicalTarget(target)}.cargo-target`))].sort();
}

function lockPid(path) {
  const pid = Number(readFileSync(path, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function pidIsLive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** Refuse cleanup before it waits behind a Cargo build that owns a shared target. */
export function assertCargoTargetLocksAvailable(targets) {
  for (const stem of cargoTargetLockPaths(targets)) {
    const lock = `${stem}.lock`;
    if (!existsSync(lock)) continue;
    const pid = lockPid(lock);
    if (pid && pidIsLive(pid)) throw new Error(`Refusing release cleanup while Cargo target lock ${lock} is held by live pid ${pid}`);
    if (!pid && Math.abs(Date.now() - lstatSync(lock).mtimeMs) < 60_000) {
      throw new Error(`Refusing release cleanup while Cargo target lock ${lock} may be held while its pid is being recorded`);
    }
  }
}

/** Serialize every process that writes one or more Cargo target directories. */
export async function withCargoTargetLocks(targets, operation, timeoutMs = 3_600_000) {
  const locks = cargoTargetLockPaths(targets);
  const acquire = async index => index === locks.length ? operation() :
    withPrivateFileLock(locks[index], () => acquire(index + 1), timeoutMs);
  return acquire(0);
}
