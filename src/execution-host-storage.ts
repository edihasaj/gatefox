import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { connect } from "node:net";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";

export const executionHostMarker = "subscription-gateway-execution-host";
export type ExecutionCapability = "native" | "gateway";
export interface SocketIdentity { inode: string; device: string; targetPath?: string; targetInode?: string; targetDevice?: string }
export interface HostIdentity { version: 1; managed: typeof executionHostMarker; configPath: string; nativeHome: string; codex: string; sdkSha256: string; socketPath: string; capabilities?: ExecutionCapability[]; nativeRelayOwnsRegistration?: boolean; nativeSdkExecutable?: string; nativeSdkSha256?: string }
export interface EngineOwner { revision: string; pid: number; socketPath: string; socket?: SocketIdentity }
export interface NativeDeath { revision: string; pid: number; instanceId: string; exitedAtMs: number; intentional: boolean }
export interface HostOwner extends HostIdentity { pid: number; state: "running" | "stopped"; socket?: SocketIdentity; generations: EngineOwner[]; native?: EngineOwner; nativeDeaths?: NativeDeath[] }
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
  if ((owner.nativeSdkExecutable === undefined) !== (owner.nativeSdkSha256 === undefined) || owner.nativeSdkExecutable !== undefined &&
    (typeof owner.nativeSdkExecutable !== "string" || !owner.nativeSdkExecutable.startsWith("/") || !/^[a-f0-9]{64}$/.test(owner.nativeSdkSha256!))) throw new Error("Native execution SDK identity is invalid");
  if (owner.nativeDeaths !== undefined && (!Array.isArray(owner.nativeDeaths) || owner.nativeDeaths.length > 32 || owner.nativeDeaths.some(death =>
    !death || !/^[a-f0-9]{64}$/.test(death.revision) || !Number.isSafeInteger(death.pid) || death.pid < 1 || typeof death.instanceId !== "string" || !/^[a-f0-9-]{36}$/.test(death.instanceId) ||
    !Number.isSafeInteger(death.exitedAtMs) || death.exitedAtMs < 0 || typeof death.intentional !== "boolean"))) throw new Error("Native execution death metadata is invalid");
  return owner;
}
/** The pinned SDK puts its physical socket in a fixed sandbox-hidden directory. */
export async function sdkSocketTarget(path: string): Promise<string> {
  const directory = resolve(await realpath("/tmp"), `codex-daemon-${process.getuid!()}`);
  const canonical = resolve(await realpath(dirname(path)), basename(path));
  return resolve(directory, createHash("sha256").update(canonical).digest("hex"));
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
  for (const directory of [dirname(path), dirname(target)]) {
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error("Execution SDK socket directory must be private and user-owned");
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
export async function removeOwnedSocket(path: string, expected?: SocketIdentity): Promise<void> {
  const actual = await inspectSocket(path, true);
  if (!actual) {
    // A process can exit between removing its advertised link and physical socket.
    if (!expected?.targetPath || expected.targetPath !== await sdkSocketTarget(path) || !expected.targetInode || !expected.targetDevice) return;
    const parent = await lstat(dirname(expected.targetPath));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o777) !== 0o700) throw new Error("Execution SDK socket directory must be private and user-owned");
    const physical = await socketIdentity(expected.targetPath); if (!physical) return;
    if (physical.targetPath || physical.inode !== expected.targetInode || physical.device !== expected.targetDevice) throw new Error("Execution socket belongs to another listener; it was preserved");
    if (await listening(expected.targetPath)) throw new Error("A live execution listener was preserved");
    const current = await socketIdentity(expected.targetPath);
    if (!current || !sameSocketIdentity(physical, current)) throw new Error("Execution socket changed during recovery; it was preserved");
    await unlink(expected.targetPath); return;
  }
  const matches = (value: SocketIdentity) => expected && expected.inode === value.inode && expected.device === value.device && expected.targetPath === value.targetPath
    && (!value.targetInode || (expected.targetInode === value.targetInode && expected.targetDevice === value.targetDevice));
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
export async function claimHost(home: string, identity: HostIdentity): Promise<HostOwner> {
  await privateDirectory(home); const receipt = resolve(home, "owner.json");
  return withPrivateFileLock(receipt, async () => {
    const previous = await readOwner(receipt);
    if (previous) {
      // The app's SDK checksum is deliberately not compared: an app update changes it, and a stopped host with no live owners below must still be replaceable.
      for (const key of ["configPath", "nativeHome", "codex", "socketPath"] as const) if (previous[key] !== identity[key]) throw new Error("Execution host identity changed; existing ownership was preserved");
      if (livePid(previous.pid)) throw new Error("An execution host already owns this configuration");
      for (const engine of previous.generations) {
        if (!engine || !/^[a-f0-9]{64}$/.test(engine.revision) || !Number.isSafeInteger(engine.pid) || engine.pid < 0 || engine.socketPath !== resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)) throw new Error("Execution generation receipt is invalid");
        if (livePid(engine.pid)) throw new Error("An execution generation is still running; its loaded chats were preserved");
        await removeOwnedSocket(engine.socketPath, engine.socket);
      }
      if (previous.native) {
        if (previous.native.socketPath !== resolve(home, "native.sock")) throw new Error("Native execution ownership receipt is invalid");
        if (livePid(previous.native.pid)) throw new Error("A native execution owner is still running; its chats were preserved");
        await removeOwnedSocket(previous.native.socketPath, previous.native.socket);
      }
    }
    await removeOwnedSocket(identity.socketPath, previous?.socket);
    const owner: HostOwner = { ...identity, pid: process.pid, state: "running", generations: [], ...(previous?.nativeDeaths ? { nativeDeaths: previous.nativeDeaths } : {}) };
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
