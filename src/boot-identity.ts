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
let ownPidForTests: number | undefined;

/** When this process started, which is what a receipt records for its own owner. */
export function thisProcessStartMs(): number { return Math.round(Date.now() - Math.max(0, process.uptime() * 1000)) }

export function bootIdentity(): Promise<BootIdentity> {
  identity ??= injected ? Promise.resolve(injected) : readBootIdentity();
  return identity;
}
/** Tests pin the boot and never touch a real machine's identity. Undefined restores the probe. */
export function setBootIdentityForTests(value?: BootIdentity): void { injected = value; identity = undefined; }
/** `ps` is not always runnable, so callers under test supply the start time instead. */
export function setProcessStartReaderForTests(reader?: ProcessStartReader): void { startReader = reader; }
/** The pid whose receipts are this process's own leftovers. Production: always this process. */
export function ownPid(): number { return ownPidForTests ?? process.pid; }
/**
 * A test that starts a host inside its own process cannot have that host's receipt read as a leftover
 * of a failed start, because in production the host is a process of its own. This points the rule at a
 * pid no process can be holding (never signalled, only compared). Production never calls it.
 */
export function setOwnPidForTests(pid?: number): void { ownPidForTests = pid; }

/** The fields a new receipt records about the process it names. */
export async function ownerStamp(): Promise<{ bootId?: string; startedAtMs: number }> {
  const boot = await bootIdentity();
  return { ...(boot.id ? { bootId: boot.id } : {}), startedAtMs: thisProcessStartMs() };
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
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) return false;
  if (record.pid === ownPid()) return false; // A leftover from an earlier attempt inside this very process.
  try { process.kill(record.pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") return false; // Gone, or somebody else's: never this gateway's owner.
    return true; // An unexpected answer is not proof of death.
  }
  if (record.startedAtMs !== undefined) {
    const started = await (startReader ?? readProcessStartMs)(record.pid);
    if (started !== undefined && Math.abs(started - record.startedAtMs) > startSkewMs) return false; // The pid was reused.
  }
  return true;
}

/** True when the pid cannot be the writer of a lock file last touched at `writtenAtMs`. */
export async function processStartedAfter(pid: number, writtenAtMs: number): Promise<boolean> {
  const started = await (startReader ?? readProcessStartMs)(pid);
  return started !== undefined && started > writtenAtMs + startSkewMs;
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
  try {
    const { stdout } = await execute("/bin/ps", ["-o", "lstart=", "-p", String(pid)]);
    const started = Date.parse(stdout.trim());
    return Number.isFinite(started) ? started : undefined;
  } catch { return undefined; }
}
function execute(command: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((done, failed) => {
    execFile(command, args, { timeout: 2000, maxBuffer: 8192 }, (error, stdout) => error ? failed(error) : done({ stdout }));
  });
}
/** What a receipt records about a process it started just now. */
export async function spawnStamp(): Promise<{ bootId?: string; startedAtMs: number }> {
  const boot = await bootIdentity();
  return { ...(boot.id ? { bootId: boot.id } : {}), startedAtMs: Date.now() };
}
