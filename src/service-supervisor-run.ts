import { mkdir } from "node:fs/promises";
import { configureTelemetry } from "./telemetry.js";
import { startErrorReports } from "./error-report.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { serviceStatusPath, type ServicePlan } from "./service-plan.js";
import { ServiceSupervisor } from "./service-supervisor.js";

export async function runServiceSupervisor(plan: ServicePlan, state: string): Promise<void> {
  await mkdir(state, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "service"); startErrorReports(state, "service");
  await withPrivateFileLock(serviceStatusPath(state), async () => {
    const supervisor = new ServiceSupervisor(plan, state);
    supervisor.enableLiveUpdates();
    const stop = () => { void supervisor.current().stop(); };
    const restart = () => { void supervisor.current().restartWhenIdle(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    if (process.platform !== "win32") process.on("SIGUSR2", restart);
    try { await supervisor.start(); await supervisor.stopped; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGUSR2", restart); await supervisor.current().stop(); }
  });
}
