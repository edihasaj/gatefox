import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { readServicePlan, serviceExecutionPaths, serviceNativeExecutionPaths, servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";
import { requireMaintenanceWindow } from "./mac-consolidate.js";
import { readOwner, sdkIdentity } from "./execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { archiveStoppedExecutionReceipt, archiveStoppedNativeHomeReceipt } from "./service-execution-recovery.js";
import { sharedServiceRegistration } from "./mac-shared-native.js";
import { defaultPlanSwapServices, planNotWrittenBackMessage, planSharesExecutors, relaunchOntoPlan, writePlanText, type PlanSwapServices, type PlanSwapTiming, type RelaunchOutcome, type RunningPlan } from "./mac-shared-plan-swap.js";
import { configureTelemetry, flushTelemetry, telemetry } from "./telemetry.js";
import { executionHostHome } from "./execution-host.js";
import { safeErrorMessage } from "./error-message.js";

export type SharingMode = "shared-executors" | "shared-native";

/** How a failed disable ended: the rollback outcome of the service, or that the previous plan could not be written back. */
export type DisableOutcome = RelaunchOutcome | "not_restored";

/**
 * Why turning a sharing mode off failed, and how to recover. The reason goes through
 * safeErrorMessage: a JSON parse error quotes a slice of the plan it tripped over, which can
 * hold a credential, so the snippet never reaches the terminal.
 */
export function sharingDisableFailureMessage(mode: SharingMode, error: unknown, backup: string, outcome: DisableOutcome, lost: { running: RunningPlan; path: string } = { running: "unknown", path: "the plan file" }): string {
  const reason = `Turning off ${mode} failed (${safeErrorMessage(error, "Unknown failure")}).`;
  switch (outcome) {
    case "restarted": return `${reason} The previous plan is restored from ${backup} and the service was restarted.`;
    case "kept": return `${reason} The previous plan is restored from ${backup} and the service kept running.`;
    case "started": return `${reason} The previous plan is restored from ${backup}, and the service, which was down, was started.`;
    case "stuck": return `${reason} The plan file is restored from ${backup}; the service still runs the plan without ${mode}; run \`gateway service restart\` when idle.`;
    case "down": return `${reason} The plan file is restored from ${backup}, but the service is down and could not be started; run \`gateway service install\`.`;
    case "unknown": return `${reason} The plan file is restored from ${backup}, but the service could not be checked; run \`gateway service status\`, then \`gateway service restart\` when idle.`;
    case "not_restored": return planNotWrittenBackMessage(reason, backup, lost.path, lost.running, { previous: `the plan with ${mode}`, replacement: `the plan without ${mode}` });
  }
}

/** The service operations a disable uses; tests replace them to stand in for launchd. */
export interface SharingDisableDependencies extends PlanSwapServices {
  registration(config: string): Promise<boolean>;
  maintenance(config: string): Promise<void>;
  sdk(codex: string): ReturnType<typeof sdkIdentity>;
  /** Archives the stopped host receipt (and the native-home receipt it names) once no relaunched host can claim it. */
  archive(identity: Parameters<typeof archiveStoppedExecutionReceipt>[0], backup: string): Promise<unknown>;
  /** Releases only the stopped native-home receipt, for a relaunch that keeps gateway executors. */
  releaseNative(identity: { configPath: string; nativeHome: string }, backup: string): Promise<unknown>;
  timing?: PlanSwapTiming;
}
const defaults: SharingDisableDependencies = {
  ...defaultPlanSwapServices, registration: sharedServiceRegistration, maintenance: requireMaintenanceWindow, sdk: sdkIdentity,
  archive: archiveStoppedExecutionReceipt, releaseNative: archiveStoppedNativeHomeReceipt,
};

/**
 * Turns one sharing mode off again. The next plan is written first and the service restarts onto it: the restart is
 * guarded by the service's own idle check, which releases every lease and loaded chat before it exits, and launchd's
 * KeepAlive relaunch then starts the plan without the mode. Stopping the job and waiting for it to stay down cannot work:
 * KeepAlive relaunches it within milliseconds (at most launchd's 10 s throttle later), and a relaunch on the old plan would
 * own the shared host again. Once the service runs the new plan, its stopped receipts are released, but only those no
 * relaunched host can claim: when the new plan still shares executors its host claims owner.json itself (claimHost takes over
 * the stopped receipt), so archiving it would race that claim. Any failure restores the previous plan and runs it.
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
      const identity = { configPath: resolve(configPath), nativeHome: paths.nativeHome };
      if (!planSharesExecutors(next)) await deps.archive({ ...identity, ...sdk }, backup);
      else if (mode === "shared-native" && next.sharedExecutors === true) await deps.releaseNative(identity, backup);
    } catch (error) {
      // Never leave inference and tunnels down: restore the previous plan and run it. The plan goes back first, through a rename,
      // because a relaunch may read the file at any moment; then the service restarts onto it.
      let restored = false; let outcome: DisableOutcome = "not_restored"; let running: RunningPlan = "unknown";
      try { await writePlanText(path, original); restored = true; } catch { /* Reported below. */ }
      // A relaunch that was started from the next plan is still starting and refuses the idle restart; relaunchOntoPlan waits for it.
      if (restored) outcome = await relaunchOntoPlan(deps, configPath, config.stateDirectory, before.pid as number | undefined, deps.timing).catch((): DisableOutcome => "unknown");
      // The plan file still holds the plan without the mode. The process that ran the plan before the change (before.pid) still runs the
      // previous plan; any other process was relaunched from the plan without the mode.
      else running = await deps.status(config.stateDirectory).then((now): RunningPlan => typeof now.pid !== "number" ? "down" : now.pid === before.pid ? "previous" : "replacement", (): RunningPlan => "unknown");
      telemetry("sharing_disable_failed", { mode, outcome }); await flushTelemetry();
      throw new Error(sharingDisableFailureMessage(mode, error, backup, outcome, { running, path }));
    }
    telemetry("sharing_disabled", { mode }); await flushTelemetry();
    return { ...preview, applied: true, backup, ...await deps.status(config.stateDirectory) };
  });
}
