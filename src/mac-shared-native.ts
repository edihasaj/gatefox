import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, writePrivateJson } from "./config.js";
import { serviceNativeExecutionPaths, readServicePlan, servicePlanPath, validateServicePlan, serviceLabel, serviceMarker, type ServicePlan } from "./service-plan.js";
import { consolidatedStatus, requireMaintenanceWindow } from "./mac-consolidate.js";
import { macService } from "./mac-service.js";
import { executionHostHome } from "./execution-host.js";
import { sdkIdentity, readOwner, livePid } from "./execution-host-storage.js";
import { verifyNativeSdk } from "./native-execution-host-sdk.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { archiveStoppedExecutionReceipt } from "./service-execution-recovery.js";
import { inspectLegacyWriters } from "./service-legacy-writers.js";
import { inspectNativeWriters, type LegacyNativeWriter } from "./service-native-writers.js";
import { executionHostReady } from "./mac-shared-executors.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { planSwapTiming, rollBackEnable, serviceHealthy, type PlanSwapTiming } from "./mac-shared-plan-swap.js";

const exec = promisify(execFile);
type Status = Record<string, unknown>;
type Sdk = Awaited<ReturnType<typeof sdkIdentity>>;
interface RelayStatus { connected: boolean; environmentId?: string; modifiedAt: number }
export interface SharedNativeMigrationDependencies {
  platform: string;
  pending(state: string): Promise<boolean>;
  status(state: string): Promise<Status>;
  registration(config: string): Promise<boolean>;
  maintenance(config: string): Promise<void>;
  writers(config: string, state: string, codex: string, supervisorPid?: number, nativePid?: number): Promise<Array<{ pid: number; kind: string }>>;
  sdk(codex: string): Promise<Sdk>;
  validateSdk(codex: string): Promise<void>;
  ready(plan: ServicePlan, pid: number): Promise<boolean>;
  restart(config: string): Promise<unknown>;
  /** Whether the service answers /health; a rollback waits for it before it restarts a relaunched service. */
  health(config: string): Promise<boolean>;
  rollbackTiming?: Partial<PlanSwapTiming>;
  archive(identity: Parameters<typeof archiveStoppedExecutionReceipt>[0], backup: string): Promise<unknown>;
  install(config: string): Promise<unknown>;
}
export async function sharedServiceRegistration(config: string): Promise<boolean> {
  const plist = resolve(homedir(), "Library/LaunchAgents", serviceLabel + ".plist");
  let file;
  try {
    file = await open(plist, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); const info = await file.stat();
    if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid?.() || (info.mode & 0o022)) return false;
    const text = await file.readFile("utf8");
    const args = JSON.parse((await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist])).stdout) as unknown;
    return text.includes(serviceMarker) && Array.isArray(args) && args.every(arg => typeof arg === "string") &&
      args.includes("daemon") && args[args.indexOf("--config") + 1] === resolve(config);
  } catch { return false; }
  finally { await file?.close(); }
}
function dependencies(overrides: Partial<SharedNativeMigrationDependencies>): SharedNativeMigrationDependencies {
  return {
    platform: process.platform, pending: async state => !!await readPendingLoginConsolidation(state), status: consolidatedStatus, registration: sharedServiceRegistration,
    maintenance: requireMaintenanceWindow, sdk: sdkIdentity, validateSdk: async codex => { await verifyNativeSdk(codex); }, ready: executionHostReady,
    writers: async (config, state, codex, supervisorPid, nativePid) => {
      const result = [...await inspectLegacyWriters(config, state, supervisorPid), ...await inspectNativeWriters(config, codex, nativePid)];
      return [...new Map(result.map(value => [value.pid, value])).values()];
    },
    restart: config => macService("restart", config), health: serviceHealthy, archive: archiveStoppedExecutionReceipt,
    install: config => macService("install", config), ...overrides,
  };
}
async function relayStatus(plan: ServicePlan): Promise<RelayStatus | undefined> {
  const component = plan.components.find(value => value.kind === "native")!;
  const path = resolve(component.args[component.args.indexOf("--relay-home") + 1], "status.json"); let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); const info = await file.stat();
    if (!info.isFile() || info.size > 16384 || info.uid !== process.getuid?.() || (info.mode & 0o077)) return;
    const bytes = await file.readFile(); if (bytes.length > 16384) return;
    const value = JSON.parse(bytes.toString("utf8"));
    return { connected: value.status === "connected", modifiedAt: info.mtimeMs,
      ...(typeof value.environmentId === "string" ? { environmentId: value.environmentId } : {}) };
  } catch { return; }
  finally { await file?.close(); }
}
async function awaitReady(plan: ServicePlan, state: string, port: number, began: number, original: RelayStatus | undefined, deps: SharedNativeMigrationDependencies): Promise<Status> {
  for (let attempt = 0; attempt < 225; attempt++) {
    const current = await deps.status(state);
    const runtime = current.runtime as { executionHost?: { state: string }; components?: Array<{ state: string }> } | undefined;
    if (current.statusCurrent && typeof current.pid === "number" && runtime?.executionHost?.state === "running" &&
      runtime.components?.length === plan.components.length && runtime.components.every(value => ["running", "complete"].includes(value.state))) {
      try {
        let ready = await deps.ready(plan, current.pid);
        if (ready && plan.components.some(value => value.kind === "inference")) {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
          ready = response.ok && (await response.json() as { status?: string }).status === "ok";
        }
        const relay = await relayStatus(plan);
        ready &&= !!relay?.connected && relay.modifiedAt >= began && (!original?.environmentId || relay.environmentId === original.environmentId);
        if (ready) return current;
      } catch { /* The original relay can reconnect after control-host startup. */ }
    }
    await delay(200);
  }
  throw new Error("Shared native control or the original relay did not become ready");
}

/** Explicit native-only migration; failed rollback never restores competing writers. */
export async function enableSharedNative(configPath: string, apply = false, overrides: Partial<SharedNativeMigrationDependencies> = {}): Promise<Status> {
  const deps = dependencies(overrides);
  if (deps.platform !== "darwin") throw new Error("Shared native service migration currently supports macOS");
  const config = await loadConfig(configPath);
  if (await deps.pending(config.stateDirectory)) throw new Error("Gateway startup consolidation is pending; native ownership was not changed");
  const plan = await readServicePlan(config.stateDirectory);
  if (!plan || plan.config !== resolve(configPath)) throw new Error("Consolidate the existing gateway service before enabling shared native ownership");
  const paths = serviceNativeExecutionPaths(plan);
  if (plan.sharedExecutors) throw new Error("Native-only migration requires gateway executor sharing disabled; the existing service was preserved");
  const home = executionHostHome(configPath, paths.nativeHome); const current = await deps.status(config.stateDirectory);
  const owner = plan.sharedNativeExecutor ? await readOwner(resolve(home, "owner.json")) : undefined;
  const native = owner && owner.pid === current.pid ? (owner as typeof owner & { native?: { pid: number } }).native : undefined;
  const writers = await deps.writers(configPath, config.stateDirectory, paths.codex, current.statusCurrent ? Number(current.pid) : undefined, native?.pid);
  const preview = { sharedNativeExecutor: true, sharedExecutors: false, alreadyEnabled: plan.sharedNativeExecutor === true,
    startupJobs: 1, executionHome: home, ...paths, externalLegacyWriters: writers, nativeConfigUntouched: true,
    nativeAuthenticationUntouched: true, remoteRegistrationPreserved: true, nativeWorkerStartup: "first_real_adapter" };
  if (!apply) return { ...preview, applied: false, next: "gateway service shared-native --apply after local and remote connections close" };
  if (!await deps.registration(configPath)) throw new Error("The unified LaunchAgent belongs to another configuration or is unavailable; no service was changed");
  if (plan.sharedNativeExecutor && current.statusCurrent && typeof current.pid === "number" && await deps.ready(plan, current.pid)) return { ...preview, applied: true, ...current };
  await deps.maintenance(configPath);
  const sdk = await deps.sdk(paths.codex); await deps.validateSdk(sdk.codex);
  const path = servicePlanPath(config.stateDirectory);
  return withPrivateFileLock(path, async () => {
    if (await deps.pending(config.stateDirectory)) throw new Error("Gateway startup consolidation became pending; no writer was stopped");
    const original = await readFile(path, "utf8");
    if (JSON.stringify(validateServicePlan(JSON.parse(original))) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the native migration");
    const before = await deps.status(config.stateDirectory);
    if (before.installed !== true) throw new Error("The existing unified service registration is unavailable; restore it before native migration");
    if ((await deps.writers(configPath, config.stateDirectory, paths.codex, before.statusCurrent ? Number(before.pid) : undefined, native?.pid)).length) {
      throw new Error("Legacy native or gateway writers are still connected. Close their desktop and remote connections normally; no writer was stopped");
    }
    const next = validateServicePlan({ ...plan, sharedNativeExecutor: true }); const oldRelay = await relayStatus(plan); const began = Date.now();
    const backup = resolve(config.stateDirectory, "service-backups", `shared-native-${began}`);
    await mkdir(backup, { recursive: true, mode: 0o700 }); await writeFile(resolve(backup, "service-plan.json"), original, { mode: 0o600, flag: "wx" });
    try {
      await writePrivateJson(path, next); await deps.restart(configPath);
      return { ...preview, applied: true, backup, ...await awaitReady(next, config.stateDirectory, config.port, began, oldRelay, deps) };
    } catch (error) {
      if (JSON.stringify(await readServicePlan(config.stateDirectory)) !== JSON.stringify(next)) throw new Error(`Native migration failed and its plan changed; review ${backup}`);
      // The plan swap: the previous plan goes back first and the replacement restarts onto it through its own idle guard, so launchd's
      // KeepAlive cannot relaunch the plan being undone. Stopping the job and waiting for it to stay down loses that race.
      const outcome = await rollBackEnable({ configPath, state: config.stateDirectory, path, original, previous: plan, next, services: deps, timing: { ...planSwapTiming, ...deps.rollbackTiming },
        beforePid: typeof before.pid === "number" ? before.pid : undefined, archive: () => deps.archive({ configPath: resolve(configPath), nativeHome: paths.nativeHome, ...sdk }, backup) });
      if (outcome === "preserved") throw new Error(`Native migration could not roll back safely. Its ownership plan and writers were preserved; review ${backup}`);
      if (outcome === "needs_recovery") throw new Error(`The previous native plan is restored but its service needs recovery; review ${backup}`);
      throw error;
    }
  });
}
