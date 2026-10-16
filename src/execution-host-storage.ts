import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { connect } from "node:net";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { fromPreviousBoot, ownerAlive, ownerStamp } from "./boot-identity.js";
import { telemetry } from "./telemetry.js";

export const executionHostMarker = "subscription-gateway-execution-host";
export type ExecutionCapability = "native" | "gateway";
export interface SocketIdentity { inode: string; device: string; targetPath?: string; targetInode?: string; targetDevice?: string }
export interface HostIdentity { version: 1; managed: typeof executionHostMarker; configPath: string; nativeHome: string; codex: string; sdkSha256: string; socketPath: string; capabilities?: ExecutionCapability[]; nativeRelayOwnsRegistration?: boolean; nativeSdkExecutable?: string; nativeSdkSha256?: string }
export interface EngineOwner { revision: string; pid: number; socketPath: string; socket?: SocketIdentity; bootId?: string; startedAtMs?: number }
export interface NativeDeath { revision: string; pid: number; instanceId: string; exitedAtMs: number; intentional: boolean }
export interface HostOwner extends HostIdentity { pid: number; state: "running" | "stopped"; socket?: SocketIdentity; generations: EngineOwner[]; native?: EngineOwner; nativeDeaths?: NativeDeath[]; bootId?: string; startedAtMs?: number }
export type OwnerReclaim = "previous_boot" | "dead_pids" | "invalid_receipt";
/** Why the previous owner is gone, or "live" when it can still own the home. */
export type OwnerLiveness = "live" | OwnerReclaim;
/** The pids one receipt names, and the sockets it advertises, are everything an owner can be alive by. */
export interface ReceiptOwner { pid: number; bootId?: string; startedAtMs?: number }
export function executionCapabilities(value?: unknown): ExecutionCapability[] {
  if (value === undefined) return ["gateway"];
  if (!Array.isArray(value) || !value.length || value.length > 2 || value.some(item => item !== "native" && item !== "gateway") || new Set(value).size !== value.length) throw new Error("Execution host capabilities are invalid");
  return [...value] as ExecutionCapability[];
}
export function executionHostHome(configPath: string, nativeHome: string): string {
  const scope = createHash("sha256").update(resolve(configPath) + "\0" + resolve(nativeHome)).digest("hex").slice(0, 16);
  return resolve(homedir(), ".local/state/gw-exec", scope);
}
export function livePid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** True when the receipt names a process that can still be this machine's owner in this boot. */
export async function receiptPidAlive(record: ReceiptOwner, mtimeMs: number): Promise<boolean> {
  return ownerAlive({ pid: record.pid, ...(record.bootId ? { bootId: record.bootId } : {}), ...(record.startedAtMs !== undefined ? { startedAtMs: record.startedAtMs } : {}) }, mtimeMs);
}
/** A refused probe is never taken as proof that nothing listens: that would allow a removal. */
export async function socketAnswers(path: string): Promise<boolean> {
  try { return await listening(path); } catch { return true; }
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Execution host directory must be private and user-owned");
}
export async function sdkIdentity(codex: string): Promise<{ codex: string; sdkSha256: string }> {
  const path = await realpath(codex); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o022)) throw new Error("Execution host SDK must be a non-writable executable file");
    const hash = createHash("sha256");
    for await (const buffer of file.createReadStream({ autoClose: false })) hash.update(buffer);
    return { codex: path, sdkSha256: hash.digest("hex") };
  } finally { await file.close(); }
}
export async function readOwner(path: string): Promise<HostOwner | undefined> {
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return; throw error; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 16384) throw new Error("Execution host ownership receipt is invalid");
  let owner: HostOwner;
  try { owner = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("Execution host ownership receipt is unreadable"); }
  if (!owner || owner.version !== 1 || owner.managed !== executionHostMarker || !["running", "stopped"].includes(owner.state) || !Number.isSafeInteger(owner.pid) || owner.pid < 0 || !Array.isArray(owner.generations) || owner.generations.length > 4) throw new Error("Execution host ownership receipt is invalid");
  const capabilities = executionCapabilities(owner.capabilities);
  if (owner.nativeRelayOwnsRegistration !== undefined && typeof owner.nativeRelayOwnsRegistration !== "boolean" || owner.nativeRelayOwnsRegistration && !capabilities.includes("native")) throw new Error("Execution host ownership receipt is invalid");
  if (owner.native && (!capabilities.includes("native") || !/^[a-f0-9]{64}$/.test(owner.native.revision) || !Number.isSafeInteger(owner.native.pid) || owner.native.pid < 0 || typeof owner.native.socketPath !== "string")) throw new Error("Native execution ownership receipt is invalid");
  if (owner.bootId !== undefined && typeof owner.bootId !== "string" || owner.startedAtMs !== undefined && (!Number.isSafeInteger(owner.startedAtMs) || owner.startedAtMs! < 0)) throw new Error("Execution host ownership receipt is invalid");
  if ((owner.nativeSdkExecutable === undefined) !== (owner.nativeSdkSha256 === undefined) || owner.nativeSdkExecutable !== undefined &&
    (typeof owner.nativeSdkExecutable !== "string" || !owner.nativeSdkExecutable.startsWith("/") || !/^[a-f0-9]{64}$/.test(owner.nativeSdkSha256!))) throw new Error("Native execution SDK identity is invalid");
  if (owner.nativeDeaths !== undefined && (!Array.isArray(owner.nativeDeaths) || owner.nativeDeaths.length > 32 || owner.nativeDeaths.some(death =>
    !death || !/^[a-f0-9]{64}$/.test(death.revision) || !Number.isSafeInteger(death.pid) || death.pid < 1 || typeof death.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(death.instanceId) ||
    !Number.isSafeInteger(death.exitedAtMs) || death.exitedAtMs < 0 || typeof death.intentional !== "boolean"))) throw new Error("Native execution death metadata is invalid");
  return owner;
}
/** The pinned SDK puts its physical socket in a fixed sandbox-hidden directory. */
export async function sdkSocketTarget(path: string): Promise<string> {
  const directory = await sdkSocketRoot();
  const canonical = resolve(await realpath(dirname(path)), basename(path));
  return resolve(directory, createHash("sha256").update(canonical).digest("hex"));
}
let sdkSocketRootOverride: string | undefined;
/** Tests point the rendezvous at a short folder of their own; production always uses the fixed SDK one. */
export function setSdkSocketRootForTests(root?: string): void { sdkSocketRootOverride = root ? resolve(root) : undefined; }
async function sdkSocketRoot(): Promise<string> {
  return sdkSocketRootOverride ?? resolve(await realpath("/tmp"), `codex-daemon-${process.getuid!()}`);
}
export function sameSocketIdentity(a: SocketIdentity, b: SocketIdentity): boolean {
  return a.inode === b.inode && a.device === b.device && a.targetPath === b.targetPath && a.targetInode === b.targetInode && a.targetDevice === b.targetDevice;
}
export async function socketIdentity(path: string): Promise<SocketIdentity | undefined> { return inspectSocket(path, false); }
async function inspectSocket(path: string, allowMissingTarget: boolean): Promise<SocketIdentity | undefined> {
  const info = await lstat(path).catch(error => { if (error.code === "ENOENT") return; throw error; });
  if (!info) return;
  const identity = { inode: String(info.ino), device: String(info.dev) };
  if (info.isSocket() && info.uid === process.getuid?.() && !(info.mode & 0o077)) return identity;
  if (!info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error("Execution socket must be private and user-owned");
  const target = await sdkSocketTarget(path);
  if (await readlink(path) !== target) throw new Error("Execution SDK socket rendezvous points to an unrelated target; it was preserved");
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error("Execution SDK socket directory must be private and user-owned");
  // A machine that rebooted cleared the SDK's fixed directory: the alias is stale on its own, exactly like a missing target.
  const protectedParent = await lstat(dirname(target)).catch(error => {
    if (allowMissingTarget && error.code === "ENOENT") return;
    if (error.code === "ENOENT") throw new Error("Execution SDK socket directory must be private and user-owned");
    throw error;
  });
  if (protectedParent) {
    if (!protectedParent.isDirectory() || protectedParent.isSymbolicLink() || protectedParent.uid !== process.getuid?.() || (protectedParent.mode & 0o777) !== 0o700) throw new Error("Execution SDK socket directory must be private and user-owned");
  }
  const physical = await lstat(target).catch(error => { if (allowMissingTarget && error.code === "ENOENT") return; throw error; });
  if (!physical) return { ...identity, targetPath: target };
  if (!physical.isSocket() || physical.uid !== process.getuid?.() || (physical.mode & 0o077)) throw new Error("Execution SDK socket target must be private and user-owned");
  return { ...identity, targetPath: target, targetInode: String(physical.ino), targetDevice: String(physical.dev) };
}
async function listening(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); const timer = setTimeout(() => { socket.destroy(); reject(new Error("Execution socket liveness check timed out")); }, 1500);
    const finish = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", error => { if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")) finish(false); else { clearTimeout(timer); socket.destroy(); reject(new Error("Execution socket liveness check failed")); } });
  });
}
/** Recovery never removes a live or unrecorded listener. */
export async function removeOwnedSocket(path: string, expected?: SocketIdentity, staleOwner = false): Promise<void> {
  const actual = await inspectSocket(path, true);
  // A proven-dead owner's own rendezvous inside a private host home is named by its path alone:
  // what is observed after the validation below is what recovery is allowed to remove. A direct
  // socket nobody recorded is not that link, so an unrecorded listener stays exactly where it is.
  if (staleOwner && !expected && actual && !actual.targetPath) throw new Error("Execution socket belongs to another listener; it was preserved");
  const owned = expected ?? (staleOwner ? actual : undefined);
  if (!actual) {
    // A process can exit between removing its advertised link and physical socket.
    if (!owned?.targetPath || owned.targetPath !== await sdkSocketTarget(path) || !owned.targetInode || !owned.targetDevice) return;
    const parent = await lstat(dirname(owned.targetPath)).catch(error => {
      if (error.code === "ENOENT") return; // The reboot cleared it: nothing is left to remove.
      throw error;
    });
    if (!parent) return;
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error("Execution SDK socket directory must be private and user-owned");
    const physical = await socketIdentity(owned.targetPath); if (!physical) return;
    if (physical.targetPath || physical.inode !== owned.targetInode || physical.device !== owned.targetDevice) throw new Error("Execution socket belongs to another listener; it was preserved");
    if (await listening(owned.targetPath)) throw new Error("A live execution listener was preserved");
    const current = await socketIdentity(owned.targetPath);
    if (!current || !sameSocketIdentity(physical, current)) throw new Error("Execution socket changed during recovery; it was preserved");
    await unlink(owned.targetPath); return;
  }
  const matches = (value: SocketIdentity) => owned && owned.inode === value.inode && owned.device === value.device && owned.targetPath === value.targetPath
    && (!value.targetInode || (owned.targetInode === value.targetInode && owned.targetDevice === value.targetDevice));
  if (!matches(actual)) throw new Error("Execution socket belongs to another listener; it was preserved");
  if (await listening(path)) throw new Error("A live execution listener was preserved");
  const current = await inspectSocket(path, true);
  if (!current || !matches(current)) throw new Error("Execution socket changed during recovery; it was preserved");
  await unlink(path);
  if (current.targetPath && current.targetInode) {
    const physical = await lstat(current.targetPath).catch(error => { if (error.code === "ENOENT") return; throw error; });
    if (physical?.isSocket() && String(physical.ino) === current.targetInode && String(physical.dev) === current.targetDevice) await unlink(current.targetPath);
  }
}
/** The fixed links a host receipt can own, independent of whatever its unreadable body claimed. */
function hostLinks(home: string): string[] { return [resolve(home, "host.sock"), resolve(home, "native.sock")]; }
async function receiptMtime(path: string): Promise<number> { return (await lstat(path).catch(() => undefined))?.mtimeMs ?? Number.POSITIVE_INFINITY; }
/** A dead owner never blocks: its processes are gone and nothing it advertised answers a connect. */
function ownerRecords(owner: HostOwner): ReceiptOwner[] { return [owner, ...owner.generations.filter(Boolean), ...(owner.native ? [owner.native] : [])]; }
function ownerLinks(home: string, owner: HostOwner): string[] {
  return [typeof owner.socketPath === "string" ? owner.socketPath : resolve(home, "host.sock"),
    ...owner.generations.filter(engine => engine && /^[a-f0-9]{64}$/.test(engine.revision)).map(engine => resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)),
    ...(owner.native ? [resolve(home, "native.sock")] : [])];
}
async function ownerIsDead(home: string, owner: HostOwner, mtimeMs: number): Promise<OwnerLiveness> {
  if (await fromPreviousBoot({ ...(owner.bootId ? { bootId: owner.bootId } : {}) }, mtimeMs)) return "previous_boot";
  for (const record of ownerRecords(owner)) if (await receiptPidAlive(record, mtimeMs)) return "live";
  for (const path of ownerLinks(home, owner)) if (await socketAnswers(path)) return "live";
  return "dead_pids";
}
/** Nothing a receipt named is alive, and nothing it advertised answers. */
async function orphanReceiptIsDead(links: string[]): Promise<boolean> {
  for (const path of links) if (await socketAnswers(path) || await socketAnswers(await sdkSocketTarget(path).catch(() => path))) return false;
  return true;
}
/** An owner this machine no longer has leaves its receipt behind in `<folder>/stale/`, never deleted. */
export async function archiveStaleReceipt(receiptPath: string, scope: "host" | "native_home", reason: OwnerReclaim): Promise<void> {
  const folder = resolve(dirname(receiptPath), "stale");
  await privateDirectory(folder);
  const archive = resolve(folder, `${basename(receiptPath, ".json")}-${Date.now()}.json`);
  try { await copyFile(receiptPath, archive); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // Another writer already replaced it: there is nothing left to keep.
    // An unreadable body is still a receipt: move it aside instead of reporting a copy failure as nothing to keep.
    if (code !== "EACCES" && code !== "EIO") throw error;
    await rename(receiptPath, archive);
  }
  await chmod(archive, 0o600);
  const names = (await readdir(folder)).filter(name => name.startsWith(`${basename(receiptPath, ".json")}-`)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - 5))) await unlink(resolve(folder, name)).catch(() => {});
  telemetry("execution_owner_reclaimed", { scope, reason });
}
/** The receipt plus the file time a bootless receipt needs for its previous-boot comparison. */
export async function readOwnerRecord(receipt: string): Promise<{ owner?: HostOwner; mtimeMs: number; invalid: boolean }> {
  const mtimeMs = await receiptMtime(receipt);
  try { return { owner: await readOwner(receipt), mtimeMs, invalid: false }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mtimeMs: 0, invalid: false };
    return { mtimeMs, invalid: true };
  }
}
export async function claimHost(home: string, identity: HostIdentity): Promise<HostOwner> {
  await privateDirectory(home); const receipt = resolve(home, "owner.json");
  return withPrivateFileLock(receipt, async () => {
    const stored = await readOwnerRecord(receipt);
    let reclaim: OwnerReclaim | undefined;
    if (stored.invalid) {
      // A garbled receipt only stops a claim while something it could have named is still answering.
      if (await orphanReceiptIsDead(hostLinks(home))) { await removeOwnedSocket(identity.socketPath, undefined, true); reclaim = "invalid_receipt"; }
      else throw new Error("Execution host ownership receipt is invalid");
    } else if (stored.owner) {
      const previous = stored.owner;
      const dead = await ownerIsDead(home, previous, stored.mtimeMs);
      if (dead === "live") {
        for (const key of ["configPath", "nativeHome", "codex", "socketPath"] as const) if (previous[key] !== identity[key]) throw new Error("Execution host identity changed; existing ownership was preserved");
        if (await receiptPidAlive(previous, stored.mtimeMs)) throw new Error("An execution host already owns this configuration");
        for (const engine of previous.generations) {
          if (!engine || !/^[a-f0-9]{64}$/.test(engine.revision) || !Number.isSafeInteger(engine.pid) || engine.pid < 0 || engine.socketPath !== resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)) throw new Error("Execution generation receipt is invalid");
          if (await receiptPidAlive(engine, stored.mtimeMs)) throw new Error("An execution generation is still running; its loaded chats were preserved");
          await removeOwnedSocket(engine.socketPath, engine.socket);
        }
        if (previous.native) {
          if (previous.native.socketPath !== resolve(home, "native.sock")) throw new Error("Native execution ownership receipt is invalid");
          if (await receiptPidAlive(previous.native, stored.mtimeMs)) throw new Error("A native execution owner is still running; its chats were preserved");
          await removeOwnedSocket(previous.native.socketPath, previous.native.socket);
        }
        // Nothing the receipt named is running, yet one of its links still answers: recovery preserves it.
        await removeOwnedSocket(identity.socketPath, previous.socket);
        throw new Error("An execution host already owns this configuration");
      }
      // A stopped or dead owner keeps only the identity that says which configuration and home this is:
      // the app's SDK path and checksum move with an update, and the generations below were proven gone.
      for (const key of ["configPath", "nativeHome", "socketPath"] as const) if (previous[key] !== identity[key]) throw new Error("Execution host identity changed; existing ownership was preserved");
      for (const engine of previous.generations) if (engine && /^[a-f0-9]{64}$/.test(engine.revision) && engine.socketPath === resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)) await removeOwnedSocket(engine.socketPath, engine.socket, true);
      if (previous.native?.socketPath === resolve(home, "native.sock")) await removeOwnedSocket(previous.native.socketPath, previous.native.socket, true);
      await removeOwnedSocket(identity.socketPath, previous.socket, true);
      // A receipt that never claimed a process is an ordinary handover, so it is not worth a reclaim record.
      if (previous.state === "running" || previous.pid > 0 || previous.generations.some(engine => (engine?.pid ?? 0) > 0) || (previous.native?.pid ?? 0) > 0) reclaim = dead;
    } else await removeOwnedSocket(identity.socketPath);
    const owner: HostOwner = { ...identity, pid: process.pid, state: "running", generations: [], ...await ownerStamp(), ...(stored.owner?.nativeDeaths ? { nativeDeaths: stored.owner.nativeDeaths } : {}) };
    if (reclaim) await archiveStaleReceipt(receipt, "host", reclaim);
    await writePrivateJson(receipt, owner); return owner;
  });
}
export async function publishOwner(home: string, owner: HostOwner): Promise<void> {
  const receipt = resolve(home, "owner.json");
  await withPrivateFileLock(receipt, async () => {
    const current = await readOwner(receipt);
    if (current?.pid !== process.pid || current.managed !== executionHostMarker || current.socketPath !== owner.socketPath) throw new Error("Execution host ownership changed");
    await writePrivateJson(receipt, owner);
  });
}
