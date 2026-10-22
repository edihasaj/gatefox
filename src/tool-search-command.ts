import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { validateConfig, writePrivateJson, type GatewayConfig, type ProviderConfig } from "./config.js";
import { daemonConfigStatus, type ConfigRejection } from "./config-rejection.js";

export type ToolSearchAction = "on" | "off" | "status";
export interface ToolSearchResult {
  providers: Array<{ id: string; toolSearch: "bridge" | "off" }>;
  changed: boolean;
  /** Whether the running daemon took the saved file; absent for `status`. */
  daemon?: { reachable: boolean; rejection?: ConfigRejection };
}

const state = (provider: Pick<ProviderConfig, "toolSearch">): "bridge" | "off" => provider.toolSearch === "bridge" ? "bridge" : "off";

/**
 * `gateway tool-search on|off|status`: the tool search bridge (`"toolSearch": "bridge"`, see docs/responses.md) for every
 * `codex-subscription` provider. `on` sets the field, `off` removes it (off is the default), `status` only reads. The
 * edited file is validated before it is saved, and the change applies live, like `discover --load`: no restart, and no
 * other field of gateway.json changes. Codex picks up the new catalog for chats it loads afterwards.
 */
export async function toolSearchCommand(action: ToolSearchAction, path: string, config: GatewayConfig,
  status: typeof daemonConfigStatus = daemonConfigStatus): Promise<ToolSearchResult> {
  if (config.clientOnly) throw new Error("This gateway is a client of another one; change tool search on the gateway that serves the Codex subscription");
  const codex = config.providers.filter(provider => provider.type === "codex-subscription");
  if (!codex.length) throw new Error("No codex-subscription provider is configured");
  if (action === "status") return { providers: codex.map(provider => ({ id: provider.id, toolSearch: state(provider) })), changed: false };
  const source = JSON.parse(await readFile(path, "utf8")) as { providers?: Array<Record<string, unknown>> };
  let changed = false;
  for (const provider of source.providers ?? []) {
    if (provider.type !== "codex-subscription") continue;
    const before = provider.toolSearch;
    if (action === "on") provider.toolSearch = "bridge"; else delete provider.toolSearch;
    if (provider.toolSearch !== before) changed = true;
  }
  const next = validateConfig(source, dirname(path));
  if (changed) await writePrivateJson(path, source);
  const providers = next.providers.filter(provider => provider.type === "codex-subscription").map(provider => ({ id: provider.id, toolSearch: state(provider) }));
  return { providers, changed, ...(changed ? { daemon: await status(config.port) } : {}) };
}
