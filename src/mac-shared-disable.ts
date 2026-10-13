import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { readServicePlan, serviceExecutionPaths, serviceNativeExecutionPaths, servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";
import { consolidatedStatus, requireMaintenanceWindow } from "./mac-consolidate.js";
import { macService } from "./mac-service.js";
import { sdkIdentity } from "./execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { archiveStoppedExecutionReceipt } from "./service-execution-recovery.js";
import { sharedServiceRegistration, stopSharedServiceReplacement } from "./mac-shared-native.js";
import { telemetry } from "./telemetry.js";

export type SharingMode = "shared-executors" | "shared-native";

/**
 * Turns one sharing mode off again. It uses the same path as a failed migration's
 * rollback: the service stops only after its own idle guard releases every lease and
 * loaded chat, the stopped host receipt is archived, and the previous plan restarts.
 */
export async function disableSharing(configPath: string, mode: SharingMode, apply = false): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("Shared service changes currently support macOS");
  const config = await loadConfig(configPath); const plan = await readServicePlan(config.stateDirectory);
  if (!plan || plan.config !== resolve(configPath)) throw new Error("No unified service plan for this configuration; nothing is shared");
  const key = mode === "shared-executors" ? "sharedExecutors" : "sharedNativeExecutor";
  const next: ServicePlan = { ...plan }; delete next[key];
  const preview = { mode, enabled: plan[key] === true, remaining: { sharedNativeExecutor: next.sharedNativeExecutor === true, sharedExecutors: next.sharedExecutors === true } };
  if (!apply) return { ...preview, applied: false, next: `gateway service ${mode} --disable --apply after local and remote chats finish` };
  if (plan[key] !== true) return { ...preview, applied: true, alreadyDisabled: true };
  if (!await sharedServiceRegistration(configPath)) throw new Error("The unified LaunchAgent belongs to another configuration or is unavailable; no service was changed");
  await requireMaintenanceWindow(configPath);
  const paths = plan.sharedNativeExecutor ? serviceNativeExecutionPaths(plan) : serviceExecutionPaths(plan);
  const sdk = await sdkIdentity(paths.codex);
  const path = servicePlanPath(config.stateDirectory);
  return withPrivateFileLock(path, async () => {
    const original = await readFile(path, "utf8");
    if (JSON.stringify(validateServicePlan(JSON.parse(original))) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the change");
    const backup = resolve(config.stateDirectory, "service-backups", `${mode}-disable-${Date.now()}`); await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(resolve(backup, "service-plan.json"), original, { mode: 0o600, flag: "wx" });
    const status = await consolidatedStatus(config.stateDirectory);
    if (typeof status.pid === "number") await stopSharedServiceReplacement(configPath, config.stateDirectory, status.pid);
    await archiveStoppedExecutionReceipt({ configPath: resolve(configPath), nativeHome: paths.nativeHome, ...sdk }, backup);
    await writePrivateJson(path, validateServicePlan(next));
    await macService("install", configPath);
    telemetry("sharing_disabled", { mode });
    return { ...preview, applied: true, backup, ...await consolidatedStatus(config.stateDirectory) };
  });
}
