import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { requireMaintenanceWindow } from "./mac-consolidate.js";
import { HostLookupError, providerReaches, reachesListener, systemLookup, type HostLookup, type ReachableListener } from "./mac-tunnel-local.js";
import { tunnelListeners, type SshResolver } from "./mac-tunnel-ssh.js";
import { readPlanFile, readRemovals, removalsForCurrentPlan, removalsPath } from "./mac-tunnel-removals.js";
import { lockBusyCode, withPrivateFileLock } from "./private-file-lock.js";
import { withLoginRegistrationLock } from "./login-registration-lock.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";

const appliesAt = "next service restart";
export const pendingMessage = "Tunnel startup is staged under the unified service at next login; its separate registration was not changed";
type ListProcesses = Parameters<typeof requireMaintenanceWindow>[1];
// No consolidation is running here, so the shared guard's consolidation wording is replaced.
const blocks = { desktop: "Quit ChatGPT normally after local and remote chats finish", busy: "Gateway inference is busy or unhealthy" };
/** Test seams: how ssh resolves the tunnel's forwards, how the plan is written, how long the plan lock is awaited, and how provider hostnames resolve. */
export interface TunnelRemoveSeams { resolveSsh?: SshResolver; writePlan?: (path: string, plan: ServicePlan) => Promise<void>; lockTimeoutMs?: number; lookup?: HostLookup; lookupTimeoutMs?: number }

/**
 * Removes one SSH tunnel component from a unified service plan. Takes the plan lock first and
 * the login registration lock second, the order `service shared-executors`, `shared-native` and
 * their disable commands use, so a command that holds the plan lock never waits on this one.
 * Callers must hold neither lock. The pending next-login plan is checked again inside both,
 * because the commands that move the plan hold only the login lock.
 * Nothing is restarted: the supervisor reads the plan whenever the unified service
 * starts, so the tunnel stops at the next restart of that service.
 */
export async function removeTunnelComponent(state: string, plan: ServicePlan, id: string, listProcesses?: ListProcesses, seams: TunnelRemoveSeams = {}): Promise<Record<string, unknown>> {
  const componentId = `tunnel-${id}`;
  const component = plan.components.find(candidate => candidate.id === componentId);
  if (component && component.kind !== "tunnel") throw new Error(`No tunnel ${id} in the unified service plan`);
  if (!component) {
    // A repeat of a removal this command already made is idempotent; any other name is unknown.
    if ((await removalsForCurrentPlan(state, servicePlanPath(state))).some(removal => removal.id === id)) return { tunnel: id, removed: false, alreadyRemoved: true, appliesAt, note: "Already removed from the service plan; if the service has not restarted since, the tunnel stops at the next gateway service restart" };
    throw new Error(`No tunnel ${id} in the unified service plan`);
  }
  if (plan.components.length === 1) throw new Error(`Tunnel ${id} is the only unified service component; uninstall the gateway service instead of removing it`);
  // The forward parsing and `ssh -G` are OpenSSH's; another binary (autossh, a Homebrew ssh) gets no guess.
  if (component.command !== "/usr/bin/ssh") throw new Error(`Cannot determine tunnel ${id}'s local port; edit the service plan manually`);
  const config = await loadConfig(plan.config);
  const ports = await tunnelListeners(component, seams.resolveSsh);
  if (!ports) throw new Error(`Cannot determine tunnel ${id}'s local port; edit the service plan manually`);
  // On a remote client, that forwarded port is how the client reaches its gateway: removing this tunnel disconnects it.
  const carried = config.clientOnly ? ports.find(listener => listener.port === config.port)?.port : undefined;
  if (carried !== undefined) throw new Error(`Tunnel ${id} carries this client's gateway connection on port ${carried}; stop this remote client with gateway service uninstall instead of removing its tunnel`);
  await refuseProviderOnListeners(config.providers, ports, id, seams);
  // The shared maintenance guard: desktop quit, and /health ok and idle when this plan runs inference.
  // A remote client or a plan without inference has no local listener, so its probe never needs a tunnel.
  try { await requireMaintenanceWindow(plan.config, listProcesses, blocks); }
  catch (error) {
    if (error instanceof Error && ["TypeError", "TimeoutError", "AbortError", "SyntaxError"].includes(error.name)) throw new Error("Cannot verify the running gateway is idle; the tunnel was not removed");
    throw new Error(`${error instanceof Error ? error.message : "The maintenance check failed"}; the tunnel was not removed`);
  }
  const path = servicePlanPath(state); let planLocked = false; let loginLocked = false;
  try {
    // The same plan-file lock every other plan writer holds across its read, compare and write.
    return await withPrivateFileLock(path, async () => {
      planLocked = true;
      // Then the login lock, which `service uninstall` and the staging commands hold while they move the plan.
      return await withLoginRegistrationLock(state, async () => {
        loginLocked = true;
        // Re-checked under both locks, as shared-executors does: a plan may have been staged or moved while waiting.
        if (await readPendingLoginConsolidation(state)) throw new Error(pendingMessage);
        return rewritePlan(state, path, plan, id, seams.writePlan ?? writePrivateJson);
      });
    }, seams.lockTimeoutMs);
  } catch (error) {
    if (loginLocked) throw error; // Both locks were held: this is the work failing, not a lock.
    // A lock failed to be acquired before anything was read or written. The plan lock comes first,
    // so a failure while holding it can only be the login lock.
    const code = (error as NodeJS.ErrnoException)?.code;
    const target = planLocked ? "registration" : "plan";
    throw new Error(code === lockBusyCode ? `Gateway service ${target} is busy; the tunnel was not removed`
      : `Cannot lock the gateway service ${target}${code ? ` (${code})` : ""}; the tunnel was not removed`);
  }
}

/** A provider on one of the tunnel's local ports blocks its removal. Hosts as written are settled first; names are then resolved, each once. */
async function refuseProviderOnListeners(providers: Array<{ id: string; baseUrl?: string }>, ports: ReachableListener[], id: string, seams: TunnelRemoveSeams): Promise<void> {
  const blocked = (provider: { id: string }, listener: ReachableListener) =>
    new Error(`Provider ${provider.id} uses this tunnel's local port ${listener.port}; point it at another endpoint or remove it from the gateway configuration, then repeat the removal`);
  for (const listener of ports) for (const provider of providers) if (reachesListener(provider.baseUrl, listener)) throw blocked(provider, listener);
  const lookups = new Map<string, Promise<string[]>>(); const lookup = seams.lookup ?? systemLookup;
  const cached: HostLookup = host => { let found = lookups.get(host); if (!found) lookups.set(host, found = lookup(host)); return found; };
  for (const listener of ports) for (const provider of providers) {
    let reaches: boolean;
    try { reaches = await providerReaches(provider.baseUrl, listener, cached, seams.lookupTimeoutMs); }
    catch (error) {
      if (!(error instanceof HostLookupError)) throw error;
      throw new Error(`Cannot determine whether provider ${provider.id}'s host ${error.host} reaches tunnel ${id}'s local port ${listener.port}; the tunnel was not removed`);
    }
    if (reaches) throw blocked(provider, listener);
  }
}

/** Under the plan lock: re-read, compare, back up, write the shorter plan, then record the removal. */
async function rewritePlan(state: string, path: string, plan: ServicePlan, id: string, writePlan: (path: string, plan: ServicePlan) => Promise<void>): Promise<Record<string, unknown>> {
  let original: string; let before: string;
  try { ({ text: original, key: before } = await readPlanFile(path)); }
  catch (error) {
    // A plan that is gone was moved by the command that held the login lock, the same as a plan that was rewritten.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Gateway service plan changed; repeat the tunnel removal");
  }
  if (JSON.stringify(validateServicePlan(JSON.parse(original))) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the tunnel removal");
  const backups = resolve(state, "service-backups"); await mkdir(backups, { recursive: true, mode: 0o700 });
  const backup = resolve(backups, `tunnel-removed-${id}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(backup, original, { mode: 0o600, flag: "wx" });
  await writePlan(path, validateServicePlan({ ...plan, components: plan.components.filter(candidate => candidate.id !== `tunnel-${id}`) }));
  const note = "Removed from the service plan; it stops at the next gateway service restart";
  // The plan is already changed, so a failed record must not turn the removal into an error.
  try {
    const { key: after } = await readPlanFile(path);
    // Earlier removals stay valid only if they describe the plan this one started from.
    const kept = (await readRemovals(state)).filter(entry => entry.plan === before).map(entry => ({ ...entry, plan: after }));
    await writePrivateJson(removalsPath(state), { version: 2, removals: [...kept, { id, backup, removedAt: new Date().toISOString(), plan: after }] });
  } catch { return { tunnel: id, removed: true, backup, appliesAt, note: `${note}; the removal could not be recorded, so repeating this command will report no such tunnel` }; }
  return { tunnel: id, removed: true, backup, appliesAt, note };
}
