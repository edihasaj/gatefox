/**
 * Why a changed `gateway.json` was not applied, from a fixed vocabulary that never carries a path, a value or an error's text:
 * `rebind` (an existing alias would change account, provider, credential source, base URL or upstream model),
 * `restart_required` (the port, mode or state directory changed), `invalid` (it does not parse or validate) or
 * `unreadable` (it could not be read).
 */
export const configRejections = ["rebind", "restart_required", "invalid", "unreadable"] as const;
export type ConfigRejection = (typeof configRejections)[number];

/** A reason read from a process's answer: only a word of the fixed list survives, anything else is nothing. */
export function parseConfigRejection(value: unknown): ConfigRejection | undefined {
  return configRejections.find(reason => reason === value);
}

/**
 * Asks the daemon on this machine whether it is holding back a change to `gateway.json`. Its `/health` answer reads the file
 * first, so the question also makes it look at what was just written. `reachable` is false when nothing answered.
 */
export async function daemonConfigStatus(port: number, signal: AbortSignal = AbortSignal.timeout(2000)): Promise<{ reachable: boolean; rejection?: ConfigRejection }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal, redirect: "error" });
    const body = await response.json().catch(() => undefined) as { configRejected?: unknown } | undefined;
    const rejection = parseConfigRejection(body?.configRejected);
    return { reachable: true, ...(rejection ? { rejection } : {}) };
  } catch { return { reachable: false }; }
}
