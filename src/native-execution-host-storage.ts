import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { archiveStaleReceipt, privateDirectory, receiptPidAlive, removeOwnedSocket, sdkSocketTarget, socketAnswers, type EngineOwner, type HostIdentity, type OwnerReclaim, type SocketIdentity } from "./execution-host-storage.js";
import { fromPreviousBoot, ownerStamp } from "./boot-identity.js";

const marker = "subscription-gateway-native-execution-owner";
export interface NativeHomeOwner {
  version: 1; managed: typeof marker; configPath: string; nativeHome: string; codex: string; sdkSha256: string;
  hostPid: number; pid: number; socketPath: string; state: "running" | "stopped"; revision?: string; socket?: SocketIdentity;
  sdkState: "idle" | "starting" | "running" | "exited" | "stopped"; nativeSdkExecutable?: string; nativeSdkSha256?: string;
  bootId?: string; startedAtMs?: number; sdkBootId?: string; sdkStartedAtMs?: number;
}
export function nativeHomeOwnerPath(nativeHome: string): string {
  let canonical: string; try { canonical = realpathSync(nativeHome); } catch { canonical = resolve(nativeHome); }
  const scope = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return resolve(homedir(), ".local/state/gw-native", scope, "owner.json");
}
/** writePrivateJson replaces the receipt by atomic rename, so a reader can see two inodes across lstat and open. */
const replacedDuringRead = Symbol("native-owner-replaced");
const replacementRetries = 8;
export async function readNativeHomeOwner(nativeHome: string): Promise<NativeHomeOwner | undefined> {
  const path = nativeHomeOwnerPath(nativeHome);
  for (let attempt = 0; attempt < replacementRetries; attempt++) {
    const owner = await readNativeHomeOwnerOnce(path);
    if (owner !== replacedDuringRead) return owner;
    await new Promise(done => setTimeout(done, attempt));
  }
  throw new Error("Native execution ownership receipt is invalid");
}
async function readNativeHomeOwnerOnce(path: string): Promise<NativeHomeOwner | undefined | typeof replacedDuringRead> {
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
    if (!owner || owner.version !== 1 || owner.managed !== marker || typeof owner.nativeHome !== "string" || nativeHomeOwnerPath(owner.nativeHome) !== path || !["running", "stopped"].includes(owner.state) ||
      !Number.isSafeInteger(owner.hostPid) || owner.hostPid < 0 || !Number.isSafeInteger(owner.pid) || owner.pid < 0 ||
      ![owner.configPath, owner.codex, owner.socketPath].every(value => typeof value === "string" && value.startsWith("/") && !value.includes("\0")) ||
      typeof owner.sdkSha256 !== "string" || !/^[a-f0-9]{64}$/.test(owner.sdkSha256) || owner.revision !== undefined && !/^[a-f0-9]{64}$/.test(owner.revision)) throw new Error("Native execution ownership receipt is invalid");
    if (!["idle", "starting", "running", "exited", "stopped"].includes(owner.sdkState)) throw new Error("Native execution ownership receipt is invalid");
    if (owner.bootId !== undefined && typeof owner.bootId !== "string" || owner.sdkBootId !== undefined && typeof owner.sdkBootId !== "string"
      || [owner.startedAtMs, owner.sdkStartedAtMs].some(value => value !== undefined && (!Number.isSafeInteger(value) || value! < 0))) throw new Error("Native execution ownership receipt is invalid");
    if ((owner.nativeSdkExecutable === undefined) !== (owner.nativeSdkSha256 === undefined) || owner.nativeSdkExecutable !== undefined &&
      (typeof owner.nativeSdkExecutable !== "string" || !owner.nativeSdkExecutable.startsWith("/") || !/^[a-f0-9]{64}$/.test(owner.nativeSdkSha256!))) throw new Error("Native execution SDK identity is invalid");
    return owner;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Native execution ownership receipt is invalid"); }
  finally { await file?.close(); }
}

/** The receipt plus the file time a bootless receipt needs for its previous-boot comparison. */
export async function readNativeHomeOwnerRecord(nativeHome: string): Promise<{ owner?: NativeHomeOwner; mtimeMs: number; invalid: boolean }> {
  const mtimeMs = await stat(nativeHomeOwnerPath(nativeHome)).then(info => info.mtimeMs, error => (error as NodeJS.ErrnoException).code === "ENOENT" ? Number.POSITIVE_INFINITY : (() => { throw error; })());
  if (mtimeMs === Number.POSITIVE_INFINITY) return { mtimeMs, invalid: false };
  try { return { owner: await readNativeHomeOwner(nativeHome), mtimeMs, invalid: false }; }
  catch { return { mtimeMs, invalid: true }; }
}
/** A host that died after publishing "starting" may have left an SDK child still coming up; it gets this long to show itself. */
const defaultStartupGraceMs = 60_000;
let startupGraceMs = defaultStartupGraceMs;
/** Tests shorten the startup grace instead of waiting it out. Undefined restores the production value. */
export function setNativeStartupGraceForTests(ms?: number): void { startupGraceMs = ms ?? defaultStartupGraceMs; }
/**
 * What an existing receipt means for a new claim: "live" while a recorded process or an answering socket can still own the
 * home, "unconfirmed" while a launch it recorded cannot be proven absent, or the reason the owner is gone.
 */
type NativeLiveness = "live" | "unconfirmed" | OwnerReclaim;
async function nativeOwnerLiveness(owner: NativeHomeOwner, mtimeMs: number): Promise<NativeLiveness> {
  if (await fromPreviousBoot({ ...(owner.bootId ? { bootId: owner.bootId } : {}) }, mtimeMs)) return "previous_boot";
  if (await receiptPidAlive({ pid: owner.hostPid, bootId: owner.bootId, startedAtMs: owner.startedAtMs }, mtimeMs)) return "live";
  if (await receiptPidAlive({ pid: owner.pid, ...(owner.sdkBootId ? { bootId: owner.sdkBootId } : {}), ...(owner.sdkStartedAtMs !== undefined ? { startedAtMs: owner.sdkStartedAtMs } : {}) }, mtimeMs)) return "live";
  // A host that died between publishing "starting" and recording the SDK child may have left a child that is still starting.
  const starting = owner.state === "running" && owner.sdkState === "starting";
  const answers = await socketAnswers(owner.socketPath) || await socketAnswers(await sdkSocketTarget(owner.socketPath).catch(() => owner.socketPath));
  if (answers) return starting ? "unconfirmed" : "live";
  if (starting && !(Date.now() - mtimeMs >= startupGraceMs)) return "unconfirmed";
  return "dead_pids";
}
/** A garbled receipt only protects the socket its host home can still name. */
async function nativeLinkIsDead(hostHome: string): Promise<boolean> {
  const path = resolve(hostHome, "native.sock");
  return !(await socketAnswers(path) || await socketAnswers(await sdkSocketTarget(path).catch(() => path)));
}
/** One native home cannot be shared through two different managed host configs. */
export async function claimNativeHome(identity: HostIdentity, hostHome: string): Promise<NativeHomeLease> {
  const path = nativeHomeOwnerPath(identity.nativeHome); await privateDirectory(dirname(path));
  const socketPath = resolve(hostHome, "native.sock");
  const owner: NativeHomeOwner = { version: 1, managed: marker, configPath: identity.configPath, nativeHome: identity.nativeHome,
    codex: identity.codex, sdkSha256: identity.sdkSha256, hostPid: process.pid, pid: 0, socketPath, state: "running", sdkState: "idle", ...await ownerStamp(),
    ...(identity.nativeSdkExecutable ? { nativeSdkExecutable: identity.nativeSdkExecutable, nativeSdkSha256: identity.nativeSdkSha256 } : {}) };
  await withPrivateFileLock(path, async () => {
    const stored = await readNativeHomeOwnerRecord(identity.nativeHome);
    let reclaim: OwnerReclaim | undefined;
    if (stored.invalid) {
      if (await nativeLinkIsDead(hostHome)) { await removeOwnedSocket(socketPath, undefined, true); reclaim = "invalid_receipt"; }
      else throw new Error("Native execution ownership receipt is invalid");
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
        await removeOwnedSocket(previous.socketPath, previous.socket, true);
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
