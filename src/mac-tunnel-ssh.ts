import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ServiceComponent } from "./service-plan.js";
import { parseTunnelForwards, validPort, type LocalListener } from "./mac-tunnel-ports.js";
import type { ReachableListener } from "./mac-tunnel-local.js";

const exec = promisify(execFile);

/** What `ssh -G` resolved for the tunnel's arguments. */
export interface SshForwards { listeners: LocalListener[]; declared: boolean; gatewayPorts: boolean }
export type SshResolver = (args: string[]) => Promise<SshForwards | undefined>;

/**
 * Reads the resolved configuration `/usr/bin/ssh -G` prints for the tunnel's own arguments:
 * the forwards -F or the host alias add to the explicit ones, and GatewayPorts. It does not
 * connect. Returns undefined when ssh cannot resolve the arguments or a forward's listener
 * is not a numbered port, so callers refuse instead of guessing.
 */
export const resolveSshForwards: SshResolver = async args => {
  let stdout: string;
  try { stdout = (await exec("/usr/bin/ssh", ["-G", ...args], { timeout: 5000, maxBuffer: 1 << 20 })).stdout; } catch { return undefined; }
  return parseSshConfigDump(stdout);
};

/** `localforward [bind]:port [host]:hostport`, `dynamicforward port`, `remoteforward ...`, `gatewayports yes`. */
export function parseSshConfigDump(text: string): SshForwards | undefined {
  const listeners: LocalListener[] = []; let declared = false; let gatewayPorts = false;
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(localforward|dynamicforward|remoteforward|gatewayports)(?:\s+(\S+))?/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (key === "gatewayports") { gatewayPorts = match[2]?.toLowerCase() === "yes"; continue; }
    declared = true;
    if (key === "remoteforward") continue;
    const listener = match[2]?.match(/^(?:\[(.*)\]:)?(\d+)$/); const port = listener ? validPort(listener[2]) : undefined;
    if (!listener || port === undefined) return undefined;
    listeners.push({ port, bind: listener[1] });
  }
  return { listeners, declared, gatewayPorts };
}

const loopbackBind = (bind: string) => ["localhost", "::1"].includes(bind.toLowerCase()) || bind.startsWith("127.");

/**
 * Every local listener the tunnel opens: the ports parsed from its arguments merged with what
 * ssh resolves for them. Undefined when it cannot be determined: ssh cannot resolve the
 * arguments, a listener's port is unidentifiable, or no forward is declared anywhere.
 */
export async function tunnelListeners(component: ServiceComponent, resolve: SshResolver = resolveSshForwards): Promise<ReachableListener[] | undefined> {
  const parsed = parseTunnelForwards(component.args); if (!parsed) return undefined;
  const resolved = await resolve(component.args); if (!resolved) return undefined;
  if (!parsed.declared && !resolved.declared) return undefined;
  const byPort = new Map<number, boolean>();
  for (const { port, bind } of [...parsed.listeners, ...resolved.listeners]) {
    // Without a bind address ssh listens on loopback only, unless GatewayPorts opens it to every interface.
    const wildcard = bind === undefined ? resolved.gatewayPorts : !loopbackBind(bind);
    byPort.set(port, byPort.get(port) === true || wildcard);
  }
  return [...byPort].map(([port, wildcard]) => ({ port, wildcard }));
}
