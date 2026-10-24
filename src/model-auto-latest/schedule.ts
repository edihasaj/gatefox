import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open, realpath, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { ensureJobTmp, jobTmpDirectory, plainPath } from "./schedule-safety.js";

/** Model checks belong to the existing app-owned service. This module only retires the legacy 0.8.7 job. */
const exec = promisify(execFile);
export const autoLatestLabelPrefix = "com.edihasaj.harness-gateway.models-";
export const autoLatestIntervalSeconds = 300;
/** Compatibility version for manual probes and legacy clients. */
export const autoLatestProtocol = 1;
const marker = "<!-- Managed by harness-gateway auto-latest -->";
const launchctlTimeoutMs = 8000;
const probeTimeoutMs = 20000;
export const statusTimeoutMs = 3000;

/** Every reason this module reports is one of these fixed words; none carries an error message, a path or a value. */
export type AutoLatestScheduleReason = "unsupported" | "config_unavailable" | "launcher_unavailable" | "command_unavailable"
  | "unsafe_path" | "foreign_job" | "state_unavailable" | "launchctl_failed" | "not_loaded" | "service_unavailable";
export interface AutoLatestScheduleResult { scheduled: boolean; reason?: AutoLatestScheduleReason }
export interface AutoLatestScheduleStatus {
  supported: true; mode: "app-service"; scheduled: boolean; reason?: AutoLatestScheduleReason;
}

/** What the schedule needs from the machine. Tests hand in fakes, so none of it reaches the real launchd or home. */
export interface AutoLatestScheduleTools {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  /** Runs launchctl with the arguments and resolves with its output; a failure throws with `stderr` and `code`. */
  launchctl(args: string[], options?: { timeoutMs?: number }): Promise<string>;
  /** Whether the managed launcher answers `auto-latest probe`; an older release does not. */
  probe(launcher: string): Promise<boolean>;
  stateDirectory(configPath: string): Promise<string>;
  /** Where the job's private TMPDIR parent lives. */
  tmpRoot: string;
  sleep(ms: number): Promise<void>;
  /** Observe the existing service timer, never a separate launchd job. */
  runtimeStatus?: (configPath: string) => Promise<AutoLatestScheduleResult>;
}

const standardPath = (home: string) => `${join(home, ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

export function defaultScheduleTools(): AutoLatestScheduleTools {
  const home = userInfo().homedir; // the account database, not an environment variable
  return {
    platform: process.platform, uid: process.getuid?.() ?? -1, home, tmpRoot: "/tmp",
    launchctl: async (args, options) => (await exec("/bin/launchctl", args, { timeout: options?.timeoutMs ?? launchctlTimeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20, env: { PATH: "/usr/bin:/bin" } })).stdout,
    probe: async launcher => {
      try {
        const { stdout } = await exec(launcher, ["auto-latest", "probe"], { timeout: probeTimeoutMs, killSignal: "SIGKILL", maxBuffer: 4096, env: { HOME: home, PATH: standardPath(home) } });
        return (JSON.parse(stdout) as { autoLatest?: unknown }).autoLatest === autoLatestProtocol;
      } catch { return false; }
    },
    stateDirectory: async configPath => (await loadConfig(configPath)).stateDirectory,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
  };
}

/** The configuration path the job is keyed on. Links are resolved so one configuration never gets two jobs. */
async function normalizedConfig(configPath: string): Promise<string> {
  const absolute = resolve(configPath);
  return realpath(absolute).catch(() => absolute);
}
/** `com.edihasaj.harness-gateway.models-<first 16 hex of sha256(config path)>`. */
export function autoLatestLabel(configPath: string): string {
  return `${autoLatestLabelPrefix}${createHash("sha256").update(resolve(configPath)).digest("hex").slice(0, 16)}`;
}
/** The job's private folder and log inside the state directory. */
export const autoLatestJobDirectory = (stateDirectory: string) => join(stateDirectory, "model-auto-latest");
export const autoLatestLogPath = (stateDirectory: string) => join(autoLatestJobDirectory(stateDirectory), "schedule.log");

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function notLoaded(error: unknown): boolean {
  const failure = error as { stderr?: unknown; message?: unknown; code?: unknown } | undefined;
  return failure?.code === 113 || [failure?.stderr, failure?.message].some(text => typeof text === "string" && /Could not find service|service not found|No such process|\bESRCH\b/.test(text));
}
/** True or false when launchd answered; undefined when it could not be asked. */
async function isLoaded(target: string, tools: AutoLatestScheduleTools, timeoutMs?: number): Promise<boolean | undefined> {
  try { await tools.launchctl(["print", target], timeoutMs ? { timeoutMs } : undefined); return true; }
  catch (error) { return notLoaded(error) ? false : undefined; }
}
async function waitUnloaded(target: string, tools: AutoLatestScheduleTools): Promise<boolean> {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (await isLoaded(target, tools) === false) return true;
    await tools.sleep(200);
  }
  return false;
}

const plistLimitBytes = 64 * 1024;
type Existing = { kind: "none" } | { kind: "ours"; text: string; dev: number; ino: number; mtimeMs: number } | { kind: "foreign" };
/** Reads the job file without following a link. A file that is not this user's regular file with our marker is not ours to replace or remove. */
function readExisting(path: string, uid: number): Existing {
  let fd: number | undefined;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "foreign" }; }
  try {
    const info = fstatSync(fd);
    // A plist another user can change is not ours to trust, replace or remove, whatever text it carries.
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o022) !== 0 || info.size > plistLimitBytes) return { kind: "foreign" };
    // Bounded read: one byte past the limit is enough to tell that the file grew after the size check.
    const buffer = Buffer.alloc(plistLimitBytes + 1); let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
      if (length > plistLimitBytes) return { kind: "foreign" };
    }
    const text = buffer.subarray(0, length).toString("utf8");
    return text.includes(marker) ? { kind: "ours", text, dev: info.dev, ino: info.ino, mtimeMs: info.mtimeMs } : { kind: "foreign" };
  } catch { return { kind: "foreign" }; } finally { if (fd !== undefined) closeSync(fd); }
}
/** Where the job's plist lives, and the launchd names it uses. */
function names(configPath: string, tools: AutoLatestScheduleTools) {
  const label = autoLatestLabel(configPath); const domain = `gui/${tools.uid}`;
  return { label, domain, target: `${domain}/${label}`, directory: join(tools.home, "Library", "LaunchAgents"), path: join(tools.home, "Library", "LaunchAgents", `${label}.plist`) };
}

/**
 * Never registers another job. Retires only this configuration's verified legacy metadata job, then observes the timer
 * inside the existing service. Switching off changes no service registration and stops no inference process.
 */
export async function syncAutoLatestSchedule(configPath: string, enabled: boolean, tools: AutoLatestScheduleTools = defaultScheduleTools()): Promise<AutoLatestScheduleResult> {
  if (tools.platform === "darwin") {
    const config = await normalizedConfig(configPath);
    if (!plainPath(config)) return { scheduled: false, reason: "unsafe_path" };
    const job = names(config, tools);
    try {
      const existing = readExisting(job.path, tools.uid);
      if (existing.kind === "foreign") return { scheduled: false, reason: "foreign_job" };
      if (existing.kind === "ours") {
        if (!existing.text.includes(`<key>Label</key><string>${xml(job.label)}</string>`) || !existing.text.includes(`<string>${xml(config)}</string>`)
          || !existing.text.includes("<string>auto-latest</string><string>check</string>")) return { scheduled: false, reason: "foreign_job" };
        const retired = await disable(job, tools);
        if (retired.scheduled || retired.reason) return { scheduled: false, reason: retired.reason ?? "launchctl_failed" };
      }
    } catch { return { scheduled: false, reason: "state_unavailable" }; }
  }
  return enabled ? getAutoLatestScheduleStatus(configPath, tools) : { scheduled: false };
}

type Names = ReturnType<typeof names>;
async function disable(job: Names, tools: AutoLatestScheduleTools): Promise<AutoLatestScheduleResult> {
  const existing = readExisting(job.path, tools.uid);
  if (existing.kind === "foreign") return { scheduled: false, reason: "foreign_job" };
  try { await tools.launchctl(["bootout", job.target]); }
  catch (error) {
    if (!notLoaded(error) && await isLoaded(job.target, tools) !== false) return { scheduled: true, reason: "launchctl_failed" };
  }
  if (!await waitUnloaded(job.target, tools)) return { scheduled: true, reason: "launchctl_failed" };
  if (existing.kind === "ours") {
    // launchctl is asynchronous: never remove a file another writer replaced while the old job was draining.
    const current = readExisting(job.path, tools.uid);
    if (current.kind === "none") return { scheduled: false };
    if (current.kind !== "ours" || current.dev !== existing.dev || current.ino !== existing.ino || current.mtimeMs !== existing.mtimeMs || current.text !== existing.text) return { scheduled: false, reason: "foreign_job" };
    await unlink(job.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
  return { scheduled: false };
}

/** Compatibility CLI status, now explicitly owned by the existing service rather than a second startup job. */
export async function autoLatestScheduleStatus(configPath: string, tools: AutoLatestScheduleTools = defaultScheduleTools()): Promise<AutoLatestScheduleStatus> {
  return { supported: true, mode: "app-service", ...(await getAutoLatestScheduleStatus(configPath, tools)) };
}

/** The job's own startup: makes its private TMPDIR (the plist names it, but /tmp is cleared at boot) and returns it for the process to use. */
export async function prepareScheduledTemp(tools: Pick<AutoLatestScheduleTools, "uid" | "tmpRoot"> = defaultScheduleTools()): Promise<string> {
  const directory = jobTmpDirectory(tools.uid, tools.tmpRoot);
  await ensureJobTmp(directory, tools.uid);
  return directory;
}

/** launchd only appends to the log, so each run keeps it bounded: past the limit it starts over. Failures here never stop a run. */
export const scheduleLogLimitBytes = 256 * 1024;
export async function trimScheduleLog(stateDirectory: string, limit = scheduleLogLimitBytes, uid = process.getuid?.() ?? -1): Promise<void> {
  // The log is opened once, without following a link and without waiting on a pipe, and judged by the descriptor itself:
  // only this user's own regular file is ever truncated, so a planted link or FIFO can neither cut another file nor hang the run.
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(autoLatestLogPath(stateDirectory), constants.O_WRONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (info.isFile() && info.uid === uid && info.size > limit) await file.truncate(0);
  } catch { /* no log yet, or not ours */ } finally { await file?.close().catch(() => undefined); }
}

/** A read-only fresh heartbeat from the existing service's maintenance timer. Creates and starts nothing. */
export async function getAutoLatestScheduleStatus(configPath: string, tools: AutoLatestScheduleTools = defaultScheduleTools()): Promise<AutoLatestScheduleResult> {
  try {
    const result = await (tools.runtimeStatus ?? (async path => (await import("./maintenance-status.js")).readMaintenanceStatus(path)))(configPath);
    const reason = result.reason && /^[a-z][a-z_]{0,40}$/.test(result.reason) ? result.reason as AutoLatestScheduleReason : undefined;
    return { scheduled: result.scheduled === true, ...(reason ? { reason } : {}) };
  } catch { return { scheduled: false, reason: "service_unavailable" }; }
}
