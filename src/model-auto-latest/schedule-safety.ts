import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gatefoxLauncherName, launcherMarker, launcherName, legacyLauncherName } from "../command.js";

/** Thrown for a path the job must not trust. Callers turn it into the fixed `unsafe_path` reason. */
export class UnsafePath extends Error {
  constructor() { super("unsafe path"); }
}

/** XML 1.0 cannot carry control characters, and a path holding one is never a path the gateway created. */
export function plainPath(path: string): boolean {
  return path.length > 0 && path.length < 1024 && !/[\u0000-\u001f\u007f]/.test(path);
}

/**
 * Every directory from the root to `path` must be a real directory that only its owner (or root) can change. A world-writable
 * directory is allowed only when it is root's sticky one, like /tmp. The path is resolved first, so a link the user placed on
 * purpose (a state folder on another volume) is followed once, and the real chain is what gets judged.
 */
export async function privateDirectory(path: string, uid: number): Promise<string> {
  if (!plainPath(path)) throw new UnsafePath();
  const real = await realpath(resolve(path)).catch(() => { throw new UnsafePath(); });
  const chain: string[] = [];
  for (let current = real; ; current = dirname(current)) { chain.unshift(current); if (dirname(current) === current) break; }
  for (const directory of chain) {
    const info = await lstat(directory).catch(() => { throw new UnsafePath(); });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new UnsafePath();
    if (info.uid !== uid && info.uid !== 0) throw new UnsafePath();
    if ((info.mode & 0o022) !== 0 && !((info.mode & 0o1000) !== 0 && info.uid === 0)) throw new UnsafePath();
  }
  return real;
}

/**
 * Creates `path` (mode 700 where new) one component at a time and returns its real path. `mkdir -p` would walk a link that is
 * not ours before anything is judged, so instead the deepest existing ancestor is resolved and judged first, each missing
 * component is made under that real folder and checked, and a link standing at `path` itself is refused rather than followed.
 */
export async function ensurePrivateDirectory(path: string, uid: number, mode = 0o700): Promise<string> {
  if (!plainPath(path)) throw new UnsafePath();
  const target = resolve(path);
  const missing: string[] = [];
  let existing = target;
  for (;;) {
    const info = await lstat(existing).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new UnsafePath(); });
    if (info) { if (existing === target && info.isSymbolicLink()) throw new UnsafePath(); break; }
    missing.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) throw new UnsafePath();
    existing = parent;
  }
  let base = await privateDirectory(existing, uid);
  for (const name of missing) {
    const next = join(base, name);
    await mkdir(next, { mode }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(next).catch(() => { throw new UnsafePath(); });
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) throw new UnsafePath();
    base = next;
  }
  return privateDirectory(base, uid);
}

/** Tightens a folder this user owns through a descriptor opened without following links, so a swapped-in link is never chmod'ed. */
async function tightenOwned(path: string, uid: number): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY).catch(() => { throw new UnsafePath(); });
  try {
    const info = await handle.stat();
    if (!info.isDirectory() || info.uid !== uid) throw new UnsafePath();
    if ((info.mode & 0o077) !== 0) await handle.chmod(0o700);
  } finally { await handle.close().catch(() => undefined); }
}

/** A folder only this user may read or change: the owner must be this user, and looser bits are tightened, never trusted. */
export async function ownedPrivateFolder(path: string, uid: number): Promise<string> {
  const real = await ensurePrivateDirectory(path, uid);
  await tightenOwned(real, uid);
  return real;
}

/**
 * The job's TMPDIR: `<tmp root>/harness-gateway-model-refresh-<uid>`. /tmp is cleared at boot, so the job itself recreates this folder
 * on every run. It must be a real directory this user owns with no group or other access, never a link someone else planted.
 */
export function jobTmpDirectory(uid: number, root = "/tmp"): string {
  return join(root, `harness-gateway-model-refresh-${uid}`);
}
export async function ensureJobTmp(directory: string, uid: number): Promise<void> {
  if (!plainPath(directory)) throw new UnsafePath();
  await privateDirectory(dirname(directory), uid);
  await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(directory).catch(() => { throw new UnsafePath(); });
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) throw new UnsafePath();
  await tightenOwned(directory, uid);
}

/**
 * The launcher a job may run: a regular file (never a link), owned by this user, not writable by anyone else, executable,
 * starting with a shell header and carrying the installer's marker line, in a directory chain only this user controls.
 * `harness-gateway` is preferred because macOS names the background item after it; `gateway` is the same launcher.
 */
export async function verifiedLauncher(home: string, uid: number): Promise<string | undefined> {
  const directory = join(home, ".local", "bin");
  try { await privateDirectory(directory, uid); } catch { return undefined; }
  for (const name of [gatefoxLauncherName, launcherName, legacyLauncherName]) {
    const path = join(directory, name);
    if (launcherLooksManaged(path, uid)) return path;
  }
  return undefined;
}
function launcherLooksManaged(path: string, uid: number): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o022) !== 0 || (info.mode & 0o100) === 0) return false;
    const buffer = Buffer.alloc(4096); const length = readSync(fd, buffer, 0, buffer.length, 0);
    const lines = buffer.subarray(0, length).toString("utf8").split("\n");
    return lines[0] === "#!/bin/sh" && lines.includes(launcherMarker);
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}
