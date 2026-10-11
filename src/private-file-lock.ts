import { open, readFile, lstat, unlink, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Serialize small private-file updates across adapter processes. */
export async function withPrivateFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`; const deadline = Date.now() + 5000;
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
      let abandoned = false;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); }
        catch (error) { abandoned = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      } else abandoned = Date.now() - info.mtimeMs > 5000;
      if (abandoned) {
        const current = await lstat(lock).catch(() => undefined);
        if (current?.ino === info.ino && current.dev === info.dev) await unlink(lock).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Private preferences are busy; retry the selection");
      await delay(25);
    }
  }
  try { return await operation(); }
  finally { await file.close(); await unlink(lock); }
}
