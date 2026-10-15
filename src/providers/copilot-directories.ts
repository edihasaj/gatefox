import { execFile } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every Copilot CLI process gets a private folder under the OS temp folder, because the CLI logs the
 * conversation (prompts and tool results) to `session-state/<id>/events.jsonl` inside its configuration folder.
 * The folder name carries the owning gateway's pid and start time, so a later gateway can tell a dead owner's
 * leftovers from a running gateway's folders even after the pid was reused. `run` is a one-shot request, `live`
 * a long-lived session.
 */
export type DirectoryKind = "run" | "live";

/** When a process started, in whole seconds since the epoch (`ps -o lstart`), or undefined when that cannot be read. */
export function processStart(pid: number): Promise<number | undefined> {
  return new Promise(resolve => execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3000, env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => {
    const time = Date.parse(`${String(stdout).trim().replace(/\s+/g, " ")} UTC`);
    resolve(error || !Number.isFinite(time) ? undefined : Math.floor(time / 1000));
  }));
}

/** Two readings of one process's start differ by at most this many seconds (Linux derives it from the boot time). */
const startSlackSeconds = 2;
const sameStart = (a: number, b: number) => Math.abs(a - b) <= startSlackSeconds;

// One reading per process, shared by every loaded copy of this module, so every folder this process names agrees.
const ownStartKey = Symbol.for("harness-gateway/copilot-owner-start/v1");
function ownStart(): Promise<number | undefined> {
  const scope = globalThis as unknown as Record<symbol, Promise<number | undefined> | undefined>;
  return scope[ownStartKey] ??= processStart(process.pid);
}

/** The folder prefix for this process: kind, pid and start time (base 36). Without a readable start time it carries the pid alone. */
export async function directoryPrefix(kind: DirectoryKind): Promise<string> {
  const start = await ownStart();
  return `gateway-copilot-${kind}-${process.pid.toString(36)}-${start === undefined ? "" : `${start.toString(36)}-`}`;
}

/** One-shot folders of releases before the owner joined the name: `gateway-copilot-` and six random characters. */
const legacy = /^gateway-copilot-[A-Za-z0-9]{6}$/;
/** Longer than any request can run (the server caps one at an hour), so an older legacy folder is certainly abandoned. */
export const legacyAgeMs = { value: 2 * 3600 * 1000 };
/** Owner pid, then (current names) the owner's start time, then mkdtemp's six random characters. */
const owned = /^gateway-copilot-(?:run|live)-([0-9a-z]+)-(?:([0-9a-z]+)-)?[A-Za-z0-9]{6}$/;

const alive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

/** Whether the folder's owner still runs: a process with its pid and its start time. A name without a start time trusts the pid. */
async function ownerRuns(pid: number, start: number | undefined): Promise<boolean> {
  if (pid === process.pid) { const own = await ownStart(); return start === undefined || (own !== undefined && sameStart(own, start)); }
  if (!alive(pid)) return false;
  if (start === undefined) return true;
  const actual = await processStart(pid);
  // A start time that cannot be read is no proof of a reused pid; the folder stays until a later sweep can tell.
  return actual === undefined || sameStart(actual, start);
}

/**
 * Removes the folders of gateway processes that no longer run, which hold prompt logs the CLI wrote.
 * Runs once when the gateway starts, whichever mode any provider is in. A folder is removed only if it is a
 * real directory (never a symlink) that the current user owns. A living process that reuses a dead owner's
 * pid does not keep the folder: its start time differs.
 */
export async function sweepCopilotDirectories(base = tmpdir()): Promise<void> {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  void ownStart(); // Read once at startup, so the first Copilot request does not wait for it.
  for (const name of await readdir(base).catch(() => [] as string[])) {
    const match = owned.exec(name);
    if (!match && !legacy.test(name)) continue;
    const path = join(base, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory() || (uid !== undefined && info.uid !== uid)) continue;
    if (match) { if (await ownerRuns(parseInt(match[1], 36), match[2] === undefined ? undefined : parseInt(match[2], 36))) continue; }
    else if (Date.now() - info.mtimeMs < legacyAgeMs.value) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
