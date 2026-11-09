import { resolve } from "node:path";
import { writePrivateJson, readClientToken } from "./config.js";
import { gatewayCommand } from "./command.js";

export { readClientToken } from "./config.js";

export function endpointURL(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Endpoint requires HTTPS or loopback HTTP, without credentials, query, or fragment");
  return url.href.replace(/\/$/, "");
}

/** Codex gives up on a silent stream after this long; gateway heartbeats arrive every 15 seconds. */
export const codexStreamIdleTimeoutMs = 90000;

/** The provider id the desktop adapter registers under in a native configuration. */
/** The provider id the generated settings select; `subscription_gateway` is registered beside it so chats saved before 1.8.0 resolve. */
export const adapterProvider = "gatefox";
export const legacyAdapterProvider = "subscription_gateway";

/**
 * The gateway's own Responses provider, in the spelling `config.toml` uses. Both the adapter's generated settings and
 * API mode's native `model_providers` table come from here, so a change to the endpoint, the retry policy or the
 * credential helper is one change. The table is passed to the engine as data and written verbatim, so its keys stay in
 * TOML form (`base_url`, not `baseUrl`).
 */
export function gatewayProviderTable(endpoint: string, credentialArgs: string[]): Record<string, unknown> {
  const helper = gatewayCommand();
  return { name: "GateFox", base_url: endpointURL(endpoint), wire_api: "responses", supports_websockets: false,
    request_max_retries: 2, stream_idle_timeout_ms: codexStreamIdleTimeoutMs,
    auth: { command: helper.command, args: [...helper.args, "token", ...credentialArgs], timeout_ms: 5000, refresh_interval_ms: 300000 } };
}

/** How the engine spells a settings value: strings quoted, arrays inline, numbers and booleans as they are. */
const tomlValue = (value: unknown): string => Array.isArray(value) ? `[${value.map(tomlValue).join(", ")}]` : JSON.stringify(value);
const tomlEntries = (table: Record<string, unknown>): string => Object.entries(table).map(([key, value]) => `${key} = ${tomlValue(value)}`).join("\n");

/** The provider's two tables, as the generated settings have always printed them. */
function providerTableToml(endpoint: string, credentialArgs: string[], id: string): string {
  const { auth, ...flat } = gatewayProviderTable(endpoint, credentialArgs);
  return `[model_providers.${id}]\n${tomlEntries(flat)}\n\n[model_providers.${id}.auth]\n${tomlEntries(auth as Record<string, unknown>)}\n`;
}

export function codexSettings(model: string, catalog: string, endpoint: string, credentialArgs: string[]): string {
  const quoted = (value: string) => JSON.stringify(value);
  return `model = ${quoted(model)}\nmodel_provider = "${adapterProvider}"\nmodel_catalog_json = ${quoted(resolve(catalog))}\nmodel_reasoning_summary = "auto"\n\n${providerTableToml(endpoint, credentialArgs, adapterProvider)}\n${providerTableToml(endpoint, credentialArgs, legacyAdapterProvider)}`;
}

/** Fetch only the public catalog. The inference host keeps provider credentials. */
export async function remoteCodexSettings(model: string, endpoint: string, tokenFile: string, catalogPath: string): Promise<string> {
  const base = endpointURL(endpoint);
  const token = await readClientToken(tokenFile);
  const response = await fetch(`${base}/model-catalog`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Remote catalog returned HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 1024 * 1024) throw new Error("Remote model catalog exceeds 1 MiB");
  const catalog = JSON.parse(body) as { models?: Array<{ slug?: string }> };
  if (!Array.isArray(catalog.models) || catalog.models.some(entry => !entry || typeof entry.slug !== "string") || new Set(catalog.models.map(entry => entry.slug)).size !== catalog.models.length || !catalog.models.some(entry => entry.slug === model)) throw new Error("Selected model is absent from a valid remote catalog");
  if (resolve(catalogPath) === resolve(tokenFile)) throw new Error("Catalog must not overwrite the client token");
  await writePrivateJson(catalogPath, catalog);
  return codexSettings(model, catalogPath, base, ["--file", resolve(tokenFile)]);
}
