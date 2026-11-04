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
import { bootIdentity, fromPreviousBoot, processAlive } from "./boot-identity.js";
import { socketAnswers } from "./execution-host-storage.js";

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
export interface SshLeasePrevious { inode: string; device: string; boundPath: string; release?: string; bootId?: string; pid?: number; startedAtMs?: number }

/** The listener to retire at bind time: the releases on either side of the swap and the
 * inode/device the public alias had when the decision was made. */
export interface SshSocketReplacement { from: string; to: string; inode: string; device: string }

/** A bound socket's name: `.gw-` and twelve hex digits, in the alias's own folder. */
const boundName = /^\.gw-[0-9a-f]{12}$/;
const isBoundPath = (value: unknown, folder: string): value is string => typeof value === "string" && dirname(value) === folder && boundName.test(value.split("/").at(-1) ?? "");
const bootIdPattern = /^[0-9a-fA-F][0-9a-fA-F-]{6,63}$/;
interface WriterStamp { bootId?: string; pid?: number; startedAtMs?: number }
/** The boot and writer a lease was stamped with; undefined when a field has the wrong shape. Leases written before 0.7.7 carry none. */
function stampOf(value: Record<string, unknown>): WriterStamp | undefined {
  const { bootId, pid, startedAtMs } = value;
  if (bootId !== undefined && !(typeof bootId === "string" && bootIdPattern.test(bootId))) return undefined;
  if (pid !== undefined && !(Number.isSafeInteger(pid) && (pid as number) > 0)) return undefined;
  if (startedAtMs !== undefined && !(Number.isSafeInteger(startedAtMs) && (startedAtMs as number) >= 0)) return undefined;
  // The writer's own order (see `serveUnix`), so a record restored from `previous` is the old text again, byte for byte.
  return { ...(bootId !== undefined ? { bootId: bootId as string } : {}), ...(startedAtMs !== undefined ? { startedAtMs: startedAtMs as number } : {}), ...(pid !== undefined ? { pid: pid as number } : {}) };
}

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
  const stamp = stampOf(value as Record<string, unknown>);
  if (!stamp) return undefined;
  return { inode, device, boundPath, ...(typeof release === "string" ? { release } : {}), ...stamp };
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

/** `mtimeMs` is the later of the record file's modification and change time, the only age a record without a boot stamp has. */
interface Lease extends WriterStamp { inode: string; device: string; boundPath?: string; release?: string; previous?: SshLeasePrevious; mtimeMs: number; drifted?: boolean }

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
  const stamp = stampOf(parsed);
  if (!stamp) throw new Error("SSH socket ownership record is invalid");
  // `previous` is optional, and a malformed one is ignored: it only ever enables a repair.
  return { inode: parsed.inode, device: parsed.device, boundPath: typeof parsed.boundPath === "string" ? parsed.boundPath : undefined,
    release: parsed.release as string | undefined, previous: readPrevious(parsed.previous, dirname(leasePath)), ...stamp, mtimeMs: Math.max(file.mtimeMs, file.ctimeMs) };
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

/** The listener that owns the alias at a socket path: its release and the writer stamp it bound with. */
export interface SshListenerOwner { release?: string; pid?: number; startedAtMs?: number }
/**
 * Who serves the socket at `path` now, from its ownership record, but only when that record describes the alias as it is
 * (same private socket, inode and device). Anything else, including a swap in progress, is undefined. Never changes anything.
 */
export async function sshListenerOwner(path: string): Promise<SshListenerOwner | undefined> {
  try {
    const info = await lstat(path, { bigint: true });
    const lease = await readLease(path + ".gateway-lease");
    if (!privateSocket(info) || String(info.ino) !== lease.inode || String(info.dev) !== lease.device) return undefined;
    return { ...(lease.release !== undefined ? { release: lease.release } : {}), ...(lease.pid !== undefined ? { pid: lease.pid } : {}),
      ...(lease.startedAtMs !== undefined ? { startedAtMs: lease.startedAtMs } : {}) };
  } catch { return undefined; }
}

async function inspectSshSocket(path: string, state: ReleaseState | undefined): Promise<SshSocketReuse> {
  const info = await lstat(path, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return { reused: false };
  const leasePath = path + ".gateway-lease";
  let lease = await readLease(leasePath);
  const owned = (value: Entry) => privateSocket(value) && String(value.ino) === lease.inode && String(value.dev) === lease.device;
  if (!owned(info)) lease = await repairInterruptedSwap(leasePath, lease, info) ?? lease;
  // A repair that had to accept a rebooted device number left the previous owner's record in force with the device now in use:
  // that owner is gone with the boot, and its alias is removed like any proven-drifted one (listener probe and frozen recheck).
  if (lease.drifted) return removeDriftedSocket(path, lease, info);
  if (!owned(info)) {
    // The same socket under another device number is a reboot's doing, but only a proven earlier boot may say so.
    if (!await provenDeviceDrift(path, lease, info)) throw new Error("SSH socket belongs to another listener; it was not replaced");
    return removeDriftedSocket(path, lease, info);
  }
  if (typeof lease.boundPath !== "string" || dirname(lease.boundPath) !== dirname(path) || !lease.boundPath.split("/").at(-1)?.startsWith(".gw-")) throw new Error("SSH socket belongs to another listener; it was not replaced");
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
 * macOS can number the same filesystem differently after a reboot, so the recorded device no longer matches a socket whose
 * inode is unchanged. That is recoverable only when every one of these holds: the alias is a private socket of ours with the
 * recorded inode and another device; the record names this folder's exact managed bound socket (`.gw-` and twelve hex
 * digits); the folder is private and ours; a bound socket that still exists is the same link as the alias; and the record
 * was written in an earlier boot. A stamped record proves that by its boot id. An older record has no stamp, so the
 * latest modification or change time of the record and of the sockets must predate the current boot by the usual grace
 * (an assumption: a clock that stepped forward could make a live record look old, which is why a stamped writer's pid
 * that still runs, or a listener that answers, always keeps the alias).
 */
async function provenDeviceDrift(path: string, lease: Lease, alias: Entry): Promise<boolean> {
  const folder = dirname(path);
  if (!privateSocket(alias) || String(alias.ino) !== lease.inode || String(alias.dev) === lease.device || !isBoundPath(lease.boundPath, folder)) return false;
  if (!await privateFolder(folder)) return false;
  const bound = await lstat(lease.boundPath, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (bound && (!privateSocket(bound) || bound.ino !== alias.ino || bound.dev !== alias.dev)) return false;
  return writtenInEarlierBoot(lease, [alias, bound]);
}

/** A folder that is ours alone, reached without a link. */
async function privateFolder(folder: string): Promise<boolean> {
  const parent = await lstat(folder).catch(() => undefined);
  return !!parent && parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid!() && !(parent.mode & 0o077);
}

/** Whether the record, with the sockets it names, was written before the current boot (see `provenDeviceDrift` for the rule and its assumption). */
async function writtenInEarlierBoot(lease: Lease, entries: ReadonlyArray<Entry | undefined>): Promise<boolean> {
  const written = Math.max(lease.mtimeMs, ...entries.flatMap(entry => entry ? [Number(entry.mtimeMs), Number(entry.ctimeMs)] : []));
  if (!await fromPreviousBoot(lease.bootId ? { bootId: lease.bootId } : {}, written)) return false;
  const provenById = lease.bootId !== undefined && (await bootIdentity()).id !== undefined;
  if (!provenById && lease.pid !== undefined && await processAlive({ pid: lease.pid, ...(lease.startedAtMs !== undefined ? { startedAtMs: lease.startedAtMs } : {}) })) return false;
  return true;
}

/**
 * Removes a proven-drifted alias and its bound link. A listener that answers (the probe asks again after a refusal, and an
 * unknown answer counts as a listener) keeps both. The identity observed now is frozen, and checked again just before the
 * removal, so a path replaced while the probe waited is never touched.
 */
async function removeDriftedSocket(path: string, lease: Lease, frozen: Entry): Promise<SshSocketReuse> {
  const boundPath = lease.boundPath as string; const folder = dirname(path);
  if (await socketAnswers(path)) throw new Error("SSH socket is served by a live listener; it was not replaced");
  const same = (value?: Entry) => !!value && privateSocket(value) && value.ino === frozen.ino && value.dev === frozen.dev;
  // The folder and both links are looked at again immediately before each removal, so nothing replaced while the probe
  // waited (or between the two removals) is ever unlinked.
  const recheck = async () => {
    const parent = await lstat(folder).catch(() => undefined);
    if (!parent || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid!() || (parent.mode & 0o077)) throw new Error("SSH socket changed during recovery; retry the connection");
    const current = await lstat(path, { bigint: true }).catch(() => undefined);
    const bound = await lstat(boundPath, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!same(current) || (bound && !same(bound))) throw new Error("SSH socket changed during recovery; retry the connection");
  };
  await recheck();
  await unlink(path);
  const bound = await lstat(boundPath, { bigint: true }).catch(() => undefined);
  if (same(bound)) await unlink(boundPath).catch(() => {});
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
  if (!previous || !isBoundPath(boundPath, dirname(leasePath)) || !privateSocket(alias) || String(alias.ino) !== previous.inode) return undefined;
  const staged = await lstat(boundPath + ".alias", { bigint: true }).catch(() => undefined);
  if (!staged || !privateSocket(staged) || String(staged.ino) !== lease.inode) return undefined;
  // A reboot renumbers the device of both links at once. That is accepted only when both moved to the same new number, the
  // folder is private, the new bound socket (if it exists) is the staged link, and the record is proven to predate this boot.
  const aliasMoved = String(alias.dev) !== previous.device; const stagedMoved = String(staged.dev) !== lease.device;
  if (aliasMoved !== stagedMoved) return undefined;
  let bound = await lstat(boundPath, { bigint: true }).catch(() => undefined);
  if (aliasMoved) {
    if (alias.dev !== staged.dev || !await privateFolder(dirname(leasePath))) return undefined;
    if (bound && (!privateSocket(bound) || bound.ino !== staged.ino || bound.dev !== staged.dev)) return undefined;
    if (!await writtenInEarlierBoot(lease, [alias, staged, bound])) return undefined;
  }
  // The record goes back first, so the state is consistent again before anything is removed. A rebooted device number is
  // written as the one now in use; the previous owner's boot stamp is kept as it was.
  const restored: SshLeasePrevious = aliasMoved ? { ...previous, device: String(alias.dev) } : previous;
  await writePrivateJson(leasePath, restored);
  // Each removal is preceded by a look at the identity observed earlier, so a link replaced while something awaited is kept.
  const unchanged = async (name: string, frozen: Entry) => {
    const now = await lstat(name, { bigint: true }).catch(() => undefined);
    return !!now && privateSocket(now) && now.ino === frozen.ino && now.dev === frozen.dev;
  };
  if (await unchanged(boundPath + ".alias", staged)) await unlink(boundPath + ".alias").catch(() => {});
  // Only a dead socket of ours is removed; one that still answers is never touched. The socket observed before the probe
  // is frozen and must still be the one at that path when the removal comes.
  bound = await lstat(boundPath, { bigint: true }).catch(() => undefined);
  if (bound && privateSocket(bound) && await (aliasMoved ? socketAnswers(boundPath) : accepts(boundPath)).then(answers => !answers, () => false)
    && await unchanged(boundPath, bound)) await unlink(boundPath).catch(() => {});
  // Nothing here knows when the restored owner started, so a record without its own stamp stays out of the age rule.
  return { ...restored, mtimeMs: Number.POSITIVE_INFINITY, ...(aliasMoved ? { drifted: true } : {}) };
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
