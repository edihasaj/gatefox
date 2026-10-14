import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { livePid, privateDirectory, removeOwnedSocket, type EngineOwner, type HostIdentity, type SocketIdentity } from "./execution-host-storage.js";

const marker = "subscription-gateway-native-execution-owner";
export interface NativeHomeOwner {
  version: 1; managed: typeof marker; configPath: string; nativeHome: string; codex: string; sdkSha256: string;
  hostPid: number; pid: number; socketPath: string; state: "running" | "stopped"; revision?: string; socket?: SocketIdentity;
  sdkState: "idle" | "starting" | "running" | "exited" | "stopped"; nativeSdkExecutable?: string; nativeSdkSha256?: string;
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
    if ((owner.nativeSdkExecutable === undefined) !== (owner.nativeSdkSha256 === undefined) || owner.nativeSdkExecutable !== undefined &&
      (typeof owner.nativeSdkExecutable !== "string" || !owner.nativeSdkExecutable.startsWith("/") || !/^[a-f0-9]{64}$/.test(owner.nativeSdkSha256!))) throw new Error("Native execution SDK identity is invalid");
    return owner;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("Native execution ownership receipt is invalid"); }
  finally { await file?.close(); }
}

/** One native home cannot be shared through two different managed host configs. */
export async function claimNativeHome(identity: HostIdentity, hostHome: string): Promise<NativeHomeLease> {
  const path = nativeHomeOwnerPath(identity.nativeHome); await privateDirectory(dirname(path));
  const socketPath = resolve(hostHome, "native.sock");
  const owner: NativeHomeOwner = { version: 1, managed: marker, configPath: identity.configPath, nativeHome: identity.nativeHome,
    codex: identity.codex, sdkSha256: identity.sdkSha256, hostPid: process.pid, pid: 0, socketPath, state: "running", sdkState: "idle",
    ...(identity.nativeSdkExecutable ? { nativeSdkExecutable: identity.nativeSdkExecutable, nativeSdkSha256: identity.nativeSdkSha256 } : {}) };
  await withPrivateFileLock(path, async () => {
    const previous = await readNativeHomeOwner(identity.nativeHome);
    if (previous) {
      if (livePid(previous.hostPid) || livePid(previous.pid)) throw new Error("A native execution owner already owns this native home; its chats were preserved");
      if (previous.state === "running" && previous.sdkState === "starting") throw new Error("Native execution launch is unconfirmed; existing ownership was preserved");
      for (const key of ["configPath", "codex", "sdkSha256", "socketPath", "nativeSdkExecutable", "nativeSdkSha256"] as const) if (previous[key] !== owner[key]) throw new Error("Native execution ownership changed; existing ownership was preserved");
      await removeOwnedSocket(previous.socketPath, previous.socket);
    }
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
      if (stopped && engine && livePid(engine.pid)) throw new Error("Native execution SDK is still running; its ownership was preserved");
      Object.assign(this.owner, { pid: engine?.pid ?? 0, ...(engine ? { revision: engine.revision, socket: engine.socket } : {}),
        state: stopped ? "stopped" : "running", sdkState: stopped ? "stopped" : sdkState, hostPid: stopped ? 0 : process.pid });
      await writePrivateJson(this.path, this.owner);
    });
  }
}
