import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
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
let executionHostRootOverride: string | undefined;
/** The folder that holds every configuration's host home. Production: `~/.local/state/gw-exec`. */
export function executionHostRoot(): string { return executionHostRootOverride ?? resolve(homedir(), ".local/state/gw-exec"); }
/** Tests keep host homes in a folder of their own; production never calls it. Undefined restores the real root. */
export function setExecutionHostRootForTests(root?: string): void { executionHostRootOverride = root ? resolve(root) : undefined; }
export function executionHostHome(configPath: string, nativeHome: string): string {
  const scope = createHash("sha256").update(resolve(configPath) + "\0" + resolve(nativeHome)).digest("hex").slice(0, 16);
  return resolve(executionHostRoot(), scope);
}
export function livePid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** True when the receipt names a process that can still be this machine's owner in this boot. */
export async function receiptPidAlive(record: ReceiptOwner, mtimeMs: number): Promise<boolean> {
  return ownerAlive({ pid: record.pid, ...(record.bootId ? { bootId: record.bootId } : {}), ...(record.startedAtMs !== undefined ? { startedAtMs: record.startedAtMs } : {}) }, mtimeMs);
}
/**
 * A refused probe is never taken as proof that nothing listens: that would allow a removal. A path that is not a socket
 * is the exception. A plain file, a folder or a pipe can never be a live listener (connect answers ENOTSOCK), so it
 * cannot keep a dead owner alive; counted as answering, a stray file at a socket path blocked every reclaim for good.
 */
export async function socketAnswers(path: string): Promise<boolean> {
  // Followed like connect follows it: a link is judged by what it names.
  const info = await stat(path).catch(() => undefined);
  if (info && !info.isSocket()) return false;
  try { return await listening(path); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOTSOCK"; }
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
    if (error.code === "ENOENT") throw new Error("Execution SDK socket directory is missing");
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
    socket.once("error", error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (["ECONNREFUSED", "ENOENT"].includes(code || "")) finish(false);
      else { clearTimeout(timer); socket.destroy(); reject(Object.assign(new Error("Execution socket liveness check failed"), { code })); }
    });
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
/** Every link a host home can hold, recorded or not: its control link, its native link and each generation link. */
async function homeLinks(home: string): Promise<string[]> {
  const names = await readdir(home).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[]; throw error; });
  return [resolve(home, "host.sock"), resolve(home, "native.sock"), ...names.filter(name => /^e-[0-9a-f]{16}\.sock$/.test(name)).sort().map(name => resolve(home, name))];
}
/** A link answers when it, or the SDK socket it names, accepts a connect: a link can be gone while its listener still serves. */
export async function linkAnswers(path: string): Promise<boolean> {
  return await socketAnswers(path) || await socketAnswers(await sdkSocketTarget(path).catch(() => path));
}
async function receiptMtime(path: string): Promise<number> { return (await lstat(path).catch(() => undefined))?.mtimeMs ?? Number.POSITIVE_INFINITY; }
function ownerRecords(owner: HostOwner): ReceiptOwner[] { return [owner, ...owner.generations.filter(Boolean), ...(owner.native ? [owner.native] : [])]; }
function ownerLinks(home: string, owner: HostOwner): string[] {
  return [typeof owner.socketPath === "string" ? owner.socketPath : resolve(home, "host.sock"),
    ...owner.generations.filter(engine => engine && /^[a-f0-9]{64}$/.test(engine.revision)).map(engine => resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)),
    ...(owner.native ? [resolve(home, "native.sock")] : [])];
}
/**
 * A dead owner never blocks, and a live one is never displaced. An owner is live while a process it names can
 * still be its own, or while anything it advertised or its home holds answers a connect. An earlier boot ends
 * every process at once, but a listener that answers still keeps the owner: the two rules always agree.
 */
async function ownerLiveness(home: string, records: ReceiptOwner[], links: string[], bootId: string | undefined, mtimeMs: number): Promise<OwnerLiveness> {
  const previous = await fromPreviousBoot(bootId ? { bootId } : {}, mtimeMs);
  if (!previous) for (const record of records) if (await receiptPidAlive(record, mtimeMs)) return "live";
  for (const path of new Set([...links, ...await homeLinks(home)])) if (await linkAnswers(path)) return "live";
  return previous ? "previous_boot" : "dead_pids";
}
/** The claim's verdict on a valid host receipt: "live" while anything it names can still own the home, else why it is gone. */
export async function hostOwnerLiveness(home: string, owner: HostOwner, mtimeMs: number): Promise<OwnerLiveness> {
  return ownerLiveness(home, ownerRecords(owner), ownerLinks(home, owner), owner.bootId, mtimeMs);
}
/** A field of an invalid receipt that still names a process: its pid, with the boot and start it was stamped with. */
export function lenientRecord(value: unknown, pidKey = "pid", bootKey = "bootId", startKey = "startedAtMs"): ReceiptOwner | undefined {
  if (!value || typeof value !== "object") return;
  const fields = value as Record<string, unknown>; const pid = fields[pidKey]; const bootId = fields[bootKey]; const started = fields[startKey];
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return;
  return { pid: pid as number, ...(typeof bootId === "string" ? { bootId } : {}), ...(Number.isSafeInteger(started) && (started as number) >= 0 ? { startedAtMs: started as number } : {}) };
}
/** Whatever JSON object an invalid receipt still holds, read without following a link or blocking on a special file. */
export async function readLenientJson(path: string): Promise<Record<string, unknown> | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size > 65536) return;
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return; }
  finally { await file?.close(); }
}
/** What an invalid host receipt still says: every process it names, and the boot it was stamped with. */
function lenientHostOwner(body: Record<string, unknown> | undefined): { records: ReceiptOwner[]; bootId?: string } {
  if (!body) return { records: [] };
  const generations = Array.isArray(body.generations) ? body.generations.slice(0, 8) : [];
  const records = [lenientRecord(body), ...generations.map(engine => lenientRecord(engine)), lenientRecord(body.native)].filter((record): record is ReceiptOwner => !!record);
  return { records, ...(typeof body.bootId === "string" ? { bootId: body.bootId } : {}) };
}
/**
 * A dead owner's link nobody recorded: removed when it is the SDK's rendezvous for this path and nothing answers it.
 * A direct socket nobody recorded is never removed. At the control socket it refuses the claim, as the host could not
 * start beside it; anywhere else it is left where it is and only its own generation stays unavailable.
 */
async function removeUnrecordedLink(path: string, controlSocket: string): Promise<void> {
  const actual = await inspectSocket(path, true);
  if (actual && !actual.targetPath && path !== controlSocket) return;
  await removeOwnedSocket(path, undefined, true);
}
const maxArchiveCopyBytes = 1024 * 1024;
/**
 * An owner this machine no longer has leaves its receipt behind in `<folder>/stale/`, never deleted; the newest five are kept.
 * A gateway generation's garbled record or catalog is kept the same way before it is rewritten.
 */
export async function archiveStaleReceipt(receiptPath: string, scope: "host" | "native_home" | "generation", reason: OwnerReclaim): Promise<void> {
  const folder = resolve(dirname(receiptPath), "stale"); const stem = basename(receiptPath, ".json");
  await privateDirectory(folder);
  const info = await lstat(receiptPath).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; });
  if (!info) return; // Another writer already replaced it: there is nothing left to keep.
  let archive: string | undefined;
  for (let ms = Date.now(), attempt = 0; !archive && attempt < 64; attempt++, ms++) {
    const candidate = resolve(folder, `${stem}-${ms}.json`);
    if (!await lstat(candidate).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; })) archive = candidate;
  }
  if (!archive) throw new Error("Execution ownership archive is full; the receipt was preserved");
  // Only a plain file is read: a link, a pipe or a device is moved aside whole, so archiving never follows or blocks on it.
  if (!info.isFile() || info.size > maxArchiveCopyBytes || !await copyReceipt(receiptPath, archive, info)) await rename(receiptPath, archive);
  const names = (await readdir(folder)).filter(name => name.startsWith(`${stem}-`)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - 5))) await unlink(resolve(folder, name)).catch(() => {});
  telemetry("execution_owner_reclaimed", { scope, reason });
}
/** Copies a plain receipt into its private archive; false when it cannot be read as the same plain file. */
async function copyReceipt(receiptPath: string, archive: string, expected: { ino: number; dev: number }): Promise<boolean> {
  let file;
  try { file = await open(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0)); }
  catch (error) { if (["EACCES", "EIO", "ELOOP", "EPERM", "ENXIO", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.ino !== expected.ino || opened.dev !== expected.dev || opened.size > maxArchiveCopyBytes) return false;
    let bytes: Buffer;
    try { bytes = await file.readFile(); }
    catch (error) { if (["EACCES", "EIO"].includes((error as NodeJS.ErrnoException).code ?? "")) return false; throw error; }
    // A copy that fails half way (a full disk, say) is removed, so the next attempt never finds a partial archive.
    try { await writeFile(archive, bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") await unlink(archive).catch(() => {}); throw error; }
    return true;
  } finally { await file.close(); }
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
      // A receipt this release cannot validate still names processes, and its home still holds links: any of them alive keeps it.
      const lenient = lenientHostOwner(await readLenientJson(receipt));
      if (await ownerLiveness(home, lenient.records, [], lenient.bootId, stored.mtimeMs) === "live") throw new Error("Execution host ownership receipt is invalid");
      for (const path of await homeLinks(home)) await removeUnrecordedLink(path, identity.socketPath);
      reclaim = "invalid_receipt";
    } else if (stored.owner) {
      const previous = stored.owner;
      const dead = await ownerLiveness(home, ownerRecords(previous), ownerLinks(home, previous), previous.bootId, stored.mtimeMs);
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
      const recorded = new Set<string>();
      for (const engine of previous.generations) if (engine && /^[a-f0-9]{64}$/.test(engine.revision) && engine.socketPath === resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)) { recorded.add(engine.socketPath); await removeOwnedSocket(engine.socketPath, engine.socket, true); }
      if (previous.native?.socketPath === resolve(home, "native.sock")) { recorded.add(previous.native.socketPath); await removeOwnedSocket(previous.native.socketPath, previous.native.socket, true); }
      await removeOwnedSocket(identity.socketPath, previous.socket, true); recorded.add(identity.socketPath);
      // A generation the dead owner never got to record still left its link behind: it would block that revision for ever.
      for (const path of await homeLinks(home)) if (!recorded.has(path)) await removeUnrecordedLink(path, identity.socketPath);
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
