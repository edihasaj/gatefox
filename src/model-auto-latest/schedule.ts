import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { open, realpath, rename, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "../config.js";
import { UnsafePath, ensureJobTmp, ensurePrivateDirectory, jobTmpDirectory, ownedPrivateFolder, plainPath, verifiedLauncher } from "./schedule-safety.js";

/**
 * Background upkeep for auto-latest model selections.
 *
 * The inference service may hold active chats for days and is never restarted for this, so the upkeep is its own small
 * LaunchAgent: one per configuration, named from a hash of the configuration path, running `gateway auto-latest check` every five
 * minutes at background priority. Turning the setting off boots out and removes only that job. The job carries no credentials:
 * its plist names the managed launcher and the configuration path, a fixed PATH and a private TMPDIR, and nothing else.
 */
const exec = promisify(execFile);
export const autoLatestLabelPrefix = "com.edihasaj.harness-gateway.models-";
export const autoLatestIntervalSeconds = 300;
/** The version of `gateway auto-latest probe`; a release that does not answer it cannot run the job. */
export const autoLatestProtocol = 1;
const marker = "<!-- Managed by harness-gateway auto-latest -->";
const launchctlTimeoutMs = 8000;
const probeTimeoutMs = 20000;
export const statusTimeoutMs = 3000;

/** Every reason this module reports is one of these fixed words; none carries an error message, a path or a value. */
export type AutoLatestScheduleReason = "unsupported" | "config_unavailable" | "launcher_unavailable" | "command_unavailable"
  | "unsafe_path" | "foreign_job" | "state_unavailable" | "launchctl_failed" | "not_loaded";
export interface AutoLatestScheduleResult { scheduled: boolean; reason?: AutoLatestScheduleReason }
export interface AutoLatestScheduleStatus {
  supported: boolean; label: string; installed: boolean;
  /** Whether launchd has the job; absent when launchd could not be asked. */
  loaded?: boolean; reason?: AutoLatestScheduleReason;
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
export interface AutoLatestPlist { label: string; launcher: string; config: string; home: string; tmp: string; workingDirectory: string; log: string }
export function autoLatestPlist(job: AutoLatestPlist): string {
  const strings = (values: string[]) => values.map(value => `<string>${xml(value)}</string>`).join("");
  const environment = Object.entries({ HOME: job.home, PATH: standardPath(job.home), TMPDIR: job.tmp }).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${marker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n`
    + `<key>Label</key><string>${xml(job.label)}</string>\n`
    + `<key>ProgramArguments</key><array>${strings([job.launcher, "auto-latest", "check", "--config", job.config, "--scheduled"])}</array>\n`
    + `<key>WorkingDirectory</key><string>${xml(job.workingDirectory)}</string>\n`
    + `<key>EnvironmentVariables</key><dict>${environment}</dict>\n`
    + `<key>RunAtLoad</key><true/><key>StartInterval</key><integer>${autoLatestIntervalSeconds}</integer>\n`
    + `<key>ProcessType</key><string>Background</string><key>LowPriorityIO</key><true/>\n`
    + `<key>StandardOutPath</key><string>${xml(job.log)}</string>\n<key>StandardErrorPath</key><string>${xml(job.log)}</string>\n</dict></plist>\n`;
}

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
type Existing = { kind: "none" } | { kind: "ours"; text: string } | { kind: "foreign" };
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
    return text.includes(marker) ? { kind: "ours", text } : { kind: "foreign" };
  } catch { return { kind: "foreign" }; } finally { if (fd !== undefined) closeSync(fd); }
}
async function writePlist(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** Where the job's plist lives, and the launchd names it uses. */
function names(configPath: string, tools: AutoLatestScheduleTools) {
  const label = autoLatestLabel(configPath); const domain = `gui/${tools.uid}`;
  return { label, domain, target: `${domain}/${label}`, directory: join(tools.home, "Library", "LaunchAgents"), path: join(tools.home, "Library", "LaunchAgents", `${label}.plist`) };
}

/**
 * Brings the background job in line with the setting. Enabling installs (or repairs) this configuration's job and loads it;
 * disabling stops and removes only that job. The result is what launchd actually has afterwards, so an unavailable
 * job reports `scheduled: false` with a fixed reason instead of pretending. It never touches the inference service.
 */
export async function syncAutoLatestSchedule(configPath: string, enabled: boolean, tools: AutoLatestScheduleTools = defaultScheduleTools()): Promise<AutoLatestScheduleResult> {
  if (tools.platform !== "darwin") return { scheduled: false, reason: "unsupported" };
  const config = await normalizedConfig(configPath);
  if (!plainPath(config)) return { scheduled: false, reason: "unsafe_path" };
  const job = names(config, tools);
  try { return enabled ? await enable(config, job, tools) : await disable(job, tools); }
  catch (error) { return failed(error instanceof UnsafePath ? "unsafe_path" : "state_unavailable", job.target, tools); }
}

/** A failure is reported with the job's real state: a job that was already loaded is still scheduled. */
async function failed(reason: AutoLatestScheduleReason, target: string, tools: AutoLatestScheduleTools): Promise<AutoLatestScheduleResult> {
  return { scheduled: await isLoaded(target, tools) === true, reason };
}

type Names = ReturnType<typeof names>;
async function enable(config: string, job: Names, tools: AutoLatestScheduleTools): Promise<AutoLatestScheduleResult> {
  let stateDirectory: string;
  try { stateDirectory = await tools.stateDirectory(config); } catch { return failed("config_unavailable", job.target, tools); }
  const launcher = await verifiedLauncher(tools.home, tools.uid);
  if (!launcher) return failed("launcher_unavailable", job.target, tools);
  // A release older than this feature has no `auto-latest` command; a job that ran it every five minutes would only fail.
  if (!await tools.probe(launcher)) return failed("command_unavailable", job.target, tools);
  const jobDirectory = await ownedPrivateFolder(autoLatestJobDirectory(stateDirectory), tools.uid);
  const tmp = jobTmpDirectory(tools.uid, tools.tmpRoot);
  await ensureJobTmp(tmp, tools.uid);
  await ensurePrivateDirectory(job.directory, tools.uid, 0o755);
  if (![launcher, tmp, jobDirectory, tools.home, job.path].every(plainPath)) throw new UnsafePath();
  const text = autoLatestPlist({ label: job.label, launcher, config, home: tools.home, tmp, workingDirectory: jobDirectory, log: join(jobDirectory, "schedule.log") });
  const existing = readExisting(job.path, tools.uid);
  if (existing.kind === "foreign") return failed("foreign_job", job.target, tools);
  const loaded = await isLoaded(job.target, tools);
  if (existing.kind === "ours" && existing.text === text && loaded === true) return { scheduled: true };
  await writePlist(job.path, text);
  try {
    if (loaded !== false) {
      // Replacing a loaded job: stop it first, and only this job. A failed stop leaves the old definition untouched.
      await tools.launchctl(["bootout", job.target]).catch(error => { if (!notLoaded(error)) throw error; });
      if (!await waitUnloaded(job.target, tools)) throw new Error("still loaded");
    }
    await tools.launchctl(["enable", job.target]);
    await tools.launchctl(["bootstrap", job.domain, job.path]);
    if (await isLoaded(job.target, tools) !== true) throw new Error("not loaded");
    return { scheduled: true };
  } catch {
    // A file launchd does not have must not start the job at the next login while the setting reports it as off.
    if (await isLoaded(job.target, tools) !== true) await unlink(job.path).catch(() => {});
    return failed("launchctl_failed", job.target, tools);
  }
}

async function disable(job: Names, tools: AutoLatestScheduleTools): Promise<AutoLatestScheduleResult> {
  const existing = readExisting(job.path, tools.uid);
  if (existing.kind === "foreign") return { scheduled: false, reason: "foreign_job" };
  try { await tools.launchctl(["bootout", job.target]); }
  catch (error) {
    if (!notLoaded(error) && await isLoaded(job.target, tools) !== false) return { scheduled: true, reason: "launchctl_failed" };
  }
  if (existing.kind === "ours") await unlink(job.path).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  return { scheduled: false };
}

/** What is installed and loaded for this configuration, reported honestly: a file launchd does not have is installed but not loaded. */
export async function autoLatestScheduleStatus(configPath: string, tools: AutoLatestScheduleTools = defaultScheduleTools()): Promise<AutoLatestScheduleStatus> {
  const config = await normalizedConfig(configPath); const job = names(config, tools);
  if (tools.platform !== "darwin") return { supported: false, label: job.label, installed: false, reason: "unsupported" };
  const existing = readExisting(job.path, tools.uid);
  if (existing.kind === "foreign") return { supported: true, label: job.label, installed: false, reason: "foreign_job" };
  const loaded = await isLoaded(job.target, tools);
  return { supported: true, label: job.label, installed: existing.kind === "ours", ...(loaded === undefined ? { reason: "launchctl_failed" as const } : { loaded }) };
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

/**
 * Read-only answer to "is this configuration's background job running?": the plist must be ours and name this configuration,
 * and launchd must have it. One launchctl call, bounded to three seconds; nothing is created, written or started.
 */
export async function getAutoLatestScheduleStatus(configPath: string, tools: AutoLatestScheduleTools = defaultScheduleTools()): Promise<AutoLatestScheduleResult> {
  if (tools.platform !== "darwin") return { scheduled: false, reason: "unsupported" };
  const config = await normalizedConfig(configPath);
  if (!plainPath(config)) return { scheduled: false, reason: "unsafe_path" };
  const job = names(config, tools);
  const existing = readExisting(job.path, tools.uid);
  if (existing.kind === "foreign") return { scheduled: false, reason: "foreign_job" };
  if (existing.kind === "none") return { scheduled: false };
  if (!existing.text.includes(`<string>${xml(config)}</string>`)) return { scheduled: false, reason: "foreign_job" };
  const loaded = await isLoaded(job.target, tools, statusTimeoutMs);
  if (loaded === true) return { scheduled: true };
  return { scheduled: false, reason: loaded === false ? "not_loaded" : "launchctl_failed" };
}
