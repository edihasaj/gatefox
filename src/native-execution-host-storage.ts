import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { archiveStaleReceipt, executionHostRoot, lenientRecord, linkAnswers, privateDirectory, readLenientJson, receiptPidAlive, removeOwnedSocket, sdkIdentity, type EngineOwner, type HostIdentity, type OwnerReclaim, type ReceiptOwner, type SocketIdentity } from "./execution-host-storage.js";
import { testSafeRoot } from "./test-root-guard.js";
import { fromPreviousBoot, ownerStamp, spawnStamp } from "./boot-identity.js";

const marker = "subscription-gateway-native-execution-owner";
export interface NativeHomeOwner {
  version: 1; managed: typeof marker; configPath: string; nativeHome: string; codex: string; sdkSha256: string;
  hostPid: number; pid: number; socketPath: string; state: "running" | "stopped"; revision?: string; socket?: SocketIdentity;
  sdkState: "idle" | "starting" | "running" | "exited" | "stopped"; nativeSdkExecutable?: string; nativeSdkSha256?: string;
  bootId?: string; startedAtMs?: number; sdkBootId?: string; sdkStartedAtMs?: number;
  /**
   * Present only while desktop adapters' private native engines hold the home (see `claimPrivateNativeHome`). `shared` marks
   * the `owner.json` this release keeps for older releases while its private engines share the home; an `owner.json` with a
   * private owner and no `shared` is the private engine of release 0.4.5 or earlier, which holds the home alone.
   */
  privateOwner?: { instanceId: string; shared?: true; previous?: NativeHomeOwner; previousMtimeMs?: number };
}
let nativeOwnerRootOverride: string | undefined;
/** Tests keep native-home receipts in a folder of their own; production never calls it. Undefined restores the real root. */
export function setNativeOwnerRootForTests(root?: string): void { nativeOwnerRootOverride = root ? resolve(root) : undefined; }
export function nativeHomeOwnerPath(nativeHome: string): string {
  let canonical: string; try { canonical = realpathSync(nativeHome); } catch { canonical = resolve(nativeHome); }
  const scope = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return resolve(nativeOwnerRootOverride ?? testSafeRoot(resolve(homedir(), ".local/state/gw-native"), "native-home receipt root"), scope, "owner.json");
}
/** writePrivateJson replaces the receipt by atomic rename, so a reader can see two inodes across lstat and open. */
const replacedDuringRead = Symbol("native-owner-replaced");
const replacementRetries = 8;
export async function readNativeHomeOwner(nativeHome: string): Promise<NativeHomeOwner | undefined> {
  return readReceipt(nativeHomeOwnerPath(nativeHome));
}
/** One receipt of a native home's folder: its `owner.json` (the default), or a private engine's receipt beside it. */
async function readReceipt(path: string, ownerPath = path): Promise<NativeHomeOwner | undefined> {
  for (let attempt = 0; attempt < replacementRetries; attempt++) {
    const owner = await readReceiptOnce(path, ownerPath);
    if (owner !== replacedDuringRead) return owner;
    await new Promise(done => setTimeout(done, attempt));
  }
  throw new Error("Native execution ownership receipt is invalid");
}
async function readReceiptOnce(path: string, ownerPath: string): Promise<NativeHomeOwner | undefined | typeof replacedDuringRead> {
  let file;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 16384) throw new Error("Native execution ownership receipt is invalid");
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
    const opened = await file.stat();
    if (opened.isFile() && (opened.ino !== info.ino || opened.dev !== info.dev)) return replacedDuringRead;
    if (!opened.isFile() || opened.uid !== process.getuid?.() || (opened.mode & 0o077) || opened.size > 16384) throw new Error("Native execution ownership receipt is invalid");
    const bytes = Buffer.alloc(16385); let size = 0;
    while (size < bytes.length) { const part = await file.read(bytes, size, bytes.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size > 16384) throw new Error("Native execution ownership receipt is invalid");
    const owner: NativeHomeOwner = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes.subarray(0, size)));
    validateOwner(owner, ownerPath);
    // A private lease carries the receipt it replaced; it is validated by the same rules, one level deep.
    if (owner.privateOwner !== undefined) {
      const mark = owner.privateOwner as unknown;
      if (!mark || typeof mark !== "object" || typeof owner.privateOwner.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(owner.privateOwner.instanceId)) throw new Error("Native execution ownership receipt is invalid");
      if (owner.privateOwner.shared !== undefined && owner.privateOwner.shared !== true) throw new Error("Native execution ownership receipt is invalid");
      if (owner.privateOwner.previous !== undefined) { validateOwner(owner.privateOwner.previous, ownerPath); if (owner.privateOwner.previous.privateOwner !== undefined) throw new Error("Native execution ownership receipt is invalid"); }
      const time = owner.privateOwner.previousMtimeMs;
      if (time !== undefined && (!Number.isSafeInteger(time) || time < 0 || owner.privateOwner.previous === undefined)) throw new Error("Native execution ownership receipt is invalid");
    }
    // A private engine's own receipt is named by its lease and holds nothing else: the receipt to put back stays in owner.json.
    if (path !== ownerPath && (owner.privateOwner === undefined || owner.privateOwner.shared !== undefined || owner.privateOwner.previous !== undefined || !path.endsWith(`-${owner.privateOwner.instanceId}.json`))) throw new Error("Native execution ownership receipt is invalid");
    return owner;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Native execution ownership receipt is invalid"); }
  finally { await file?.close(); }
}
function validateOwner(owner: NativeHomeOwner, path: string): void {
  if (!owner || typeof owner !== "object" || owner.version !== 1 || owner.managed !== marker || typeof owner.nativeHome !== "string" || nativeHomeOwnerPath(owner.nativeHome) !== path || !["running", "stopped"].includes(owner.state) ||
    !Number.isSafeInteger(owner.hostPid) || owner.hostPid < 0 || !Number.isSafeInteger(owner.pid) || owner.pid < 0 ||
    ![owner.configPath, owner.codex, owner.socketPath].every(value => typeof value === "string" && value.startsWith("/") && !value.includes("\0")) ||
    typeof owner.sdkSha256 !== "string" || !/^[a-f0-9]{64}$/.test(owner.sdkSha256) || owner.revision !== undefined && !/^[a-f0-9]{64}$/.test(owner.revision)) throw new Error("Native execution ownership receipt is invalid");
  if (!["idle", "starting", "running", "exited", "stopped"].includes(owner.sdkState)) throw new Error("Native execution ownership receipt is invalid");
  if (owner.bootId !== undefined && typeof owner.bootId !== "string" || owner.sdkBootId !== undefined && typeof owner.sdkBootId !== "string"
    || [owner.startedAtMs, owner.sdkStartedAtMs].some(value => value !== undefined && (!Number.isSafeInteger(value) || value! < 0))) throw new Error("Native execution ownership receipt is invalid");
  if ((owner.nativeSdkExecutable === undefined) !== (owner.nativeSdkSha256 === undefined) || owner.nativeSdkExecutable !== undefined &&
    (typeof owner.nativeSdkExecutable !== "string" || !owner.nativeSdkExecutable.startsWith("/") || !/^[a-f0-9]{64}$/.test(owner.nativeSdkSha256!))) throw new Error("Native execution SDK identity is invalid");
}

/** The receipt plus the file time a bootless receipt needs for its previous-boot comparison. */
export async function readNativeHomeOwnerRecord(nativeHome: string): Promise<{ owner?: NativeHomeOwner; mtimeMs: number; invalid: boolean }> {
  return readRecordAt(nativeHomeOwnerPath(nativeHome));
}
async function readRecordAt(path: string): Promise<{ owner?: NativeHomeOwner; mtimeMs: number; invalid: boolean }> {
  const mtimeMs = await stat(path).then(info => info.mtimeMs, error => (error as NodeJS.ErrnoException).code === "ENOENT" ? Number.POSITIVE_INFINITY : (() => { throw error; })());
  if (mtimeMs === Number.POSITIVE_INFINITY) return { mtimeMs, invalid: false };
  try { return { owner: await readReceipt(path), mtimeMs, invalid: false }; }
  catch { return { mtimeMs, invalid: true }; }
}
/** A host that died after publishing "starting" may have left an SDK child still coming up; it gets this long to show itself. */
const defaultStartupGraceMs = 60_000;
let startupGraceMs = defaultStartupGraceMs;
/** Tests shorten the startup grace instead of waiting it out. Undefined restores the production value. */
export function setNativeStartupGraceForTests(ms?: number): void { startupGraceMs = ms ?? defaultStartupGraceMs; }
/**
 * A receipt that names no process at all, written this boot, is given up after this long once nothing answers: the native
 * SDK always listens while it runs, so ten quiet minutes prove its writer gone without waiting for a reboot.
 */
const defaultNamelessGraceMs = 10 * 60_000;
let namelessGraceMs = defaultNamelessGraceMs;
/** Tests shorten the grace for a receipt that names nothing. Undefined restores the production value. */
export function setNativeNamelessGraceForTests(ms?: number): void { namelessGraceMs = ms ?? defaultNamelessGraceMs; }
/**
 * What an existing receipt means for a new claim: "live" while a recorded process or an answering socket can still own the
 * home, "unconfirmed" while a launch it recorded cannot be proven absent, or the reason the owner is gone.
 */
export type NativeLiveness = "live" | "unconfirmed" | OwnerReclaim;
async function nativeOwnerLiveness(owner: NativeHomeOwner, mtimeMs: number): Promise<NativeLiveness> {
  const previous = await fromPreviousBoot({ ...(owner.bootId ? { bootId: owner.bootId } : {}) }, mtimeMs);
  if (!previous) {
    if (await receiptPidAlive({ pid: owner.hostPid, bootId: owner.bootId, startedAtMs: owner.startedAtMs }, mtimeMs)) return "live";
    if (await receiptPidAlive({ pid: owner.pid, ...(owner.sdkBootId ? { bootId: owner.sdkBootId } : {}), ...(owner.sdkStartedAtMs !== undefined ? { startedAtMs: owner.sdkStartedAtMs } : {}) }, mtimeMs)) return "live";
  }
  // A host that died between publishing "starting" and recording the SDK child may have left a child that is still starting.
  const starting = !previous && owner.state === "running" && owner.sdkState === "starting";
  // Even a receipt from an earlier boot is kept while its socket answers: something this boot is serving there.
  if (await linkAnswers(owner.socketPath)) return starting ? "unconfirmed" : "live";
  if (previous) return "previous_boot";
  if (starting && !(Date.now() - mtimeMs >= startupGraceMs)) return "unconfirmed";
  return "dead_pids";
}
/** Every host home on this machine, so a receipt that names none can still be protected by the one that is live. */
async function hostHomes(): Promise<string[]> {
  const root = executionHostRoot();
  const names = await readdir(root).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error; });
  return names.filter(name => /^[0-9a-f]{16}$/.test(name)).sort().slice(0, 4096).map(name => resolve(root, name));
}
/**
 * A receipt this release cannot validate (a newer release's, or a damaged one) is judged by whatever it still says. Any pid
 * it names that can still be its own, or its recorded socket, or the native socket of any host home answering, keeps it. A
 * receipt that names no process is given up once nothing answers and it is from an earlier boot or older than ten minutes;
 * the grace only follows the socket probes, so it never outweighs a live pid or an answering socket.
 */
async function invalidNativeLiveness(path: string, mtimeMs: number, hostHome?: string): Promise<NativeLiveness> {
  const body = await readLenientJson(path);
  const records = body ? [lenientRecord(body, "hostPid"), lenientRecord(body, "pid", "sdkBootId", "sdkStartedAtMs")].filter((record): record is ReceiptOwner => !!record) : [];
  const parsed = !!body && (Number.isSafeInteger(body.hostPid) || Number.isSafeInteger(body.pid));
  const previous = await fromPreviousBoot(typeof body?.bootId === "string" ? { bootId: body.bootId } : {}, mtimeMs);
  if (!previous) for (const record of records) if (await receiptPidAlive(record, mtimeMs)) return "live";
  const links = new Set<string>();
  if (typeof body?.socketPath === "string" && body.socketPath.startsWith("/") && !body.socketPath.includes("\0") && Buffer.byteLength(body.socketPath) < 1024) links.add(resolve(body.socketPath));
  if (hostHome) links.add(resolve(hostHome, "native.sock"));
  for (const home of await hostHomes()) links.add(resolve(home, "native.sock"));
  for (const link of links) if (await linkAnswers(link)) return "live";
  if (previous) return "previous_boot";
  if (!parsed) return Date.now() - mtimeMs >= namelessGraceMs ? "invalid_receipt" : "unconfirmed";
  if (body?.state === "running" && body.sdkState === "starting" && Date.now() - mtimeMs < startupGraceMs) return "unconfirmed";
  return "invalid_receipt";
}
/**
 * Private engines of this release share a native home with each other and never with the host's writer. Each holds a
 * receipt of its own, `private-<adapter pid>-<lease id>.json` beside `owner.json`, judged by the same liveness rules as
 * `owner.json` (boot, pid and start of the adapter and of its engine, the startup grace, the native socket). Older
 * releases read only `owner.json`, so while any private engine holds the home this release keeps a marker there that names
 * them (see `markerFor`), and puts back the receipt the first one replaced once the last one has gone.
 */
const holderFile = /^private-[0-9]{1,10}-[a-f0-9-]{36}\.json$/;
const holderLimit = 256;
interface Holder { path: string; owner?: NativeHomeOwner; verdict: NativeLiveness }
const holds = (verdict: NativeLiveness | "absent"): boolean => verdict === "live" || verdict === "unconfirmed";
/** Refuses a host's claim while an owner may still write the home, with the messages its failure classifier knows. */
function refuseHeld(verdict: NativeLiveness): void {
  if (verdict === "live") throw new Error("A native execution owner already owns this native home; its chats were preserved");
  if (verdict === "unconfirmed") throw new Error("Native execution launch is unconfirmed; existing ownership was preserved");
}
/** Every private engine's receipt beside `owner.json`, each with the verdict a claim gives it; one it cannot read is judged as an invalid receipt. */
async function privateHolders(ownerPath: string, hostHome?: string): Promise<Holder[]> {
  const folder = dirname(ownerPath);
  const names = (await readdir(folder).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error; })).filter(name => holderFile.test(name)).sort();
  if (names.length > holderLimit) throw new Error("Native execution ownership receipt is invalid");
  const holders: Holder[] = [];
  for (const name of names) {
    const path = resolve(folder, name);
    const mtimeMs = await lstat(path).then(info => info.mtimeMs, error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
    if (mtimeMs === undefined) continue; // Released meanwhile.
    let owner: NativeHomeOwner | undefined; let invalid = false;
    try { owner = await readReceipt(path, ownerPath); } catch { invalid = true; }
    if (owner) holders.push({ path, owner, verdict: await nativeOwnerLiveness(owner, mtimeMs) });
    else if (invalid) holders.push({ path, verdict: await invalidNativeLiveness(path, mtimeMs, hostHome) });
  }
  return holders;
}
/**
 * A dead private engine's receipt goes to `stale/` as a dead `owner.json` does. It takes one shared name on the way, so the
 * archive keeps the newest five of all of them rather than five per lease, and that name is cleared once archived (the
 * archive copies a plain receipt and leaves it in place); one a crash left between the steps goes first.
 */
async function archiveHolder(holder: Holder): Promise<void> {
  const pending = resolve(dirname(holder.path), "private.json"); const reason = holder.verdict as OwnerReclaim;
  const archive = async () => {
    await archiveStaleReceipt(pending, "native_home", reason);
    await unlink(pending).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  };
  await archive();
  try { await rename(holder.path, pending); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  await archive();
}
/** How many private engines hold the native home right now: live, or a launch still inside its startup grace. */
export async function privateNativeHolders(nativeHome: string, hostHome?: string): Promise<number> {
  return (await privateHolders(nativeHomeOwnerPath(nativeHome), hostHome)).filter(holder => holds(holder.verdict)).length;
}
/** The receipt fields that say which engine owns a home; a private lease keeps those of the receipt it replaced. */
const identityKeys = ["codex", "sdkSha256", "nativeSdkExecutable", "nativeSdkSha256", "revision", "socket"] as const;
type EngineFields = Pick<NativeHomeOwner, "codex" | "sdkSha256"> & Partial<Pick<NativeHomeOwner, typeof identityKeys[number]>>;
const engineFields = (receipt: NativeHomeOwner): EngineFields => Object.fromEntries(identityKeys.filter(key => receipt[key] !== undefined).map(key => [key, receipt[key]])) as EngineFields;
interface MarkerBase { previous?: NativeHomeOwner; previousMtimeMs?: number; engine: EngineFields }
/**
 * The `owner.json` this release keeps for older releases while its private engines share the home. Releases 0.4.5 and
 * earlier read only that file and keep out while either process it names lives, so a single holder is named by its adapter
 * and its engine, exactly as their own private receipt is, and two or more by the two longest-running ones, one process
 * each: the engine once it runs, the adapter before. It is rewritten whenever a holder comes, starts its engine or goes, and
 * each lease looks again every 45 seconds, so holders that crashed are replaced by live ones.
 */
function markerFor(holders: NativeHomeOwner[], base: MarkerBase): NativeHomeOwner {
  const [first, second] = [...holders].sort((a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0) || a.privateOwner!.instanceId.localeCompare(b.privateOwner!.instanceId));
  const adapter = (holder: NativeHomeOwner) => ({ pid: holder.hostPid, bootId: holder.bootId, startedAtMs: holder.startedAtMs });
  const engine = (holder: NativeHomeOwner) => ({ pid: holder.pid, bootId: holder.sdkBootId, startedAtMs: holder.sdkStartedAtMs });
  const writer = (holder: NativeHomeOwner) => holder.pid > 0 ? engine(holder) : adapter(holder);
  const [one, two] = second ? [writer(first), writer(second)] : [adapter(first), engine(first)];
  return { ...base.engine, version: 1, managed: marker, configPath: first.configPath, nativeHome: first.nativeHome, socketPath: first.socketPath,
    hostPid: one.pid, ...(one.bootId ? { bootId: one.bootId } : {}), ...(one.startedAtMs !== undefined ? { startedAtMs: one.startedAtMs } : {}),
    pid: two.pid, ...(two.bootId ? { sdkBootId: two.bootId } : {}), ...(two.startedAtMs !== undefined ? { sdkStartedAtMs: two.startedAtMs } : {}),
    state: "running", sdkState: [first, second].some(holder => holder?.sdkState === "starting") ? "starting" : "running",
    privateOwner: { instanceId: first.privateOwner!.instanceId, shared: true, ...(base.previous ? { previous: base.previous, ...(base.previousMtimeMs !== undefined ? { previousMtimeMs: base.previousMtimeMs } : {}) } : {}) } };
}
/**
 * Puts back the receipt a marker kept, with its file time, set before the atomic rename (a receipt without a boot stamp is
 * judged by it, so it never shows the restored contents with the current time), or removes the file when it kept none.
 */
async function restorePrevious(path: string, mark: NativeHomeOwner): Promise<void> {
  const previous = mark.privateOwner?.previous; const time = mark.privateOwner?.previousMtimeMs;
  if (previous) await writePrivateJson(path, previous, time !== undefined ? { mtimeMs: time } : {});
  else await unlink(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
}
/**
 * Brings `owner.json` in line with the private engines that hold the home now; the caller holds its lock. Dead holders are
 * archived, the marker names the live ones, and once none is left the receipt the first one replaced comes back. A receipt
 * this release did not write for its private engines (an older release's private engine, or one it cannot read) is never
 * rewritten, and a stopped or dead host receipt is kept inside the marker as the one to put back.
 */
async function syncPrivateMarker(path: string, hostHome: string): Promise<void> {
  const holders = await privateHolders(path, hostHome);
  for (const holder of holders) if (!holds(holder.verdict)) await archiveHolder(holder);
  const live = holders.filter(holder => holds(holder.verdict)); const named = live.flatMap(holder => holder.owner ? [holder.owner] : []);
  const stored = await readRecordAt(path); const current = stored.owner;
  if (stored.invalid || current?.privateOwner && !current.privateOwner.shared) return;
  if (!named.length) { if (current?.privateOwner && !live.length) await restorePrevious(path, current); return; }
  if (current && !current.privateOwner) {
    if (holds(await nativeOwnerLiveness(current, stored.mtimeMs))) return;
    await writePrivateJson(path, markerFor(named, { previous: current, previousMtimeMs: Math.floor(stored.mtimeMs), engine: engineFields(current) })); return;
  }
  const kept = current?.privateOwner?.previous ? { previous: current.privateOwner.previous, previousMtimeMs: current.privateOwner.previousMtimeMs } : {};
  const next = markerFor(named, { ...kept, engine: engineFields(current ?? named[0]) });
  if (!current || JSON.stringify(current) !== JSON.stringify(next)) await writePrivateJson(path, next); // Unchanged, it is left as it is.
}
/**
 * Whether a native home has an owner that keeps a private engine out, by the rule a new claim follows: "absent" without a
 * receipt, "live" or "unconfirmed" while nobody else may write it, or why its last owner is gone. Private native writers
 * obey it too. Private engines of this release share the home, so while any of them may still run, the marker they keep in
 * `owner.json` reads as "absent" here: it keeps no other private engine out, and rollback, which waits for a stopped
 * receipt, still waits. Anything answering at the host's native socket still reads as "live". The host's own claim checks
 * every private receipt itself.
 */
export async function nativeHomeOwnership(nativeHome: string, hostHome?: string): Promise<"absent" | NativeLiveness> {
  const path = nativeHomeOwnerPath(nativeHome); const stored = await readNativeHomeOwnerRecord(nativeHome);
  if (stored.invalid) return invalidNativeLiveness(path, stored.mtimeMs, hostHome);
  if (!stored.owner) return "absent";
  const verdict = await nativeOwnerLiveness(stored.owner, stored.mtimeMs);
  if (stored.owner.privateOwner?.shared) {
    // Something answering at the host's native socket is a writer no private engine may join, whatever the marker says.
    if (await linkAnswers(stored.owner.socketPath)) return "live";
    if (holds(verdict) || (await privateHolders(path, hostHome)).some(holder => holds(holder.verdict))) return "absent";
  }
  return verdict;
}
/**
 * One native home cannot be shared through two different managed host configs, and the host's writer never shares it
 * with a private engine: any private receipt that may still be live refuses the claim, and dead ones are archived first.
 */
export async function claimNativeHome(identity: HostIdentity, hostHome: string): Promise<NativeHomeLease> {
  const path = nativeHomeOwnerPath(identity.nativeHome); await privateDirectory(dirname(path));
  const socketPath = resolve(hostHome, "native.sock");
  const owner: NativeHomeOwner = { version: 1, managed: marker, configPath: identity.configPath, nativeHome: identity.nativeHome,
    codex: identity.codex, sdkSha256: identity.sdkSha256, hostPid: process.pid, pid: 0, socketPath, state: "running", sdkState: "idle", ...await ownerStamp(),
    ...(identity.nativeSdkExecutable ? { nativeSdkExecutable: identity.nativeSdkExecutable, nativeSdkSha256: identity.nativeSdkSha256 } : {}) };
  await withPrivateFileLock(path, async () => {
    const holders = await privateHolders(path, hostHome);
    for (const holder of holders) refuseHeld(holder.verdict);
    for (const holder of holders) await archiveHolder(holder);
    let stored = await readNativeHomeOwnerRecord(identity.nativeHome);
    if (stored.owner?.privateOwner?.shared) {
      // The marker those engines kept for older releases names their processes, so it is judged as those releases judge it;
      // once it names nothing that runs, the receipt it kept comes back and the claim goes on as if they had never run.
      refuseHeld(await nativeOwnerLiveness(stored.owner, stored.mtimeMs));
      await restorePrevious(path, stored.owner); stored = await readNativeHomeOwnerRecord(identity.nativeHome);
    }
    let reclaim: OwnerReclaim | undefined;
    if (stored.invalid) {
      const verdict = await invalidNativeLiveness(path, stored.mtimeMs, hostHome);
      if (verdict === "live" || verdict === "unconfirmed") throw new Error("Native execution ownership receipt is invalid");
      await removeOwnedSocket(socketPath, undefined, true); reclaim = "invalid_receipt";
    } else if (stored.owner) {
      const previous = stored.owner;
      const dead = await nativeOwnerLiveness(previous, stored.mtimeMs);
      const claimed = previous.state === "running" || previous.hostPid > 0 || previous.pid > 0;
      // A live owner keeps its name whatever the new claim looks like: identities only matter once the owner is gone.
      if (dead === "live") throw new Error("A native execution owner already owns this native home; its chats were preserved");
      if (dead === "unconfirmed") throw new Error("Native execution launch is unconfirmed; existing ownership was preserved");
      if (claimed) {
        // An app update can move or relink its engine: only the native home itself has to match a dead owner.
        for (const key of ["configPath", "nativeHome", "socketPath"] as const) if (previous[key] !== owner[key]) throw new Error("Native execution ownership changed; existing ownership was preserved");
        await removeOwnedSocket(previous.socketPath, previous.socket, true, dead === "previous_boot");
        reclaim = dead;
      } else for (const key of ["configPath", "socketPath"] as const) if (previous[key] !== owner[key]) throw new Error("Native execution ownership changed; existing ownership was preserved");
    }
    if (reclaim) await archiveStaleReceipt(path, "native_home", reclaim);
    await writePrivateJson(path, owner);
  });
  return new NativeHomeLease(path, owner);
}

export class NativeHomeLease {
  constructor(private readonly path: string, private readonly owner: NativeHomeOwner) {}
  async publish(engine?: EngineOwner, stopped = false, sdkState: NativeHomeOwner["sdkState"] = "idle"): Promise<void> {
    await withPrivateFileLock(this.path, async () => {
      const current = await readNativeHomeOwner(this.owner.nativeHome);
      if (!current || current.hostPid !== process.pid || current.configPath !== this.owner.configPath || current.socketPath !== this.owner.socketPath) throw new Error("Native execution ownership changed; existing ownership was preserved");
      if (stopped && engine && await receiptPidAlive(engine, Date.now())) throw new Error("Native execution SDK is still running; its ownership was preserved");
      Object.assign(this.owner, { pid: engine?.pid ?? 0, ...(engine?.bootId ? { sdkBootId: engine.bootId } : {}), ...(engine?.startedAtMs !== undefined ? { sdkStartedAtMs: engine.startedAtMs } : {}),
        ...(engine ? { revision: engine.revision, socket: engine.socket } : {}), state: stopped ? "stopped" : "running", sdkState: stopped ? "stopped" : sdkState, hostPid: stopped ? 0 : process.pid });
      await writePrivateJson(this.path, this.owner);
    });
  }
}

/**
 * The native-home lease a desktop adapter takes before it runs its own native engine, because the shared host stayed down
 * or runs without native sharing. Private engines share the home with each other, as stock Codex runs one app-server for
 * the app and another for an SSH remote on one home, but never with the host's writer: a live or unconfirmed host receipt,
 * a private engine of release 0.4.5 or earlier (which holds the home alone), or anything answering at the host's native socket keeps
 * the lease out, and while any lease may still be live the host's claim is refused. Each lease writes a receipt of its own
 * naming the host's configuration and native socket path, the adapter and (once spawned) the engine, so the host judges it
 * by the usual rules: after a crash it is a dead owner the host or the next lease archives. The receipt `owner.json` held
 * before the first lease is kept in the marker and put back, file time included, when the last lease is released.
 */
/** The refusal of a lease that may only join private engines when none holds the home any more: the host can take it now. */
const nothingToJoinMessage = "No private native engine holds this native home any more, so the gateway host can take it; reconnect to share it. Its chats were preserved.";
export function nothingToJoin(error: unknown): boolean { return (error as { nothingToJoin?: unknown } | undefined)?.nothingToJoin === true; }
/** How a lease writes the marker; tests make it fail, to prove a lease that cannot write it leaves nothing behind. */
const writeMarkerFile = (path: string, marker: NativeHomeOwner): Promise<void> => writePrivateJson(path, marker);
let writeClaimMarker = writeMarkerFile;
/** Tests replace the marker write of a claim. Undefined restores the production one. */
export function setClaimMarkerWriteForTests(write?: typeof writeMarkerFile): void { writeClaimMarker = write ?? writeMarkerFile; }
/**
 * `joinOnly`: the lease may only join private engines that already hold the home, as for an adapter whose host is up but
 * refused native ownership to them. With none left it is refused (see `nothingToJoin`), so that adapter asks the host again
 * instead of starting a private era beside a host that could share.
 */
export async function claimPrivateNativeHome(identity: { configPath: string; nativeHome: string; codex: string }, hostHome: string, options: { joinOnly?: boolean } = {}): Promise<PrivateNativeLease> {
  const path = nativeHomeOwnerPath(identity.nativeHome); await privateDirectory(dirname(path));
  const socketPath = resolve(hostHome, "native.sock"); const instanceId = randomUUID();
  const self = { configPath: identity.configPath, nativeHome: identity.nativeHome, socketPath };
  const differs = (owner: NativeHomeOwner, keys: ReadonlyArray<keyof typeof self>) => keys.some(key => owner[key] !== self[key]);
  const claimed = await withPrivateFileLock(path, async () => {
    const stored = await readNativeHomeOwnerRecord(identity.nativeHome);
    const holders = await privateHolders(path, hostHome); const live = holders.filter(holder => holds(holder.verdict));
    let base: Omit<MarkerBase, "engine"> & { engine?: EngineFields } = {}; let archiveOwner: OwnerReclaim | undefined;
    // Every refusal comes before anything is moved aside.
    if (stored.invalid) {
      const verdict = await invalidNativeLiveness(path, stored.mtimeMs, hostHome);
      if (verdict === "live" || verdict === "unconfirmed") throw new Error("Native execution ownership receipt is invalid");
      archiveOwner = "invalid_receipt";
    } else if (stored.owner?.privateOwner?.shared) {
      // Other private engines of this release hold the home: this one joins them under the same configuration only.
      const current = stored.owner;
      if (differs(current, ["configPath", "nativeHome", "socketPath"])) {
        if (live.length || holds(await nativeOwnerLiveness(current, stored.mtimeMs))) throw new Error("A native execution owner already owns this native home; its chats were preserved");
        throw new Error("Native execution ownership changed; existing ownership was preserved");
      }
      base = { ...(current.privateOwner!.previous ? { previous: current.privateOwner!.previous, previousMtimeMs: current.privateOwner!.previousMtimeMs } : {}), engine: engineFields(current) };
    } else if (stored.owner) {
      const current = stored.owner; const verdict = await nativeOwnerLiveness(current, stored.mtimeMs);
      // The host's writer, or the private engine of release 0.4.5 or earlier, which holds the home alone.
      if (verdict === "live") throw new Error("A native execution owner already owns this native home; its chats were preserved");
      if (verdict === "unconfirmed") throw new Error("Native execution launch is unconfirmed; existing ownership was preserved");
      // The same identity rule as the host's own claim: a home another configuration last owned is not this adapter's to take.
      const claimed = current.state === "running" || current.hostPid > 0 || current.pid > 0;
      if (differs(current, claimed ? ["configPath", "nativeHome", "socketPath"] : ["configPath", "socketPath"])) throw new Error("Native execution ownership changed; existing ownership was preserved");
      if (current.privateOwner) {
        // A 0.4.5 or earlier fallback that died with its adapter hands on the receipt it had replaced; its own receipt is archived.
        base = { ...(current.privateOwner.previous ? { previous: current.privateOwner.previous, previousMtimeMs: current.privateOwner.previousMtimeMs } : {}), engine: engineFields(current) };
        archiveOwner = verdict;
      } else base = { previous: current, previousMtimeMs: Math.floor(stored.mtimeMs), engine: engineFields(current) };
    }
    // A private engine whose receipt cannot be read, or that runs under another configuration or spelling of the home, is
    // not one this lease can share with.
    if (live.some(holder => !holder.owner || differs(holder.owner, ["configPath", "nativeHome", "socketPath"]))) throw new Error("A native execution owner already owns this native home; its chats were preserved");
    // Nothing to join: whatever answers at the host's native socket, the host is the one to ask again.
    if (options.joinOnly && !live.length) throw Object.assign(new Error(nothingToJoinMessage), { nothingToJoin: true });
    // Nothing answers at the host's native socket either: an engine that lost its receipt still keeps the home.
    if (await linkAnswers(socketPath)) throw new Error("A native execution owner already owns this native home; its chats were preserved");
    if (archiveOwner) await archiveStaleReceipt(path, "native_home", archiveOwner);
    for (const holder of holders) if (!holds(holder.verdict)) await archiveHolder(holder);
    const engine = base.engine ?? await sdkIdentity(identity.codex);
    const holder = { ...engine, version: 1, managed: marker, ...self, hostPid: process.pid, pid: 0, state: "running", sdkState: "starting", ...await ownerStamp(),
      privateOwner: { instanceId } } as NativeHomeOwner;
    const file = resolve(dirname(path), `private-${process.pid}-${instanceId}.json`);
    // Both are written before the engine is spawned: a crash in between leaves a launch the host treats as unconfirmed. A
    // marker that cannot be written takes the receipt with it, and the marker is brought back in line with the holders that
    // remain (a write that failed after its rename, say), so a refused lease never keeps the host out.
    await writePrivateJson(file, holder);
    try { await writeClaimMarker(path, markerFor([...live.map(other => other.owner!), holder], { ...base, engine })); }
    catch (error) { await unlink(file).catch(() => {}); await syncPrivateMarker(path, hostHome).catch(() => {}); throw error; }
    return { file, holder, holders: live.length + 1 };
  });
  return new PrivateNativeLease(path, claimed.file, claimed.holder, claimed.holders);
}

const defaultMarkerRefreshMs = 45_000;
let markerRefreshMs = defaultMarkerRefreshMs;
/** Tests shorten how often a lease looks at the marker again. Undefined restores the production value. */
export function setPrivateMarkerRefreshForTests(ms?: number): void { markerRefreshMs = ms ?? defaultMarkerRefreshMs; }

export class PrivateNativeLease {
  private released?: Promise<void>;
  private releaseWanted = false;
  private refreshing = false;
  /**
   * Every lease looks at the marker again on a timer, so when the holders it names have crashed and others still run, an
   * older release soon sees a live one again. It writes only when something changed, and it never keeps the process alive.
   * A release that was asked for and failed (a busy lock, say) is retried by the same timer until it succeeds, so a
   * long-lived process never keeps a lease, and with it the host, out after its engine has gone.
   */
  private readonly refresh = setInterval(() => {
    if (this.refreshing || this.released) return; this.refreshing = true;
    const tick = this.releaseWanted ? this.release()
      : withPrivateFileLock(this.path, async () => { if (!this.released && await this.own()) await syncPrivateMarker(this.path, this.hostHome); });
    void tick.catch(() => {}).finally(() => { this.refreshing = false; }); // A busy lock or a full disk is tried again at the next tick.
  }, markerRefreshMs).unref();
  /** `holders`: how many private engines held the native home once this lease was taken, this one included. */
  constructor(private readonly path: string, private readonly file: string, private readonly owner: NativeHomeOwner, readonly holders: number) {}
  private get hostHome(): string { return dirname(this.owner.socketPath); }
  private async own(): Promise<NativeHomeOwner | undefined> {
    const current = await readReceipt(this.file, this.path).catch(() => undefined);
    return current?.privateOwner?.instanceId === this.owner.privateOwner?.instanceId && current?.hostPid === this.owner.hostPid ? current : undefined;
  }
  /** Records the engine the adapter spawned, so the lease stays live for as long as that engine can still write. */
  async engineStarted(pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("The native Codex engine did not start");
    const stamp = await spawnStamp(pid);
    await withPrivateFileLock(this.path, async () => {
      if (this.released || !await this.own()) throw new Error("Native execution ownership changed; existing ownership was preserved");
      Object.assign(this.owner, { pid, sdkState: "running", ...(stamp.bootId ? { sdkBootId: stamp.bootId } : {}), sdkStartedAtMs: stamp.startedAtMs });
      await writePrivateJson(this.file, this.owner); await syncPrivateMarker(this.path, this.hostHome);
    });
  }
  /**
   * Called once the engine has exited. Removes this lease's receipt; the last lease to go puts back the receipt the first
   * one replaced, or removes `owner.json` when there was none. An engine that still answers keeps the home: the adapter
   * steps back and the receipt names only the engine, which the dead owner rules release once it has gone. A receipt that
   * is no longer this lease's is left alone. A release that fails (a busy lock, say) is not remembered: the timer and the
   * adapter's stop try it again, and the timer stops only once a release has succeeded.
   */
  release(): Promise<void> {
    this.releaseWanted = true;
    return this.released ??= withPrivateFileLock(this.path, async () => {
      if (!await this.own()) return;
      if (this.owner.pid > 0 && await receiptPidAlive({ pid: this.owner.pid, bootId: this.owner.sdkBootId, startedAtMs: this.owner.sdkStartedAtMs }, Date.now())) {
        await writePrivateJson(this.file, { ...this.owner, hostPid: 0 });
      } else await unlink(this.file).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
      await syncPrivateMarker(this.path, this.hostHome);
    }).then(() => { clearInterval(this.refresh); }, error => { this.released = undefined; throw error; });
  }
}
