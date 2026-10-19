import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, dirname, basename, relative, isAbsolute } from "node:path";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { connect } from "node:net";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { testSafeRoot } from "./test-root-guard.js";
import { releasePattern, releaseState, type ReleaseState } from "./self-update.js";

/** The folder that holds every managed SSH control home. */
const sshStateRoot = () => testSafeRoot(resolve(homedir(), ".local/state/gw-ssh"), "SSH control root");

export function sshControlHome(configPath: string, nativeHome = process.env.CODEX_HOME || resolve(homedir(), ".codex")): string {
  const scope = createHash("sha256").update(resolve(configPath) + "\0" + resolve(nativeHome)).digest("hex").slice(0, 16);
  return resolve(sshStateRoot(), scope);
}

/** Whether `path` lies in a managed SSH control home, the only place the sweep of crashed bootstraps' leftovers may run. */
export function isManagedSshSocket(path: string): boolean {
  const inside = relative(sshStateRoot(), resolve(path));
  return inside !== "" && inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside);
}

/**
 * Reuse a live owned listener. Recover only a stale socket recorded by us.
 * `state` is this bootstrap's release pair; it defaults to the real one and is
 * injectable so a test can decide whether this run is an installed release.
 */
export async function reuseSshSocket(path: string, state: ReleaseState | undefined = releaseState()): Promise<SshSocketReuse> {
  if (!await lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; })) return { reused: false };
  return withPrivateFileLock(path + ".gateway-lease", () => inspectSshSocket(path, state));
}

/** Outcome of a reuse attempt. `replace` is a decision, not an action: a live listener running
 * another release should be retired, but nothing has been replaced yet. The caller hands it to
 * `serveUnix`, which carries the swap out inside its publish lock right after binding, so a
 * bootstrap whose preparation fails leaves the old listener serving new connections. */
export interface SshSocketReuse { reused: boolean; replace?: SshSocketReplacement }

/** The ownership record a replaced listener held, kept inside the replacement's own record. A
 * bootstrap that dies between writing its record and renaming its alias into place leaves the
 * alias on the old listener while the record names the dead new one; `previous` is how the next
 * bootstrap tells that state from a foreign socket and puts the record back. */
export interface SshLeasePrevious { inode: string; device: string; boundPath: string; release?: string }

/** The listener to retire at bind time: the releases on either side of the swap and the
 * inode/device the public alias had when the decision was made. */
export interface SshSocketReplacement { from: string; to: string; inode: string; device: string }

/** A bound socket's name: `.gw-` and twelve hex digits, in the alias's own folder. */
const boundName = /^\.gw-[0-9a-f]{12}$/;
const isBoundPath = (value: unknown, folder: string): value is string => typeof value === "string" && dirname(value) === folder && boundName.test(value.split("/").at(-1) ?? "");

/** The record a replacement stores as `previous`, read from the replaced listener's record text.
 * It must describe `alias`, the inode the replacement is about to displace; anything else yields none. */
export function previousLease(text: string | undefined, folder: string, alias: { ino: bigint; dev: bigint }): SshLeasePrevious | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  const previous = readPrevious(value, folder);
  return previous && previous.inode === String(alias.ino) && previous.device === String(alias.dev) ? previous : undefined;
}

function readPrevious(value: unknown, folder: string): SshLeasePrevious | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { inode, device, boundPath, release } = value as Record<string, unknown>;
  if (typeof inode !== "string" || typeof device !== "string" || !isBoundPath(boundPath, folder)) return undefined;
  if (release !== undefined && !(typeof release === "string" && releasePattern.test(release))) return undefined;
  return { inode, device, boundPath, ...(typeof release === "string" ? { release } : {}) };
}

/** Whether something accepts connections at `path`. Rejects when the answer is unknown (a timeout or another error). */
function accepts(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = connect(path); const timer = setTimeout(() => { socket.destroy(); reject(new Error("SSH socket liveness probe timed out")); }, 1500);
    const finish = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", error => { if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")) finish(false); else { clearTimeout(timer); reject(error); } });
  });
}

type Entry = BigIntStats;
const privateSocket = (value: Entry) => value.isSocket() && value.uid === BigInt(process.getuid!()) && (value.mode & 0o077n) === 0n;

interface Lease { inode: string; device: string; boundPath?: string; release?: string; previous?: SshLeasePrevious }

/** Read and validate the ownership record at `leasePath`. Throws when it is unavailable or invalid. */
async function readLease(leasePath: string): Promise<Lease> {
  const file = await lstat(leasePath);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 4096) throw new Error("SSH socket ownership record is unavailable");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(await readFile(leasePath, "utf8")); }
  catch { throw new Error("SSH socket ownership record is invalid"); }
  if (!parsed || typeof parsed !== "object" || typeof parsed.inode !== "string" || typeof parsed.device !== "string") throw new Error("SSH socket ownership record is invalid");
  // Leases written before 0.4.4 carry no release. Anything else must look like a release name.
  if (parsed.release !== undefined && !(typeof parsed.release === "string" && releasePattern.test(parsed.release))) throw new Error("SSH socket ownership record is invalid");
  // `previous` is optional, and a malformed one is ignored: it only ever enables a repair.
  return { inode: parsed.inode, device: parsed.device, boundPath: typeof parsed.boundPath === "string" ? parsed.boundPath : undefined,
    release: parsed.release as string | undefined, previous: readPrevious(parsed.previous, dirname(leasePath)) };
}

/**
 * Put the ownership record back when a crashed swap left it naming a dead listener while the alias
 * is still the previous listener's. A publish calls this under the lease lock before it sweeps or
 * reads the record: the sweep removes the staged link that is the only evidence of the swap, and the
 * record it reads becomes the new `previous`, so both must see the real current owner. Nothing to
 * repair (no alias, an unreadable record, a record that owns the alias, or no evidence) returns
 * false. A failure while repairing is thrown, so the caller stops before it destroys the evidence.
 */
export async function repairSshLease(path: string): Promise<boolean> {
  const leasePath = path + ".gateway-lease";
  const info = await lstat(path, { bigint: true }).catch(() => undefined);
  const lease = info && await readLease(leasePath).catch(() => undefined);
  if (!info || !lease || (privateSocket(info) && String(info.ino) === lease.inode && String(info.dev) === lease.device)) return false;
  return await repairInterruptedSwap(leasePath, lease, info) !== undefined;
}

async function inspectSshSocket(path: string, state: ReleaseState | undefined): Promise<SshSocketReuse> {
  const info = await lstat(path, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return { reused: false };
  const leasePath = path + ".gateway-lease";
  let lease = await readLease(leasePath);
  const owned = (value: Entry) => privateSocket(value) && String(value.ino) === lease.inode && String(value.dev) === lease.device;
  if (!owned(info)) lease = await repairInterruptedSwap(leasePath, lease, info) ?? lease;
  if (!owned(info) || typeof lease.boundPath !== "string" || dirname(lease.boundPath) !== dirname(path) || !lease.boundPath.split("/").at(-1)?.startsWith(".gw-")) throw new Error("SSH socket belongs to another listener; it was not replaced");
  const live = await accepts(path);
  if (live) {
    // A listener keeps running the release it bound with, so a live listener on another
    // release would pin every reconnect to it, and a bootstrap on the installed release must
    // retire it. Only the decision happens here: the alias is swapped by an atomic rename at
    // bind time, inside serveUnix's publish lock, so a bootstrap that fails its preparation
    // leaves this listener serving. A name outside the shared pattern can never match a lease,
    // so it must not replace either.
    if (state && state.installed === state.running && releasePattern.test(state.running) && lease.release !== state.running) {
      return { reused: false, replace: { from: lease.release ?? "unknown", to: state.running, inode: lease.inode, device: lease.device } };
    }
    return { reused: true };
  }
  const current = await lstat(path, { bigint: true }).catch(() => undefined);
  if (!current || !owned(current)) throw new Error("SSH socket changed during recovery; retry the connection");
  await unlink(path);
  const bound = await lstat(lease.boundPath, { bigint: true }).catch(() => undefined);
  if (bound && owned(bound)) await unlink(lease.boundPath);
  return { reused: false };
}

/**
 * Undo a swap that was interrupted between writing the new record and renaming the staged alias
 * into place (the bootstrap was killed, or could not put the old record back). The alias is still
 * the previous listener's while the record names the dead new one, so no listener would ever pass
 * the ownership check. The evidence is the record's `previous` matching the alias, plus the new
 * listener's staged link still on disk. Runs under the lease lock the caller holds. Returns the
 * record that is in force again, or nothing when this is not that state.
 */
async function repairInterruptedSwap(leasePath: string, lease: Lease, alias: Entry): Promise<Lease | undefined> {
  const { previous, boundPath } = lease;
  if (!previous || !isBoundPath(boundPath, dirname(leasePath)) || !privateSocket(alias) || String(alias.ino) !== previous.inode || String(alias.dev) !== previous.device) return undefined;
  const staged = await lstat(boundPath + ".alias", { bigint: true }).catch(() => undefined);
  if (!staged || !privateSocket(staged) || String(staged.ino) !== lease.inode || String(staged.dev) !== lease.device) return undefined;
  // The record goes back first, so the state is consistent again before anything is removed.
  await writePrivateJson(leasePath, previous);
  await unlink(boundPath + ".alias").catch(() => {});
  // Only a dead socket of ours is removed; one that still answers is never touched.
  const bound = await lstat(boundPath, { bigint: true }).catch(() => undefined);
  if (bound && privateSocket(bound) && await accepts(boundPath).then(answers => !answers, () => false)) await unlink(boundPath).catch(() => {});
  return { ...previous };
}

/**
 * Remove what crashed bootstraps left beside the alias: `.gw-<hex>` bound sockets and
 * `.gw-<hex>.alias` staged links. Call it under the lease lock. An entry goes only when it is a
 * private socket of ours, is not the current alias's inode, and its `.gw-<hex>` socket is missing
 * or refuses connections. A live listener's socket is never removed. The `.alias` name is never
 * connected to (it can exceed the socket path limit); its bound socket decides. `keep` names
 * entries to skip, such as the caller's own bound socket. It also removes the temporary files
 * a record write left beside this alias (`<alias>.gateway-lease.<16 hex>.tmp`): every writer of
 * one holds the same lock, so none is in use. Only regular files of ours go, never a symlink.
 * Best effort: anything it cannot judge stays.
 */
export async function sweepSshLeftovers(path: string, keep: readonly string[] = []): Promise<void> {
  const folder = dirname(path);
  const current = await lstat(path, { bigint: true }).catch(() => undefined);
  const temporary = new RegExp(`^${basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.gateway-lease\\.[0-9a-f]{16}\\.tmp$`);
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (temporary.test(name)) {
      const file = await lstat(resolve(folder, name), { bigint: true }).catch(() => undefined);
      if (file?.isFile() && file.uid === BigInt(process.getuid!())) await unlink(resolve(folder, name)).catch(() => {});
      continue;
    }
    if (!/^\.gw-[0-9a-f]{12}(\.alias)?$/.test(name) || keep.includes(name)) continue;
    const entry = resolve(folder, name);
    const info = await lstat(entry, { bigint: true }).catch(() => undefined);
    if (!info || !privateSocket(info) || (info.mode & 0o777n) !== 0o600n) continue;
    if (current && info.ino === current.ino && info.dev === current.dev) continue;
    const bound = name.endsWith(".alias") ? resolve(folder, name.slice(0, -6)) : entry;
    const owner = bound === entry ? info : await lstat(bound, { bigint: true }).catch(() => undefined);
    if (owner && (!privateSocket(owner) || await accepts(bound).catch(() => true))) continue;
    await unlink(entry).catch(() => {});
  }
}
