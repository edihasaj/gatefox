import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { lstat, readFile, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { withPrivateFileLock } from "./private-file-lock.js";
import { releasePattern, releaseState, type ReleaseState } from "./self-update.js";

export function sshControlHome(configPath: string, nativeHome = process.env.CODEX_HOME || resolve(homedir(), ".codex")): string {
  const scope = createHash("sha256").update(resolve(configPath) + "\0" + resolve(nativeHome)).digest("hex").slice(0, 16);
  return resolve(homedir(), ".local/state/gw-ssh", scope);
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

/** Outcome of a reuse attempt. `replaced` names the releases on either side of a live
 * listener this bootstrap retired; the caller records the event once its own telemetry
 * is configured, because the bootstrap runs before that happens. */
export interface SshSocketReuse { reused: boolean; replaced?: { from: string; to: string } }

async function inspectSshSocket(path: string, state: ReleaseState | undefined): Promise<SshSocketReuse> {
  const info = await lstat(path, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return { reused: false };
  const leasePath = path + ".gateway-lease";
  const file = await lstat(leasePath);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 4096) throw new Error("SSH socket ownership record is unavailable");
  let lease: { inode?: string; device?: string; boundPath?: string; release?: string };
  try { lease = JSON.parse(await readFile(leasePath, "utf8")); }
  catch { throw new Error("SSH socket ownership record is invalid"); }
  if (!lease || typeof lease !== "object") throw new Error("SSH socket ownership record is invalid");
  // Leases written before 0.4.2 carry no release. Anything else must look like a release name.
  if (lease.release !== undefined && !(typeof lease.release === "string" && releasePattern.test(lease.release))) throw new Error("SSH socket ownership record is invalid");
  const owned = (value: NonNullable<typeof info>) => value.isSocket() && value.uid === BigInt(process.getuid!()) && (value.mode & 0o077n) === 0n && String(value.ino) === lease.inode && String(value.dev) === lease.device;
  if (!owned(info) || typeof lease.boundPath !== "string" || dirname(lease.boundPath) !== dirname(path) || !lease.boundPath.split("/").at(-1)?.startsWith(".gw-")) throw new Error("SSH socket belongs to another listener; it was not replaced");
  const live = await new Promise<boolean>((resolve, reject) => {
    const socket = connect(path); const timer = setTimeout(() => { socket.destroy(); reject(new Error("SSH socket liveness probe timed out")); }, 1500);
    const finish = (value: boolean) => { clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.once("connect", () => finish(true));
    socket.once("error", error => { if (["ECONNREFUSED", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")) finish(false); else { clearTimeout(timer); reject(error); } });
  });
  if (live) {
    // A listener keeps running the release it bound with, so a live listener on another
    // release would pin every reconnect to it. Retire it when this bootstrap is the
    // installed release; its open sessions finish on its bound socket untouched. A name
    // outside the shared pattern can never match a lease, so it must not replace either.
    if (state && state.installed === state.running && releasePattern.test(state.running) && lease.release !== state.running) {
      const current = await lstat(path, { bigint: true }).catch(() => undefined);
      if (!current || !owned(current)) throw new Error("SSH socket changed during recovery; retry the connection");
      await unlink(path);
      return { reused: false, replaced: { from: lease.release ?? "unknown", to: state.running } };
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
