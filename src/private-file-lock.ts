import { open, readFile, lstat, unlink, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ownerAlive, processStartedAfter } from "./boot-identity.js";

/** Serialize small private-file updates across adapter processes. */
export const lockBusyCode = "ELOCKBUSY";
const held = new Set<string>();
export async function withPrivateFileLock<T>(path: string, operation: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const lock = `${path}.lock`; const deadline = Date.now() + timeoutMs;
  let file: FileHandle;
  for (;;) {
    try {
      file = await open(lock, "wx", 0o600);
      try { await file.writeFile(String(process.pid)); }
      catch (error) { await file.close(); await unlink(lock); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(lock).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) continue;
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 32) throw new Error("Private preference lock is invalid");
      const pid = Number(await readFile(lock, "utf8").catch(() => "0"));
      // The same rule as an ownership receipt: an owner is only alive if this boot can still have it.
      let abandoned = false;
      if (Number.isSafeInteger(pid) && pid > 0) abandoned = !(await lockOwnerAlive(pid, lock, info.mtimeMs));
      else abandoned = Math.abs(Date.now() - info.mtimeMs) > 5000;
      if (abandoned) {
        const current = await lstat(lock).catch(() => undefined);
        if (current?.ino === info.ino && current.dev === info.dev) await unlink(lock).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        continue;
      }
      if (Date.now() >= deadline) throw Object.assign(new Error("Private preferences are busy; retry the selection"), { code: lockBusyCode });
      await delay(25);
    }
  }
  held.add(lock);
  try { return await operation(); }
  finally { held.delete(lock); await file.close(); await unlink(lock); }
}

/** A lock is held by this process only while it is inside `held`; any other name of our pid is a leftover. */
async function lockOwnerAlive(pid: number, lock: string, mtimeMs: number): Promise<boolean> {
  if (pid === process.pid) return held.has(lock); // Our own pid: only a lock this process still holds is held.
  if (!(await ownerAlive({ pid }, mtimeMs))) return false;
  return !(await processStartedAfter(pid, mtimeMs));
}
