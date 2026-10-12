import { lstat, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { executionHostHome, readOwner, livePid, removeOwnedSocket, type HostIdentity } from "./execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { nativeHomeOwnerPath, readNativeHomeOwner } from "./native-execution-host-storage.js";

/** Legacy fallback returns only after every managed writer is proven stopped. */
export async function archiveStoppedExecutionReceipt(identity: Omit<HostIdentity, "version" | "managed" | "socketPath">, backup: string): Promise<string | undefined> {
  const home = executionHostHome(identity.configPath, identity.nativeHome); const receipt = resolve(home, "owner.json");
  const present = await lstat(receipt).catch(error => { if (error.code === "ENOENT") return; throw error; });
  const nativeReceipt = await readNativeHomeOwner(identity.nativeHome);
  if (nativeReceipt && (livePid(nativeReceipt.hostPid) || livePid(nativeReceipt.pid) || nativeReceipt.state !== "stopped" || nativeReceipt.sdkState !== "stopped")) {
    throw new Error("Native execution ownership is not fully stopped; legacy writers were preserved");
  }
  if (!present) {
    if (nativeReceipt?.configPath === identity.configPath) throw new Error("Native execution receipt has no matching host proof; ownership was preserved");
    return;
  }
  return withPrivateFileLock(receipt, async () => {
    const owner = await readOwner(receipt); if (!owner) return;
    for (const key of ["configPath", "nativeHome", "codex", "sdkSha256"] as const) if (owner[key] !== identity[key]) throw new Error("Execution rollback ownership does not match this migration; it was preserved");
    if (owner.socketPath !== resolve(home, "host.sock") || owner.state !== "stopped" || owner.pid !== 0) throw new Error("Execution host must be fully stopped before restoring legacy writers");
    for (const engine of owner.generations) {
      if (!engine || !/^[a-f0-9]{64}$/.test(engine.revision) || !Number.isSafeInteger(engine.pid) || engine.pid < 0 || engine.socketPath !== resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)) throw new Error("Execution rollback generation identity is invalid; it was preserved");
      if (livePid(engine.pid)) throw new Error("A managed execution writer is still live; rollback preserved it");
      await removeOwnedSocket(engine.socketPath, engine.socket);
    }
    const archiveNative = async () => {
      const current = await readNativeHomeOwner(identity.nativeHome);
      const expectsNative = owner.capabilities?.includes("native");
      if (!expectsNative) return;
      if (!current || current.state !== "stopped" || current.sdkState !== "stopped" || current.hostPid !== 0 || current.pid !== 0) throw new Error("Native execution owner must be proven stopped before legacy fallback");
      for (const key of ["configPath", "nativeHome", "codex", "sdkSha256", "nativeSdkExecutable", "nativeSdkSha256"] as const) {
        if (current[key] !== owner[key]) throw new Error("Native execution rollback ownership does not match; its receipt was preserved");
      }
      if (current.socketPath !== resolve(home, "native.sock")) throw new Error("Native execution rollback socket identity changed; it was preserved");
      if (owner.native) {
        if (livePid(owner.native.pid) || owner.native.socketPath !== current.socketPath || current.revision !== owner.native.revision) throw new Error("A native SDK writer is still live or unconfirmed; rollback preserved it");
        await removeOwnedSocket(owner.native.socketPath, owner.native.socket);
      } else if (current.revision !== undefined) throw new Error("Native execution rollback revision is unconfirmed; it was preserved");
      const target = resolve(backup, "native-execution-owner.json");
      if (await lstat(target).catch(error => { if (error.code === "ENOENT") return; throw error; })) throw new Error("Native ownership backup already exists; its receipt was preserved");
      await rename(nativeHomeOwnerPath(identity.nativeHome), target);
    };
    await removeOwnedSocket(owner.socketPath, owner.socket);
    await mkdir(backup, { recursive: true, mode: 0o700 }); const archive = resolve(backup, "execution-owner.json");
    if (await lstat(archive).catch(error => { if (error.code === "ENOENT") return; throw error; })) throw new Error("Execution ownership backup already exists; rollback preserved its receipt");
    if (owner.capabilities?.includes("native")) {
      if (!nativeReceipt) throw new Error("Native execution owner receipt is missing; rollback preserved its host proof");
      await withPrivateFileLock(nativeHomeOwnerPath(identity.nativeHome), archiveNative);
    }
    await rename(receipt, archive); return archive;
  });
}
