import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { verifySignature } from "./app-background.js";
import { processStartMs } from "./boot-identity.js";
import { bootoutJob } from "./launchctl.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { ClaudeRefusal, ClaudeRetirementError } from "./service-claude-legacy.js";
import { atomicWrite, decodePlistWithPlutil, randomId, readRegularFile, sha256, type Plist } from "./service-claude-io.js";
import { pendingClaudeConsolidationPath, type PendingClaudeConsolidation, type ReceiptJob } from "./service-claude-receipt.js";
import { readPendingNativeSharing } from "./service-native-staging.js";
import { serviceLabel } from "./service-plan.js";
import { telemetry } from "./telemetry.js";

const exec = promisify(execFile);
export const maximumLegacyPlistBytes = 16 * 1024;
const startSkewMs = 2000;

export interface Launchd {
  /** Rejects when launchd's answer cannot be trusted; a job that is simply not loaded answers `{ loaded: false }`. */
  print(label: string): Promise<{ loaded: boolean; pid?: number }>;
  disabled(label: string): Promise<boolean>;
  bootout(label: string): Promise<void>;
  bootstrap(plistPath: string): Promise<void>;
}
export interface Processes {
  census(): Promise<Array<{ pid: number; args: string }>>;
  alive(pid: number): boolean;
  startMs(pid: number): Promise<number | undefined>;
  /** Whether the process holds an established TCP connection (`lsof -a`); rejects when that cannot be answered. */
  established(pid: number): Promise<boolean>;
}
export interface ClaudeHost {
  platform: string; home: string; uid: number;
  launchd: Launchd; processes: Processes;
  primary(): Promise<boolean>;
  decodePlist(bytes: Buffer): Promise<Plist>;
  verifySignature(app: string, helper: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  pendingLogin(state: string): Promise<unknown>;
  pendingNative(state: string): Promise<unknown>;
  /** The plan commit; isolated so tests can fail it before or after it renames. */
  commit(path: string, text: string): Promise<void>;
  wait(ms: number): Promise<void>;
  settleTries: number; settleMs: number;
  notice(event: string, fields: Record<string, string | number>): void;
}
export type ClaudeDependencies = Partial<Omit<ClaudeHost, "launchd" | "processes">> & { launchd?: Partial<Launchd>; processes?: Partial<Processes> };

function systemLaunchd(uid: number): Launchd {
  const domain = `gui/${uid}`;
  return {
    async print(label) {
      try {
        const { stdout } = await exec("/bin/launchctl", ["print", `${domain}/${label}`], { timeout: 5000 });
        return { loaded: true, pid: Number(String(stdout).match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
      } catch (error) {
        if (/Could not find (?:specified )?service/.test(String((error as { stderr?: unknown }).stderr))) return { loaded: false };
        throw new Error("Cannot verify launchd state");
      }
    },
    async disabled(label) {
      const { stdout } = await exec("/bin/launchctl", ["print-disabled", domain], { timeout: 5000 });
      return String(stdout).split("\n").some(line => line.includes(`"${label}"`) && /=>\s*(?:true|disabled)\b/.test(line));
    },
    async bootout(label) { await bootoutJob(`${domain}/${label}`); },
    async bootstrap(plistPath) { await exec("/bin/launchctl", ["bootstrap", domain, plistPath], { timeout: 10000 }); },
  };
}

const systemProcesses: Processes = {
  async census() {
    const { stdout } = await exec("/bin/ps", ["-axww", "-o", "pid=,args="], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    return String(stdout).split("\n").flatMap(line => { const match = line.match(/^\s*(\d+)\s+(.*)$/); return match ? [{ pid: Number(match[1]), args: match[2]! }] : []; });
  },
  alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } },
  startMs: pid => processStartMs(pid).catch(() => undefined),
  async established(pid) {
    try {
      const { stdout } = await exec("/usr/sbin/lsof", ["-a", "-nP", "-iTCP", "-sTCP:ESTABLISHED", "-p", String(pid)], { timeout: 5000, maxBuffer: 1 << 20 });
      return String(stdout).trim() !== "";
    } catch (error) {
      const failure = error as { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
      // lsof exits 1 with no output when nothing matches; a timeout kill, a signal or any other failure leaves the question unanswered.
      if (failure.code === 1 && !failure.killed && !failure.signal && String(failure.stdout ?? "").trim() === "" && String(failure.stderr ?? "").trim() === "") return false;
      throw new Error("Cannot determine process connections");
    }
  },
};

export function claudeHost(overrides: ClaudeDependencies = {}): ClaudeHost {
  const uid = overrides.uid ?? process.getuid?.() ?? -1;
  const launchd: Launchd = { ...systemLaunchd(uid), ...overrides.launchd };
  const processes: Processes = { ...systemProcesses, ...overrides.processes };
  const { launchd: _launchd, processes: _processes, ...rest } = overrides; void _launchd; void _processes;
  return {
    platform: process.platform, home: homedir(), uid, launchd, processes,
    primary: async () => { try { const job = await launchd.print(serviceLabel); return job.loaded && job.pid === process.pid; } catch { return false; } },
    decodePlist: decodePlistWithPlutil, verifySignature, realpath: path => realpath(path),
    pendingLogin: readPendingLoginConsolidation, pendingNative: readPendingNativeSharing,
    commit: (path, text) => atomicWrite(path, text),
    wait: ms => new Promise(done => setTimeout(done, ms)), settleTries: 120, settleMs: 250,
    notice: (event, fields) => { try { telemetry(event, fields); } catch { /* Observability never changes the outcome. */ } },
    ...rest,
  };
}

export async function executableFile(path: string): Promise<boolean> {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) return false; await access(path, constants.X_OK); return true; } catch { return false; }
}

export const livePlistPath = (host: ClaudeHost, label: string): string => join(host.home, "Library", "LaunchAgents", `${label}.plist`);

/**
 * The exact legacy process is gone only when (with `census`) no process runs its argument line and the recorded pid is
 * either dead or provably a different process (its start differs). Any question that cannot be answered counts as "not gone".
 * A caller that knows the app-owned replacement could run an identical argument line passes `census: false`.
 */
export async function oldProcessGone(host: ClaudeHost, job: ReceiptJob, census = true): Promise<boolean> {
  if (census) {
    const line = job.argv.join(" ");
    if ((await host.processes.census()).some(row => row.args === line)) return false;
  }
  if (job.pid !== undefined && host.processes.alive(job.pid)) {
    if (job.startedAtMs === undefined) return false;
    const started = await host.processes.startMs(job.pid);
    if (started === undefined || Math.abs(started - job.startedAtMs) <= startSkewMs) return false;
  }
  return true;
}

async function settle(host: ClaudeHost, job: ReceiptJob): Promise<void> {
  for (let attempt = 0; attempt < host.settleTries; attempt++) {
    if (!(await host.launchd.print(job.label)).loaded && await oldProcessGone(host, job)) return;
    await host.wait(host.settleMs);
  }
  throw new ClaudeRetirementError("A legacy Claude job or its process did not stop");
}

async function exactLivePlist(host: ClaudeHost, job: ReceiptJob): Promise<boolean> {
  const live = await readRegularFile(livePlistPath(host, job.label), maximumLegacyPlistBytes, false);
  return !!live && sha256(live.bytes) === job.plistSha256;
}

export interface LiveIdentity { loaded: boolean; pid?: number; startedAtMs?: number }

/**
 * Binds a job's live launchd registration to its frozen definition. The disk plist is not the loaded definition, so the
 * running pid's actual command line must equal the frozen legacy argv, and an unloaded label must have no such process.
 * Anything that cannot be answered is a refusal.
 */
export async function liveIdentity(host: ClaudeHost, job: ReceiptJob): Promise<LiveIdentity> {
  const line = job.argv.join(" ");
  let status: { loaded: boolean; pid?: number }; let rows: Array<{ pid: number; args: string }>;
  try { status = await host.launchd.print(job.label); rows = await host.processes.census(); }
  catch { throw new ClaudeRefusal("launchd_unknown"); }
  if (!status.loaded) {
    if (rows.some(row => row.args === line)) throw new ClaudeRefusal("unmanaged_process");
    return { loaded: false };
  }
  if (!status.pid) throw new ClaudeRefusal("identity_unknown");
  if (!rows.some(row => row.pid === status.pid && row.args === line)) throw new ClaudeRefusal("process_mismatch");
  const started = await host.processes.startMs(status.pid).catch(() => undefined);
  if (started === undefined) throw new ClaudeRefusal("identity_unknown");
  return { loaded: true, pid: status.pid, startedAtMs: started };
}

/** Stops one verified legacy job, proves job and old process are gone, then archives its plist privately. Never loads anything new. */
export async function retireJob(host: ClaudeHost, receipt: PendingClaudeConsolidation, job: ReceiptJob): Promise<void> {
  if (!await exactLivePlist(host, job)) throw new ClaudeRetirementError("A legacy Claude plist changed during retirement");
  // The registration may have been swapped since the preflight: it must still be the journaled process before it is stopped.
  const live = await liveIdentity(host, job);
  const same = live.loaded === (job.loaded === true) && live.pid === job.pid
    && (live.startedAtMs === undefined ? job.startedAtMs === undefined : job.startedAtMs !== undefined && Math.abs(live.startedAtMs - job.startedAtMs) <= startSkewMs);
  if (!same) throw new ClaudeRetirementError("A legacy Claude job changed after the journal was written");
  if (live.loaded) await host.launchd.bootout(job.label);
  await settle(host, job);
  if (!await exactLivePlist(host, job)) throw new ClaudeRetirementError("A legacy Claude plist changed during retirement");
  const archive = join(receipt.backup, `retired-${job.label}.${randomId()}.plist`);
  await rename(livePlistPath(host, job.label), archive);
  const moved = await readRegularFile(archive, maximumLegacyPlistBytes, false);
  if (!moved || sha256(moved.bytes) !== job.plistSha256) throw new ClaudeRetirementError("A legacy Claude plist changed while it was archived");
}

/**
 * Puts the exact old jobs back from the receipt's own bytes. A loaded job is left running; a job that was running when
 * retirement began is bootstrapped only after its old process is proven gone; a job that was not running is restored but
 * never started. Every job is attempted independently, and failures are reported as one fixed aggregate without details.
 */
async function restoreJob(host: ClaudeHost, job: ReceiptJob): Promise<void> {
  const live = livePlistPath(host, job.label);
  const current = await readRegularFile(live, maximumLegacyPlistBytes, false);
  if (current && sha256(current.bytes) !== job.plistSha256) throw new ClaudeRetirementError("A foreign file occupies a legacy Claude job path");
  if (!current) await atomicWrite(live, Buffer.from(job.plistBase64, "base64"), job.mode, true);
  if ((await host.launchd.print(job.label)).loaded) return;
  if (job.loaded !== true) return;
  if (!await oldProcessGone(host, job)) throw new ClaudeRetirementError("A legacy Claude process may still be running; it was not restarted");
  await host.launchd.bootstrap(live);
  if (!(await host.launchd.print(job.label)).loaded) throw new ClaudeRetirementError("A legacy Claude job did not load again");
}

export async function restoreLegacy(host: ClaudeHost, receipt: PendingClaudeConsolidation): Promise<void> {
  let failed = 0;
  for (const job of receipt.jobs) {
    try { await restoreJob(host, job); } catch { failed++; }
  }
  if (failed) throw new ClaudeRetirementError(`${failed} legacy Claude job(s) could not be restored safely; the recoverable journal was kept`);
}

/** Moves the receipt into its private backup directory; callers decide whether a failure matters. */
export async function archiveReceipt(state: string, receipt: PendingClaudeConsolidation, outcome: string): Promise<void> {
  await rename(pendingClaudeConsolidationPath(state), join(receipt.backup, `claude-${outcome}.${randomId()}.json`));
}

/** Archives a leftover legacy plist only when it is byte-identical to the frozen one. */
export async function archiveExactLegacyPlist(host: ClaudeHost, receipt: PendingClaudeConsolidation, job: ReceiptJob): Promise<void> {
  const live = await readRegularFile(livePlistPath(host, job.label), maximumLegacyPlistBytes, false);
  if (!live) return;
  if (sha256(live.bytes) !== job.plistSha256) throw new ClaudeRetirementError("A foreign file occupies a retired Claude job path");
  await rename(livePlistPath(host, job.label), join(receipt.backup, `retired-${job.label}.${randomId()}.plist`));
}
