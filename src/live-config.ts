import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateConfig, type GatewayConfig, type ProviderConfig } from "./config.js";
import type { ConfigRejection } from "./config-rejection.js";
import { telemetry } from "./telemetry.js";

export type { ConfigRejection } from "./config-rejection.js";

function bindings(config: GatewayConfig): Map<string, string> {
  const identity = (provider: ProviderConfig, model: string) => JSON.stringify([provider.id, provider.type, provider.credentialFile || "", provider.authDirectory || "", provider.baseUrl || "", provider.tailnet === true, provider.apiKeyEnv || "", model]);
  return new Map(config.providers.flatMap(provider => Object.entries(provider.models).map(([alias, model]) => [alias, identity(provider, model)])));
}

/**
 * What a refused file still takes away. The last good configuration keeps serving, minus every alias the refused file no
 * longer has: a provider removed on purpose (a revoked account, say) must stop serving even when another edit in the same
 * file was refused. Unchanged when nothing was removed.
 */
function withoutRemoved(config: GatewayConfig, wanted: GatewayConfig): GatewayConfig {
  const keep = new Set(wanted.providers.flatMap(provider => Object.keys(provider.models)));
  let removed = false;
  const providers = config.providers.flatMap(provider => {
    const aliases = Object.keys(provider.models).filter(alias => keep.has(alias));
    if (aliases.length === Object.keys(provider.models).length) return [provider];
    removed = true;
    if (!aliases.length) return [];
    const pick = <T>(table: Record<string, T>): Record<string, T> => Object.fromEntries(aliases.filter(alias => Object.hasOwn(table, alias)).map(alias => [alias, table[alias]]));
    return [{ ...provider, models: pick(provider.models), ...(provider.modelMetadata ? { modelMetadata: pick(provider.modelMetadata) } : {}) }];
  });
  const oldManaged = config.managedRouting;
  const managed = Object.entries(oldManaged?.routes ?? {}).filter(([alias]) => Object.hasOwn(wanted.managedRouting?.routes ?? {}, alias));
  const removedManaged = managed.length !== Object.keys(oldManaged?.routes ?? {}).length;
  if (!removed && !removedManaged) return config;
  const result = { ...config, providers };
  if (removedManaged) {
    if (managed.length) result.managedRouting = { routes: Object.fromEntries(managed) };
    else delete result.managedRouting;
  }
  return result;
}

/**
 * Reload an atomic config replacement without changing the listener or credentials. A change that cannot be applied live
 * is refused, never thrown: the last good configuration keeps serving (less any alias a refused but valid file removed), the
 * refusal is recorded once per file stamp as `config_rejected`, and the next file that is valid and allowed is adopted. The first load at startup is not
 * this class's: it stays fatal in `startServeRuntime`.
 */
export class LiveConfig {
  private stamp = "";
  private value: GatewayConfig;
  /** What is served: the last good configuration, less the aliases a refused file removed; it is `value` itself when nothing is held back. */
  private served: GatewayConfig;
  private pending?: Promise<GatewayConfig>;
  private readonly pinnedBindings: Map<string, string>;
  /** The stamp of the file that was refused, and why; undefined while the newest file is applied. */
  private refused?: { stamp: string; reason: ConfigRejection };
  /**
   * `onApplied` runs once for each file this reload actually adopts, never for a refused one and never twice for the
   * same stamp. It is told the configuration that is now serving. The first load at startup is not its to observe.
   */
  constructor(private readonly path: string, initial: GatewayConfig, private readonly portOverride?: number, private readonly onApplied?: (config: GatewayConfig) => void) { this.value = initial; this.served = initial; this.pinnedBindings = bindings(initial); }
  /** Why the newest change to the file is not applied, or undefined when the file in place is the one serving. */
  get rejection(): ConfigRejection | undefined { return this.refused?.reason; }
  current(): Promise<GatewayConfig> {
    if (this.pending) return this.pending;
    const read = this.read(); this.pending = read;
    void read.finally(() => { if (this.pending === read) this.pending = undefined; }).catch(() => {});
    return read;
  }
  /**
   * Keeps serving the last good configuration, less the aliases `removing` (a refused file that did validate) no longer has;
   * a file that did not validate leaves what is served as it is. The refusal is recorded once per stamp, so a file that
   * stays wrong is not logged per request.
   */
  private refuse(stamp: string, reason: ConfigRejection, removing?: GatewayConfig): GatewayConfig {
    if (removing) this.served = withoutRemoved(this.value, removing);
    if (this.refused?.stamp !== stamp) { this.refused = { stamp, reason }; telemetry("config_rejected", { reason }); }
    return this.served;
  }
  private async read(): Promise<GatewayConfig> {
    let stamp: string;
    try { const info = await stat(this.path, { bigint: true }); stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`; }
    catch { return this.refuse("unreadable", "unreadable"); }
    // The file in place is the one that serves (a refused change was put back, say): nothing is pending any more.
    if (stamp === this.stamp) { this.refused = undefined; this.served = this.value; return this.value; }
    // A refused file is judged once: the bindings it was judged against only change when another file is adopted.
    // An unreadable one is read again, because mending its permissions does not change its stamp.
    if (stamp === this.refused?.stamp && this.refused.reason !== "unreadable") return this.served;
    let text: string;
    try { text = await readFile(this.path, "utf8"); } catch { return this.refuse(stamp, "unreadable"); }
    let parsed: GatewayConfig;
    try { parsed = validateConfig(JSON.parse(text), dirname(resolve(this.path))); } catch { return this.refuse(stamp, "invalid"); }
    const next = this.portOverride === undefined ? parsed : { ...parsed, port: this.portOverride };
    if (next.port !== this.value.port || next.stateDirectory !== this.value.stateDirectory || next.clientOnly !== this.value.clientOnly) return this.refuse(stamp, "restart_required", next);
    const before = this.pinnedBindings; const after = bindings(next);
    for (const [alias, route] of before) if (after.has(alias) && after.get(alias) !== route) return this.refuse(stamp, "rebind", next);
    for (const [alias, route] of after) this.pinnedBindings.set(alias, route);
    this.value = next; this.served = next; this.stamp = stamp; this.refused = undefined;
    // Only now, with the new configuration in place, may anything act on it. A hook that throws is not this class's
    // problem to solve twice: the configuration it was adopted for is already serving.
    this.onApplied?.(next);
    return next;
  }
}
