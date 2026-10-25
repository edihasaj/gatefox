import { access, constants, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, writePrivateJson, type GatewayConfig } from "./config.js";
import { modelCatalog } from "./catalog.js";
import { gatewayProviderTable } from "./codex-config.js";
import { configureTelemetry, telemetry } from "./telemetry.js";
import { withLoginRegistrationLock } from "./login-registration-lock.js";
import type { NativeConfigClient, NativeConfigEdit } from "./desktop-api-mode-native.js";

/**
 * API mode for the Codex desktop app. While the receipt below exists the app starts its own signed engine and uses this
 * gateway only as a plain Responses model provider, so the app's own `codex_app` tools (automation, threads) reach
 * gateway models: the app's tool pipe only trusts an OpenAI-signed engine process chain, which the adapter breaks
 * (docs/api-mode.md, docs/client-tool-reachability.md). The gateway never runs that engine itself; it changes the
 * configuration the engine is launched with, through the engine, so comments, key order and every setting the gateway
 * does not own stay as the user left them.
 *
 * The receipt is also the switch: it is the only thing that separates API mode from the adapter on this machine, so
 * every path that hands the desktop back to the adapter refuses while it is present. What was in the native
 * configuration before is remembered in it, so `off` can put each key back.
 */

/** The provider id API mode writes. The adapter uses its own id (`codex-config.ts`); the two never share a file. */
export const apiModeProvider = "harness_gateway";
export const apiModeCatalogFile = "api-mode-models.json";
export const apiModeReceiptFile = "api-mode.json";

/** What `on` found in the user configuration, so `off` can restore it: a key this object omits was absent before. */
export type ApiModeReceipt = {
  version: 1;
  nativeHome: string;
  original: { model?: unknown; model_provider?: unknown; model_catalog_json?: unknown };
  providerTableExisted: boolean;
  applied: { provider: string; catalogPath: string; model: string };
  /** Whether API mode removed this gateway's own adapter override from the login session, so `off` must set it back. */
  cliPathCleared: boolean;
  enabledAt: string;
};

/** The user-configuration keys API mode owns while it is on, in the spelling the engine parses. */
const modelKeys = ["model", "model_provider", "model_catalog_json"] as const;
type ModelKey = (typeof modelKeys)[number];

export type ApiModeAction = "on" | "off" | "status";

/** The seams a test or the opt-in check replaces; the production set lives in `desktop-api-mode-native.ts`. */
export interface ApiModeDeps {
  /** A client for the app's own signed engine, pointed at `nativeHome`. */
  native: (nativeHome: string, app: string) => Promise<NativeConfigClient>;
  appRunning: (app: string) => Promise<boolean>;
  /** The native home the app's engine reads: `CODEX_HOME`, else `~/.codex`. A seam so no test touches the real one. */
  nativeHome: () => string;
  /** Who owns the login session's adapter override: this gateway's wrapper, nobody, or somebody else. Never its value. */
  cliPathOwner: (stateDirectory: string) => Promise<"gateway" | "none" | "other">;
  /** Remove the session's adapter override. Only ever called once `cliPathOwner` answered `gateway`. */
  clearCliPath: () => Promise<void>;
  /** The daemon's own first step: sets the override again when the registration receipt names our wrapper. */
  presetEnv: (stateDirectory: string) => Promise<void>;
  now: () => Date;
}

export const apiModeReceiptPath = (stateDirectory: string): string => resolve(stateDirectory, apiModeReceiptFile);
export const apiModeCatalogPath = (stateDirectory: string): string => resolve(stateDirectory, apiModeCatalogFile);

const unreadable = "The API mode receipt is unreadable; resolve it by hand before changing the desktop adapter";

/** The receipt, or nothing where API mode is off. Unreadable JSON fails: its edits may well be in place. */
export async function readApiModeReceipt(stateDirectory: string): Promise<ApiModeReceipt | undefined> {
  let value: unknown;
  try { value = JSON.parse(await readFile(apiModeReceiptPath(stateDirectory), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(unreadable); }
  const receipt = value as Partial<ApiModeReceipt>;
  if (!value || typeof value !== "object" || Array.isArray(value) || receipt.version !== 1 || typeof receipt.nativeHome !== "string"
    || !receipt.original || typeof receipt.original !== "object" || typeof receipt.providerTableExisted !== "boolean" || typeof receipt.cliPathCleared !== "boolean"
    || !receipt.applied || typeof receipt.applied !== "object" || ["provider", "catalogPath", "model"].some(key => typeof (receipt.applied as Record<string, unknown>)[key] !== "string")) {
    throw new Error(unreadable);
  }
  return value as ApiModeReceipt;
}

/** Whether API mode owns the desktop right now. A broken receipt counts as on: its edits may be in place. */
export async function apiModeActive(stateDirectory: string): Promise<boolean> {
  try { return await readApiModeReceipt(stateDirectory) !== undefined; } catch { return true; }
}

/** Why the adapter paths refuse while API mode is on. */
export const apiModeOnMessage = "API mode is on; run gateway desktop api-mode off first";

/** One `desktop_api_mode` event. Only the fixed words below ever reach telemetry, never a path, model or value. */
function report(action: "on" | "off" | "preset", outcome: "applied" | "refused" | "rolled_back" | "failed" | "skipped", reason?: string): void {
  telemetry("desktop_api_mode", { action, outcome, ...(reason ? { reason } : {}) });
}

/** Whether a process already reported the adapter being held back, so a long-lived daemon says it once. */
let presetReported = false;
/** The one event the adapter paths log when the receipt holds them back: never an error, never a value. */
export function reportPresetSkipped(stateDirectory: string): void {
  if (presetReported) return;
  presetReported = true;
  configureTelemetry(stateDirectory, "service");
  report("preset", "skipped");
}

/**
 * The hook the running service calls once it has adopted a new gateway configuration: while API mode is on, the catalog
 * file the native engine reads is rewritten from the configuration that now serves, so a model added to the gateway
 * reaches the app's picker without a restart. It does nothing at all when there is no receipt, throws nothing, and
 * starts no timer or background item of its own.
 */
export async function refreshApiModeCatalog(config: GatewayConfig): Promise<boolean> {
  try {
    const receipt = await readApiModeReceipt(config.stateDirectory).catch(() => undefined);
    if (!receipt) return false;
    await writePrivateJson(receipt.applied.catalogPath || apiModeCatalogPath(config.stateDirectory), modelCatalog(config));
    return true;
  } catch { return false; }
}

/** The provider table, in the TOML spelling the engine writes verbatim; the adapter's settings come from the same builder. */
function providerTable(config: GatewayConfig, configPath: string): Record<string, unknown> {
  if (!config.port) throw new Error("Use a fixed port before API mode can serve the desktop");
  return gatewayProviderTable(`http://127.0.0.1:${config.port}/v1`, ["--config", resolve(configPath)]);
}

/** The model API mode selects: the caller's choice, else the model already in use if we serve it, else the first offered. */
export function chooseModel(wanted: string | undefined, nativeModel: unknown, catalog: Array<Record<string, unknown>>): string {
  if (wanted !== undefined) {
    if (!catalog.some(row => row.slug === wanted)) throw new Error("That model is not in this gateway's catalog; run `gateway catalog` to see what it offers");
    return wanted;
  }
  const slugs = new Set(catalog.map(row => row.slug));
  if (typeof nativeModel === "string" && slugs.has(nativeModel)) return nativeModel;
  const row = catalog.find(entry => entry.visibility === "list") || catalog[0];
  if (typeof row.slug !== "string") throw new Error("This gateway's catalog has no usable model row");
  return row.slug;
}

/** What `on` writes, in one batch: the provider, then the three keys that point the engine at it. */
function applyEdits(config: GatewayConfig, configPath: string, receipt: ApiModeReceipt): NativeConfigEdit[] {
  return [
    { keyPath: `model_providers.${apiModeProvider}`, value: providerTable(config, configPath), mergeStrategy: "replace" },
    { keyPath: "model_provider", value: apiModeProvider, mergeStrategy: "replace" },
    { keyPath: "model_catalog_json", value: receipt.applied.catalogPath, mergeStrategy: "replace" },
    { keyPath: "model", value: receipt.applied.model, mergeStrategy: "replace" },
  ];
}

/**
 * The edits that put the user configuration back: each key API mode still holds returns to what the receipt found
 * there (a key that was absent is cleared), one the user has since changed is left alone and named, and the provider
 * table is removed only where API mode created it.
 */
function editsToRestore(receipt: ApiModeReceipt, config: Record<string, unknown>): { edits: NativeConfigEdit[]; changed: ModelKey[] } {
  const applied: Record<ModelKey, unknown> = { model: receipt.applied.model, model_provider: receipt.applied.provider, model_catalog_json: receipt.applied.catalogPath };
  const edits: NativeConfigEdit[] = []; const changed: ModelKey[] = [];
  for (const key of modelKeys) {
    if (JSON.stringify(config[key]) !== JSON.stringify(applied[key])) { changed.push(key); continue; }
    const original = receipt.original[key];
    edits.push({ keyPath: key, value: original === undefined ? null : original, mergeStrategy: "replace" });
  }
  if (!receipt.providerTableExisted) edits.push({ keyPath: `model_providers.${apiModeProvider}`, value: null, mergeStrategy: "replace" });
  return { edits, changed };
}

/** Read the current user layer and undo API mode in it. Used by `off` and by every rollback path. */
async function restore(client: NativeConfigClient, receipt: ApiModeReceipt): Promise<{ restored: string[]; changed: ModelKey[] }> {
  const read = await client.read();
  const { edits, changed } = editsToRestore(receipt, read.config);
  if (edits.length) await client.write(edits, read.version);
  return { restored: edits.map(edit => edit.keyPath), changed };
}

/**
 * `gateway desktop api-mode on|off|status`. Everything that changes machine state happens under the login registration
 * lock, the same one register and unregister take, so nothing else can move the desktop between the read and the write.
 * macOS only: the app, its signed engine and the login session are what the adapter already depends on.
 */
export async function desktopApiMode(action: ApiModeAction, configPath: string, options: { model?: string; app?: string }, deps: ApiModeDeps): Promise<Record<string, unknown>> {
  if (process.platform !== "darwin") throw new Error("API mode is only available on macOS");
  if (!["on", "off", "status"].includes(action)) throw new Error("gateway desktop api-mode takes on, off or status");
  const config = await loadConfig(configPath);
  configureTelemetry(config.stateDirectory, "service");
  const app = resolve(options.app || "/Applications/ChatGPT.app");
  if (action === "status") return await runStatus(config, app, deps);
  if (action === "on" && config.clientOnly) { report("on", "refused", "client_only"); throw new Error("API mode needs a gateway running on this Mac"); }
  return action === "on"
    ? await withLoginRegistrationLock(config.stateDirectory, () => enable(config, configPath, app, options.model, deps))
    : await withLoginRegistrationLock(config.stateDirectory, () => disable(config, app, deps));
}

async function runStatus(config: GatewayConfig, app: string, deps: ApiModeDeps): Promise<Record<string, unknown>> {
  const receipt = await readApiModeReceipt(config.stateDirectory);
  const registered = await desktopRegistrationPresent(config.stateDirectory);
  const [appRunning, cliPathOverride] = await Promise.all([deps.appRunning(app), deps.cliPathOwner(config.stateDirectory)]);
  let nativeProviderMatches = false;
  // Only a machine that could be in API mode has an engine worth asking; a client configuration has no local provider.
  if (receipt || !config.clientOnly) {
    let client: NativeConfigClient | undefined;
    try {
      client = await deps.native(receipt?.nativeHome || deps.nativeHome(), app);
      nativeProviderMatches = (await client.read()).config.model_provider === apiModeProvider;
    } catch { nativeProviderMatches = false; } finally { await client?.close(); }
  }
  const catalog = receipt?.applied.catalogPath || apiModeCatalogPath(config.stateDirectory);
  return { mode: receipt ? "api" : registered ? "adapter" : "neither", receipt: !!receipt, nativeProviderMatches,
    catalogPresent: await access(catalog, constants.F_OK).then(() => true, () => false), registered, appRunning, cliPathOverride };
}

/** Whether the adapter registration receipt names a wrapper, as `gateway desktop status` counts it. */
async function desktopRegistrationPresent(stateDirectory: string): Promise<boolean> {
  let wrapper: unknown;
  try { wrapper = (JSON.parse(await readFile(resolve(stateDirectory, "desktop-registration.json"), "utf8")) as { wrapper?: unknown }).wrapper; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  return typeof wrapper === "string" && wrapper !== "";
}

async function enable(config: GatewayConfig, configPath: string, app: string, wanted: string | undefined, deps: ApiModeDeps): Promise<Record<string, unknown>> {
  const stateDirectory = config.stateDirectory;
  if (await readApiModeReceipt(stateDirectory)) { report("on", "refused", "already_on"); throw new Error("API mode is already on; run `gateway desktop api-mode off` first"); }
  if (await deps.appRunning(app)) { report("on", "refused", "app_running"); throw new Error("Quit ChatGPT first; API mode applies to the next launch."); }
  const owner = await deps.cliPathOwner(stateDirectory);
  // A foreign override stays exactly where it is: nothing is written, because API mode could not hand it back later.
  if (owner === "other") { report("on", "refused", "foreign_cli_path"); throw new Error("Another desktop CLI override is active; it was not replaced. API mode cannot run while CODEX_CLI_PATH names a CLI this gateway did not register."); }
  const nativeHome = deps.nativeHome();
  const client = await deps.native(nativeHome, app);
  try {
    const read = await client.read();
    const original: ApiModeReceipt["original"] = {};
    for (const key of modelKeys) if (read.config[key] !== undefined) original[key] = read.config[key];
    const providers = read.config.model_providers;
    const catalog = modelCatalog(config);
    // The engine refuses to read a configuration whose catalog is missing or empty, so this file has to exist with at
    // least one row before `model_catalog_json` names it, or the app would be left without any model at all.
    if (!catalog.models.length) throw new Error("This gateway offers no models, so there is nothing for API mode to serve");
    const catalogPath = apiModeCatalogPath(stateDirectory);
    let receipt: ApiModeReceipt = { version: 1, nativeHome, original,
      providerTableExisted: hasProvider(providers),
      applied: { provider: apiModeProvider, catalogPath, model: chooseModel(wanted, read.config.model, catalog.models) },
      cliPathCleared: false, enabledAt: new Date().toISOString() };
    // Everything this batch needs from the configuration is checked before a single file is written, so a bad port,
    // endpoint or model choice is a refusal rather than a rollback.
    const edits = applyEdits(config, configPath, receipt);
    await writePrivateJson(catalogPath, catalog);
    // The receipt lands before the batch write, so a crash between the two leaves the record that says what to undo.
    await writePrivateJson(apiModeReceiptPath(stateDirectory), receipt);
    try { await client.write(edits, read.version); }
    catch (error) { await detach(client, receipt, stateDirectory); report("on", "rolled_back", "native_write"); throw error; }
    // Detach the adapter: the app must not load the wrapper beside its own provider. The registration receipt and the
    // service plan are left as they are, so `off` and the daemon's own preset can put the override back.
    if (owner === "gateway") {
      try { await deps.clearCliPath(); }
      catch (error) { await detach(client, receipt, stateDirectory); report("on", "rolled_back", "clear_cli_path"); throw error; }
      receipt = { ...receipt, cliPathCleared: true };
    }
    await writePrivateJson(apiModeReceiptPath(stateDirectory), receipt);
    report("on", "applied");
    return { mode: "api", model: receipt.applied.model, catalogPath: receipt.applied.catalogPath, cliPathCleared: receipt.cliPathCleared, freshAppLaunchRequired: true };
  } finally { await client.close(); }
}

/** Undo a failed `on`: put the user configuration back as the receipt found it, then retire the receipt. */
async function detach(client: NativeConfigClient, receipt: ApiModeReceipt, stateDirectory: string): Promise<void> {
  await restore(client, receipt).catch(() => undefined);
  await unlink(apiModeReceiptPath(stateDirectory)).catch(() => undefined);
}

const hasProvider = (providers: unknown): boolean => !!providers && typeof providers === "object" && Object.hasOwn(providers as Record<string, unknown>, apiModeProvider);

async function disable(config: GatewayConfig, app: string, deps: ApiModeDeps): Promise<Record<string, unknown>> {
  const stateDirectory = config.stateDirectory;
  const receipt = await readApiModeReceipt(stateDirectory);
  if (!receipt) { report("off", "refused", "not_on"); throw new Error("API mode is not on"); }
  if (await deps.appRunning(app)) { report("off", "refused", "app_running"); throw new Error("Quit ChatGPT first; API mode applies to the next launch."); }
  const client = await deps.native(receipt.nativeHome, app);
  try {
    const { restored, changed } = await restore(client, receipt);
    await unlink(apiModeReceiptPath(stateDirectory));
    // Hand the desktop back to the adapter the same way the daemon takes it up: only a registration receipt that names
    // this gateway's wrapper can set the override, and the app picks it up at its next launch.
    let cliPathRestored = false;
    if (await desktopRegistrationPresent(stateDirectory)) { await deps.presetEnv(stateDirectory); cliPathRestored = true; }
    report("off", "applied");
    return { mode: "adapter", restored, changedSinceEnable: changed, cliPathRestored };
  } catch (error) { report("off", "failed", "native_write"); throw error; } finally { await client.close(); }
}
