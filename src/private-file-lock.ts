import { constants } from "node:fs";
import { lstat, open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processAlive, processStartedAfter } from "./boot-identity.js";

/** Serialize small private-file updates across adapter processes. */
export const lockBusyCode = "ELOCKBUSY";
/**
 * How many callers in this process hold each lock right now, keyed by the lock's canonical path. An entry
 * exists from the moment the exclusive create succeeds until the lock file is gone, so a second caller here
 * never reads our own pid as a leftover while one of ours still holds the lock.
 */
const held = new Map<string, number>();
/** Breaking a stale lock is one step at a time per lock inside this process, keyed like `held`. */
const breaking = new Map<string, Promise<void>>();
/** A breaker that died inside its few-millisecond step leaves its marker this long at most. */
const breakMarkerStaleMs = 10_000;

export async function withPrivateFileLock<T>(path: string, operation: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const lock = await canonicalLock(path); const deadline = Date.now() + timeoutMs;
  let file: FileHandle;
  for (;;) {
    let created: FileHandle;
    try { created = await open(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await breakIfAbandoned(lock) && Date.now() < deadline) continue;
      if (Date.now() >= deadline) throw Object.assign(new Error("Private preferences are busy; retry the selection"), { code: lockBusyCode });
      await delay(25); continue;
    }
    hold(lock);
    try { await created.writeFile(String(process.pid)); }
    catch (error) { await release(lock, created); throw error; }
    file = created; break;
  }
  try { return await operation(); }
  finally { await release(lock, file); }
}

/**
 * One lock file has one name here, however the caller spelled its folder (`/tmp/x` and `/private/tmp/x`, or a link to
 * the folder). `held`, `breaking` and the `.break` marker all use this name, so a second spelling can never read the
 * first caller's live lock as this process's own leftover and break it. A folder that does not exist fails here as the
 * lock's own create would.
 */
async function canonicalLock(path: string): Promise<string> { return `${resolve(await realpath(dirname(resolve(path))), basename(path))}.lock`; }

function hold(lock: string): void { held.set(lock, (held.get(lock) ?? 0) + 1); }
function unhold(lock: string): void { const count = (held.get(lock) ?? 1) - 1; if (count > 0) held.set(lock, count); else held.delete(lock); }

/**
 * Removes the lock only while the path still names the file this handle created. The open handle keeps
 * that inode from being given to another file, so a lock somebody else made in its place is never removed.
 */
async function release(lock: string, file: FileHandle): Promise<void> {
  try {
    try {
      const mine = await file.stat({ bigint: true });
      const current = await lstat(lock, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; });
      if (current && current.ino === mine.ino && current.dev === mine.dev) await unlink(lock).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    } finally { await file.close(); }
  } finally { unhold(lock); }
}

/** True when the caller should try to create the lock again at once: it was gone, or it was abandoned and is now removed. */
async function breakIfAbandoned(lock: string): Promise<boolean> {
  const previous = breaking.get(lock) ?? Promise.resolve();
  let finish!: () => void; const turn = new Promise<void>(done => { finish = done; });
  const chain = previous.then(() => turn); breaking.set(lock, chain);
  await previous;
  try { return await judgeAndBreak(lock); }
  finally { finish(); if (breaking.get(lock) === chain) breaking.delete(lock); }
}

async function judgeAndBreak(lock: string): Promise<boolean> {
  let file: FileHandle;
  try { file = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    // A link, a socket, a device or anything else that is not a plain file cannot be a lock this code wrote.
    if (["ELOOP", "EMLINK", "ENXIO", "EOPNOTSUPP", "EISDIR"].includes(code ?? "")) throw new Error("Private preference lock is invalid");
    throw error;
  }
  // Held open, the judged file keeps its inode: no lock created after this one can be mistaken for it.
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || Number(info.uid) !== process.getuid?.() || (Number(info.mode) & 0o077) || info.size > 32n) throw new Error("Private preference lock is invalid");
    const bytes = Buffer.alloc(33); const { bytesRead } = await file.read(bytes, 0, 33, 0);
    const pid = Number(bytes.subarray(0, bytesRead).toString("utf8"));
    const mtimeMs = Number(info.mtimeMs);
    const abandoned = Number.isSafeInteger(pid) && pid > 0 ? !(await lockOwnerAlive(pid, lock, mtimeMs)) : Math.abs(Date.now() - mtimeMs) > 5000;
    if (!abandoned) return false;
    return await withBreakMarker(lock, async () => {
      const current = await lstat(lock, { bigint: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; });
      if (current && current.ino === info.ino && current.dev === info.dev) await unlink(lock).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      return true;
    });
  } finally { await file.close(); }
}

/**
 * One breaker at a time across processes: two that judged the same stale lock could otherwise each remove
 * it, and the slower one would remove the lock the faster one had just created in its place. Answers false
 * while another breaker is at work, so the caller waits and looks again.
 */
async function withBreakMarker(lock: string, action: () => Promise<boolean>): Promise<boolean> {
  const path = `${lock}.break`; let marker: FileHandle;
  try { marker = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await clearStaleBreakMarker(path); return false;
  }
  try { await marker.writeFile(String(process.pid)); return await action(); }
  finally {
    try {
      const mine = await marker.stat({ bigint: true });
      const current = await lstat(path, { bigint: true }).catch(() => undefined);
      if (current && current.ino === mine.ino && current.dev === mine.dev) await unlink(path).catch(() => {});
    } finally { await marker.close(); }
  }
}
async function clearStaleBreakMarker(path: string): Promise<void> {
  let file: FileHandle;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0)); } catch { return; }
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || Number(info.uid) !== process.getuid?.() || info.size > 32n) return;
    const bytes = Buffer.alloc(33); const { bytesRead } = await file.read(bytes, 0, 33, 0);
    const pid = Number(bytes.subarray(0, bytesRead).toString("utf8"));
    // A fresh marker is kept while its breaker can still be at work: alive, or not done writing its pid yet. Breakers
    // inside this process take turns, so a marker naming this process is a leftover of its own.
    const fresh = Math.abs(Date.now() - Number(info.mtimeMs)) <= breakMarkerStaleMs;
    if (fresh && (Number.isSafeInteger(pid) && pid > 0 ? pid !== process.pid && await processAlive({ pid }) : true)) return;
    const current = await lstat(path, { bigint: true }).catch(() => undefined);
    if (current && current.ino === info.ino && current.dev === info.dev) await unlink(path).catch(() => {});
  } finally { await file.close(); }
}

/**
 * Whether the pid in a lock can still be its holder. This process holds a lock only while `held` counts it;
 * any other lock naming our pid is a leftover. Locks never use the file-time boot rule: a clock that steps
 * forward would make a live lock look older than the boot, while a reused pid shows a start after the write.
 */
async function lockOwnerAlive(pid: number, lock: string, mtimeMs: number): Promise<boolean> {
  if (pid === process.pid) return (held.get(lock) ?? 0) > 0;
  if (!(await processAlive({ pid }))) return false;
  return !(await processStartedAfter(pid, mtimeMs));
}
