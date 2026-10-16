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

/** Outcome of a reuse attempt. `replace` is a decision, not an action: a live listener running
 * another release should be retired, but nothing has been unlinked yet. The caller hands it to
 * `serveUnix`, which carries the swap out inside its publish lock right after binding, so a
 * bootstrap whose preparation fails leaves the old listener serving new connections. */
export interface SshSocketReuse { reused: boolean; replace?: SshSocketReplacement }

/** The listener to retire at bind time: the releases on either side of the swap and the
 * inode/device the public alias had when the decision was made. */
export interface SshSocketReplacement { from: string; to: string; inode: string; device: string }

/**
 * Validate a deferred replacement without changing anything: report whether the public alias
 * still points at the recorded listener (a private socket owned by this user, matching the
 * recorded inode/device). The unlink itself now happens inside `serveUnix`'s publish lock, so
 * this remains a check for callers that want to know whether a replacement decision is still
 * live. A false return means the alias is gone or already belongs to another listener.
 */
export async function replaceSshListener(path: string, target: SshSocketReplacement): Promise<boolean> {
  return withPrivateFileLock(path + ".gateway-lease", async () => {
    const info = await lstat(path, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info || !info.isSocket() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o077n) !== 0n) return false;
    return String(info.ino) === target.inode && String(info.dev) === target.device;
  });
}

async function inspectSshSocket(path: string, state: ReleaseState | undefined): Promise<SshSocketReuse> {
  const info = await lstat(path, { bigint: true }).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info) return { reused: false };
  const leasePath = path + ".gateway-lease";
  const file = await lstat(leasePath);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size > 4096) throw new Error("SSH socket ownership record is unavailable");
  let lease: { inode?: string; device?: string; boundPath?: string; release?: string };
  try { lease = JSON.parse(await readFile(leasePath, "utf8")); }
  catch { throw new Error("SSH socket ownership record is invalid"); }
  if (!lease || typeof lease !== "object" || typeof lease.inode !== "string" || typeof lease.device !== "string") throw new Error("SSH socket ownership record is invalid");
  // Leases written before 0.4.4 carry no release. Anything else must look like a release name.
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
    // release would pin every reconnect to it, and a bootstrap on the installed release must
    // retire it. Only the decision happens here: the alias is unlinked at bind time, inside
    // serveUnix's publish lock, so a bootstrap that fails its preparation leaves this listener
    // serving. A name outside the shared pattern can never match a lease, so it must not
    // replace either.
    if (state && state.installed === state.running && releasePattern.test(state.running) && lease.release !== state.running) {
      return { reused: false, replace: { from: lease.release ?? "unknown", to: state.running, inode: lease.inode, device: lease.device } };
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
