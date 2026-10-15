import { sshOptionsWithArgument } from "./service-tunnel.js";

/** A local listener a tunnel opens: its port and the bind address written for it, if any. */
export interface LocalListener { port: number; bind?: string }
export interface ParsedForwards { listeners: LocalListener[]; declared: boolean }

/**
 * Every local listener the tunnel's own arguments open: -L and -D (also as -o LocalForward
 * and DynamicForward), in separate, attached or clustered form. A reverse -R forward only
 * listens on the other machine, so it opens nothing here, but it still counts as declared.
 * Returns undefined when any local listener's port cannot be identified, so callers refuse
 * instead of guessing. `declared` is false when the arguments hold no forward at all: its
 * forwards then come from ssh_config, through -F or the host alias, which `ssh -G` resolves
 * (see mac-tunnel-ssh.ts). Scanning stops at `--`.
 */
export function parseTunnelForwards(args: string[]): ParsedForwards | undefined {
  const listeners: LocalListener[] = []; let declared = false;
  const found = (listener: LocalListener | undefined) => { if (!listener) return false; listeners.push(listener); return true; };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") break;
    if (!arg.startsWith("-")) continue;
    for (let position = 1; position < arg.length; position++) {
      const flag = arg[position];
      if (!sshOptionsWithArgument.includes(flag)) continue;
      const attached = arg.slice(position + 1); const value = attached || args[++index];
      if (value === undefined) { if (flag === "L" || flag === "D" || flag === "R") return undefined; break; }
      if (flag === "L") { declared = true; if (!found(forwardListener(value, [3, 4]))) return undefined; }
      if (flag === "D") { declared = true; if (!found(forwardListener(value, [1, 2]))) return undefined; }
      if (flag === "R") declared = true;
      if (flag === "o") {
        const option = value.trim().match(/^(LocalForward|DynamicForward|RemoteForward)(?:\s*=\s*|\s+)(\S.*)$/i);
        if (option) declared = true;
        // ssh_config: the listener is the first word; only a LocalForward has a second one for its target.
        if (option && !/^remote/i.test(option[1]) && !found(forwardListener(option[2].trim().split(/\s+/)[0], [1, 2]))) return undefined;
      }
      break;
    }
  }
  return { listeners, declared };
}

/** A listener from `[bind:]port[:host:hostport]`, honouring bracketed IPv6 addresses. */
function forwardListener(spec: string, counts: number[]): LocalListener | undefined {
  const parts: string[] = []; let current = ""; let depth = 0;
  for (const char of spec) {
    if (char === "[") depth++; else if (char === "]") depth = Math.max(0, depth - 1);
    if (char === ":" && depth === 0) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  if (!counts.includes(parts.length)) return undefined;
  const bound = parts.length === 2 || parts.length === 4;
  const port = validPort(bound ? parts[1] : parts[0]);
  return port === undefined ? undefined : { port, bind: bound ? parts[0].replace(/^\[(.*)\]$/, "$1") : undefined };
}

export function validPort(value: string): number | undefined {
  return /^\d{1,5}$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? Number(value) : undefined;
}
