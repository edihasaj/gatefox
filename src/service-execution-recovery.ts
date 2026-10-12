import { lstat, mkdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { executionHostHome, readOwner, livePid, removeOwnedSocket, type HostIdentity } from "./execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";

/** Legacy fallback returns only after every managed writer is proven stopped. */
export async function archiveStoppedExecutionReceipt(identity: Omit<HostIdentity, "version" | "managed" | "socketPath">, backup: string): Promise<string | undefined> {
  const home = executionHostHome(identity.configPath, identity.nativeHome); const receipt = resolve(home, "owner.json");
  const present = await lstat(receipt).catch(error => { if (error.code === "ENOENT") return; throw error; }); if (!present) return;
  return withPrivateFileLock(receipt, async () => {
    const owner = await readOwner(receipt); if (!owner) return;
    for (const key of ["configPath", "nativeHome", "codex", "sdkSha256"] as const) if (owner[key] !== identity[key]) throw new Error("Execution rollback ownership does not match this migration; it was preserved");
    if (owner.socketPath !== resolve(home, "host.sock") || owner.state !== "stopped" || owner.pid !== 0) throw new Error("Execution host must be fully stopped before restoring legacy writers");
    for (const engine of owner.generations) {
      if (!engine || !/^[a-f0-9]{64}$/.test(engine.revision) || !Number.isSafeInteger(engine.pid) || engine.pid < 0 || engine.socketPath !== resolve(home, `e-${engine.revision.slice(0, 16)}.sock`)) throw new Error("Execution rollback generation identity is invalid; it was preserved");
      if (livePid(engine.pid)) throw new Error("A managed execution writer is still live; rollback preserved it");
      await removeOwnedSocket(engine.socketPath, engine.socket);
    }
    await removeOwnedSocket(owner.socketPath, owner.socket);
    await mkdir(backup, { recursive: true, mode: 0o700 }); const archive = resolve(backup, "execution-owner.json");
    if (await lstat(archive).catch(error => { if (error.code === "ENOENT") return; throw error; })) throw new Error("Execution ownership backup already exists; rollback preserved its receipt");
    await rename(receipt, archive); return archive;
  });
}
