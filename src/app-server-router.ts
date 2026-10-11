import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { modelCatalog } from "./catalog.js";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import type { DesktopCatalog } from "./desktop-catalog.js";
import { withPrivateFileLock } from "./private-file-lock.js";

type ObjectValue = Record<string, unknown>;
export type BackendRequest = (method: string, params: ObjectValue) => Promise<ObjectValue>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const gatewayProvider = "subscription_gateway";
const preferenceKeys = new Set(["model", "model_reasoning_effort", "model_reasoning_summary", "service_tier"]);
const requestedModel = (params: ObjectValue): unknown => object(object(params.collaborationMode).settings).model ?? params.model ?? object(params.config).model;

export class AppServerRoutingError extends Error {
  readonly code = -32600;
}

/** Adds gateway routes without replacing the native engine's authentication or defaults. */
export class AppServerRouter {
  private readonly aliases: Set<string>;
  private readonly routes = new Map<string, { provider: string; model?: string }>();
  private preferences: ObjectValue = {};
  private writes: Promise<unknown> = Promise.resolve();
  private readonly preferencesPath: string;
  readonly catalogPath: string;
  private extraModels: ObjectValue[];
  constructor(private readonly config: GatewayConfig, private readonly backend: BackendRequest, catalogPath?: string, private readonly source?: DesktopCatalog) {
    this.aliases = new Set(config.providers.flatMap(provider => Object.keys(provider.models)));
    this.extraModels = modelCatalog(config).models;
    this.preferencesPath = resolve(config.stateDirectory, "desktop-preferences.json");
    this.catalogPath = catalogPath || resolve(config.stateDirectory, "codex-models.json");
  }
  async initialize(): Promise<void> {
    if (this.catalogPath === resolve(this.config.stateDirectory, "codex-models.json")) await writePrivateJson(this.catalogPath, modelCatalog(this.config));
    await this.readPreferences();
  }
  private async readPreferences(): Promise<void> {
    let saved: unknown;
    try { saved = JSON.parse(await readFile(this.preferencesPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.preferences = {}; return; } throw new AppServerRoutingError("Gateway desktop preferences are unreadable"); }
    const preferences = object(saved);
    this.preferences = typeof preferences.model === "string" && preferences.model
      ? Object.fromEntries(Object.entries(preferences).filter(([key]) => preferenceKeys.has(key))) : {};
  }
  private remember(result: ObjectValue): void {
    const thread = object(result.thread);
    if (typeof thread.id === "string" && typeof result.modelProvider === "string") {
      this.routes.set(thread.id, { provider: result.modelProvider, ...(typeof result.model === "string" ? { model: result.model } : {}) });
    }
  }
  private async route(threadId: string) {
    const known = this.routes.get(threadId);
    if (known) return known;
    const thread = object((await this.backend("thread/read", { threadId, includeTurns: false })).thread);
    if (typeof thread.modelProvider !== "string") throw new AppServerRoutingError("Cannot determine this chat's provider");
    const route = { provider: thread.modelProvider, ...(typeof thread.model === "string" ? { model: thread.model } : {}) };
    this.routes.set(threadId, route); return route;
  }
  private modelRequest(params: ObjectValue, model: string): ObjectValue {
    const metadata = this.extraModels.find(entry => entry.slug === model);
    if (!metadata) throw new AppServerRoutingError("This model alias is no longer offered by the gateway; select a current gateway model");
    const levels = (metadata.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort);
    const saved = this.preferences.model === model ? this.preferences.model_reasoning_effort : undefined;
    const effort = typeof saved === "string" && levels.includes(saved) ? saved : levels.includes("medium") ? "medium" : levels[0] || "none";
    return { ...params, model, modelProvider: gatewayProvider,
      config: { model_reasoning_effort: effort, ...object(params.config), model_catalog_json: this.catalogPath, web_search: "disabled", model_reasoning_summary: "auto" } };
  }
  private assertSameProvider(provider: string, model: unknown): void {
    if (typeof model !== "string") return;
    if ((provider === gatewayProvider) !== this.aliases.has(model)) {
      throw new AppServerRoutingError("This Codex version cannot change a loaded chat between native and gateway providers. Start a new chat with the selected model. Your account and existing chat are unchanged.");
    }
  }
  private async models(params: ObjectValue): Promise<ObjectValue> {
    const cursor = params.cursor;
    if (cursor !== undefined && cursor !== null && (typeof cursor !== "string" || !/^gateway-models:\d+$/.test(cursor))) throw new AppServerRoutingError("Invalid gateway model cursor");
    const limit = params.limit ?? 100;
    if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 1000) throw new AppServerRoutingError("Model list limit must be 1 through 1000");
    const native: ObjectValue[] = []; let nextCursor: unknown = null;
    do {
      if (native.length >= 4096) throw new AppServerRoutingError("Native catalog exceeds the gateway model limit");
      const page = await this.backend("model/list", { ...params, cursor: nextCursor, limit: 100 });
      if (!Array.isArray(page.data)) throw new AppServerRoutingError("Native engine returned an invalid model list");
      native.push(...page.data.map(object).filter(model => !this.aliases.has(String(model.model)))); nextCursor = page.nextCursor;
    } while (typeof nextCursor === "string" && nextCursor);
    const extra = this.extraModels.map(model => ({
      id: model.slug, model: model.slug, displayName: model.display_name, description: model.description,
      upgrade: null, upgradeInfo: null, availabilityNux: null, modelSpecialty: null, hidden: false,
      supportedReasoningEfforts: (model.supported_reasoning_levels as Array<{ effort: string; description: string }>).map(level => ({ reasoningEffort: level.effort, description: level.description })),
      defaultReasoningEffort: model.default_reasoning_level || "none", inputModalities: model.input_modalities || ["text"], supportsPersonality: false,
      multiAgentVersion: null, additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null, isDefault: false,
    }));
    const models = [...native, ...extra];
    const offset = cursor ? Number(String(cursor).split(":")[1]) : 0;
    if (!Number.isSafeInteger(offset) || offset > models.length) throw new AppServerRoutingError("Invalid gateway model cursor");
    return { data: models.slice(offset, offset + Number(limit)), nextCursor: offset + Number(limit) < models.length ? `gateway-models:${offset + Number(limit)}` : null };
  }
  private async writePreferences(method: string, params: ObjectValue): Promise<ObjectValue | undefined> {
    const edits = method === "config/value/write" ? [params] : Array.isArray(params.edits) ? params.edits.map(object) : [];
    if (edits.some(edit => typeof edit.keyPath === "string" && edit.keyPath.endsWith(".model") && typeof edit.value === "string" && this.aliases.has(edit.value))) throw new AppServerRoutingError("Gateway defaults cannot be saved into a native Codex profile");
    const modelEdit = edits.find(edit => edit.keyPath === "model");
    const chosen = modelEdit ? modelEdit.value : this.preferences.model;
    if (typeof chosen !== "string" || !chosen) throw new AppServerRoutingError("This adapter only saves model preferences; native Codex configuration is managed separately");
    const local = edits.filter(edit => preferenceKeys.has(String(edit.keyPath)));
    if (!local.length) throw new AppServerRoutingError("Native Codex configuration is managed separately and cannot be changed by this adapter");
    // Do not redirect writes explicitly aimed at a project or other profile.
    if (typeof params.filePath === "string" && params.filePath !== this.preferencesPath) throw new AppServerRoutingError("Gateway defaults are scoped to this adapter; choose a model without a custom config-file target");
    if (params.expectedVersion !== undefined && params.expectedVersion !== null) throw new AppServerRoutingError("Gateway default writes do not support a native config version guard");
    for (const edit of local) {
      if (!["replace", "upsert"].includes(String(edit.mergeStrategy)) || (edit.value !== null && typeof edit.value !== "string")) throw new AppServerRoutingError("Gateway defaults require string values with replace or upsert merge strategy");
    }
    const remaining = edits.filter(edit => !preferenceKeys.has(String(edit.keyPath)));
    if (remaining.length) throw new AppServerRoutingError("Save gateway model preferences separately from native configuration changes");
    const preferences = { ...this.preferences, ...Object.fromEntries(local.map(edit => [String(edit.keyPath), edit.value])) };
    await writePrivateJson(this.preferencesPath, preferences); this.preferences = preferences;
    return { status: "ok", version: createHash("sha256").update(JSON.stringify(preferences)).digest("hex"), filePath: this.preferencesPath, overriddenMetadata: null };
  }
  async request(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) await this.readPreferences();
    if (this.source && ["model/list", "thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method)) {
      const requested = requestedModel(params) ?? (method === "thread/start" ? this.preferences.model : undefined);
      const strict = (typeof requested === "string" && !this.source.isNative(requested)) || params.modelProvider === gatewayProvider || (typeof params.threadId === "string" && this.routes.get(params.threadId)?.provider === gatewayProvider);
      this.extraModels = (await this.source.refresh(strict)).models;
      for (const model of this.extraModels) this.aliases.add(String(model.slug));
      if (typeof requested === "string" && !this.source.isNative(requested) && !this.aliases.has(requested)) throw new AppServerRoutingError("This model is absent from both the native and gateway catalogs; select an offered model");
    }
    if (method === "config/write") throw new AppServerRoutingError("Native Codex configuration is managed separately and cannot be changed by this adapter");
    if (method === "model/list") return this.models(params);
    if (method === "config/value/write" || method === "config/batchWrite") {
      const operation = this.writes.then(() => withPrivateFileLock(this.preferencesPath, async () => {
        await this.readPreferences();
        const written = await this.writePreferences(method, params);
        if (!written) throw new AppServerRoutingError("Native Codex configuration is managed separately");
        return written;
      }));
      this.writes = operation.catch(() => undefined); return operation;
    }
    let forwarded = params;
    if (method === "thread/start") {
      const model = requestedModel(params) ?? this.preferences.model;
      if (typeof model === "string" && this.aliases.has(model)) forwarded = this.modelRequest(params, model);
      else if (typeof model === "string") forwarded = { ...params, model, config: { ...(typeof this.preferences.model_reasoning_effort === "string" && this.preferences.model === model ? { model_reasoning_effort: this.preferences.model_reasoning_effort } : {}), ...object(params.config) } };
    } else if (["thread/resume", "thread/fork", "turn/start"].includes(method) && typeof params.threadId === "string") {
      const route = await this.route(params.threadId);
      this.assertSameProvider(route.provider, requestedModel(params));
      if (method !== "turn/start" && route.provider === gatewayProvider) {
        const model = requestedModel(params) ?? route.model;
        if (typeof model !== "string" || !this.aliases.has(model)) throw new AppServerRoutingError("This gateway chat needs a currently configured model alias");
        forwarded = this.modelRequest(params, model);
      }
    }
    const result = await this.backend(method, forwarded);
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      this.remember(result);
      if (forwarded.modelProvider === gatewayProvider && result.modelProvider !== gatewayProvider) throw new AppServerRoutingError("The native engine did not apply the requested gateway provider; start a new chat");
    }
    const selected = requestedModel(params);
    if (method === "turn/start" && typeof selected === "string" && typeof params.threadId === "string") {
      const route = this.routes.get(params.threadId); if (route) route.model = selected;
    }
    if (method === "config/read") {
      await this.readPreferences();
      return { ...result, config: { ...object(result.config), ...this.preferences, model_catalog_json: this.catalogPath } };
    }
    return result;
  }
}
