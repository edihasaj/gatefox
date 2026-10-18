import { appUpdateHint, handleAppUpdate, processPendingAppUpdate, trustedAppUpdateModule, type AppUpdateDependencies } from "../app-updates.js";

const dailyMs = 24 * 60 * 60 * 1000;
const initialDelayMs = 5 * 60 * 1000;
const pendingTickMs = 60 * 1000;

/** The service only schedules updates from an immutable installed release, never a checkout or test CLI. */
export async function canonicalUpdateModule(moduleURL = import.meta.url): Promise<boolean> {
  if (!moduleURL.startsWith("file:")) return false;
  return trustedAppUpdateModule(moduleURL.replace(/\/app-updates\/scheduler\.js$/, "/app-updates.js"));
}

export interface AppUpdateSchedule {
  stop(): void;
}
export async function startAppUpdateScheduler(configPath: string, dependencies: AppUpdateDependencies = {}, moduleURL = import.meta.url): Promise<AppUpdateSchedule> {
  if (!await canonicalUpdateModule(moduleURL)) return { stop() {} };
  const controller = new AbortController(); let stopped = false; let running = false; let pending = false;
  let nextCheckAt = Date.now() + initialDelayMs;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const hint = await appUpdateHint(configPath, dependencies);
      pending = hint?.pending === true || hint?.recoveryNeeded === true;
      if (pending) {
        pending = await processPendingAppUpdate(configPath, { ...dependencies, signal: controller.signal });
        if (pending) return;
      }
      if (Date.now() < nextCheckAt) return;
      const status = await handleAppUpdate({ operation: "status", configPath }, { ...dependencies, signal: controller.signal });
      pending = status.ok && status.result.phase === "waiting_for_app_exit";
      nextCheckAt = Date.now() + dailyMs;
      if (pending || !status.ok || !status.result.automatic) return;
      const checked = status.result.lastChecked ? Date.parse(status.result.lastChecked) : 0;
      if (Number.isFinite(checked) && Date.now() - checked < dailyMs) return;
      const update = await handleAppUpdate({ operation: "check", configPath }, { ...dependencies, signal: controller.signal });
      if (update.ok && update.result.available) {
        const installed = await handleAppUpdate({ operation: "install", configPath }, { ...dependencies, signal: controller.signal });
        pending = installed.ok && installed.result.phase === "waiting_for_app_exit";
      }
    } catch { /* Update failures are intentionally private and never stop the gateway service. */ }
    finally { running = false; }
  };
  const first = setTimeout(() => { void tick(); }, initialDelayMs); first.unref();
  const interval = setInterval(() => { void tick(); }, pendingTickMs); interval.unref();
  return { stop() { stopped = true; controller.abort(); clearTimeout(first); clearInterval(interval); } };
}
