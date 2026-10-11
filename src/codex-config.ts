import { resolve } from "node:path";
import { writePrivateJson, readClientToken } from "./config.js";
import { gatewayCommand } from "./command.js";

export { readClientToken } from "./config.js";

export function endpointURL(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Endpoint requires HTTPS or loopback HTTP, without credentials, query, or fragment");
  return url.href.replace(/\/$/, "");
}

export function codexSettings(model: string, catalog: string, endpoint: string, credentialArgs: string[], timeoutMs = 120000): string {
  const quoted = (value: string) => JSON.stringify(value);
  const helper = gatewayCommand();
  return `model = ${quoted(model)}\nmodel_provider = "subscription_gateway"\nmodel_catalog_json = ${quoted(resolve(catalog))}\nmodel_reasoning_summary = "auto"\nweb_search = "disabled"\n\n[model_providers.subscription_gateway]\nname = "Subscription Gateway"\nbase_url = ${quoted(endpointURL(endpoint))}\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 2\nstream_max_retries = 0\nstream_idle_timeout_ms = ${timeoutMs}\n\n[model_providers.subscription_gateway.auth]\ncommand = ${quoted(helper.command)}\nargs = [${[...helper.args, "token", ...credentialArgs].map(quoted).join(", ")}]\ntimeout_ms = 5000\nrefresh_interval_ms = 300000\n`;
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
