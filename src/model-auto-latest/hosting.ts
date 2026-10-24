import { startAutoLatestMaintenance, type MaintenanceHandle } from "./maintenance.js";
import type { MaintenanceOwner } from "./maintenance-status.js";
import { syncAutoLatestSchedule } from "./schedule.js";

export interface MaintenanceHostDependencies {
  retire: (path: string) => Promise<{ scheduled: boolean; reason?: string }>;
  start: (path: string, owner: MaintenanceOwner) => MaintenanceHandle;
  retry: (run: () => void) => () => void;
}
const defaults: MaintenanceHostDependencies = {
  retire: path => syncAutoLatestSchedule(path, false),
  start: (path, owner) => startAutoLatestMaintenance(path, { owner }),
  retry: run => { const timer = setTimeout(run, 30_000); timer.unref(); return () => clearTimeout(timer); },
};

/** Owns maintenance inside an existing runtime. A transient legacy-cleanup failure retries without restarting any chat. */
export function hostAutoLatestMaintenance(path: string, owner: MaintenanceOwner, deps: MaintenanceHostDependencies = defaults): MaintenanceHandle {
  let stopped = false; let maintenance: MaintenanceHandle | undefined; let cancelRetry: (() => void) | undefined;
  let pending: Promise<void> = Promise.resolve(); let stopping: Promise<void> | undefined;
  const launch = () => { pending = start(); };
  const start = async (): Promise<void> => {
    if (stopped || maintenance) return;
    try {
      const result = await deps.retire(path);
      if (stopped) return;
      if (result.scheduled || result.reason) { cancelRetry = deps.retry(launch); return; }
      maintenance = deps.start(path, owner);
    } catch { if (!stopped) cancelRetry = deps.retry(launch); }
  };
  launch();
  return { stop() {
    if (stopping) return stopping;
    stopped = true; cancelRetry?.();
    return stopping = pending.then(async () => { await maintenance?.stop(); });
  } };
}
