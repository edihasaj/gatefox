import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerAlive, ownerStamp, type OwnerRecord } from "../boot-identity.js";

/**
 * Recovery for a gateway that was killed (SIGKILL, a crash, a power cut) and so ran no exit hook: its Gemini scratch roots
 * (`gateway-gemini-live-*` for a session, `gateway-gemini-login-*` for a sign-in) still hold a copied credential and, for a
 * session, the CLI's transcript. Each root records its owner when it is created; a root whose owner can no longer be running
 * (gone, rebooted past, or its pid reused by another program) is removed the next time any gateway process starts a session or
 * a sign-in. A root with no owner record, or an owner that may still be running, is never touched. The sweep removes folders
 * only: an orphaned ACP CLI ends by itself when its stdin closes, and a sign-in CLI gives up after its own five minutes.
 */
const ownerFile = "owner.json";
const scratchRoot = /^gateway-gemini-(?:live|login)-/;

/** Records which gateway process owns the scratch root `directory`. */
export async function markGeminiScratchOwner(directory: string): Promise<void> {
  const record: OwnerRecord = { pid: process.pid, ...await ownerStamp().catch(() => ({})) };
  await writeFile(join(directory, ownerFile), JSON.stringify(record), { mode: 0o600 });
}

/** Removes the scratch roots under `root` whose owner is gone, and returns how many. Best effort: nothing here throws. */
export async function sweepGeminiScratch(root = tmpdir()): Promise<number> {
  let removed = 0;
  const names = await readdir(root).catch(() => [] as string[]);
  for (const name of names.filter(entry => scratchRoot.test(entry))) {
    try {
      const path = join(root, name); const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) continue;
      const decoded: unknown = JSON.parse(await readFile(join(path, ownerFile), "utf8"));
      const record = decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : undefined;
      if (!record || typeof record.pid !== "number") continue;
      // This process's own roots are live sessions and sign-ins, whatever the pid check says.
      if (record.pid === process.pid) continue;
      const owner: OwnerRecord = { pid: record.pid, ...(typeof record.bootId === "string" ? { bootId: record.bootId } : {}), ...(typeof record.startedAtMs === "number" ? { startedAtMs: record.startedAtMs } : {}) };
      if (await ownerAlive(owner, info.mtimeMs)) continue;
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); removed++;
    } catch { /* A root that cannot be judged is left alone. */ }
  }
  return removed;
}

let swept = false;
/** The sweep, once per process, in the background: the first session or sign-in of a gateway run clears the last run's leftovers. */
export function sweepGeminiScratchOnce(): void {
  if (swept) return; swept = true;
  void sweepGeminiScratch().catch(() => {});
}
/** Test seam: lets the once-per-process sweep run again. */
export function resetGeminiScratchSweepForTests(): void { swept = false; }
