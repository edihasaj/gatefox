import { lstat, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { executionHostHome, hostOwnerLiveness, readOwnerRecord, receiptPidAlive, removeOwnedSocket, removeUnrecordedLinks, type HostIdentity } from "./execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { nativeHomeOwnerPath, nativeHomeOwnership, readNativeHomeOwnerRecord, type NativeHomeOwner } from "./native-execution-host-storage.js";

/** A receipt's pid is only proof while this boot can still own it. */
async function writerAlive(pid: number, bootId: string | undefined, startedAtMs: number | undefined, mtimeMs: number): Promise<boolean> {
  return pid > 0 && await receiptPidAlive({ pid, ...(bootId ? { bootId } : {}), ...(startedAtMs !== undefined ? { startedAtMs } : {}) }, mtimeMs);
}

/**
 * Whether a native-home receipt's owner is proven stopped, the rule rollback and a plan swap share: no pid it names is still
 * its process (judged by boot and start, not by the pid alone), and it is either cleanly stopped (`stopped` with no pids) or
 * still says running while the claim's own verdict proves its owner gone (`dead`: a crash, a SIGKILL or a reboot). A live,
 * starting or answering owner, or one with no receipt verdict, is never stopped.
 */
export async function nativeReceiptStopped(owner: NativeHomeOwner, mtimeMs: number, nativeHome: string, hostHome: string): Promise<"stopped" | "dead" | undefined> {
  if (await writerAlive(owner.hostPid, owner.bootId, owner.startedAtMs, mtimeMs) || await writerAlive(owner.pid, owner.sdkBootId, owner.sdkStartedAtMs, mtimeMs)) return;
  if (owner.state === "running") return ["live", "unconfirmed", "absent"].includes(await nativeHomeOwnership(nativeHome, hostHome)) ? undefined : "dead";
  return owner.state === "stopped" && owner.sdkState === "stopped" && owner.hostPid === 0 && owner.pid === 0 ? "stopped" : undefined;
}

/** Legacy fallback returns only after every managed writer is proven stopped. */
export async function archiveStoppedExecutionReceipt(identity: Omit<HostIdentity, "version" | "managed" | "socketPath">, backup: string): Promise<string | undefined> {
  const home = executionHostHome(identity.configPath, identity.nativeHome); const receipt = resolve(home, "owner.json");
  const present = await lstat(receipt).catch(error => { if (error.code === "ENOENT") return; throw error; });
  const native = await readNativeHomeOwnerRecord(identity.nativeHome); const nativeReceipt = native.owner;
  // A receipt still marked running whose owner is proven gone (a crash, a SIGKILL or a reboot) counts as stopped: it must
  // not block rollback for good. Proven gone is the claim's own verdict, so a live, starting or answering owner still blocks.
  const deadRunningNative = nativeReceipt?.state === "running" && !["live", "unconfirmed", "absent"].includes(await nativeHomeOwnership(identity.nativeHome, home));
  if (nativeReceipt && ((await writerAlive(nativeReceipt.hostPid, nativeReceipt.bootId, nativeReceipt.startedAtMs, native.mtimeMs)) || await writerAlive(nativeReceipt.pid, nativeReceipt.sdkBootId, nativeReceipt.sdkStartedAtMs, native.mtimeMs) || (!deadRunningNative && (nativeReceipt.state !== "stopped" || nativeReceipt.sdkState !== "stopped")))) {
    throw new Error("Native execution ownership is not fully stopped; legacy writers were preserved");
  }
  if (!present) {
    if (nativeReceipt?.configPath === identity.configPath) throw new Error("Native execution receipt has no matching host proof; ownership was preserved");
    return;
  }
  return withPrivateFileLock(receipt, async () => {
    const stored = await readOwnerRecord(receipt); const owner = stored.owner; if (!owner) return;
    // A gateway-only host runs its pinned runtime, so the app's codex is not part of its identity: an app update must not block rollback.
    const keys = owner.capabilities?.includes("native") ? ["configPath", "nativeHome", "codex", "sdkSha256"] as const : ["configPath", "nativeHome"] as const;
    for (const key of keys) if (owner[key] !== identity[key]) throw new Error("Execution rollback ownership does not match this migration; it was preserved");
    // A dead owner is cleared the way its claim clears it (see claimHost): a recorded socket with no identity is judged as found,
    // and the links its home holds that it never recorded go too, when nothing answers them.
    const deadRunning = owner.state === "running" && await hostOwnerLiveness(home, owner, stored.mtimeMs) !== "live";
    if (owner.socketPath !== resolve(home, "host.sock") || (!deadRunning && (owner.state !== "stopped" || owner.pid !== 0))) throw new Error("Execution host must be fully stopped before restoring legacy writers");
    const recorded = new Set<string>([owner.socketPath]);
    for (const engine of owner.generations) {
      if (!engine || !/^[a-f0-9]{64}$/.test(engine.revision) || !Number.isSafeInteger(engine.pid) || engine.pid < 0 || engine.socketPath !== resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)) throw new Error("Execution rollback generation identity is invalid; it was preserved");
      if (await receiptPidAlive(engine, stored.mtimeMs)) throw new Error("A managed execution writer is still live; rollback preserved it");
      recorded.add(engine.socketPath); await removeOwnedSocket(engine.socketPath, engine.socket, deadRunning);
    }
    const archiveNative = async () => {
      const current = await readNativeHomeOwnerRecord(identity.nativeHome);
      const expectsNative = owner.capabilities?.includes("native");
      if (!expectsNative) return;
      // Judged again under the lease's own lock: another configuration's host could have claimed the home since the first look.
      const verdict = current.owner && await nativeReceiptStopped(current.owner, current.mtimeMs, identity.nativeHome, home);
      if (!current.owner || !verdict) throw new Error("Native execution owner must be proven stopped before legacy fallback");
      const lease = current.owner;
      for (const key of ["configPath", "nativeHome", "codex", "sdkSha256", "nativeSdkExecutable", "nativeSdkSha256"] as const) {
        if (lease[key] !== owner[key]) throw new Error("Native execution rollback ownership does not match; its receipt was preserved");
      }
      if (lease.socketPath !== resolve(home, "native.sock")) throw new Error("Native execution rollback socket identity changed; it was preserved");
      // Two crashed owners may disagree on the native revision (the host died before recording the one its SDK started), and
      // neither can serve it any more, so the revision is compared only while either side could still be speaking for it.
      const bothDead = deadRunning && verdict === "dead";
      if (owner.native) {
        if (await receiptPidAlive(owner.native, stored.mtimeMs) || owner.native.socketPath !== lease.socketPath || (!bothDead && lease.revision !== owner.native.revision)) throw new Error("A native SDK writer is still live or unconfirmed; rollback preserved it");
        await removeOwnedSocket(owner.native.socketPath, owner.native.socket, deadRunning);
      } else if (!bothDead && lease.revision !== undefined) throw new Error("Native execution rollback revision is unconfirmed; it was preserved");
      const target = resolve(backup, "native-execution-owner.json");
      if (await lstat(target).catch(error => { if (error.code === "ENOENT") return; throw error; })) throw new Error("Native ownership backup already exists; its receipt was preserved");
      await rename(nativeHomeOwnerPath(identity.nativeHome), target);
    };
    await removeOwnedSocket(owner.socketPath, owner.socket, deadRunning);
    // Swept before anything is archived, so a listener nobody recorded refuses the rollback with both receipts in place.
    if (owner.native?.socketPath === resolve(home, "native.sock")) recorded.add(owner.native.socketPath);
    if (deadRunning) await removeUnrecordedLinks(home, recorded, owner.socketPath);
    await mkdir(backup, { recursive: true, mode: 0o700 }); const archive = resolve(backup, "execution-owner.json");
    if (await lstat(archive).catch(error => { if (error.code === "ENOENT") return; throw error; })) throw new Error("Execution ownership backup already exists; rollback preserved its receipt");
    if (owner.capabilities?.includes("native")) {
      if (!nativeReceipt) throw new Error("Native execution owner receipt is missing; rollback preserved its host proof");
      await withPrivateFileLock(nativeHomeOwnerPath(identity.nativeHome), archiveNative);
    }
    await rename(receipt, archive); return archive;
  });
}

/**
 * Releases only the native-home receipt of a stopped host, never the host's own owner.json. Used after a relaunch that keeps
 * gateway executors: the new host claimed owner.json already, but it does not claim the native home, so the stopped native
 * receipt would stay behind. It checks that the receipt names this configuration and native home and that its owner is
 * proven stopped by the rule rollback uses (nativeReceiptStopped: a clean stop, or a running receipt whose owner is proven
 * gone); it does not check socketPath, the Codex executable, the SDK identity or the revision.
 */
export async function archiveStoppedNativeHomeReceipt(identity: { configPath: string; nativeHome: string }, backup: string): Promise<string | undefined> {
  const receipt = nativeHomeOwnerPath(identity.nativeHome);
  if (!await lstat(receipt).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) return;
  return withPrivateFileLock(receipt, async () => {
    const stored = await readNativeHomeOwnerRecord(identity.nativeHome); const owner = stored.owner; if (!owner) return;
    if (owner.configPath !== resolve(identity.configPath) || owner.nativeHome !== resolve(identity.nativeHome)) throw new Error("The native execution receipt belongs to another configuration; it was preserved");
    if (!await nativeReceiptStopped(owner, stored.mtimeMs, identity.nativeHome, executionHostHome(identity.configPath, identity.nativeHome))) {
      throw new Error("Native execution ownership is not fully stopped; its receipt was preserved");
    }
    await mkdir(backup, { recursive: true, mode: 0o700 }); const target = resolve(backup, "native-execution-owner.json");
    if (await lstat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Native ownership backup already exists; its receipt was preserved");
    await rename(receipt, target); return target;
  });
}
