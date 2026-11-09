import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gatewayCommand } from "./command.js";
import { adapterProvider, codexAuthCommandTimeoutMs, codexStreamIdleTimeoutMs, legacyAdapterProvider } from "./codex-config.js";
import { apiModeEngine, apiModeNativeHome, openNativeConfig, type NativeConfigClient } from "./desktop-api-mode-native.js";
import { telemetry } from "./telemetry.js";

/**
 * The gateway's provider row in the native Codex configuration. Gateway chats are saved with the provider id
 * `gatefox` (`subscription_gateway` before 1.8.0). Every engine the gateway starts registers both ids with `-c` settings, but the ChatGPT app's own
 * engine reads only `~/.codex/config.toml`. When the app starts before the gateway service has set CODEX_CLI_PATH at
 * login, or runs its own engine for any other reason, a gateway chat would fail to open with "Model provider
 * `subscription_gateway` not found". Publishing this one row lets any engine open those chats and send their turns to
 * the loopback gateway. It never sets `model_provider`, a model or a catalog, so new native chats keep their own
 * provider. See docs/harness-identity.md.
 */
export type NativeProviderRow = Record<string, unknown> & { auth: Record<string, unknown> };

/** The row, in the TOML spelling the engine reads. The adapter's `-c` settings are the same row, flattened. */
export function nativeProviderRow(port: number, configPath: string): NativeProviderRow {
  const helper = gatewayCommand();
  return { name: "GateFox", base_url: `http://127.0.0.1:${port}/v1`, wire_api: "responses", requires_openai_auth: false,
    supports_websockets: false, request_max_retries: 2, stream_idle_timeout_ms: codexStreamIdleTimeoutMs,
    auth: { command: helper.command, args: [...helper.args, "token", "--config", resolve(configPath)], timeout_ms: codexAuthCommandTimeoutMs, refresh_interval_ms: 300000 } };
}

/** The row as the dotted `-c` keys an engine launch takes (`auth.command`, not a nested table). */
export function providerOverrides(row: NativeProviderRow): Record<string, unknown> {
  const { auth, ...flat } = row;
  return { ...flat, ...Object.fromEntries(Object.entries(auth).map(([key, value]) => [`auth.${key}`, value])) };
}

export type NativeProviderOutcome = "written" | "current" | "foreign" | "skipped" | "failed";
export type NativeProviderRemoval = "removed" | "absent" | "foreign" | "failed";

export type NativeProviderDeps = {
  open: (nativeHome: string, app: string) => Promise<NativeConfigClient>;
  nativeHome: () => string;
};

const defaultDeps: NativeProviderDeps = {
  open: async (nativeHome, app) => await openNativeConfig(await apiModeEngine(app), nativeHome),
  nativeHome: apiModeNativeHome,
};

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A row is the gateway's when it carries the gateway's name or credential helper; anything else is left alone. */
const ownedRow = (row: unknown): boolean => ["GateFox", "Harness Gateway"].includes(String(object(row).name)) || object(object(row).auth).command === gatewayCommand().command;
/** Both of the gateway's ids get the same row: `gatefox` for chats since 1.8.0, `subscription_gateway` for older ones. */
const rowIds = [adapterProvider, legacyAdapterProvider];

async function withNative<T>(app: string, deps: NativeProviderDeps, run: (client: NativeConfigClient) => Promise<T>, failed: T): Promise<T> {
  let client: NativeConfigClient | undefined;
  try { client = await deps.open(deps.nativeHome(), app); return await run(client); }
  catch { return failed; }
  finally { await client?.close().catch(() => undefined); }
}

/**
 * Writes the row through the app's own engine, as API mode writes its settings, so comments and every unrelated key stay
 * as they are. A current row is left untouched, a foreign row of the same id is never replaced, and a failure is reported
 * and returned rather than thrown: desktop registration must not fail because the native configuration is unavailable.
 */
export async function publishNativeProvider(port: number | undefined, configPath: string, app: string, deps: NativeProviderDeps = defaultDeps): Promise<NativeProviderOutcome> {
  const outcome: NativeProviderOutcome = !port ? "skipped" : await withNative<NativeProviderOutcome>(app, deps, async client => {
    const row = nativeProviderRow(port, configPath);
    const { version, config } = await client.read();
    const rows = object(config.model_providers);
    // A foreign row under either id stops the whole publish, so the two ids never point at different gateways.
    if (rowIds.some(id => rows[id] !== undefined && !ownedRow(rows[id]))) return "foreign";
    const stale = rowIds.filter(id => !isDeepStrictEqual(rows[id], row));
    if (!stale.length) return "current";
    await client.write(stale.map(id => ({ keyPath: `model_providers.${id}`, value: row, mergeStrategy: "replace" as const })), version);
    return "written";
  }, "failed");
  telemetry("native_provider_row", { action: "publish", outcome });
  return outcome;
}

/** Removes the row at uninstall, only when it is the gateway's own. */
export async function withdrawNativeProvider(app: string, deps: NativeProviderDeps = defaultDeps): Promise<NativeProviderRemoval> {
  const outcome = await withNative<NativeProviderRemoval>(app, deps, async client => {
    const { version, config } = await client.read();
    const rows = object(config.model_providers);
    const present = rowIds.filter(id => rows[id] !== undefined);
    if (!present.length) return "absent";
    if (present.some(id => !ownedRow(rows[id]))) return "foreign";
    await client.write(present.map(id => ({ keyPath: `model_providers.${id}`, value: null, mergeStrategy: "replace" as const })), version);
    return "removed";
  }, "failed");
  telemetry("native_provider_row", { action: "withdraw", outcome });
  return outcome;
}
