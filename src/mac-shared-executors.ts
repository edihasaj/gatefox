import { readFile, mkdir, writeFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, writePrivateJson } from "./config.js";
import { serviceExecutionPaths, readServicePlan, servicePlanPath, validateServicePlan, serviceLabel, serviceMarker, type ServicePlan } from "./service-plan.js";
import { consolidatedStatus, requireMaintenanceWindow } from "./mac-consolidate.js";
import { macService } from "./mac-service.js";
import { executionHostHome } from "./execution-host.js";
import { sdkIdentity, readOwner, socketIdentity, sameSocketIdentity, livePid } from "./execution-host-storage.js";
import { validateExecutionSdk } from "./execution-host-engine.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { archiveStoppedExecutionReceipt } from "./service-execution-recovery.js";
import { inspectLegacyWriters } from "./service-legacy-writers.js";
const exec = promisify(execFile);

export async function executionHostReady(plan: ServicePlan, pid: number): Promise<boolean> {
  if (!plan.sharedExecutors) return true;
  const paths = serviceExecutionPaths(plan); const home = executionHostHome(plan.config, paths.nativeHome);
  const owner = await readOwner(resolve(home, "owner.json"));
  if (!owner || owner.state !== "running" || owner.pid !== pid || owner.configPath !== resolve(plan.config) || owner.nativeHome !== paths.nativeHome || owner.codex !== await realpath(paths.codex) || owner.socketPath !== resolve(home, "host.sock")) return false;
  const socket = await socketIdentity(owner.socketPath);
  if (!socket || !owner.socket || !sameSocketIdentity(socket, owner.socket)) return false;
  const connection = new SocketAppServerConnection(owner.socketPath, async () => {});
  try {
    const timeout = AbortSignal.timeout(3000); const aborted = new Promise<never>((_resolve, reject) => timeout.addEventListener("abort", () => { connection.stop(); reject(new Error("Execution host health timed out")); }, { once: true }));
    const result = await Promise.race([connection.ready.then(() => connection.request("execution/status", {})), aborted]);
    return result.pid === pid && result.version === 1;
  } finally { connection.stop(); }
}

async function awaitSharedReady(plan: ServicePlan, state: string, port: number, began: number): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 225; attempt++) {
    const status = await consolidatedStatus(state); const runtime = status.runtime as { executionHost?: { state: string }; components?: Array<{ state: string }> };
    if (status.statusCurrent && typeof status.pid === "number" && runtime.executionHost?.state === "running" && runtime.components?.length === plan.components.length && runtime.components.every(component => ["running", "complete"].includes(component.state))) {
      try {
        let ready = await executionHostReady(plan, status.pid);
        if (ready && plan.components.some(component => component.kind === "inference")) {
          const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
          ready = response.ok && (await response.json() as { status?: string }).status === "ok";
        }
        const native = plan.components.find(component => component.kind === "native");
        if (ready && native) {
          const relayHome = native.args[native.args.indexOf("--relay-home") + 1]; const path = resolve(relayHome, "status.json");
          ready = (await stat(path)).mtimeMs >= began && JSON.parse(await readFile(path, "utf8")).status === "connected";
        }
        if (ready) return status;
      } catch { /* Startup can race the first readiness receipt. */ }
    }
    await delay(200);
  }
  throw new Error("Shared execution host did not become ready; restoring the previous service plan");
}

/** Migration is explicit; rollback releases only a proven stopped owned host. */
export async function enableSharedExecutors(configPath: string, apply = false): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("Shared service migration currently supports macOS");
  const config = await loadConfig(configPath); const plan = await readServicePlan(config.stateDirectory);
  if (!plan || plan.config !== resolve(configPath)) throw new Error("Consolidate the existing gateway service before enabling shared executors");
  const paths = serviceExecutionPaths(plan);
  const currentService = await consolidatedStatus(config.stateDirectory);
  const externalLegacyWriters = await inspectLegacyWriters(configPath, config.stateDirectory, currentService.statusCurrent ? Number(currentService.pid) : undefined);
  const preview = { sharedExecutors: true, alreadyEnabled: plan.sharedExecutors === true, executionHome: executionHostHome(configPath, paths.nativeHome), ...paths, externalLegacyWriters, nativeConfigUntouched: true };
  if (!apply) return { ...preview, applied: false, next: "gateway service shared-executors --apply after local and remote chats finish" };
  await requireMaintenanceWindow(configPath);
  const sdk = await sdkIdentity(paths.codex); await validateExecutionSdk(sdk.codex);
  const latestService = await consolidatedStatus(config.stateDirectory);
  if ((await inspectLegacyWriters(configPath, config.stateDirectory, latestService.statusCurrent ? Number(latestService.pid) : undefined)).length) throw new Error("Legacy gateway writers run outside the unified service. Close their SSH or desktop connections normally before migration; no process was stopped");
  const path = servicePlanPath(config.stateDirectory);
  return withPrivateFileLock(path, async () => {
    const original = await readFile(path, "utf8");
    const current = validateServicePlan(JSON.parse(original));
    if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the migration");
    if (plan.sharedExecutors && await executionHostReady(plan, Number((await consolidatedStatus(config.stateDirectory)).pid))) return { ...preview, applied: true, ...await consolidatedStatus(config.stateDirectory) };
    const next = validateServicePlan({ ...plan, sharedExecutors: true });
    const before = await consolidatedStatus(config.stateDirectory); const began = Date.now();
    const backup = resolve(config.stateDirectory, "service-backups", `shared-executors-${Date.now()}`); await mkdir(backup, { recursive: true, mode: 0o700 });
    await writeFile(resolve(backup, "service-plan.json"), original, { mode: 0o600, flag: "wx" });
    try {
      await writePrivateJson(path, next);
      await macService("restart", configPath);
      return { ...preview, applied: true, backup, ...await awaitSharedReady(next, config.stateDirectory, config.port, began) };
    } catch (error) {
      const latest = await readServicePlan(config.stateDirectory);
      if (JSON.stringify(latest) !== JSON.stringify(next)) throw new Error(`Shared migration failed and the service plan changed; review the saved plan in ${backup}`);
      await writePrivateJson(path, plan);
      const currentStatus = await consolidatedStatus(config.stateDirectory);
      // A refused idle restart leaves the original process already running the
      // restored plan. Do not send another stop request to that working service.
      if (before.pid && currentStatus.pid === before.pid) throw error;
      try {
        if (!plan.sharedExecutors) {
          // Stop only this migration's replacement before restoring legacy
          // writers. Its verified ownership record must disappear first.
          if (currentStatus.installed) {
            const plist = resolve(homedir(), "Library/LaunchAgents", serviceLabel + ".plist");
            const text = await readFile(plist, "utf8");
            const args = JSON.parse((await exec("/usr/bin/plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist])).stdout) as unknown;
            if (!text.includes(serviceMarker) || !Array.isArray(args) || args.some(arg => typeof arg !== "string") || !args.includes("daemon") || args[args.indexOf("--config") + 1] !== resolve(configPath)) throw new Error("Rollback refused an unrelated service registration");
            await exec("/bin/launchctl", ["bootout", `gui/${process.getuid!()}/${serviceLabel}`], { timeout: 10000 });
          }
          for (let attempt = 0; attempt < 100; attempt++) {
            const owner = await readOwner(resolve(preview.executionHome, "owner.json"));
            if ((!currentStatus.pid || !livePid(Number(currentStatus.pid))) && (!owner || owner.state === "stopped")) break;
            if (attempt === 99) throw new Error("Replacement executor did not stop; rollback preserved its writers");
            await delay(100);
          }
          await archiveStoppedExecutionReceipt({ configPath: resolve(configPath), nativeHome: paths.nativeHome, ...sdk }, backup);
        }
        await macService("install", configPath);
      }
      catch { throw new Error(`Shared migration failed; the previous plan is restored in ${backup}, but its service needs recovery`); }
      throw error;
    }
  });
}
