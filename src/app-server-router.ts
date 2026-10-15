import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { modelCatalog } from "./catalog.js";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import type { DesktopCatalog } from "./desktop-catalog.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { applyDesktopEdits, isDesktopPreferenceKey, mergeDesktopPreferences, readDesktopPreferences } from "./desktop-preferences.js";
import { gatewayUsage, mergeGatewayUsage } from "./provider-usage.js";
import { readPublicServiceTierMetadata } from "./model-service-tiers.js";
import { ThreadServiceTiers, type ThreadServiceTier } from "./thread-service-tiers.js";
import { ThreadReasoningStore, isModelName, isReasoningEffort, isReasoningSummary, type ThreadReasoningSelection } from "./thread-reasoning.js";
import { ResumeReasoning, fitEffort, type ReasoningChoice, type ThreadReasonSnapshot } from "./resume-reasoning.js";
import { homedir } from "node:os";
import { telemetry } from "./telemetry.js";
import { nativeThreadAbsent } from "./native-thread-absence.js";

type ObjectValue = Record<string, unknown>;
export type BackendRequest = (method: string, params: ObjectValue) => Promise<ObjectValue>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const gatewayProvider = "subscription_gateway";
const preferenceKeys = new Set(["model", "model_reasoning_effort", "model_reasoning_summary", "service_tier"]);
const requestedModel = (params: ObjectValue): unknown => object(object(params.collaborationMode).settings).model ?? params.model ?? object(params.config).model;
const tierSelection = (params: ObjectValue): { value: unknown } | undefined => Object.hasOwn(params, "serviceTier") && params.serviceTier !== undefined
  ? { value: params.serviceTier } : Object.hasOwn(object(params.config), "service_tier") ? { value: object(params.config).service_tier } : undefined;
const tierId = (value: unknown): unknown => value === "fast" ? "priority" : value;
const savedTier = (value: string | null): string | null => value === "default" ? null : tierId(value) as string | null;
// An effort can arrive as a turn setting or inside the collaboration mode that carries it.
const requestedEffort = (params: ObjectValue): unknown => params.effort ?? object(object(params.collaborationMode).settings).reasoning_effort;
const configEffort = (params: ObjectValue): unknown => object(params.config).model_reasoning_effort;
const enumEffort = (value: unknown): string | undefined => typeof value === "string" && ["none","minimal","low","medium","high","xhigh","max","ultra"].includes(value) ? value : undefined;
type TierDrop = { model: string; tier: string; method: string };
type ThreadRoute = { provider: string; model?: string; serviceTier?: string | null };

export class AppServerRoutingError extends Error {
  constructor(message: string, readonly code: number = -32600) { super(message); }
}

/** Adds gateway routes without replacing the native engine's authentication or defaults. */
export class AppServerRouter {
  private readonly aliases: Set<string>;
  private readonly routes = new Map<string, ThreadRoute>();
  private readonly activeTurns = new Map<string, { turnId: string; route: ThreadRoute }>();
  private readonly threadTiers: ThreadServiceTiers;
  private readonly threadReasoning: ThreadReasoningStore;
  private readonly reasoning: ResumeReasoning;
  private readonly chatSnapshots = new Map<string, ThreadReasonSnapshot>();
  private readonly tierRecords = new Map<string, ThreadServiceTier | undefined>();
  private readonly settingsVersions = new Map<string, number>();
  private preferences: ObjectValue = {};
  private writes: Promise<unknown> = Promise.resolve();
  private readonly preferencesPath: string;
  readonly catalogPath: string;
  private extraModels: ObjectValue[];
  constructor(private readonly config: GatewayConfig, private readonly backend: BackendRequest, catalogPath?: string, private readonly source?: DesktopCatalog, nativeHome = resolve(process.env.CODEX_HOME || homedir() + "/.codex")) {
    this.aliases = new Set(config.providers.flatMap(provider => Object.keys(provider.models)));
    this.extraModels = modelCatalog(config).models;
    this.preferencesPath = resolve(config.stateDirectory, "desktop-preferences.json");
    this.catalogPath = catalogPath || resolve(config.stateDirectory, "codex-models.json");
    this.threadTiers = new ThreadServiceTiers(config.stateDirectory, nativeHome);
    this.threadReasoning = new ThreadReasoningStore(config.stateDirectory, nativeHome);
    this.reasoning = new ResumeReasoning(this.threadReasoning, nativeHome);
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
    this.preferences = Object.fromEntries(Object.entries(preferences).filter(([key]) => preferenceKeys.has(key)));
    if (typeof this.preferences.model !== "string" || !this.preferences.model) delete this.preferences.model;
    try {
      const desktop = readDesktopPreferences(preferences.desktop);
      if (Object.keys(desktop).length) this.preferences.desktop = desktop;
    } catch { throw new AppServerRoutingError("Gateway desktop display preferences are invalid"); }
  }
  private async remember(result: ObjectValue, params: ObjectValue, expected: ThreadServiceTier | undefined, requestStartedAtMs: number): Promise<void> {
    const thread = object(result.thread);
    if (typeof thread.id === "string") {
      const config = object(params.config);
      await this.recordReasoning(thread.id, { model: typeof result.model === "string" ? result.model : params.model,
        effort: result.reasoningEffort ?? config.model_reasoning_effort, summary: result.reasoningSummary ?? config.model_reasoning_summary }, requestStartedAtMs);
    }
    if (typeof thread.id === "string" && typeof result.modelProvider === "string") {
      const tier = Object.hasOwn(result, "serviceTier") ? result.serviceTier : tierSelection(params)?.value;
      const route: ThreadRoute = { provider: result.modelProvider, ...(typeof result.model === "string" ? { model: result.model } : {}),
        ...(tier === null || typeof tier === "string" ? { serviceTier: tierId(tier) as string | null } : {}) };
      this.routes.set(thread.id, route);
      // SDK snapshots are authoritative; requested values alone cannot establish durable settings.
      if (route.provider === gatewayProvider && typeof route.model === "string" && (result.serviceTier === null || typeof result.serviceTier === "string")) {
        const record = { model: route.model, serviceTier: savedTier(result.serviceTier) };
        await this.threadTiers.write(thread.id, record, thread.id === params.threadId ? expected ?? null : null, requestStartedAtMs);
        const current = await this.threadTiers.read(thread.id);
        this.tierRecords.set(thread.id, current);
        if (current) { route.model = current.model; route.serviceTier = current.serviceTier; }
      }
    }
  }
  private async route(threadId: string): Promise<ThreadRoute | undefined> {
    let route = this.routes.get(threadId);
    if (!route) {
      let probe: ObjectValue;
      try { probe = await this.backend("thread/read", { threadId, includeTurns: false }); }
      catch (error) { if (nativeThreadAbsent(error, threadId)) return undefined; throw error; }
      const thread = object(probe.thread);
      if (typeof thread.modelProvider !== "string") throw new AppServerRoutingError("Cannot determine this chat's provider");
      route = { provider: thread.modelProvider, ...(typeof thread.model === "string" ? { model: thread.model } : {}) };
      this.routes.set(threadId, route);
      this.chatSnapshots.set(threadId, { path: thread.path, effort: thread.reasoningEffort });
    }
    if (route.provider === gatewayProvider) {
      const current = await this.threadTiers.read(threadId);
      if (current && (!this.tierRecords.has(threadId) || JSON.stringify(current) !== JSON.stringify(this.tierRecords.get(threadId)))) {
        route.model = current.model; route.serviceTier = current.serviceTier;
      } else if (!current && this.tierRecords.get(threadId)) delete route.serviceTier;
      this.tierRecords.set(threadId, current);
    }
    return route;
  }
  /** Provider family and model for diagnostics; no settings or content. */
  describeThread(threadId: string): { provider?: string; model?: string } {
    const route = this.routes.get(threadId);
    return route ? { provider: route.provider === gatewayProvider ? "gateway" : "native", ...(typeof route.model === "string" ? { model: route.model } : {}) } : {};
  }
  /** Only applied thread settings are durable; active-turn settings remain connection-local. */
  async observeNotification(message: ObjectValue): Promise<void> {
    const params = object(message.params);
    if (message.method === "thread/settings/updated" && typeof params.threadId === "string") {
      // The pinned SDK stamps the envelope before fan-out to clients on this host.
      const emittedAtMs = message.emittedAtMs;
      if (!Number.isSafeInteger(emittedAtMs) || Number(emittedAtMs) <= 0 || Number(emittedAtMs) > Date.now() + 1000) return;
      const settings = object(params.threadSettings);
      await this.recordReasoning(params.threadId, { model: settings.model, effort: settings.effort, summary: settings.summary }, Number(emittedAtMs));
      if (settings.modelProvider !== gatewayProvider || typeof settings.model !== "string" || (settings.serviceTier !== null && typeof settings.serviceTier !== "string")) return;
      const record = { model: settings.model, serviceTier: savedTier(settings.serviceTier), emittedAtMs: Number(emittedAtMs) };
      this.settingsVersions.set(params.threadId, (this.settingsVersions.get(params.threadId) || 0) + 1);
      // Duplicate notifications from slower shared clients cannot replace newer settings.
      await this.threadTiers.write(params.threadId, record, this.tierRecords.get(params.threadId) ?? null);
      const current = await this.threadTiers.read(params.threadId);
      if (current) this.routes.set(params.threadId, { provider: gatewayProvider, ...current });
      this.tierRecords.set(params.threadId, current);
    }
    if (message.method === "turn/completed" && typeof params.threadId === "string" && this.activeTurns.get(params.threadId)?.turnId === object(params.turn).id) this.activeTurns.delete(params.threadId);
  }
  /** Mirrors the SDK's catalog check: Standard is always offered, any other tier only if the row lists it. */
  private offersServiceTier(model: string, tier: string): boolean {
    if (tier === "default") return true;
    const metadata = this.extraModels.find(entry => entry.slug === model);
    if (!metadata) return false;
    try { return !!readPublicServiceTierMetadata(metadata).serviceTiers?.some(entry => entry.id === tierId(tier)); } catch { return false; }
  }
  /** Tier ids safe to log: the catalog's own plus the SDK's fixed names. Anything else is reported as "other". */
  private loggableTier(tier: string): string {
    const known = new Set(["priority", "fast", "default", "flex"]);
    for (const metadata of this.extraModels) {
      try { for (const entry of readPublicServiceTierMetadata(metadata).serviceTiers ?? []) known.add(entry.id); } catch { /* an invalid row advertises nothing */ }
    }
    return known.has(tier) ? tier : "other";
  }
  /** Recorded only once the SDK accepted the request, so a rejected request leaves no event. */
  private recordTierDrops(drops: TierDrop[]): void {
    for (const drop of drops) telemetry("service_tier_dropped", { model: drop.model, tier: this.loggableTier(drop.tier), method: drop.method });
  }
  /**
   * At session start the SDK drops a tier the model lacks and starts Standard, so the gateway sends
   * serviceTier null. A tier that is not a string is left for the SDK to reject as invalid params.
   */
  private dropUnsupportedTier(params: ObjectValue, model: string, method: string, drops: TierDrop[]): ObjectValue {
    const tier = tierSelection(params);
    if (!tier || typeof tier.value !== "string" || this.offersServiceTier(model, tier.value)) return params;
    const { service_tier: _dropped, ...config } = object(params.config);
    drops.push({ model, tier: tier.value, method });
    return { ...params, serviceTier: null, ...(params.config === undefined ? {} : { config }) };
  }
  /** A resumed or forked chat starts with its own tier; one its row lacks starts Standard. A tier the gateway never read is left to the SDK. */
  private inheritedTier(params: ObjectValue, route: ThreadRoute, model: string, method: string, drops: TierDrop[]): ObjectValue {
    if (tierSelection(params) || route.serviceTier === undefined) return params;
    if (route.serviceTier !== null && !this.offersServiceTier(model, route.serviceTier)) {
      drops.push({ model, tier: route.serviceTier, method });
      return { ...params, serviceTier: null };
    }
    return { ...params, serviceTier: route.serviceTier };
  }
  private preferenceRequest(params: ObjectValue, model: string): ObjectValue {
    if (tierSelection(params) || this.preferences.model !== model || !Object.hasOwn(this.preferences, "service_tier")) return params;
    return { ...params, serviceTier: this.preferences.service_tier };
  }
  private modelRequest(params: ObjectValue, model: string, newChat = false, restored?: ReasoningChoice | null): ObjectValue {
    const metadata = this.extraModels.find(entry => entry.slug === model);
    if (!metadata) throw new AppServerRoutingError("This model alias is no longer offered by the gateway; select a current gateway model");
    const levels = (metadata.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort);
    const saved = this.preferences.model === model ? this.preferences.model_reasoning_effort : undefined;
    const effort = typeof saved === "string" && levels.includes(saved) ? saved : levels.includes("medium") ? "medium" : levels[0] || "none";
    // The saved new-chat tier was applied, then checked against this row, before this call.
    let selected = params;
    if (!tierSelection(selected) && newChat && typeof metadata.default_service_tier === "string") selected = { ...selected, serviceTier: metadata.default_service_tier };
    const summary = this.preferences.model === model && typeof this.preferences.model_reasoning_summary === "string" ? this.preferences.model_reasoning_summary : "auto";
    // A resumed chat keeps the reasoning settings saved with it; injecting a
    // default here would silently reset a Max chat to Medium on reload. A restored
    // choice is the chat's own setting, which the engine cannot recover on its own.
    const reasoning = restored === null ? {} : { model_reasoning_effort: restored?.effort ?? effort, model_reasoning_summary: restored?.summary ?? summary };
    return { ...selected, model, modelProvider: gatewayProvider,
      config: { ...reasoning, ...object(params.config), model_catalog_json: this.catalogPath, web_search: "disabled" } };
  }
  private assertSameProvider(provider: string, model: unknown): void {
    if (typeof model !== "string") return;
    if ((provider === gatewayProvider) !== this.aliases.has(model)) {
      throw new AppServerRoutingError("This Codex version cannot change a loaded chat between native and gateway providers. Start a new chat with the selected model. Reset to default selects a model; it does not reload the model list. Your account and existing chat are unchanged.", -32002);
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
      multiAgentVersion: null, additionalSpeedTiers: model.additional_speed_tiers || [], serviceTiers: model.service_tiers || [], defaultServiceTier: model.default_service_tier ?? null, availableAccessPrograms: null, isDefault: false,
    }));
    let models = [...native, ...extra];
    const preferred = this.preferences.model;
    if (typeof preferred === "string" && models.some(model => model.model === preferred)) {
      models = models.map(model => ({ ...model, isDefault: model.model === preferred }));
    }
    const offset = cursor ? Number(String(cursor).split(":")[1]) : 0;
    if (!Number.isSafeInteger(offset) || offset > models.length) throw new AppServerRoutingError("Invalid gateway model cursor");
    return { data: models.slice(offset, offset + Number(limit)), nextCursor: offset + Number(limit) < models.length ? `gateway-models:${offset + Number(limit)}` : null };
  }
  private async writePreferences(method: string, params: ObjectValue): Promise<ObjectValue | undefined> {
    const edits = method === "config/value/write" ? [params] : Array.isArray(params.edits) ? params.edits.map(object) : [];
    if (edits.some(edit => typeof edit.keyPath === "string" && edit.keyPath.endsWith(".model") && typeof edit.value === "string" && this.aliases.has(edit.value))) throw new AppServerRoutingError("Gateway defaults cannot be saved into a native Codex profile");
    const modelEdit = edits.find(edit => edit.keyPath === "model");
    const chosen = modelEdit ? modelEdit.value : this.preferences.model;
    const local = edits.filter(edit => preferenceKeys.has(String(edit.keyPath)));
    const desktopEdits = edits.filter(edit => isDesktopPreferenceKey(edit.keyPath));
    if (!local.length && !desktopEdits.length) throw new AppServerRoutingError("Native Codex configuration is managed separately and cannot be changed by this adapter");
    if (local.length && (typeof chosen !== "string" || !chosen)) throw new AppServerRoutingError("Select a model before saving its reasoning preferences");
    // Do not redirect writes explicitly aimed at a project or other profile.
    if (typeof params.filePath === "string" && params.filePath !== this.preferencesPath) throw new AppServerRoutingError("Gateway defaults are scoped to this adapter; choose a model without a custom config-file target");
    if (params.expectedVersion !== undefined && params.expectedVersion !== null) throw new AppServerRoutingError("Gateway default writes do not support a native config version guard");
    for (const edit of local) {
      if (!["replace", "upsert"].includes(String(edit.mergeStrategy)) || (edit.value !== null && typeof edit.value !== "string")) throw new AppServerRoutingError("Gateway defaults require string values with replace or upsert merge strategy");
      if (edit.keyPath === "service_tier" && edit.value !== null && typeof chosen === "string" && this.aliases.has(chosen) && !this.offersServiceTier(chosen, edit.value as string)) {
        throw new AppServerRoutingError("This gateway model does not offer that speed, so it cannot be the saved default. Choose Standard, or pick a model that offers it, then save again.", -32002);
      }
    }
    const remaining = edits.filter(edit => !preferenceKeys.has(String(edit.keyPath)) && !isDesktopPreferenceKey(edit.keyPath));
    if (remaining.length) throw new AppServerRoutingError("Save gateway model preferences separately from native configuration changes");
    let desktop: ObjectValue;
    try { desktop = applyDesktopEdits(object(this.preferences.desktop), desktopEdits); }
    catch { throw new AppServerRoutingError("Gateway desktop display settings contain an unsupported value"); }
    const preferences: ObjectValue = { ...this.preferences, ...Object.fromEntries(local.map(edit => [String(edit.keyPath), edit.value])),
      ...(Object.keys(desktop).length ? { desktop } : {}) };
    if (modelEdit && chosen !== this.preferences.model && !local.some(edit => edit.keyPath === "service_tier")) delete preferences.service_tier;
    await writePrivateJson(this.preferencesPath, preferences); this.preferences = preferences;
    return { status: "ok", version: createHash("sha256").update(JSON.stringify(preferences)).digest("hex"), filePath: this.preferencesPath, overriddenMetadata: null };
  }
  /** The chat read already needed for routing also carries its rollout path and effort. */
  private async threadSnapshot(threadId: string): Promise<ThreadReasonSnapshot> {
    const cached = this.chatSnapshots.get(threadId);
    if (cached) return cached;
    const thread = object((await this.backend("thread/read", { threadId, includeTurns: false })).thread);
    const snapshot: ThreadReasonSnapshot = { path: thread.path, effort: thread.reasoningEffort };
    this.chatSnapshots.set(threadId, snapshot);
    return snapshot;
  }
  /** Best effort: reasoning must never fail the chat operation that records it. */
  private async recordReasoning(threadId: string, value: { model: unknown; effort?: unknown; summary?: unknown }, atMs: number): Promise<void> {
    if (!isModelName(threadId) || !isModelName(value.model) || !Number.isSafeInteger(atMs) || atMs < 0) return;
    const effort = isReasoningEffort(value.effort) ? value.effort : null;
    const summary = isReasoningSummary(value.summary) ? value.summary : null;
    if (effort === null && summary === null) return;
    await this.threadReasoning.write(threadId, { model: value.model, effort, summary, atMs }).then(() => undefined, () => undefined);
  }
  /** A gateway chat's own reasoning, fitted to the model it resumes with; null keeps what is loaded. */
  private async restoredReasoning(threadId: string, model: string, method: string): Promise<ReasoningChoice | null> {
    const recovered = await this.reasoning.recover(threadId, model, () => this.threadSnapshot(threadId));
    if (!recovered) return null;
    const metadata = this.extraModels.find(entry => entry.slug === model);
    const levels = ((metadata?.supported_reasoning_levels ?? []) as Array<{ effort: string }>).map(level => level.effort);
    // A model with no reasoning control has nothing to restore to; an effort here would be a guess.
    if (!levels.length) return null;
    const fitted = fitEffort(recovered.effort, levels, typeof metadata?.default_reasoning_level === "string" ? metadata.default_reasoning_level : undefined);
    if (fitted.adjusted) telemetry("reasoning_effort_reset", { from: enumEffort(recovered.effort), to: enumEffort(fitted.effort), model, method });
    telemetry("reasoning_restored", { provider: "gateway", method, source: recovered.source, adjusted: fitted.adjusted });
    return { effort: fitted.effort, ...(recovered.summary ? { summary: recovered.summary } : {}) };
  }
  /** A native chat needs an override only where the caller's typed model blocks the engine's own restore. */
  private async nativeRestoredEffort(params: ObjectValue, method: string, route: ThreadRoute): Promise<string | undefined> {
    if (!this.source || typeof params.threadId !== "string") return;
    const threadId = params.threadId;
    const override = params.model !== undefined || params.modelProvider !== undefined || object(params.config).model !== undefined;
    const requested = requestedModel(params);
    if (method === "thread/fork") {
      if (configEffort(params) !== undefined) return;
    } else {
      if (!override || configEffort(params) !== undefined) return;
      // A native model change must not carry the previous model's effort.
      if (typeof requested === "string" && route.model !== undefined && requested !== route.model) return;
    }
    const model = typeof requested === "string" ? requested : route.model;
    if (typeof model !== "string") return;
    const levels = (((this.source.nativeRow(model) ?? {}).supported_reasoning_levels ?? []) as Array<{ effort: string }>).map(level => level.effort);
    if (!levels.length) return;
    const recovered = await this.reasoning.recover(threadId, model, () => this.threadSnapshot(threadId));
    if (!recovered || !levels.includes(recovered.effort)) return;
    telemetry("reasoning_restored", { provider: "native", method, source: recovered.source, adjusted: false });
    return recovered.effort;
  }
  /** Provider-specific rewriting for a chat some SDK knows; the SDK still validates the result. */
  private async routedRequest(method: string, params: ObjectValue, threadRoute: ThreadRoute, drops: TierDrop[]): Promise<ObjectValue> {
    let forwarded = params;
    if (typeof params.threadId !== "string") return forwarded;
    const active = this.activeTurns.get(params.threadId);
    const route = method === "turn/settings/update" && active && active.turnId === params.turnId ? active.route : threadRoute;
    this.assertSameProvider(route.provider, requestedModel(params));
    const sessionStart = method === "thread/resume" || method === "thread/fork";
    // Inside a running chat the SDK keeps the chat's chosen tier and leaves it off an outgoing request only
    // while the model lacks it, so the gateway neither clears nor injects a tier here. The SDK also accepts a
    // tier the model does not offer. Its per-turn field reads "priority", so the legacy "fast" alias is mapped.
    if (route.provider === gatewayProvider && !sessionStart && params.serviceTierForTurn === "fast") forwarded = { ...params, serviceTierForTurn: "priority" };
    if (sessionStart && route.provider === gatewayProvider) {
      const model = requestedModel(params) ?? route.model;
      const sameModel = model === route.model;
      if (typeof model !== "string" || !this.aliases.has(model)) throw new AppServerRoutingError("This gateway chat needs a currently configured model alias");
      const inherited = this.inheritedTier(this.dropUnsupportedTier(params, model, method, drops), route, model, method, drops);
      // A typed model override disables the engine's persisted-settings restore,
      // so the gateway supplies the chat's own reasoning for the model it keeps.
      let restored: ReasoningChoice | null | undefined = null;
      if (!sameModel) restored = undefined;
      else if (configEffort(params) === undefined) restored = await this.restoredReasoning(String(params.threadId), model, method);
      forwarded = this.modelRequest(inherited, model, false, restored);
    } else if (sessionStart) {
      const effort = await this.nativeRestoredEffort(params, method, route);
      if (effort !== undefined) forwarded = { ...forwarded, config: { ...object(forwarded.config), model_reasoning_effort: effort } };
    }
    return forwarded;
  }
  async request(method: string, params: ObjectValue): Promise<ObjectValue> {
    if (["model/list", "thread/start", "thread/resume", "thread/fork"].includes(method)) await this.readPreferences();
    if (this.source && ["model/list", "thread/start", "thread/resume", "thread/fork", "turn/start", "thread/settings/update", "turn/settings/update"].includes(method)) {
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
    const drops: TierDrop[] = [];
    if (method === "thread/start") {
      const model = requestedModel(params) ?? this.preferences.model;
      // The saved new-chat default applies first, so a Fast default the row no longer offers starts Standard.
      if (typeof model === "string" && this.aliases.has(model)) forwarded = this.modelRequest(this.dropUnsupportedTier(this.preferenceRequest(params, model), model, method, drops), model, true);
      else if (typeof model === "string") forwarded = { ...this.preferenceRequest(params, model), model, config: { ...(typeof this.preferences.model_reasoning_effort === "string" && this.preferences.model === model ? { model_reasoning_effort: this.preferences.model_reasoning_effort } : {}), ...object(params.config) } };
    } else if (["thread/resume", "thread/fork", "turn/start", "thread/settings/update", "turn/settings/update"].includes(method) && typeof params.threadId === "string") {
      // No SDK knows this chat: forward the request unchanged so the SDK gives its own answer.
      const threadRoute = await this.route(params.threadId);
      if (threadRoute) forwarded = await this.routedRequest(method, params, threadRoute, drops);
    }
    const expectedTier = typeof params.threadId === "string" ? this.tierRecords.get(params.threadId) : undefined;
    const settingsVersion = typeof params.threadId === "string" ? this.settingsVersions.get(params.threadId) || 0 : 0;
    const requestStartedAtMs = Date.now();
    const result = await this.backend(method, forwarded);
    this.recordTierDrops(drops);
    if (method === "account/rateLimits/read") {
      try { return mergeGatewayUsage(result, await gatewayUsage(this.config)); }
      catch { return result; }
    }
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      await this.remember(result, forwarded, expectedTier, requestStartedAtMs);
      if (forwarded.modelProvider === gatewayProvider && result.modelProvider !== gatewayProvider) throw new AppServerRoutingError("The native engine did not apply the requested gateway provider; start a new chat");
    }
    // An applied settings change or a turn that carries one is durable from this request on.
    if (typeof params.threadId === "string" && (method === "turn/start" || (method === "thread/settings/update" && result.status === "applied"))) {
      await this.recordReasoning(params.threadId, { model: requestedModel(params) ?? this.routes.get(params.threadId)?.model, effort: requestedEffort(params), summary: params.summary }, requestStartedAtMs);
    }
    const selected = requestedModel(params);
    const settingsUnchanged = typeof params.threadId !== "string" || (this.settingsVersions.get(params.threadId) || 0) === settingsVersion;
    if (settingsUnchanged && method === "turn/start" && typeof selected === "string" && typeof params.threadId === "string") {
      const route = this.routes.get(params.threadId); if (route) route.model = selected;
    }
    // In-memory state follows what the SDK was actually sent, not what the caller asked for.
    const sentTier = tierSelection(forwarded);
    if (settingsUnchanged && method === "turn/start" && typeof params.threadId === "string") {
      const route = this.routes.get(params.threadId);
      if (route && sentTier && (sentTier.value === null || typeof sentTier.value === "string")) route.serviceTier = tierId(sentTier.value) as string | null;
    }
    if (method === "turn/start" && typeof params.threadId === "string" && typeof object(result.turn).id === "string") {
      const route = this.routes.get(params.threadId);
      const turnId = String(object(result.turn).id);
      if (route && this.activeTurns.get(params.threadId)?.turnId !== turnId) this.activeTurns.set(params.threadId, { turnId, route: { ...route,
        ...(typeof forwarded.serviceTierForTurn === "string" ? { serviceTier: tierId(forwarded.serviceTierForTurn) as string } : {}) } });
    }
    if (method === "turn/settings/update" && result.status === "applied" && typeof params.threadId === "string" && typeof params.turnId === "string") {
      const active = this.activeTurns.get(params.threadId);
      const route = active?.turnId === params.turnId ? active.route : this.routes.get(params.threadId);
      if (route) this.activeTurns.set(params.threadId, { turnId: params.turnId, route: { ...route,
        ...(typeof selected === "string" ? { model: selected } : {}),
        ...(sentTier && (sentTier.value === null || typeof sentTier.value === "string") ? { serviceTier: tierId(sentTier.value) as string | null } : {}) } });
    }
    if (method === "config/read") {
      await this.readPreferences();
      const { desktop, ...modelPreferences } = this.preferences;
      return { ...result, config: { ...mergeDesktopPreferences(object(result.config), object(desktop)), ...modelPreferences, model_catalog_json: this.catalogPath } };
    }
    return result;
  }
}
