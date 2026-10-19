import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { writePrivateJson } from "./config.js";

/**
 * An adapter that finds the shared host missing or dead asks the service to retry at once instead of waiting out its
 * backoff. The request is one private file, `<host home>/kick`, whose content is the time of the request and nothing
 * else; the service only watches that the file was written again. A kick is a hint: the adapter waits for the host
 * either way, so neither side depends on it arriving.
 */
export async function requestHostKick(home: string): Promise<void> {
  try {
    // Only a home the host has claimed before: an adapter never creates the service's folders.
    const folder = await lstat(home);
    if (!folder.isDirectory() || folder.uid !== process.getuid?.() || (folder.mode & 0o077)) return;
    await writePrivateJson(resolve(home, "kick"), Date.now());
  } catch { /* Missing home, full disk or a refused write: the adapter still waits and fails exactly as before. */ }
}

export interface HostKickWatchOptions { intervalMs?: number; minimumGapMs?: number }

/**
 * For the service: polls `<home>/kick` every second (on a timer that never keeps the process alive) and calls `onKick`
 * when the file was written again since the last look, at most once every five seconds. A kick inside that gap is kept
 * and delivered when the gap ends, so an adapter's request is never lost to the rate limit. A kick written before the
 * watch began is not a new request. A write is told apart by the file's inode and time together, so a clock that
 * stepped back still counts as a new write. Returns the function that stops the watch. `onKick` may be async: whatever it
 * throws or rejects with is dropped here, so a failing handler never becomes an unhandled rejection or stops the watch.
 */
export function watchHostKick(home: string, onKick: () => unknown, options: HostKickWatchOptions = {}): () => void {
  const path = resolve(home, "kick"); const intervalMs = options.intervalMs ?? 1000; const minimumGapMs = options.minimumGapMs ?? 5000;
  const stamp = (info?: { isFile(): boolean; ino: bigint; mtimeNs: bigint }) => info?.isFile() ? `${info.ino}:${info.mtimeNs}` : undefined;
  let seen: string | undefined;
  try { seen = stamp(lstatSync(path, { bigint: true })); } catch { /* No kick yet. */ }
  let pending = false; let lastKick = Number.NEGATIVE_INFINITY; let polling = false; let stopped = false;
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const current = stamp(await lstat(path, { bigint: true }).catch(() => undefined));
      if (current !== undefined && current !== seen) pending = true;
      seen = current;
      const now = performance.now();
      if (pending && !stopped && now - lastKick >= minimumGapMs) {
        pending = false; lastKick = now;
        void Promise.resolve().then(onKick).catch(() => { /* The service's own handler reports its failures. */ });
      }
    } finally { polling = false; }
  };
  const timer = setInterval(() => { void poll(); }, intervalMs); timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
