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
import { bootoutJob } from "./launchctl.js";
import { consolidationFailureMessage, rollbackConsolidation } from "./mac-consolidate-rollback.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { readServicePlan, serviceLabel, servicePlanPath, serviceStatusPath, validateServicePlan, type ServicePlan, type ServiceComponent } from "./service-plan.js";
import { componentUp, nativeRegistrationEnabled } from "./native-pause.js";

const exec = promisify(execFile);
interface Job { path: string; label: string; text: string; loaded: boolean; kind: ServiceComponent["kind"]; component: ServiceComponent }
const domain = () => `gui/${process.getuid!()}`;
async function loaded(label: string): Promise<boolean> { try { await exec("/bin/launchctl", ["print", `${domain()}/${label}`], { timeout: 5000 }); return true; } catch { return false; } }
/**
 * Which service component a LaunchAgent label is, by exact match. The login-time environment agent
 * (`<service>.desktop-env`) is deliberately not one: it is no daemon, so it is neither collected into a plan nor retired.
 */
export const kindFor = (label: string): ServiceComponent["kind"] | undefined => label === serviceLabel ? "inference" : label === serviceLabel + ".desktop" ? "desktop" : label === serviceLabel + ".native" ? "native" : /^com\.edihasaj\.subscription-gateway\.tunnel\.[a-z][a-z0-9-]{0,63}$/.test(label) || label === serviceLabel + ".macbook-pro-2" ? "tunnel" : undefined;

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

const consolidationBlocks = { desktop: "Keep the running service while chats are open. Finish local and remote chats, then quit ChatGPT normally before consolidation", busy: "Gateway inference is busy or unhealthy; consolidation did not stop it" };
/** `blocks` words the two refusals for an operation other than consolidation. */
export async function requireMaintenanceWindow(configPath: string, listProcesses: () => Promise<string> = async () => (await exec("/bin/ps", ["-axo", "comm="], { timeout: 5000 })).stdout, blocks: { desktop: string; busy: string } = consolidationBlocks): Promise<void> {
  const stdout = await listProcesses();
  if (stdout.split("\n").some(line => line.trim() === "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT")) throw new Error(blocks.desktop);
  const config = await loadConfig(configPath);
  // A Mac moving from client-only to standalone runs a plan without inference, so nothing listens on the port yet.
  const running = await readServicePlan(config.stateDirectory);
  const hasInference = running ? running.components.some(component => component.kind === "inference") : !config.clientOnly;
  if (hasInference && !config.clientOnly) {
    const health = await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) })).json() as { active?: number; status?: string };
    if (health.active !== 0 || health.status !== "ok") throw new Error(blocks.busy);
  }
}

/** Fixed classes naming the readiness condition that failed; they carry no paths or values. */
export type ReadinessGap = "status_not_current" | "components_not_running" | "inference_unhealthy" | "native_relay_not_connected";
/** The runtime snapshot and the registration receipt are injectable, so readiness can be checked without a live service. */
export async function readinessGap(config: { stateDirectory: string; port: number }, plan: ServicePlan, began: number,
  deps: { status?: (state: string) => Promise<Record<string, unknown>>; registered?: (state: string) => Promise<boolean> } = {}): Promise<ReadinessGap | undefined> {
  const status = await (deps.status ?? consolidatedStatus)(config.stateDirectory);
  const runtime = status.runtime as { components?: Array<{ state: string; kind?: string }> };
  // The relay is optional, so a paused one is not a readiness gap; everything else must be up.
  if (!status.statusCurrent) return "status_not_current";
  if (runtime.components?.length !== plan.components.length || !runtime.components.every(componentUp)) return "components_not_running";
  if (plan.components.some(component => component.kind === "inference")) {
    try { const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) }); if (!response.ok || (await response.json() as { status?: string }).status !== "ok") return "inference_unhealthy"; } catch { return "inference_unhealthy"; }
  }
  const native = plan.components.find(component => component.kind === "native");
  // Only a machine that registered a relay whose slot is running has to have one connected; a relay
  // the service paused is optional by design, and its status file is as stale as it is going to get.
  const relayPaused = runtime.components?.some(component => component.kind === "native" && component.state === "paused") === true;
  if (native && !relayPaused && await (deps.registered ?? nativeRegistrationEnabled)(config.stateDirectory)) {
    try {
      const relayHome = native.args[native.args.indexOf("--relay-home") + 1]; const relayStatus = resolve(relayHome, "status.json");
      if ((await stat(relayStatus)).mtimeMs < began || JSON.parse(await readFile(relayStatus, "utf8")).status !== "connected") return "native_relay_not_connected";
    } catch { return "native_relay_not_connected"; }
  }
  return undefined;
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
  const pending = await readPendingLoginConsolidation(config.stateDirectory);
  if (pending) {
    if (apply) throw new Error("Gateway consolidation is already staged for next login; no running job was stopped");
    return { applied: false, consolidationPending: "next_login", jobsAfter: 1, activeChatsPreserved: true, components: pending.plan.components.map(component => ({ id: component.id, kind: component.kind })) };
  }
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
    for (const job of jobs) { checkInterrupted(); if (job.loaded) await bootoutJob(`${domain()}/${job.label}`); }
    checkInterrupted();
    await writePrivateJson(servicePlanPath(config.stateDirectory), plan);
    replacementAttempted = true;
    await writeFile(targetPath, contents, { mode: 0o600 });
    await exec("/bin/launchctl", ["enable", `${domain()}/${serviceLabel}`], { timeout: 5000 });
    await exec("/bin/launchctl", ["bootstrap", domain(), targetPath], { timeout: 10000 });
    let ready = false; let stable = 0; let gap: ReadinessGap | undefined;
    for (let attempt = 0; attempt < 225; attempt++) {
      checkInterrupted();
      await delay(200);
      gap = await readinessGap(config, plan, began);
      stable = gap ? 0 : stable + 1;
      if (stable >= 5) { ready = true; break; }
    }
    if (!ready) throw new Error(`Consolidated components did not start (${gap ?? "not_stable"}); previous jobs will be restored`);
    const trash = resolve(homedir(), ".Trash"); await mkdir(trash, { recursive: true });
    for (const job of jobs) if (job.label !== serviceLabel) await rename(job.path, resolve(trash, `${job.label}.${Date.now()}.plist`));
    return { ...preview, applied: true, backup, ...await consolidatedStatus(config.stateDirectory) };
  } catch (error) {
    const failures = await rollbackConsolidation({ jobs, serviceLabel, targetPath, planPath: servicePlanPath(config.stateDirectory), trash: resolve(homedir(), ".Trash"), replacementAttempted,
      launchctl: { bootout: async label => { await bootoutJob(`${domain()}/${label}`); }, isLoaded: loaded, bootstrap: async path => { await exec("/bin/launchctl", ["bootstrap", domain(), path], { timeout: 10000 }); } } });
    if (failures.length) throw new Error(consolidationFailureMessage(error, failures, backup), { cause: error });
    throw error;
  } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
}
