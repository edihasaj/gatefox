import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { accountDirectory, ensureAccountDirectory } from "./account-engine-home.js";
import { livePid } from "./execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";

/** One owner per account home: the refresh lock inside Codex is per process only. */
export type LeaseHolder = "login" | "connection" | "host";
export interface AccountLease { version: 1; pid: number; startedAt: number; acquiredAt: number; holder: LeaseHolder; nonce: string }
export const accountLeasePath = (state: string, id: string): string => join(accountDirectory(state, id), "engine.lease");
// Process start as wall-clock milliseconds; a recorded pid with another start time is a reused pid.
export const processStartedAt = (): number => Math.round(Date.now() - process.uptime() * 1000);
const startSlackMs = 5000;

async function readLease(path: string): Promise<AccountLease | undefined | "invalid"> {
  const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 1024) throw new Error("Account lease is not a private file owned by this user");
  try {
    const lease = JSON.parse(await readFile(path, "utf8")) as AccountLease;
    if (lease?.version !== 1 || !Number.isSafeInteger(lease.pid) || lease.pid < 1 || !Number.isSafeInteger(lease.startedAt) || !Number.isSafeInteger(lease.acquiredAt)
      || !["login", "connection", "host"].includes(lease.holder) || typeof lease.nonce !== "string") return "invalid";
    return lease;
  } catch { return "invalid"; }
}

/** The kernel's start time for pid, or undefined when ps cannot tell. */
function startTime(pid: number): Promise<number | undefined> {
  return new Promise(resolve => execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 2000 }, (error, stdout) => {
    const parsed = Date.parse(String(stdout).trim().replace(/\s+/g, " "));
    resolve(error || !Number.isFinite(parsed) ? undefined : parsed);
  }));
}

/** Live when the pid runs and started when the lease says. An unreadable start time counts as live (fail closed). */
async function live(lease: AccountLease): Promise<boolean> {
  if (!livePid(lease.pid)) return false;
  if (lease.pid === process.pid) return Math.abs(lease.startedAt - processStartedAt()) <= startSlackMs;
  const started = await startTime(lease.pid);
  if (started === undefined) return livePid(lease.pid);
  return Math.abs(lease.startedAt - started) <= startSlackMs;
}

/** Returns a release function, or undefined while another live process (or this one) holds the account. */
export async function acquireAccountLease(state: string, id: string, holder: LeaseHolder): Promise<(() => Promise<void>) | undefined> {
  await ensureAccountDirectory(state, id); const path = accountLeasePath(state, id);
  const lease: AccountLease = { version: 1, pid: process.pid, startedAt: processStartedAt(), acquiredAt: Date.now(), holder, nonce: randomBytes(12).toString("hex") };
  const acquired = await withPrivateFileLock(path, async () => {
    const current = await readLease(path);
    if (current === "invalid") {
      // Another writer may still be filling a new lease; only an old unreadable lease is replaced.
      if (Date.now() - (await lstat(path)).mtimeMs < startSlackMs) return false;
      await unlink(path);
    } else if (current) { if (await live(current)) return false; await unlink(path); }
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(lease) + "\n"); await file.sync(); } finally { await file.close(); }
    return true;
  });
  if (!acquired) return;
  let released = false;
  return async () => {
    if (released) return; released = true;
    await withPrivateFileLock(path, async () => {
      const current = await readLease(path).catch(() => undefined);
      if (current && current !== "invalid" && current.nonce === lease.nonce && current.pid === process.pid) await unlink(path);
    });
  };
}

/** The current live holder, or undefined. Never removes anything. */
export async function inspectAccountLease(state: string, id: string): Promise<{ holder: LeaseHolder; pid: number; acquiredAt: number } | undefined> {
  const current = await readLease(accountLeasePath(state, id));
  if (!current || current === "invalid" || !await live(current)) return;
  return { holder: current.holder, pid: current.pid, acquiredAt: current.acquiredAt };
}
