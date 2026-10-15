import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { requireMaintenanceWindow } from "./mac-consolidate.js";
import { tunnelLocalPorts, usesLoopbackPort } from "./mac-tunnel-ports.js";
import { readPlanFile, readRemovals, removalsForCurrentPlan, removalsPath } from "./mac-tunnel-removals.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";

const appliesAt = "next service restart";
type ListProcesses = Parameters<typeof requireMaintenanceWindow>[1];
// No consolidation is running here, so the shared guard's consolidation wording is replaced.
const blocks = { desktop: "Quit ChatGPT normally after local and remote chats finish", busy: "Gateway inference is busy or unhealthy" };

/**
 * Removes one SSH tunnel component from a unified service plan. Callers hold the
 * login registration lock and have already refused a pending next-login plan.
 * Nothing is restarted: the supervisor reads the plan whenever the unified service
 * starts, so the tunnel stops at the next restart of that service.
 */
export async function removeTunnelComponent(state: string, plan: ServicePlan, id: string, listProcesses?: ListProcesses): Promise<Record<string, unknown>> {
  const componentId = `tunnel-${id}`;
  const component = plan.components.find(candidate => candidate.id === componentId);
  if (component && component.kind !== "tunnel") throw new Error(`No tunnel ${id} in the unified service plan`);
  if (!component) {
    // A repeat of a removal this command already made is idempotent; any other name is unknown.
    if ((await removalsForCurrentPlan(state, servicePlanPath(state))).some(removal => removal.id === id)) return { tunnel: id, removed: false, alreadyRemoved: true, appliesAt, note: "Already removed from the service plan; if the service has not restarted since, the tunnel stops at the next gateway service restart" };
    throw new Error(`No tunnel ${id} in the unified service plan`);
  }
  if (plan.components.length === 1) throw new Error(`Tunnel ${id} is the only unified service component; uninstall the gateway service instead of removing it`);
  const config = await loadConfig(plan.config);
  const ports = tunnelLocalPorts(component);
  if (!ports) throw new Error(`Cannot determine tunnel ${id}'s local port; edit the service plan manually`);
  // On a remote client, that forwarded port is how the client reaches its gateway: removing this tunnel disconnects it.
  const carried = config.clientOnly ? ports.find(port => port === config.port) : undefined;
  if (carried !== undefined) throw new Error(`Tunnel ${id} carries this client's gateway connection on port ${carried}; stop this remote client with gateway service uninstall instead of removing its tunnel`);
  for (const port of ports) {
    const provider = config.providers.find(candidate => usesLoopbackPort(candidate.baseUrl, port));
    if (provider) throw new Error(`Provider ${provider.id} uses this tunnel's local port ${port}; point it at another endpoint or remove it from the gateway configuration, then repeat the removal`);
  }
  // The shared maintenance guard: desktop quit, and /health ok and idle when this plan runs inference.
  // A remote client or a plan without inference has no local listener, so its probe never needs a tunnel.
  try { await requireMaintenanceWindow(plan.config, listProcesses, blocks); }
  catch (error) {
    if (error instanceof Error && ["TypeError", "TimeoutError", "AbortError", "SyntaxError"].includes(error.name)) throw new Error("Cannot verify the running gateway is idle; the tunnel was not removed");
    throw new Error(`${error instanceof Error ? error.message : "The maintenance check failed"}; the tunnel was not removed`);
  }
  const path = servicePlanPath(state);
  // The same plan-file lock every other plan writer holds across its read, compare and write.
  return withPrivateFileLock(path, async () => {
    const { text: original, key: before } = await readPlanFile(path);
    if (JSON.stringify(validateServicePlan(JSON.parse(original))) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the tunnel removal");
    const backups = resolve(state, "service-backups"); await mkdir(backups, { recursive: true, mode: 0o700 });
    const backup = resolve(backups, `tunnel-removed-${id}-${new Date().toISOString().replaceAll(":", "-")}.json`);
    await writeFile(backup, original, { mode: 0o600, flag: "wx" });
    await writePrivateJson(path, validateServicePlan({ ...plan, components: plan.components.filter(candidate => candidate.id !== componentId) }));
    const note = "Removed from the service plan; it stops at the next gateway service restart";
    // The plan is already changed, so a failed record must not turn the removal into an error.
    try {
      const { key: after } = await readPlanFile(path);
      // Earlier removals stay valid only if they describe the plan this one started from.
      const carried = (await readRemovals(state)).filter(entry => entry.plan === before && entry.id !== id).map(entry => ({ ...entry, plan: after }));
      await writePrivateJson(removalsPath(state), { version: 2, removals: [...carried, { id, backup, removedAt: new Date().toISOString(), plan: after }] });
    } catch { return { tunnel: id, removed: true, backup, appliesAt, note: `${note}; the removal could not be recorded, so repeating this command will report no such tunnel` }; }
    return { tunnel: id, removed: true, backup, appliesAt, note };
  });
}
