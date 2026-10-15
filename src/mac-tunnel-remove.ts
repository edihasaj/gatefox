import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson } from "./config.js";
import { requireMaintenanceWindow } from "./mac-consolidate.js";
import { servicePlanPath, validateServicePlan, type ServiceComponent, type ServicePlan } from "./service-plan.js";

const appliesAt = "next service restart";
type ListProcesses = Parameters<typeof requireMaintenanceWindow>[1];
interface Removal { id: string; backup: string; removedAt: string }

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
    if ((await readRemovals(state)).some(removal => removal.id === id)) return { tunnel: id, removed: false, alreadyRemoved: true, appliesAt, note: "Already removed from the service plan; if the service has not restarted since, the tunnel stops at the next gateway service restart" };
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
  try { await requireMaintenanceWindow(plan.config, listProcesses); }
  catch (error) {
    if (error instanceof Error && ["TypeError", "TimeoutError", "AbortError", "SyntaxError"].includes(error.name)) throw new Error("Cannot verify the running gateway is idle; the tunnel was not removed");
    throw new Error(`${error instanceof Error ? error.message : "The maintenance check failed"}; the tunnel was not removed`);
  }
  const path = servicePlanPath(state);
  const original = await readFile(path, "utf8");
  if (JSON.stringify(validateServicePlan(JSON.parse(original))) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the tunnel removal");
  const backups = resolve(state, "service-backups"); await mkdir(backups, { recursive: true, mode: 0o700 });
  const backup = resolve(backups, `tunnel-removed-${id}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(backup, original, { mode: 0o600, flag: "wx" });
  await writePrivateJson(path, validateServicePlan({ ...plan, components: plan.components.filter(candidate => candidate.id !== componentId) }));
  const note = "Removed from the service plan; it stops at the next gateway service restart";
  // The plan is already changed, so a failed record must not turn the removal into an error.
  try { await writePrivateJson(removalsPath(state), { version: 1, removals: [...await readRemovals(state), { id, backup, removedAt: new Date().toISOString() }] }); }
  catch { return { tunnel: id, removed: true, backup, appliesAt, note: `${note}; the removal could not be recorded, so repeating this command will report no such tunnel` }; }
  return { tunnel: id, removed: true, backup, appliesAt, note };
}

const removalsPath = (state: string) => resolve(state, "service-backups", "tunnel-removals.json");

/** Removals this command completed: the id is recorded only after the plan write succeeded. */
async function readRemovals(state: string): Promise<Removal[]> {
  let text: string;
  try { text = await readFile(removalsPath(state), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let value: { removals?: unknown }; try { value = JSON.parse(text); } catch { return []; }
  return Array.isArray(value?.removals) ? value.removals.filter((entry): entry is Removal => typeof entry?.id === "string") : [];
}

/** ssh options that take an argument; the argument is the rest of the cluster or the next word. */
const optionsWithArgument = "BbcDEeFIiJLlmOopQRSWw";

/**
 * Every local listener port the tunnel opens: -L and -D (also as -o LocalForward and
 * DynamicForward), in separate, attached or clustered form. A reverse -R forward only
 * listens on the other machine, so it opens nothing here. Returns undefined when any
 * local listener's port cannot be identified, so callers refuse instead of guessing.
 */
function tunnelLocalPorts(component: ServiceComponent): number[] | undefined {
  const ports: number[] = [];
  const found = (port: number | undefined) => { if (port === undefined) return false; ports.push(port); return true; };
  const args = component.args;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-")) continue;
    for (let position = 1; position < arg.length; position++) {
      const flag = arg[position];
      if (!optionsWithArgument.includes(flag)) continue;
      const attached = arg.slice(position + 1); const value = attached || args[++index];
      if (value === undefined) { if (flag === "L" || flag === "D") return undefined; break; }
      if (flag === "L" && !found(forwardPort(value, [3, 4]))) return undefined;
      if (flag === "D" && !found(forwardPort(value, [1, 2]))) return undefined;
      if (flag === "o") {
        const option = value.trim().match(/^(LocalForward|DynamicForward)(?:\s*=\s*|\s+)(\S.*)$/i);
        // ssh_config: the listener is the first word; only a LocalForward has a second one for its target.
        if (option && !found(forwardPort(option[2].trim().split(/\s+/)[0], [1, 2]))) return undefined;
      }
      break;
    }
  }
  return ports;
}

/** A listener port from `[bind:]port[:host:hostport]`, honouring bracketed IPv6 addresses. */
function forwardPort(spec: string, counts: number[]): number | undefined {
  const parts: string[] = []; let current = ""; let depth = 0;
  for (const char of spec) {
    if (char === "[") depth++; else if (char === "]") depth = Math.max(0, depth - 1);
    if (char === ":" && depth === 0) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  if (!counts.includes(parts.length)) return undefined;
  const value = parts.length === 1 || parts.length === 3 ? parts[0] : parts[1];
  return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : undefined;
}

function usesLoopbackPort(baseUrl: string | undefined, port: number): boolean {
  if (!baseUrl) return false;
  let url: URL; try { url = new URL(baseUrl); } catch { return false; }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase())) return false;
  return (url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80) === port;
}
