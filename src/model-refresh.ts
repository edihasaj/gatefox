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
  const updates = new Map<string, ProviderConfig["modelMetadata"]>();
  for (const provider of config.providers) {
    if (!discoverable.has(provider.type)) continue;
    let discovered: DiscoveredModel[];
    try { discovered = await discover(provider, { refresh: false, ...(tailnet ? { tailnet } : {}) }); }
    catch (error) { telemetry("model_metadata_skipped", { provider: provider.id, reason: error instanceof ChatGPTRefreshDeferred ? "refresh_deferred" : "discovery_failed" }); continue; }
    const fresh = new Map(discovered.map(entry => [entry.model, entry.metadata]));
    const metadata = { ...provider.modelMetadata };
    for (const [alias, model] of Object.entries(provider.models)) {
      const found = fresh.get(model); const window = observed[provider.id]?.[model];
      if (!found && window === undefined) continue;
      // An operator cap survives every refresh: a server reporting a larger limit never raises the saved window.
      metadata[alias] = capContextWindow({ ...metadata[alias], ...found, ...(window !== undefined ? { contextWindow: window } : {}) });
    }
    if (JSON.stringify(metadata) !== JSON.stringify(provider.modelMetadata || {})) updates.set(provider.id, metadata);
  }
  if (!updates.size) return [];
  return withPrivateFileLock(path, async () => {
    const source = JSON.parse(await readFile(path, "utf8")) as GatewayConfig;
    for (const provider of source.providers) if (updates.has(provider.id)) provider.modelMetadata = updates.get(provider.id);
    validateConfig(structuredClone(source), dirname(path));
    await writePrivateJson(path, source);
    return [...updates.keys()];
  });
}
