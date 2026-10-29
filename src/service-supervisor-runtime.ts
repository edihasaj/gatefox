import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readRegularFile } from "./service-claude-io.js";
import { releaseState } from "./self-update.js";
import { ServiceSupervisor } from "./service-supervisor.js";
import { retainRunningRelease } from "./release-retention.js";
import type { ServicePlan } from "./service-plan.js";

/** Versioned in-process ownership contract. A different ABI waits for a natural service start. */
export const supervisorRuntimeVersion = 1;
export const createSupervisor = (plan: ServicePlan, state: string): ServiceSupervisor => new ServiceSupervisor(plan, state);
type SupervisorModule = { supervisorRuntimeVersion?: number; createSupervisor: typeof createSupervisor; release(): void };

/** Imports only a regular, owned module from this installation's immutable selected release. */
export async function installedSupervisorRuntime(moduleUrl = import.meta.url): Promise<SupervisorModule | undefined> {
  try {
    const releases = realpathSync(resolve(dirname(fileURLToPath(moduleUrl)), "../../.."));
    const expected = releaseState(moduleUrl)?.installed;
    if (!expected) return;
    const file = realpathSync(resolve(releases, "../current/package/dist/service-supervisor-runtime.js"));
    if (file !== resolve(releases, expected, "package/dist/service-supervisor-runtime.js")) return;
    if (!await readRegularFile(file, 64 * 1024, false)) return;
    const lease = retainRunningRelease(pathToFileURL(file).href);
    if (lease.releaseName !== expected) { lease.release(); return; }
    try {
      const candidate = await import(pathToFileURL(file).href) as SupervisorModule;
      if (candidate.supervisorRuntimeVersion !== supervisorRuntimeVersion || typeof candidate.createSupervisor !== "function") { lease.release(); return; }
      return { ...candidate, release: () => lease.release() };
    } catch { lease.release(); return; }
  } catch { return; }
}
