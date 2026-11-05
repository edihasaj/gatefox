import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { ChatGPTRefreshDeferred } from "./auth/chatgpt.js";
import { discoverModels, type DiscoveredModel } from "./catalog.js";
import { capContextWindow, loadConfig, validateConfig, writePrivateJson, type GatewayConfig, type ProviderConfig } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import type { TailnetSeams } from "./tailnet.js";
import { telemetry } from "./telemetry.js";

type Windows = Record<string, Record<string, number>>;
const discoverable = new Set(["codex-subscription", "claude-subscription", "copilot-subscription", "responses-api", "chat-completions-api"]);
const windowsPath = (state: string) => resolve(state, "observed-context-windows.json");

async function readWindows(state: string): Promise<Windows> {
  try {
    const value = JSON.parse(await readFile(windowsPath(state), "utf8")) as { providers?: Windows };
    return value && typeof value.providers === "object" && value.providers ? value.providers : {};
  } catch { return {}; }
}

/** Context windows a provider reported while serving real requests; they outrank static defaults. */
export class ObservedContextWindows {
  private windows?: Promise<Windows>;
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly state: string) {}
  record(providerId: string, model: string, contextWindow: number): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(providerId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(model) || !Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 100_000_000) return;
    this.windows ||= readWindows(this.state);
    this.writes = this.writes.then(async () => {
      const windows = await this.windows!;
      if (windows[providerId]?.[model] === contextWindow) return;
      windows[providerId] = { ...windows[providerId], [model]: contextWindow };
      await writePrivateJson(windowsPath(this.state), { version: 1, providers: windows });
    }).catch(() => {});
  }
  /** Settles once every window recorded so far is written, or its write failed. */
  flush(): Promise<void> { return this.writes; }
}

/**
 * Updates metadata for already configured models from each provider's own catalog,
 * then applies context windows the provider reported in real responses. The model
 * set is unchanged: adding or removing routes stays an explicit `gateway discover`.
 *
 * This runs on a timer, possibly while the Mac sleeps, so it never refreshes a Codex login: a
 * codex-subscription provider whose access token would need a refresh is skipped for the round
 * and refreshed by the next real request or an explicit `gateway discover`. Claude and Copilot
 * discovery still run their own CLI or SDK, which may refresh its own login; guarding them is
 * left to a later release.
 */
export async function refreshModelMetadata(path: string, discover: (provider: ProviderConfig, options: { refresh: false; tailnet?: TailnetSeams }) => Promise<DiscoveredModel[]> = discoverModels, tailnet?: TailnetSeams): Promise<string[]> {
  const config = await loadConfig(path);
  if (config.clientOnly) return [];
  const observed = await readWindows(config.stateDirectory);
  // Per provider, per alias: the model the patch was computed for and the vendor fields to apply. Policy fields such as
  // `pickerHidden` are never part of a patch, so vendor data can neither hide nor unhide a model.
  const patches = new Map<string, { route: string; aliases: Map<string, { model: string; patch: Record<string, unknown> }> }>();
  for (const provider of config.providers) {
    if (!discoverable.has(provider.type)) continue;
    let discovered: DiscoveredModel[];
    try { discovered = await discover(provider, { refresh: false, ...(tailnet ? { tailnet } : {}) }); }
    catch (error) { telemetry("model_metadata_skipped", { provider: provider.id, reason: error instanceof ChatGPTRefreshDeferred ? "refresh_deferred" : "discovery_failed" }); continue; }
    const fresh = new Map(discovered.map(entry => [entry.model, entry.metadata]));
    const aliases = new Map<string, { model: string; patch: Record<string, unknown> }>();
    for (const [alias, model] of Object.entries(provider.models)) {
      const found = fresh.get(model); const window = observed[provider.id]?.[model];
      if (!found && window === undefined) continue;
      aliases.set(alias, { model, patch: { ...withoutPickerPolicy(found), ...(window !== undefined ? { contextWindow: window } : {}) } });
    }
    // Cheap pre-check against the snapshot: nothing to write when the patches change nothing.
    const snapshot = JSON.stringify(provider.modelMetadata || {});
    if (JSON.stringify(applyPatches(provider.modelMetadata, aliases)) !== snapshot) patches.set(provider.id, { route: routeFingerprint(provider), aliases });
  }
  if (!patches.size) return [];
  return withPrivateFileLock(path, async () => {
    // The current file decides: a model another writer hid or retired since the snapshot stays as it is now.
    const raw = await readFile(path, "utf8");
    const source = JSON.parse(raw) as GatewayConfig;
    const changed: string[] = [];
    for (const provider of source.providers) {
      const planned = patches.get(provider.id);
      if (!planned) continue;
      // The patch describes the account and endpoint the snapshot named. If the route changed since (credential file, base URL,
      // auth directory, account), that metadata belongs to another account: skip it; the next round discovers again.
      if (routeFingerprint(provider) !== planned.route) { telemetry("model_metadata_skipped", { provider: provider.id, reason: "route_changed" }); continue; }
      const aliases = planned.aliases;
      // A route re-pointed since the snapshot is not patched with metadata of the old model.
      const current = new Map([...aliases].filter(([alias, entry]) => provider.models?.[alias] === entry.model));
      const merged = applyPatches(provider.modelMetadata, current);
      if (JSON.stringify(merged) === JSON.stringify(provider.modelMetadata || {})) continue;
      provider.modelMetadata = merged; changed.push(provider.id);
    }
    if (!changed.length) return [];
    validateConfig(structuredClone(source), dirname(path));
    // Compare-and-swap for writers outside the lock: if the file changed while this was prepared, retry from the new contents.
    if (await readFile(path, "utf8") !== raw) throw new Error("Configuration changed during the metadata refresh; it will retry");
    await writePrivateJson(path, source);
    return changed;
  });
}

/** Vendor metadata minus every field the operator's picker policy owns. */
function withoutPickerPolicy(metadata: object | undefined): Record<string, unknown> {
  const { pickerHidden: _hidden, ...rest } = (metadata || {}) as Record<string, unknown>;
  return rest;
}

/** Merge patches over `base` (the current metadata), keeping every policy field of `base` and re-applying the operator cap. */
function applyPatches(base: ProviderConfig["modelMetadata"], aliases: Map<string, { patch: Record<string, unknown> }>): NonNullable<ProviderConfig["modelMetadata"]> {
  const metadata = { ...base };
  for (const [alias, { patch }] of aliases) {
    // An operator cap survives every refresh: a server reporting a larger limit never raises the saved window.
    metadata[alias] = capContextWindow({ ...metadata[alias], ...patch, ...pickPolicy(metadata[alias]) });
  }
  return metadata;
}

function pickPolicy(metadata: object | undefined): Record<string, unknown> {
  const hidden = (metadata as { pickerHidden?: unknown } | undefined)?.pickerHidden;
  return hidden === undefined ? {} : { pickerHidden: hidden };
}

/** Fields that are not part of where a provider's models come from; everything else (an unknown future field included) counts as route identity. */
const nonRouteFields = new Set(["models", "modelMetadata", "label", "maxConcurrent", "capacityDiscovery", "claudeSessions", "copilotSessions", "grokSessions", "defaultForBareModels", "toolSearch", "sessionAffinity", "selfHosted"]);
/** A digest of the provider's route: its type, endpoint and account settings as configured. A change makes a stale metadata patch unsafe. */
export function routeFingerprint(provider: ProviderConfig): string {
  const route = Object.fromEntries(Object.entries(provider).filter(([key]) => !nonRouteFields.has(key)).sort(([a], [b]) => a.localeCompare(b)));
  return createHash("sha256").update(JSON.stringify(route)).digest("hex");
}
