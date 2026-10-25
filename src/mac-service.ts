import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { loadConfig, gatewayToken } from "./config.js";
import { gatewayCommand } from "./command.js";
import { readServicePlan, servicePlanPath, type ServicePlan } from "./service-plan.js";
import { isClaudeComponent } from "./service-claude-activity.js";
import { consolidatedStatus, requireMaintenanceWindow } from "./mac-consolidate.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { bootoutJob, isNoSuchProcess } from "./launchctl.js";
import { withLoginRegistrationLock } from "./login-registration-lock.js";
import { renameLaunchers } from "./mac-launcher-rename.js";
import { processStartMs } from "./boot-identity.js";
import { serviceStopTimeoutMs } from "./runtime-activity.js";

const exec = promisify(execFile);
const label = "com.edihasaj.subscription-gateway";
const marker = "<!-- Managed by subscription-gateway -->";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function servicePlist(node: string, cli: string, config: string, log: string, path: string, installedCommand?: string, mode = "serve"): string {
  const args = [...(installedCommand ? [installedCommand] : [node, cli]), mode, "--config", config].map(value => `<string>${xml(value)}</string>`).join("");
  const processGroup = mode === "daemon" ? "<key>AbandonProcessGroup</key><false/>\n" : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n${marker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args}</array>\n<key>WorkingDirectory</key><string>${xml(dirname(config))}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n${processGroup}<key>StandardOutPath</key><string>${xml(log)}</string>\n<key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
}
async function status(target: string, timeoutMs = 5000): Promise<{ installed: boolean; state?: string; pid?: number }> {
  try {
    const { stdout } = await exec("/bin/launchctl", ["print", target], { timeout: timeoutMs });
    return { installed: true, state: stdout.match(/^\s*state = ([a-zA-Z ]+)$/m)?.[1], pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
  } catch { return { installed: false }; }
}
type ServiceStatus = { installed: boolean; pid?: number };
type ProcessIdentity = { pid: number; startedAtMs: number };
type ProcessIdentityState = "alive" | "gone" | "reused" | "unknown";

/** `status` deliberately keeps its old best-effort behaviour. Replacing a job needs a stricter answer. */
async function strictStatus(target: string): Promise<ServiceStatus> {
  try {
    const { stdout } = await exec("/bin/launchctl", ["print", target], { timeout: 5000 });
    return { installed: true, pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
  } catch (error) {
    if (isNoSuchProcess(error) || /Could not find service|service not found/i.test(String((error as Error).message))) return { installed: false };
    throw new Error("Cannot confirm whether the managed service is unloaded", { cause: error });
  }
}

async function inspectProcess(identity: ProcessIdentity): Promise<ProcessIdentityState> {
  try { process.kill(identity.pid, 0); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? "gone" : "unknown"; // EPERM is not proof that the old writer exited.
  }
  try {
    const started = await processStartMs(identity.pid);
    if (started === undefined) return "unknown";
    return started === identity.startedAtMs ? "alive" : "reused";
  } catch { return "unknown"; }
}

export interface LegacyReplacementTools {
  status(): Promise<ServiceStatus>;
  processStart(pid: number): Promise<number | undefined>;
  processState(identity: ProcessIdentity): Promise<ProcessIdentityState>;
  disable(): Promise<void>;
  enable(): Promise<void>;
  signalIdleExit(pid: number): void;
  bootout(): Promise<unknown>;
  write(contents: string): Promise<void>;
  backup(contents: string): Promise<void>;
  discardBackup(): Promise<void>;
  bootstrap(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

async function captureProcess(status: ServiceStatus, tools: LegacyReplacementTools): Promise<ProcessIdentity | undefined> {
  if (!status.pid) return;
  const startedAtMs = await tools.processStart(status.pid).catch(() => undefined);
  if (startedAtMs === undefined) throw new Error("Cannot identify the running managed service; its settings were not changed");
  return { pid: status.pid, startedAtMs };
}
async function waitForAbsent(identity: ProcessIdentity | undefined, tools: LegacyReplacementTools): Promise<void> {
  const deadline = tools.now() + serviceStopTimeoutMs;
  do {
    const current = await tools.status(); const state = identity ? await tools.processState(identity) : "gone";
    if (state === "unknown") throw new Error("Cannot confirm the old managed service exited; its settings were not changed");
    if (current.installed && current.pid && identity && (current.pid !== identity.pid || state === "reused")) throw new Error("Service restarted before migration; retry while idle");
    if (!current.installed && (state === "gone" || state === "reused")) return;
    await tools.sleep(100);
  } while (tools.now() < deadline);
  throw new Error("Cannot confirm the managed service is unloaded; its settings were not changed");
}
async function signalOwnedIdleService(identity: ProcessIdentity, tools: LegacyReplacementTools): Promise<void> {
  const current = await tools.status(); const state = await tools.processState(identity);
  if (state === "unknown") throw new Error("Cannot confirm the old managed service exited; its settings were not changed");
  if ((state === "gone" || state === "reused") && !current.installed) return;
  if (state !== "alive" || !current.installed || current.pid !== identity.pid) throw new Error("Service restarted before migration; retry while idle");
  tools.signalIdleExit(identity.pid);
}
function rollbackFailure(original: unknown, rollback: unknown): Error {
  const first = original instanceof Error ? original.message : String(original);
  const second = rollback instanceof Error ? rollback.message : String(rollback);
  return new Error(`${first}; rollback incomplete: ${second}. The previous managed service was not confirmed running.`, { cause: original });
}
async function originalStillRunning(identity: ProcessIdentity | undefined, tools: LegacyReplacementTools): Promise<boolean> {
  if (!identity) return false;
  const current = await tools.status();
  return current.installed && current.pid === identity.pid && (await tools.processState(identity)) === "alive";
}
/**
 * The legacy plist replacement transaction. Its fakes make the two teardown proofs testable without touching launchd.
 * It never bootstraps either definition until launchd no longer has the old job and its recorded process identity is gone.
 */
export async function replaceLegacyService(existing: string | undefined, contents: string, tools: LegacyReplacementTools, expected?: ServiceStatus): Promise<void> {
  let disabled = false; let teardownProven = false; let replacementAttempted = false;
  let original: ProcessIdentity | undefined;
  try {
    const current = await tools.status();
    if (expected && (current.installed !== expected.installed || (current.installed && current.pid !== expected.pid))) throw new Error("Service changed after its idle check; retry while idle");
    if (current.installed) {
      original = await captureProcess(current, tools);
      await tools.disable(); disabled = true;
      if (original) {
        await signalOwnedIdleService(original, tools); await waitForAbsent(original, tools); teardownProven = true;
      } else {
        const afterDisable = await tools.status();
        if (afterDisable.installed && afterDisable.pid) throw new Error("Service restarted before migration; retry while idle");
        if (afterDisable.installed) await tools.bootout();
        await waitForAbsent(undefined, tools); teardownProven = true;
      }
    }
    else { await waitForAbsent(undefined, tools); teardownProven = true; }
    if (existing !== undefined) await tools.backup(existing);
    await waitForAbsent(original, tools);
    await tools.write(contents);
    await waitForAbsent(original, tools);
    await tools.enable(); disabled = false; replacementAttempted = true; await tools.bootstrap();
    if (existing !== undefined) await tools.discardBackup().catch(() => undefined);
  } catch (error) {
    if (existing === undefined) throw error;
    if (!teardownProven) {
      if (!disabled) throw error;
      let restored = false;
      try {
        if (await originalStillRunning(original, tools)) { await tools.enable(); restored = true; }
      } catch (rollback) { throw rollbackFailure(error, rollback); }
      if (restored) throw error;
      throw rollbackFailure(error, new Error("The original service could not be confirmed running, so it was left disabled"));
    }
    try {
      if (original && (await tools.processState(original)) === "unknown") throw new Error("Cannot confirm the old managed service exited");
      const current = await tools.status();
      if (current.installed) {
        throw new Error(replacementAttempted ? "The replacement service is still loaded" : "The replacement service appeared before it was started");
      } else await waitForAbsent(original, tools);
      await tools.write(existing);
      await waitForAbsent(original, tools);
      await tools.enable(); disabled = false; await tools.bootstrap();
      await tools.discardBackup().catch(() => undefined);
    } catch (rollback) { throw rollbackFailure(error, rollback); }
    throw error;
  }
}
export async function macService(action: string | undefined, configPath: string, options: { force?: boolean } = {}): Promise<Record<string, unknown>> {
  if (options.force && action !== "restart") throw new Error("--force is only valid with gateway service restart");
  if (action === "status") return serviceOperation(action, configPath);
  const config = await loadConfig(configPath);
  return withLoginRegistrationLock(config.stateDirectory, () => serviceOperation(action, configPath, options.force === true));
}
/** What restarting a running unified service needs; a test supplies fakes, so none of it reaches the real session. */
export interface UnifiedRestartTools {
  /** Reads launchd's view of the job, giving up after `timeoutMs`. */
  status(timeoutMs: number): Promise<{ installed: boolean; pid?: number }>;
  /** Refuses (throws) unless ChatGPT is quit and inference is idle. */
  maintenance(): Promise<void>;
  /** Asks the supervisor for its strict idle restart (SIGUSR2). */
  signal(pid: number): void;
  /** Stops the service through launchd and starts it again (`kickstart -k`), the explicit operator stop. */
  kickstart(): Promise<unknown>;
  finish(): Promise<Record<string, unknown>>;
  wait(ms: number): Promise<unknown>;
  /** A monotonic clock in milliseconds; the restart's wait is bounded by elapsed time, not by attempts. */
  now(): number;
  /** Whether the saved configuration is now client-only; the maintenance window then skips its inference probe. */
  configuredClientOnly?: boolean;
}
export const restartBlocks = {
  desktop: "Finish local and remote chats, then quit ChatGPT normally before restarting the gateway service",
  busy: "Gateway inference is busy or unhealthy; the service was not restarted",
};
const claudeRestartRefusal = "Claude Desktop components are configured, so the service refuses an idle restart: their runtime cannot drain safely. " +
  "Run gateway service restart --force to stop and restart the whole service now; it may interrupt Claude work";
/**
 * `gateway service restart` on a unified plan with a running service. Both forms first require the maintenance window.
 * Without `force` it asks for the supervisor's strict idle restart, which a configured Claude component always refuses, so
 * that case is refused up front with its reason. With `force` the operator has authorized an interruption: launchd stops the
 * supervisor (SIGTERM, which drains inference and stops every component) and starts it again.
 */
export async function restartUnifiedService(plan: ServicePlan, pid: number, force: boolean, tools: UnifiedRestartTools): Promise<Record<string, unknown>> {
  // A forced stop has no supervisor idle guard behind it, so the window's inference probe must not be skipped while the
  // running plan still serves inference: a config edited to client-only would otherwise stop busy inference unchecked.
  if (force && tools.configuredClientOnly && plan.components.some(component => component.kind === "inference")) {
    throw new Error("The configuration is client-only but the running service still serves inference, so its idle state cannot be checked; the service was not restarted");
  }
  await tools.maintenance();
  if (!force && plan.components.some(isClaudeComponent)) throw new Error(claudeRestartRefusal);
  // A deadline, not an attempt count: a slow launchctl must not stretch the advertised wait (and the held lock) past it.
  const moved = async (budgetMs: number, interval: number): Promise<boolean> => {
    const deadline = tools.now() + budgetMs;
    for (;;) {
      const beforeWait = deadline - tools.now(); if (beforeWait <= 0) return false;
      await tools.wait(Math.min(interval, beforeWait));
      const remaining = deadline - tools.now(); if (remaining <= 0) return false;
      const next = await tools.status(Math.min(5000, remaining));
      if (next.pid && next.pid !== pid) return true;
    }
  };
  if (force) {
    await tools.kickstart();
    if (await moved(60000, 500)) return { ...await tools.finish(), restart: "forced" };
    throw new Error("The gateway service was stopped but has not started again yet; inspect gateway service status");
  }
  tools.signal(pid);
  if (await moved(15000, 100)) return { ...await tools.finish(), restart: "idle" };
  throw new Error("Running gateway work held the idle restart, so the service kept running. Retry when chats are idle, or use gateway service restart --force");
}
/** What installing the unified service needs from launchd; a test supplies fakes, so none of it reaches the real session. */
export interface UnifiedInstallTools {
  status(target: string): Promise<{ installed: boolean; pid?: number }>;
  launchctl(args: string[]): Promise<unknown>;
  finish(): Promise<Record<string, unknown>>;
}
/**
 * `gateway service install` on a unified Mac. It never restarts or replaces a running service and swaps no plan: it starts
 * the service only when it is not loaded or has no process, as it always did. New in 0.4.7, it first renames the launcher in
 * the service plist file (and the desktop login plist, if one exists) from the managed `gateway` to `harness-gateway`, so
 * macOS lists the background item under that name. launchd reads the file at its next load, so a loaded service keeps its
 * current definition and shows the new name from the next login (or at once when this call loads it).
 */
export async function installUnifiedService(paths: { service: string; desktop: string; target: string; domain: string }, tools: UnifiedInstallTools): Promise<Record<string, unknown>> {
  const renamed = await renameLaunchers(paths.service, paths.desktop);
  const current = await tools.status(paths.target);
  if (!current.installed) { await tools.launchctl(["enable", paths.target]); await tools.launchctl(["bootstrap", paths.domain, paths.service]); }
  else if (!current.pid) await tools.launchctl(["kickstart", paths.target]);
  const changed = renamed.programRewritten || renamed.desktopRewritten;
  return { ...await tools.finish(), programRewritten: renamed.programRewritten, desktopRewritten: renamed.desktopRewritten,
    ...(changed ? { appliesAt: renamed.programRewritten && !current.installed ? "now" : "next login" } : {}), ...(renamed.failed ? { launcherRenameFailed: true } : {}) };
}
async function serviceOperation(action: string | undefined, configPath: string, force = false): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("User service setup currently supports macOS; use gateway serve on other systems");
  if (!["install", "status", "restart", "uninstall"].includes(action || "")) throw new Error("Choose gateway service install, status, restart, or uninstall");
  const domain = `gui/${process.getuid!()}`; const target = `${domain}/${label}`;
  const path = resolve(homedir(), "Library/LaunchAgents", `${label}.plist`);
  const configured = await loadConfig(configPath);
  const plan = await readServicePlan(configured.stateDirectory);
  const pending = await readPendingLoginConsolidation(configured.stateDirectory);
  if (action === "status") return plan ? consolidatedStatus(configured.stateDirectory) : { service: label, ...await status(target), ...(pending ? { consolidationPending: "next_login", startupJobs: 1, components: pending.plan.components.map(component => ({ id: component.id, kind: component.kind })) } : {}) };
  if (pending) throw new Error("Gateway startup consolidation is staged for next login; the running service was not changed");
  let existing: string | undefined;
  try { existing = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read the gateway LaunchAgent"); }
  if (existing !== undefined && !existing.includes(marker)) throw new Error("An unmanaged LaunchAgent uses this name; refusing to replace it");
  if (action === "uninstall") {
    if ((await status(target)).installed) await bootoutJob(target);
    if (existing !== undefined) {
      const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true, mode: 0o700 });
      await rename(path, resolve(trash, `${label}.${Date.now()}.plist`));
    }
    if (plan) await rename(servicePlanPath(configured.stateDirectory), resolve(homedir(), ".Trash", `gateway-service-plan.${Date.now()}.json`));
    return { service: label, installed: false, credentialsPreserved: true };
  }
  if (plan) {
    if (!existing || !existing.includes("<string>daemon</string>")) throw new Error("Unified service registration is incomplete; restore its saved LaunchAgent before starting it");
    if (action === "install") return installUnifiedService({ service: path, desktop: resolve(dirname(path), `${label}.desktop.plist`), target, domain }, {
      status, launchctl: args => exec("/bin/launchctl", args), finish: () => consolidatedStatus(configured.stateDirectory) });
    const current = await status(target);
    if (action === "restart" && current.pid) {
      return restartUnifiedService(plan, current.pid, force, {
        status: timeoutMs => status(target, timeoutMs),
        maintenance: () => requireMaintenanceWindow(configPath, undefined, restartBlocks),
        signal: pid => { process.kill(pid, "SIGUSR2"); },
        kickstart: () => exec("/bin/launchctl", ["kickstart", "-k", target], { timeout: 70000 }),
        finish: () => consolidatedStatus(configured.stateDirectory),
        wait: ms => delay(ms),
        now: () => performance.now(),
        configuredClientOnly: configured.clientOnly === true,
      });
    }
    if (!current.installed) { await exec("/bin/launchctl", ["enable", target]); await exec("/bin/launchctl", ["bootstrap", domain, path]); }
    else if (!current.pid) await exec("/bin/launchctl", ["kickstart", target]);
    return consolidatedStatus(configured.stateDirectory);
  }
  if (action === "restart") {
    if (force) throw new Error("--force needs the unified gateway service; this Mac runs the standalone service, so it was not restarted");
    const before = await status(target);
    if (existing === undefined || !before.installed) throw new Error("Gateway service is not installed");
    if (!before.pid) { await exec("/bin/launchctl", ["kickstart", target], { timeout: 10000 }); return { service: label, ...await status(target) }; }
    const { stdout } = await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path]);
    const args: unknown = JSON.parse(stdout);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error("Managed service arguments are invalid");
    const configIndex = args.indexOf("--config");
    if (configIndex < 0 || typeof args[configIndex + 1] !== "string") throw new Error("Managed service has no configuration path");
    const config = await loadConfig(args[configIndex + 1]);
    let health: { active?: number; idleRestart?: boolean };
    try { health = await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) })).json() as typeof health; }
    catch { throw new Error("Cannot verify the running gateway is idle; service was not restarted"); }
    if (health.active !== 0) throw new Error("Gateway has active inference; finish or cancel it before restarting");
    if (health.idleRestart !== true) throw new Error("This daemon predates safe idle restart; upgrade it after active work finishes");
    process.kill(before.pid, "SIGUSR2");
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(100); const after = await status(target);
      if (after.pid && after.pid !== before.pid) return { service: label, ...after };
      if (!after.pid) { await exec("/bin/launchctl", ["kickstart", target], { timeout: 10000 }); return { service: label, ...await status(target) }; }
    }
    throw new Error("New gateway work prevented the idle restart; the existing service is still running");
  }
  const config = await loadConfig(configPath);
  if (config.clientOnly) throw new Error("Remote clients use gateway tunnel install, not a local inference service");
  if (!config.port) throw new Error("A managed daemon requires a fixed port");
  await gatewayToken(config.stateDirectory);
  const paths = [...new Set([dirname(process.execPath), resolve(homedir(), ".local/bin"), ...(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":").filter(path => path.startsWith("/"))])].join(":");
  const command = gatewayCommand();
  const contents = servicePlist(process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), configPath, resolve(config.stateDirectory, "service.log"), paths, command.args.length ? undefined : command.command);
  const legacyBackup = resolve(config.stateDirectory, "service-backups", `legacy-service.${process.pid}.${randomUUID()}.plist`);
  const current = await strictStatus(target);
  if (current.installed && existing === undefined) throw new Error("An existing service has this label without a managed LaunchAgent; refusing to replace it");
  if (existing !== contents) {
    if (current.installed && current.pid) {
      const { stdout } = await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path]);
      const args: unknown = JSON.parse(stdout);
      if (!Array.isArray(args) || args.some(arg => typeof arg !== "string") || args.indexOf("--config") < 0) throw new Error("Managed service arguments are invalid");
      const previous = await loadConfig(args[args.indexOf("--config") + 1]);
      const health = await (await fetch(`http://127.0.0.1:${previous.port}/health`, { signal: AbortSignal.timeout(3000) })).json() as { active?: number; idleRestart?: boolean; idleUpgrade?: boolean };
      if (health.active !== 0 || health.idleRestart !== true) throw new Error("Finish active gateway work before upgrading the managed service");
      if (health.idleUpgrade !== true) throw new Error("Restart the gateway service once to load the installed idle-upgrade protocol, then repeat service install");
    }
    await replaceLegacyService(existing, contents, {
      status: () => strictStatus(target), processStart: processStartMs, processState: inspectProcess,
      disable: () => exec("/bin/launchctl", ["disable", target], { timeout: 5000 }).then(() => undefined),
      enable: () => exec("/bin/launchctl", ["enable", target], { timeout: 5000 }).then(() => undefined),
      signalIdleExit: pid => process.kill(pid, "SIGUSR1"),
      bootout: () => bootoutJob(target),
      write: async value => { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, path); },
      backup: async value => { await mkdir(dirname(legacyBackup), { recursive: true, mode: 0o700 }); await writeFile(legacyBackup, value, { mode: 0o600 }); },
      discardBackup: () => unlink(legacyBackup).catch(() => undefined),
      bootstrap: () => exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 }).then(() => undefined),
      sleep: delay, now: performance.now,
    }, current);
  }
  if (!current.installed && existing === contents) { await exec("/bin/launchctl", ["enable", target], { timeout: 5000 }); await exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 }); }
  return { service: label, ...await status(target), port: config.port };
}
