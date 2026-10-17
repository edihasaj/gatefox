import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateConfig, type GatewayConfig, type ProviderConfig } from "./config.js";
import { telemetry } from "./telemetry.js";

function bindings(config: GatewayConfig): Map<string, string> {
  const identity = (provider: ProviderConfig, model: string) => JSON.stringify([provider.id, provider.type, provider.credentialFile || "", provider.authDirectory || "", provider.baseUrl || "", provider.apiKeyEnv || "", model]);
  return new Map(config.providers.flatMap(provider => Object.entries(provider.models).map(([alias, model]) => [alias, identity(provider, model)])));
}

/**
 * Why a changed file was not applied, from a fixed vocabulary that never carries a path, a value or an error's text:
 * `rebind` (an existing alias would change account, provider, credential source, base URL or upstream model),
 * `restart_required` (the port, mode or state directory changed), `invalid` (it does not parse or validate) or
 * `unreadable` (it could not be read).
 */
export type ConfigRejection = "rebind" | "restart_required" | "invalid" | "unreadable";

/**
 * Reload an atomic config replacement without changing the listener or credentials. A change that cannot be applied live
 * is refused, never thrown: the last good configuration keeps serving every model, the refusal is recorded once per file
 * stamp as `config_rejected`, and the next file that is valid and allowed is adopted. The first load at startup is not
 * this class's: it stays fatal in `startServeRuntime`.
 */
export class LiveConfig {
  private stamp = "";
  private value: GatewayConfig;
  private pending?: Promise<GatewayConfig>;
  private readonly pinnedBindings: Map<string, string>;
  /** The stamp of the file that was refused, and why; undefined while the newest file is applied. */
  private refused?: { stamp: string; reason: ConfigRejection };
  constructor(private readonly path: string, initial: GatewayConfig, private readonly portOverride?: number) { this.value = initial; this.pinnedBindings = bindings(initial); }
  /** Why the newest change to the file is not applied, or undefined when the file in place is the one serving. */
  get rejection(): ConfigRejection | undefined { return this.refused?.reason; }
  current(): Promise<GatewayConfig> {
    if (this.pending) return this.pending;
    const read = this.read(); this.pending = read;
    void read.finally(() => { if (this.pending === read) this.pending = undefined; }).catch(() => {});
    return read;
  }
  /** Keeps the last good configuration. The refusal is recorded once per stamp, so a file that stays wrong is not logged per request. */
  private refuse(stamp: string, reason: ConfigRejection): GatewayConfig {
    if (this.refused?.stamp !== stamp) { this.refused = { stamp, reason }; telemetry("config_rejected", { reason }); }
    return this.value;
  }
  private async read(): Promise<GatewayConfig> {
    let stamp: string;
    try { const info = await stat(this.path, { bigint: true }); stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`; }
    catch { return this.refuse("unreadable", "unreadable"); }
    // The file in place is the one that serves (a refused change was put back, say): nothing is pending any more.
    if (stamp === this.stamp) { this.refused = undefined; return this.value; }
    // A refused file is judged once: the bindings it was judged against only change when another file is adopted.
    // An unreadable one is read again, because mending its permissions does not change its stamp.
    if (stamp === this.refused?.stamp && this.refused.reason !== "unreadable") return this.value;
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch { return this.refuse(stamp, "unreadable"); }
    let parsed: GatewayConfig;
    try { parsed = validateConfig(JSON.parse(text), dirname(resolve(this.path))); } catch { return this.refuse(stamp, "invalid"); }
    const next = this.portOverride === undefined ? parsed : { ...parsed, port: this.portOverride };
    if (next.port !== this.value.port || next.stateDirectory !== this.value.stateDirectory || next.clientOnly !== this.value.clientOnly) return this.refuse(stamp, "restart_required");
    const before = this.pinnedBindings; const after = bindings(next);
    for (const [alias, route] of before) if (after.has(alias) && after.get(alias) !== route) return this.refuse(stamp, "rebind");
    for (const [alias, route] of after) this.pinnedBindings.set(alias, route);
    this.value = next; this.stamp = stamp; this.refused = undefined; return next;
  }
}
