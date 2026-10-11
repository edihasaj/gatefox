import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, mkdir, rename, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, writePrivateJson } from "./config.js";
import { gatewayCommand } from "./command.js";
import { servicePlist } from "./mac-service.js";
import { readServicePlan, serviceLabel, servicePlanPath, serviceStatusPath, validateServicePlan, type ServicePlan, type ServiceComponent } from "./service-plan.js";

const exec = promisify(execFile);
interface Job { path: string; label: string; text: string; loaded: boolean; kind: ServiceComponent["kind"]; component: ServiceComponent }
const domain = () => `gui/${process.getuid!()}`;
async function loaded(label: string): Promise<boolean> { try { await exec("/bin/launchctl", ["print", `${domain()}/${label}`], { timeout: 5000 }); return true; } catch { return false; } }
const kindFor = (label: string): ServiceComponent["kind"] | undefined => label === serviceLabel ? "inference" : label === serviceLabel + ".desktop" ? "desktop" : label === serviceLabel + ".native" ? "native" : /^com\.edihasaj\.subscription-gateway\.tunnel\.[a-z][a-z0-9-]{0,63}$/.test(label) || label === serviceLabel + ".macbook-pro-2" ? "tunnel" : undefined;

export async function collectServicePlan(configPath: string, directory = resolve(homedir(), "Library/LaunchAgents")): Promise<{ plan: ServicePlan; jobs: Job[] }> {
  const config = await loadConfig(configPath); const command = gatewayCommand();
  if (command.args.length) throw new Error("Consolidation requires the installed gateway command");
  const jobs: Job[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const label = name.replace(/\.plist$/, ""); const kind = kindFor(label); if (!kind || name !== label + ".plist") continue;
    const path = resolve(directory, name); const text = await readFile(path, "utf8");
    const parsed = JSON.parse((await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", path])).stdout) as { Label?: string; ProgramArguments?: string[]; EnvironmentVariables?: Record<string, string> };
    const args = parsed.ProgramArguments;
    if (parsed.Label !== label || !Array.isArray(args) || args.some(arg => typeof arg !== "string") || !args.length) throw new Error("Gateway LaunchAgent arguments are invalid");
    const legacy = label === serviceLabel + ".macbook-pro-2" && args[0] === "/usr/bin/ssh" && args.at(-1) === "macbook-pro-2" && args.includes("127.0.0.1:3459:127.0.0.1:3457") && args.includes("-R");
    if (!text.includes("<!-- Managed by subscription-gateway") && !legacy) throw new Error(`Refusing to consolidate unmanaged service ${label}`);
    const environment = parsed.EnvironmentVariables || {};
    if (Object.keys(environment).some(key => !["PATH", "SSH_AUTH_SOCK"].includes(key))) throw new Error("A gateway job has unexpected environment overrides; review it before consolidation");
    const configIndex = args.indexOf("--config"); const nativeConfig = args.indexOf("--gateway-config");
    if (kind !== "tunnel" && resolve(args[(kind === "native" ? nativeConfig : configIndex) + 1] || "") !== resolve(configPath)) throw new Error("Gateway jobs use different configurations; consolidate each installation separately");
    const id = kind === "tunnel" ? "tunnel-" + (legacy ? "macbook-pro-2" : label.split(".").at(-1)) : kind;
    const component: ServiceComponent = { id, kind, command: args[0], args: args.slice(1), environment, log: resolve(config.stateDirectory, "services", `${id}.log`) };
    if (kind === "inference") { if (config.clientOnly || !args.includes("serve")) throw new Error("Unexpected inference service"); component.command = command.command; component.args = ["serve", "--config", resolve(configPath)]; }
    if (kind === "desktop") {
      const appIndex = args.indexOf("--app");
      component.command = command.command; component.args = ["desktop-restore", "--config", resolve(configPath), "--app", appIndex >= 0 ? args[appIndex + 1] : "/Applications/ChatGPT.app"];
    }
    if (kind === "native") {
      const gatewayIndex = component.args.indexOf("--gateway");
      if (gatewayIndex < 0 || !component.args.includes("--daemon")) throw new Error("Unexpected native relay arguments");
      component.command = resolve(dirname(command.command), "../share/subscription-gateway/current/package/native/gateway-native-relay");
      component.args[gatewayIndex + 1] = command.command;
    }
    if (kind === "tunnel" && args[0] !== "/usr/bin/ssh") throw new Error("Unexpected tunnel command");
    jobs.push({ path, label, text, kind, component, loaded: await loaded(label) });
  }
  const components = jobs.map(job => job.component).sort((a, b) => Number(a.kind !== "desktop") - Number(b.kind !== "desktop"));
  return { plan: validateServicePlan({ version: 1, config: resolve(configPath), components }), jobs };
}

export async function requireMaintenanceWindow(configPath: string): Promise<void> {
  const { stdout } = await exec("/bin/ps", ["-axo", "comm="], { timeout: 5000 });
  if (stdout.split("\n").some(line => line.trim() === "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")) throw new Error("Keep the running service while chats are open. Finish local and remote chats, then quit ChatGPT normally before consolidation");
  const config = await loadConfig(configPath);
  if (!config.clientOnly) {
    const health = await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) })).json() as { active?: number; status?: string };
    if (health.active !== 0 || health.status !== "ok") throw new Error("Gateway inference is busy or unhealthy; consolidation did not stop it");
  }
}

export async function consolidatedStatus(state: string): Promise<Record<string, unknown>> {
  const installed = await loaded(serviceLabel); let status: Record<string, unknown> = {};
  try { status = JSON.parse(await readFile(serviceStatusPath(state), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { stdout } = installed ? await exec("/bin/launchctl", ["print", `${domain()}/${serviceLabel}`]) : { stdout: "" };
  const pid = Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || undefined;
  return { service: serviceLabel, installed, mode: "supervised", pid, statusCurrent: !!pid && status.pid === pid && Date.now() - Date.parse(String(status.updatedAt)) < 15000, runtime: status };
}

export async function consolidateService(configPath: string, apply = false): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("Service consolidation currently supports macOS");
  const config = await loadConfig(configPath); const existing = await readServicePlan(config.stateDirectory);
  if (existing) return consolidatedStatus(config.stateDirectory);
  const { plan, jobs } = await collectServicePlan(configPath);
  const preview = { jobsBefore: jobs.length, jobsAfter: 1, components: plan.components.map(({ id, kind }) => ({ id, kind })), activeChatsPreserved: !apply };
  if (!apply) return { ...preview, applied: false, next: "gateway service consolidate --apply after local and remote chats finish" };
  await requireMaintenanceWindow(configPath);
  for (const job of jobs) if (await readFile(job.path, "utf8") !== job.text) throw new Error("A gateway job changed during planning; repeat consolidation");
  // Explicit application is a maintenance operation. A health snapshot cannot
  // prove that a remote agent between inference steps has finished its turn.
  const backup = resolve(config.stateDirectory, "service-backups", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(backup, { recursive: true, mode: 0o700 });
  for (const job of jobs) await writeFile(resolve(backup, job.label + ".plist"), job.text, { mode: 0o600, flag: "wx" });
  const targetPath = resolve(homedir(), "Library/LaunchAgents", serviceLabel + ".plist");
  const command = gatewayCommand(); const pathEnv = [...new Set([resolve(homedir(), ".local/bin"), ...(process.env.PATH || "/usr/bin:/bin").split(":").filter(path => path.startsWith("/"))])].join(":");
  const contents = servicePlist(process.execPath, fileURLToPath(new URL("./cli.js", import.meta.url)), resolve(configPath), resolve(config.stateDirectory, "service.log"), pathEnv, command.command, "daemon");
  let replacementAttempted = false; const began = Date.now(); let interrupted = false;
  const interrupt = () => { interrupted = true; };
  const checkInterrupted = () => { if (interrupted) throw new Error("Consolidation interrupted; previous jobs will be restored"); };
  process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
  try {
    for (const job of jobs) { checkInterrupted(); if (job.loaded) await exec("/bin/launchctl", ["bootout", `${domain()}/${job.label}`], { timeout: 10000 }); }
    checkInterrupted();
    await writePrivateJson(servicePlanPath(config.stateDirectory), plan);
    replacementAttempted = true;
    await writeFile(targetPath, contents, { mode: 0o600 });
    await exec("/bin/launchctl", ["enable", `${domain()}/${serviceLabel}`], { timeout: 5000 });
    await exec("/bin/launchctl", ["bootstrap", domain(), targetPath], { timeout: 10000 });
    let ready = false;
    let stable = 0;
    for (let attempt = 0; attempt < 225; attempt++) {
      checkInterrupted();
      await delay(200);
      const status = await consolidatedStatus(config.stateDirectory);
      const runtime = status.runtime as { components?: Array<{ state: string }> };
      let connected = !!status.statusCurrent && runtime.components?.length === plan.components.length && runtime.components.every(component => ["running", "complete"].includes(component.state));
      if (connected && plan.components.some(component => component.kind === "inference")) {
        try { const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) }); connected = response.ok && (await response.json() as { status?: string }).status === "ok"; } catch { connected = false; }
      }
      const native = plan.components.find(component => component.kind === "native");
      if (connected && native) {
        try {
          const relayHome = native.args[native.args.indexOf("--relay-home") + 1]; const relayStatus = resolve(relayHome, "status.json");
          connected = (await stat(relayStatus)).mtimeMs >= began && JSON.parse(await readFile(relayStatus, "utf8")).status === "connected";
        } catch { connected = false; }
      }
      stable = connected ? stable + 1 : 0;
      if (stable >= 5) { ready = true; break; }
    }
    if (!ready) throw new Error("Consolidated components did not start; previous jobs will be restored");
    const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true });
    for (const job of jobs) if (job.label !== serviceLabel) await rename(job.path, resolve(trash, `${job.label}.${Date.now()}.plist`));
    return { ...preview, applied: true, backup, ...await consolidatedStatus(config.stateDirectory) };
  } catch (error) {
    if (replacementAttempted && await loaded(serviceLabel)) await exec("/bin/launchctl", ["bootout", `${domain()}/${serviceLabel}`], { timeout: 10000 });
    const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true });
    await rename(servicePlanPath(config.stateDirectory), resolve(trash, `gateway-service-plan.${Date.now()}.json`)).catch(failure => { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; });
    for (const job of jobs) await writeFile(job.path, job.text, { mode: 0o600 });
    if (!jobs.some(job => job.label === serviceLabel)) await rename(targetPath, resolve(trash, `gateway-service-failed.${Date.now()}.plist`)).catch(failure => { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure; });
    const failures: string[] = [];
    for (const job of jobs) if (job.loaded && !await loaded(job.label)) {
      try { await exec("/bin/launchctl", ["bootstrap", domain(), job.path], { timeout: 10000 }); } catch { failures.push(job.label); }
    }
    if (failures.length) throw new Error(`Could not restart ${failures.join(", ")}; original plists are saved in ${backup}`);
    throw error;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
