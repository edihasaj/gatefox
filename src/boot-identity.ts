import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { uptime } from "node:os";

/**
 * Which boot this machine is in, and whether a receipt's owner can still be running.
 * A process killed by a reboot leaves its receipts and socket links behind, and its pid can be
 * handed to an unrelated program afterwards. Both are answered here so no ownership path trusts a
 * bare `kill(pid, 0)` again. Nothing about a foreign machine's identity is ever logged.
 */

/** A receipt file last written this long before the current boot started cannot be from this boot. */
const bootGraceMs = 60_000;
/** Tolerance between a recorded process start and the one the operating system reports. */
const startSkewMs = 2_000;

export interface BootIdentity { id?: string; bootedAtMs: number }
export interface OwnerRecord { pid: number; bootId?: string; startedAtMs?: number }
export type ProcessStartReader = (pid: number) => Promise<number | undefined>;

const bootIdPattern = /^[0-9a-fA-F][0-9a-fA-F-]{6,63}$/;
let identity: Promise<BootIdentity> | undefined;
let injected: BootIdentity | undefined;
let startReader: ProcessStartReader | undefined;
let ownStart: number | undefined;
/** Bumped by every reader change, so a read that was already under way cannot cache the previous reader's answer. */
let ownStartReader = 0;
let ownPidForTests: number | undefined;

/** An estimate of when this process started. Never recorded in a receipt: it drifts from the kernel's record (see `ownStartMs`). */
export function thisProcessStartMs(): number { return Math.round(Date.now() - Math.max(0, process.uptime() * 1000)) }

export function bootIdentity(): Promise<BootIdentity> {
  identity ??= injected ? Promise.resolve(injected) : readBootIdentity();
  return identity;
}
/** Tests pin the boot and never touch a real machine's identity. Undefined restores the probe. */
export function setBootIdentityForTests(value?: BootIdentity): void { injected = value; identity = undefined; }
/** `ps` is not always runnable, so callers under test supply the start time instead. It also restamps this process. */
export function setProcessStartReaderForTests(reader?: ProcessStartReader): void { startReader = reader; ownStart = undefined; ownStartReader++; }
/** The pid whose receipts are this process's own leftovers. Production: always this process. */
export function ownPid(): number { return ownPidForTests ?? process.pid; }
/**
 * A test that starts a host inside its own process cannot have that host's receipt read as a leftover
 * of a failed start, because in production the host is a process of its own. This points the rule at a
 * pid no process can be holding (never signalled, only compared). Production never calls it.
 */
export function setOwnPidForTests(pid?: number): void { ownPidForTests = pid; }

/** When the operating system says the process started, from the one source every liveness check reads. */
export function processStartMs(pid: number): Promise<number | undefined> { return (startReader ?? readProcessStartMs)(pid); }
/**
 * This process's own start, from the same source a checker uses. A start computed from the uptime drifts from the
 * kernel's record by a few parts per million, which outgrows the skew in days, so it is never a substitute. Only an
 * answer is kept: when `ps` fails there is no start, and the next stamp asks again instead of reusing a guess made
 * at first use, which could be days after this process started.
 */
export async function ownStartMs(): Promise<number | undefined> {
  if (ownStart !== undefined) return ownStart;
  const reader = ownStartReader;
  const started = await processStartMs(process.pid).catch(() => undefined);
  if (started !== undefined && reader === ownStartReader) ownStart ??= started;
  return started;
}

/**
 * The fields a new receipt records about the process it names. Without a start from the operating system the receipt
 * records none: a checker then skips the start comparison and keeps the owner while its pid answers, which errs toward
 * blocking, and the boot stamp still tells a reboot apart.
 */
export async function ownerStamp(): Promise<{ bootId?: string; startedAtMs?: number }> {
  const boot = await bootIdentity(); const started = await ownStartMs();
  return { ...(boot.id ? { bootId: boot.id } : {}), ...(started !== undefined ? { startedAtMs: started } : {}) };
}
/** What a receipt records about a child it started just now: the kernel's start when it answers, else the time of the spawn. */
export async function spawnStamp(pid?: number): Promise<{ bootId?: string; startedAtMs: number }> {
  const spawnedAtMs = Date.now(); const boot = await bootIdentity();
  const started = pid ? await processStartMs(pid).catch(() => undefined) : undefined;
  return { ...(boot.id ? { bootId: boot.id } : {}), startedAtMs: started ?? spawnedAtMs };
}

/** True when the receipt cannot belong to this boot. `mtimeMs` is the receipt file's own time. */
export async function fromPreviousBoot(record: { bootId?: string }, mtimeMs = Number.POSITIVE_INFINITY): Promise<boolean> {
  const boot = await bootIdentity();
  if (record.bootId !== undefined && boot.id !== undefined) return record.bootId !== boot.id;
  return mtimeMs < boot.bootedAtMs - bootGraceMs;
}

/** True only when the named process can still be this machine's own owner right now. */
export async function ownerAlive(record: OwnerRecord, mtimeMs = Number.POSITIVE_INFINITY): Promise<boolean> {
  if (await fromPreviousBoot({ bootId: record.bootId }, mtimeMs)) return false;
  return processAlive(record);
}
/**
 * The process half of the rule, with no file time in it: a pid that is gone, somebody else's, this very
 * process, or a different process that reused the pid is not alive. Locks use only this half, because a
 * clock that steps forward makes a live lock's file time look older than the boot.
 */
export async function processAlive(record: { pid: number; startedAtMs?: number }): Promise<boolean> {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) return false;
  if (record.pid === ownPid()) return false; // A leftover from an earlier attempt inside this very process.
  try { process.kill(record.pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false; // Gone, or somebody else's: never this gateway's owner.
    return true; // An unexpected answer is not proof of death.
  }
  if (record.startedAtMs !== undefined) {
    const started = await processStartMs(record.pid).catch(() => undefined);
    if (started !== undefined && Math.abs(started - record.startedAtMs) > startSkewMs) return false; // The pid was reused.
  }
  return true;
}

/** True when the pid cannot be the writer of a lock file last touched at `writtenAtMs`. */
export async function processStartedAfter(pid: number, writtenAtMs: number): Promise<boolean> {
  const started = await processStartMs(pid).catch(() => undefined);
  return started !== undefined && started > writtenAtMs + startSkewMs;
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * Reads `ps -o lstart=` output that was printed in UTC with the C locale ("Sat Oct 17 01:08:03 2026").
 * Parsing it as UTC keeps a daylight-saving fall-back hour or a time-zone change from moving it.
 */
export function parsePsStart(text: string): number | undefined {
  const match = /^(?:[A-Z][a-z]{2})\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text.trim());
  if (!match) return;
  const month = months.indexOf(match[1]); if (month < 0) return;
  const [day, hour, minute, second, year] = [match[2], match[3], match[4], match[5], match[6]].map(Number);
  if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return;
  const started = Date.UTC(year, month, day, hour, minute, second);
  return Number.isFinite(started) ? started : undefined;
}

async function readBootIdentity(): Promise<BootIdentity> {
  // A machine that will not report its uptime gives no boot-time guess: 0 keeps the mtime rule silent.
  let bootedAtMs = 0;
  try { bootedAtMs = Math.round(Date.now() - Math.max(0, uptime() * 1000)); } catch { /* Sandboxed or unsupported. */ }
  if (process.platform !== "darwin" && process.platform !== "linux") return { bootedAtMs };
  const id = process.platform === "darwin" ? await sysctl("kern.bootsessionuuid") : await fileBootId();
  return id ? { id, bootedAtMs } : { bootedAtMs };
}
async function sysctl(name: string): Promise<string | undefined> {
  try {
    const { stdout } = await execute("/usr/sbin/sysctl", ["-n", name]);
    return bootIdPattern.test(stdout.trim()) ? stdout.trim() : undefined;
  } catch { return undefined; }
}
async function fileBootId(): Promise<string | undefined> {
  const value = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => undefined);
  const id = value?.trim();
  return id && bootIdPattern.test(id) ? id : undefined;
}
async function readProcessStartMs(pid: number): Promise<number | undefined> {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  try {
    // The C locale and UTC make the output one fixed format whatever this process's zone or language is.
    const { stdout } = await execute("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { LC_ALL: "C", TZ: "UTC" });
    return parsePsStart(stdout);
  } catch { return undefined; }
}
function execute(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ stdout: string }> {
  return new Promise((done, failed) => {
    execFile(command, args, { timeout: 2000, maxBuffer: 8192, ...(env ? { env } : {}) }, (error, stdout) => error ? failed(error) : done({ stdout }));
  });
}
