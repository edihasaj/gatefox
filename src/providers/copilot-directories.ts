import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "./provider.js";

/**
 * Every Copilot CLI process gets a private folder, because the CLI logs the conversation (prompts and tool
 * results) to `session-state/<id>/events.jsonl` inside its configuration folder. All of them live under one
 * dedicated parent folder of the OS temp folder (mode 0700, see `copilotParent`), so the startup sweep reads
 * that small folder and never the whole temp folder, which can hold hundreds of thousands of entries.
 * The folder name carries the owning gateway's pid and start time, so a later gateway can tell a dead owner's
 * leftovers from a running gateway's folders even after the pid was reused. `run` is a one-shot request, `live`
 * a long-lived session.
 */
export type DirectoryKind = "run" | "live";

const currentUid = (): number | undefined => typeof process.getuid === "function" ? process.getuid() : undefined;

/** The dedicated parent of every CLI folder: one per user, so users who share a temp folder never meet. */
export const copilotParent = (base = tmpdir()): string => join(base, `harness-gateway-copilot${currentUid() === undefined ? "" : `-${currentUid()}`}`);

/** Whether `info` (from `lstat`) is a real directory, never a symlink, that the user `uid` owns; where there are no uids, any real directory. */
export const ownedDirectory = (info: { isDirectory(): boolean; uid: number }, uid: number | undefined): boolean => info.isDirectory() && (uid === undefined || info.uid === uid);

/**
 * Creates the parent folder if needed and returns it. It must be a real directory (never a symlink) that the current
 * user owns, and it is made 0700; anything else is refused, because the CLI folders inside it hold prompt logs.
 */
export async function ensureCopilotParent(base = tmpdir()): Promise<string> {
  const path = copilotParent(base); const uid = currentUid();
  await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(path);
  if (!ownedDirectory(info, uid)) throw new ProviderError("cli_failed", "Copilot's private temp folder is not usable", 502);
  if ((info.mode & 0o777) !== 0o700) await chmod(path, 0o700);
  return path;
}

/** What `processStart` needs of `execFile`: a spawn that reports through a callback and returns a child that may emit `error`. */
export type PsSpawn = (
  file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv },
  callback: (error: Error | null, stdout: string | Buffer) => void,
) => { on(event: "error", listener: (error: Error) => void): unknown };

/**
 * When a process started, in whole seconds since the epoch (`ps -o lstart`), or undefined when that cannot be read.
 * It never rejects: `execFile` can throw while spawning (EPERM inside a macOS sandbox) or emit `error` without calling back,
 * and either one means the start is unknown, which callers already handle like a process that is gone. `spawn` is a test seam.
 */
export function processStart(pid: number, spawn: PsSpawn = execFile as PsSpawn): Promise<number | undefined> {
  return new Promise<number | undefined>(resolve => {
    try {
      const child = spawn("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3000, env: { PATH: process.env.PATH, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => {
        const time = Date.parse(`${String(stdout).trim().replace(/\s+/g, " ")} UTC`);
        resolve(error || !Number.isFinite(time) ? undefined : Math.floor(time / 1000));
      });
      child?.on("error", () => resolve(undefined));
    } catch {
      resolve(undefined);
    }
  });
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

/** How long the one-time check of the temp folder itself for older releases' folders stands before it runs again. */
export const legacyScanIntervalMs = { value: 7 * 24 * 3600 * 1000 };
const legacyScanMarker = ".legacy-scan";

/**
 * Removes the folders `names` lists in `directory` that nobody owns any more: in the dedicated parent, those of a gateway
 * that no longer runs; in the temp folder (`older`), those of releases before the parent, once they are old enough.
 */
async function sweepIn(directory: string, names: string[], uid: number | undefined, older: boolean): Promise<void> {
  for (const name of names) {
    const match = older ? null : owned.exec(name);
    if (!match && !(older && legacy.test(name))) continue;
    const path = join(directory, name);
    const info = await lstat(path).catch(() => undefined);
    if (!info || !ownedDirectory(info, uid)) continue;
    if (match) { if (await ownerRuns(parseInt(match[1], 36), match[2] === undefined ? undefined : parseInt(match[2], 36))) continue; }
    else if (Date.now() - info.mtimeMs < legacyAgeMs.value) continue;
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Removes the folders of gateway processes that no longer run, which hold prompt logs the CLI wrote.
 * Runs once when the gateway starts, whichever mode any provider is in. It reads only the dedicated parent folder.
 * Releases before it put their folders (`gateway-copilot-<random>`) straight into the temp folder, which can be huge,
 * so that folder is read for them once, then again after `legacyScanIntervalMs`. A folder is removed only if it is a
 * real directory (never a symlink) that `uid` (the current user) owns. A living process that reuses a dead owner's
 * pid does not keep the folder: its start time differs.
 */
export async function sweepCopilotDirectories(base = tmpdir(), uid = currentUid()): Promise<void> {
  void ownStart(); // Read once at startup, so the first Copilot request does not wait for it.
  const parent = copilotParent(base); const names = (directory: string) => readdir(directory).catch(() => [] as string[]);
  // A parent that is not a real directory this user owns is neither read nor trusted: its listing and its marker are another user's.
  const present = await lstat(parent).then(info => ownedDirectory(info, uid), () => false);
  if (present) await sweepIn(parent, await names(parent), uid, false);
  const marker = join(parent, legacyScanMarker);
  if (present && await lstat(marker).then(info => info.isFile() && Date.now() - info.mtimeMs < legacyScanIntervalMs.value, () => false)) return;
  await sweepIn(base, await names(base), uid, true);
  await ensureCopilotParent(base).then(() => writeFile(marker, "", { mode: 0o600 })).catch(() => {});
}
