import type { ServiceComponent } from "./service-plan.js";
import { sshOptionsWithArgument } from "./service-tunnel.js";

/**
 * Every local listener port the tunnel opens: -L and -D (also as -o LocalForward and
 * DynamicForward), in separate, attached or clustered form. A reverse -R forward only
 * listens on the other machine, so it opens nothing here. Returns undefined when the
 * arguments declare no forward at all (its forwards then come from ssh_config, through
 * -F or the host alias, where this cannot see them) or when any local listener's port
 * cannot be identified, so callers refuse instead of guessing. Scanning stops at `--`.
 */
export function tunnelLocalPorts(component: ServiceComponent): number[] | undefined {
  const ports: number[] = []; let declared = false;
  const found = (port: number | undefined) => { if (port === undefined) return false; ports.push(port); return true; };
  const args = component.args;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    for (let position = 1; position < arg.length; position++) {
      const flag = arg[position];
      if (!sshOptionsWithArgument.includes(flag)) continue;
      const attached = arg.slice(position + 1); const value = attached || args[++index];
      if (value === undefined) { if (flag === "L" || flag === "D" || flag === "R") return undefined; break; }
      if (flag === "L") { declared = true; if (!found(forwardPort(value, [3, 4]))) return undefined; }
      if (flag === "D") { declared = true; if (!found(forwardPort(value, [1, 2]))) return undefined; }
      if (flag === "R") declared = true;
      if (flag === "o") {
        const option = value.trim().match(/^(LocalForward|DynamicForward|RemoteForward)(?:\s*=\s*|\s+)(\S.*)$/i);
        if (option) declared = true;
        // ssh_config: the listener is the first word; only a LocalForward has a second one for its target.
        if (option && !/^remote/i.test(option[1]) && !found(forwardPort(option[2].trim().split(/\s+/)[0], [1, 2]))) return undefined;
      }
      break;
    }
  }
  return declared ? ports : undefined;
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

export function usesLoopbackPort(baseUrl: string | undefined, port: number): boolean {
  if (!baseUrl) return false;
  let url: URL; try { url = new URL(baseUrl); } catch { return false; }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase())) return false;
  return (url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80) === port;
}
