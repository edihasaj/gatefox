import { stat } from "node:fs/promises";
import { loadConfig, type GatewayConfig, type ProviderConfig } from "./config.js";

function bindings(config: GatewayConfig): Map<string, string> {
  const identity = (provider: ProviderConfig, model: string) => JSON.stringify([provider.id, provider.type, provider.credentialFile || "", provider.authDirectory || "", provider.baseUrl || "", provider.apiKeyEnv || "", model]);
  return new Map(config.providers.flatMap(provider => Object.entries(provider.models).map(([alias, model]) => [alias, identity(provider, model)])));
}

/** Reload an atomic config replacement without changing the listener or credentials. */
export class LiveConfig {
  private stamp = "";
  private value: GatewayConfig;
  private pending?: Promise<GatewayConfig>;
  constructor(private readonly path: string, initial: GatewayConfig, private readonly portOverride?: number) { this.value = initial; }
  current(): Promise<GatewayConfig> {
    if (this.pending) return this.pending;
    const read = this.read(); this.pending = read;
    void read.finally(() => { if (this.pending === read) this.pending = undefined; }).catch(() => {});
    return read;
  }
  private async read(): Promise<GatewayConfig> {
    const info = await stat(this.path, { bigint: true });
    const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    if (stamp === this.stamp) return this.value;
    const parsed = await loadConfig(this.path);
    const next = this.portOverride === undefined ? parsed : { ...parsed, port: this.portOverride };
    if (next.port !== this.value.port || next.stateDirectory !== this.value.stateDirectory) throw new Error("Changing the gateway port or state directory requires restarting the daemon");
    const before = bindings(this.value); const after = bindings(next);
    for (const [alias, route] of before) if (after.has(alias) && after.get(alias) !== route) throw new Error("An existing model alias cannot be rebound live; add a new alias or restart explicitly");
    this.value = next; this.stamp = stamp; return next;
  }
}
