import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { readServicePlan, serviceExecutionPaths, serviceNativeExecutionPaths, servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";
import { consolidatedStatus, requireMaintenanceWindow } from "./mac-consolidate.js";
import { macService } from "./mac-service.js";
import { readOwner, sdkIdentity } from "./execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { archiveStoppedExecutionReceipt } from "./service-execution-recovery.js";
import { sharedServiceRegistration } from "./mac-shared-native.js";
import { configureTelemetry, flushTelemetry, telemetry } from "./telemetry.js";
import { executionHostHome } from "./execution-host.js";
import { safeErrorMessage } from "./error-message.js";

export type SharingMode = "shared-executors" | "shared-native";

/**
 * Why turning a sharing mode off failed, and how to recover. The reason goes through
 * safeErrorMessage: a JSON parse error quotes a slice of the plan it tripped over, which can
 * hold a credential, so the snippet never reaches the terminal.
 */
export function sharingDisableFailureMessage(mode: SharingMode, error: unknown, backup: string, restarted: boolean | "kept"): string {
  const service = restarted === "kept" ? " and the service kept running" : restarted ? " and the service was restarted" : "; start it with gateway service install";
  return `Turning off ${mode} failed (${safeErrorMessage(error, "Unknown failure")}). The previous plan is restored from ${backup}${service}.`;
}

/** The service operations a disable uses; tests replace them to stand in for launchd. */
export interface SharingDisableDependencies {
  registration(config: string): Promise<boolean>;
  maintenance(config: string): Promise<void>;
  status(state: string): Promise<Record<string, unknown>>;
  /** Idle-guarded restart of the running service: it exits, and launchd KeepAlive starts it again from the plan on disk. */
  restart(config: string): Promise<unknown>;
  install(config: string): Promise<unknown>;
  sdk(codex: string): ReturnType<typeof sdkIdentity>;
  archive(identity: Parameters<typeof archiveStoppedExecutionReceipt>[0], backup: string): Promise<unknown>;
}
const defaults: SharingDisableDependencies = {
  registration: sharedServiceRegistration, maintenance: requireMaintenanceWindow, status: consolidatedStatus,
  restart: config => macService("restart", config), install: config => macService("install", config), sdk: sdkIdentity, archive: archiveStoppedExecutionReceipt,
};

/**
 * Turns one sharing mode off again. The next plan is written first and the service restarts onto it: the restart is
 * guarded by the service's own idle check, which releases every lease and loaded chat before it exits, and launchd's
 * KeepAlive relaunch then starts the plan without the mode. Stopping the job and waiting for it to stay down cannot work:
 * KeepAlive relaunches it within milliseconds, and a relaunch on the old plan would own the shared host again.
 * Once the service runs the new plan its stopped host receipt is archived. Any failure restores the previous plan.
 */
export async function disableSharing(configPath: string, mode: SharingMode, apply = false, overrides: Partial<SharingDisableDependencies> = {}): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("Shared service changes currently support macOS");
  const deps = { ...defaults, ...overrides };
  const config = await loadConfig(configPath); const plan = await readServicePlan(config.stateDirectory);
  configureTelemetry(config.stateDirectory, "service");
  if (!plan || plan.config !== resolve(configPath)) throw new Error("No unified service plan for this configuration; nothing is shared");
  const key = mode === "shared-executors" ? "sharedExecutors" : "sharedNativeExecutor";
  const next: ServicePlan = { ...plan }; delete next[key];
  const preview = { mode, enabled: plan[key] === true, remaining: { sharedNativeExecutor: next.sharedNativeExecutor === true, sharedExecutors: next.sharedExecutors === true } };
  if (!apply) return { ...preview, applied: false, next: `gateway service ${mode} --disable --apply after local and remote chats finish` };
  if (plan[key] !== true) return { ...preview, applied: true, alreadyDisabled: true };
  if (!await deps.registration(configPath)) throw new Error("The unified LaunchAgent belongs to another configuration or is unavailable; no service was changed");
  await deps.maintenance(configPath);
  const paths = plan.sharedNativeExecutor ? serviceNativeExecutionPaths(plan) : serviceExecutionPaths(plan);
  // Archive with the receipt's own SDK identity: after an app update the bundled SDK
  // differs from the one the host started with, which is often why sharing is turned off.
  const receipt = await readOwner(resolve(executionHostHome(configPath, paths.nativeHome), "owner.json"));
  if (receipt && (receipt.configPath !== resolve(configPath) || receipt.nativeHome !== resolve(paths.nativeHome))) throw new Error("The execution host receipt belongs to another configuration; no service was changed");
  const sdk = receipt ? { codex: receipt.codex, sdkSha256: receipt.sdkSha256 } : await deps.sdk(paths.codex);
  const path = servicePlanPath(config.stateDirectory);
  return withPrivateFileLock(path, async () => {
    const original = await readFile(path, "utf8");
    if (JSON.stringify(validateServicePlan(JSON.parse(original))) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the change");
    const backup = resolve(config.stateDirectory, "service-backups", `${mode}-disable-${Date.now()}`); await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(resolve(backup, "service-plan.json"), original, { mode: 0o600, flag: "wx" });
    const before = await deps.status(config.stateDirectory);
    try {
      await writePrivateJson(path, validateServicePlan(next));
      if (typeof before.pid === "number") await deps.restart(configPath); else await deps.install(configPath);
      await deps.archive({ configPath: resolve(configPath), nativeHome: paths.nativeHome, ...sdk }, backup);
    } catch (error) {
      // Never leave inference and tunnels down: restore the previous plan and run it.
      let restarted: boolean | "kept" = false;
      try {
        await writeFile(path, original, { mode: 0o600 });
        const now = await deps.status(config.stateDirectory);
        // A service that refused the idle restart still runs the previous plan. One that already relaunched on the next plan
        // restarts again onto the restored one, and one that is down is started.
        if (typeof now.pid !== "number") { await deps.install(configPath); restarted = true; }
        else if (now.pid !== before.pid) { await deps.restart(configPath); restarted = true; }
        else restarted = "kept";
      } catch { /* Reported below. */ }
      telemetry("sharing_disable_failed", { mode, restarted: restarted === true, kept: restarted === "kept" }); await flushTelemetry();
      throw new Error(sharingDisableFailureMessage(mode, error, backup, restarted));
    }
    telemetry("sharing_disabled", { mode }); await flushTelemetry();
    return { ...preview, applied: true, backup, ...await deps.status(config.stateDirectory) };
  });
}
