import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson, type GatewayConfig } from "./config.js";
import { servicePlanPath, validateServicePlan, type ServiceComponent, type ServicePlan } from "./service-plan.js";

/**
 * Removes one SSH tunnel component from a unified service plan. Callers hold the
 * login registration lock and have already refused a pending next-login plan.
 * Nothing is restarted: the supervisor reads the plan when the service starts, so
 * the tunnel stops at the next gateway service restart.
 */
export async function removeTunnelComponent(state: string, plan: ServicePlan, id: string): Promise<Record<string, unknown>> {
  const componentId = `tunnel-${id}`;
  const component = plan.components.find(candidate => candidate.id === componentId);
  if (!component || component.kind !== "tunnel") {
    // A repeat of a removal that already landed is idempotent; an unknown name is not.
    if (await removalBackedUp(state, id)) return { tunnel: id, removed: false, alreadyRemoved: true };
    throw new Error(`No tunnel ${id} in the unified service plan`);
  }
  if (plan.components.length === 1) throw new Error(`Tunnel ${id} is the only unified service component; uninstall the gateway service instead of removing it`);
  const config = await loadConfig(plan.config);
  await requireIdleGateway(config);
  const port = tunnelLocalPort(component);
  const provider = port === undefined ? undefined : config.providers.find(candidate => usesLoopbackPort(candidate.baseUrl, port));
  if (provider) throw new Error(`Provider ${provider.id} uses this tunnel's local port ${port}; remove that provider from the gateway configuration first`);
  const path = servicePlanPath(state);
  const original = await readFile(path, "utf8");
  if (JSON.stringify(validateServicePlan(JSON.parse(original))) !== JSON.stringify(plan)) throw new Error("Gateway service plan changed; repeat the tunnel removal");
  const backups = resolve(state, "service-backups"); await mkdir(backups, { recursive: true, mode: 0o700 });
  const backup = resolve(backups, `tunnel-removed-${id}-${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(backup, original, { mode: 0o600, flag: "wx" });
  await writePrivateJson(path, validateServicePlan({ ...plan, components: plan.components.filter(candidate => candidate.id !== componentId) }));
  return { tunnel: id, removed: true, backup, appliesAt: "next service restart", note: "Removed from the service plan; it stops at the next gateway service restart" };
}

/** The inference listener must be reachable and idle before any plan is changed. */
async function requireIdleGateway(config: GatewayConfig): Promise<void> {
  let health: { active?: number };
  try { health = await (await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(3000) })).json() as typeof health; }
  catch { throw new Error("Cannot verify the running gateway is idle; the tunnel was not removed"); }
  if (health.active !== 0) throw new Error("Gateway has active inference; finish or cancel it before removing a tunnel");
}

/**
 * The loopback port this machine's side of the forward uses: the listener for -L,
 * and the target the tunnel connects back to for -R. The remote listener of a
 * reverse tunnel belongs to the other machine, so it is not checked here.
 */
function tunnelLocalPort(component: ServiceComponent): number | undefined {
  const flag = component.args.find(arg => arg === "-L" || arg === "-R");
  const spec = flag ? component.args[component.args.indexOf(flag) + 1] : undefined;
  if (!spec) return undefined;
  const parts = spec.split(":");
  const value = flag === "-R" ? parts.at(-1) : parts.length > 3 ? parts[1] : parts[0];
  return value !== undefined && /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : undefined;
}

function usesLoopbackPort(baseUrl: string | undefined, port: number): boolean {
  if (!baseUrl) return false;
  let url: URL; try { url = new URL(baseUrl); } catch { return false; }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase())) return false;
  return (url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80) === port;
}

async function removalBackedUp(state: string, id: string): Promise<boolean> {
  try { return (await readdir(resolve(state, "service-backups"))).some(name => new RegExp(`^tunnel-removed-${id}-\\d{4}-`).test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
