import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every Copilot CLI process gets a private folder under the OS temp folder, because the CLI logs the
 * conversation (prompts and tool results) to `session-state/<id>/events.jsonl` inside its configuration folder.
 * The folder name carries the owning gateway's pid, so a later gateway can tell a dead owner's leftovers
 * from a running gateway's folders. `run` is a one-shot request, `live` a long-lived session.
 */
export type DirectoryKind = "run" | "live";
export const directoryPrefix = (kind: DirectoryKind, pid = process.pid) => `gateway-copilot-${kind}-${pid.toString(36)}-`;

/** One-shot folders of releases before the owner pid joined the name: `gateway-copilot-` and six random characters. */
const legacy = /^gateway-copilot-[A-Za-z0-9]{6}$/;
/** Longer than any request can run (the server caps one at an hour), so an older legacy folder is certainly abandoned. */
export const legacyAgeMs = { value: 2 * 3600 * 1000 };
const owned = /^gateway-copilot-(?:run|live)-([0-9a-z]+)-/;

const ownerAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/**
 * Removes the folders of gateway processes that no longer run, which hold prompt logs the CLI wrote.
 * Runs once when the gateway starts, whichever mode any provider is in. A folder is removed only if it is a
 * real directory (never a symlink) that the current user owns.
 */
export async function sweepCopilotDirectories(base = tmpdir()): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const match = owned.exec(name);
    if (!match && !legacy.test(name)) continue;
    const path = join(base, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
    if (match) { const owner = parseInt(match[1], 36); if (owner === process.pid || ownerAlive(owner)) continue; }
    else if (Date.now() - info.mtimeMs < legacyAgeMs.value) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
