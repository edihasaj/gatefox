import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, gatewayToken } from "./config.js";
import { gatewayCommand } from "./command.js";
import { readServicePlan, servicePlanPath } from "./service-plan.js";
import { consolidatedStatus, requireMaintenanceWindow } from "./mac-consolidate.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { bootoutJob } from "./launchctl.js";
import { withLoginRegistrationLock } from "./login-registration-lock.js";
import { renameLaunchers } from "./mac-launcher-rename.js";

const exec = promisify(execFile);
const label = "com.edihasaj.subscription-gateway";
const marker = "<!-- Managed by subscription-gateway -->";
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function servicePlist(node: string, cli: string, config: string, log: string, path: string, installedCommand?: string, mode = "serve"): string {
  const args = [...(installedCommand ? [installedCommand] : [node, cli]), mode, "--config", config].map(value => `<string>${xml(value)}</string>`).join("");
  const processGroup = mode === "daemon" ? "<key>AbandonProcessGroup</key><false/>\n" : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n${marker}\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args}</array>\n<key>WorkingDirectory</key><string>${xml(dirname(config))}</string>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n${processGroup}<key>StandardOutPath</key><string>${xml(log)}</string>\n<key>StandardErrorPath</key><string>${xml(log)}</string>\n</dict></plist>\n`;
}
async function status(target: string): Promise<{ installed: boolean; state?: string; pid?: number }> {
  try {
    const { stdout } = await exec("/bin/launchctl", ["print", target], { timeout: 5000 });
    return { installed: true, state: stdout.match(/^\s*state = ([a-zA-Z ]+)$/m)?.[1], pid: Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined };
  } catch { return { installed: false }; }
}
export async function macService(action: string | undefined, configPath: string): Promise<Record<string, unknown>> {
  if (action === "status") return serviceOperation(action, configPath);
  const config = await loadConfig(configPath);
  return withLoginRegistrationLock(config.stateDirectory, () => serviceOperation(action, configPath));
}
/** What installing the unified service needs from launchd; a test supplies fakes, so none of it reaches the real session. */
export interface UnifiedInstallTools {
  status(target: string): Promise<{ installed: boolean; pid?: number }>;
  launchctl(args: string[]): Promise<unknown>;
  finish(): Promise<Record<string, unknown>>;
}
/**
 * `gateway service install` on a unified Mac. It never restarts or replaces a running service and swaps no plan: it starts
 * the service only when it is not loaded or has no process, as it always did. New in 0.4.6, it first renames the launcher in
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
async function serviceOperation(action: string | undefined, configPath: string): Promise<Record<string, unknown>> {
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
      await requireMaintenanceWindow(configPath);
      process.kill(current.pid, "SIGUSR2");
      for (let attempt = 0; attempt < 150; attempt++) { await delay(100); const next = await status(target); if (next.pid && next.pid !== current.pid) return consolidatedStatus(configured.stateDirectory); }
      throw new Error("The unified service could not restart while idle; inspect gateway service status");
    }
    if (!current.installed) { await exec("/bin/launchctl", ["enable", target]); await exec("/bin/launchctl", ["bootstrap", domain, path]); }
    else if (!current.pid) await exec("/bin/launchctl", ["kickstart", target]);
    return consolidatedStatus(configured.stateDirectory);
  }
  if (action === "restart") {
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
  const current = await status(target);
  if (current.installed && existing === undefined) throw new Error("An existing service has this label without a managed LaunchAgent; refusing to replace it");
  if (existing !== contents) {
    let disabled = false; let unloaded = false;
    try {
    if (current.installed && current.pid) {
      const { stdout } = await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", path]);
      const args: unknown = JSON.parse(stdout);
      if (!Array.isArray(args) || args.some(arg => typeof arg !== "string") || args.indexOf("--config") < 0) throw new Error("Managed service arguments are invalid");
      const previous = await loadConfig(args[args.indexOf("--config") + 1]);
      const health = await (await fetch(`http://127.0.0.1:${previous.port}/health`, { signal: AbortSignal.timeout(3000) })).json() as { active?: number; idleRestart?: boolean; idleUpgrade?: boolean };
      if (health.active !== 0 || health.idleRestart !== true) throw new Error("Finish active gateway work before upgrading the managed service");
      if (health.idleUpgrade !== true) throw new Error("Restart the gateway service once to load the installed idle-upgrade protocol, then repeat service install");
      // Disabling keeps the current process running but prevents KeepAlive from
      // starting the old command between its idle exit and plist replacement.
      await exec("/bin/launchctl", ["disable", target], { timeout: 5000 }); disabled = true;
      process.kill(current.pid, "SIGUSR1");
      let stopped = false;
      for (let attempt = 0; attempt < 30; attempt++) { await delay(100); const next = await status(target); if (!next.installed) { stopped = true; unloaded = true; break; } if (next.pid && next.pid !== current.pid) throw new Error("Service restarted before migration; retry while idle"); }
      if (!stopped) throw new Error("New gateway work prevented the service upgrade; its settings were not changed");
    }
    if ((await status(target)).installed) { await bootoutJob(target); unloaded = true; }
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, contents, { mode: 0o600 }); await rename(temporary, path);
    await exec("/bin/launchctl", ["enable", target], { timeout: 5000 }); disabled = false;
    await exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 });
    } catch (error) {
      if (unloaded && existing) {
        const temporary = `${path}.${process.pid}.rollback`; await writeFile(temporary, existing, { mode: 0o600 }); await rename(temporary, path);
        await exec("/bin/launchctl", ["enable", target], { timeout: 5000 }); disabled = false;
        await exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 });
      }
      throw error;
    } finally { if (disabled) await exec("/bin/launchctl", ["enable", target], { timeout: 5000 }); }
  }
  if (!current.installed && existing === contents) { await exec("/bin/launchctl", ["enable", target], { timeout: 5000 }); await exec("/bin/launchctl", ["bootstrap", domain, path], { timeout: 10000 }); }
  return { service: label, ...await status(target), port: config.port };
}
