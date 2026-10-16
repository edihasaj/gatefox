import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configEdits, gatewayPreferenceKeys, gatewayTargetMessage, nativeWritesViolation, partitionConfigEdits, type GatewayIdentity } from "./app-server-config-writes.js";
import { modelCatalog } from "./catalog.js";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import type { DesktopCatalog } from "./desktop-catalog.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { applyDesktopEdits, isDesktopPreferenceKey, mergeDesktopPreferences, readDesktopPreferences } from "./desktop-preferences.js";
import { gatewayUsage, mergeGatewayUsage } from "./provider-usage.js";
import { declaresServiceTier, loggableTier, offersServiceTier, recordableTier } from "./app-server-tier-offers.js";
import { storableServiceTier, ThreadServiceTiers, type ThreadServiceTier } from "./thread-service-tiers.js";
import { ThreadReasoningStore, isModelName, isReasoningEffort, isReasoningSummary, type ThreadReasoningSelection } from "./thread-reasoning.js";
import { ResumeReasoning, fitEffort, type ReasoningChoice, type ThreadReasonSnapshot } from "./resume-reasoning.js";
import { homedir } from "node:os";
import { telemetry } from "./telemetry.js";
import { nativeThreadAbsent } from "./native-thread-absence.js";

type ObjectValue = Record<string, unknown>;
export type BackendRequest = (method: string, params: ObjectValue) => Promise<ObjectValue>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const gatewayProvider = "subscription_gateway";
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
// Throwaway prediction forks are tracked in this order-bounded set while they may still be routed.
const maxEphemeralThreads = 256;
// A fork pushed out of that set may still be subscribed and keep emitting; its id alone is kept longer.
const maxEvictedEphemeralIds = 4096;

/**
 * A prediction fork (the desktop's composer suggestions) starts from the loaded parent's
 * effective settings, and the SDK refuses it with any override, including a config key.
 * It therefore reaches the engine that owns the parent exactly as the desktop sent it.
 */
export const inheritsParentSettings = (method: string, params: ObjectValue): boolean =>
  method === "thread/fork" && params.experimentalPredictionMode === true;

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
  private readonly ephemeralThreads = new Set<string>();
  private readonly evictedEphemeralIds = new Set<string>();
  private preferences: ObjectValue = {};
  private writes: Promise<unknown> = Promise.resolve();
  private readonly preferencesPath: string;
  readonly catalogPath: string;
  private extraModels: ObjectValue[];
  constructor(private readonly config: GatewayConfig, private readonly backend: BackendRequest, catalogPath?: string, private readonly source?: DesktopCatalog, private readonly nativeHome = resolve(process.env.CODEX_HOME || homedir() + "/.codex")) {
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
    this.preferences = Object.fromEntries(Object.entries(preferences).filter(([key]) => gatewayPreferenceKeys.has(key)));
    if (typeof this.preferences.model !== "string" || !this.preferences.model) delete this.preferences.model;
    try {
      const desktop = readDesktopPreferences(preferences.desktop);
      if (Object.keys(desktop).length) this.preferences.desktop = desktop;
    } catch { throw new AppServerRoutingError("Gateway desktop display preferences are invalid"); }
  }
  private async remember(result: ObjectValue, params: ObjectValue, expected: ThreadServiceTier | undefined, requestStartedAtMs: number, inherited = false): Promise<void> {
    const thread = object(result.thread);
    // A prediction fork is throwaway: only its in-memory route is kept, never a durable record.
    const ephemeral = inherited || thread.ephemeral === true || (typeof thread.id === "string" && this.evictedEphemeralIds.has(thread.id));
    if (typeof thread.id === "string" && ephemeral) this.trackEphemeral(thread.id);
    // Only a gateway chat's reasoning is ever read back; a native chat keeps its own in the SDK.
    if (typeof thread.id === "string" && !ephemeral && result.modelProvider === gatewayProvider) {
      const config = object(params.config);
      await this.recordReasoning(thread.id, { model: typeof result.model === "string" ? result.model : params.model,
        effort: result.reasoningEffort ?? config.model_reasoning_effort, summary: result.reasoningSummary ?? config.model_reasoning_summary }, requestStartedAtMs);
    }
    if (typeof thread.id === "string" && typeof result.modelProvider === "string") {
      const tier = Object.hasOwn(result, "serviceTier") ? result.serviceTier : tierSelection(params)?.value;
      const route: ThreadRoute = { provider: result.modelProvider, ...(typeof result.model === "string" ? { model: result.model } : {}),
        ...(tier === null || (typeof tier === "string" && storableServiceTier(tierId(tier))) ? { serviceTier: tierId(tier) as string | null } : {}) };
      this.routes.set(thread.id, route);
      // SDK snapshots are authoritative; requested values alone cannot establish durable settings.
      if (!ephemeral && route.provider === gatewayProvider && typeof route.model === "string" && (result.serviceTier === null || typeof result.serviceTier === "string")) {
        const record = { model: route.model, serviceTier: recordableTier(this.extraModels, route.model, savedTier(result.serviceTier)) };
        const against = thread.id === params.threadId ? expected ?? null : null;
        // The SDK accepted a tier the private store cannot hold, so the chat's tier is recorded as unknown. The route above already leaves it out.
        if (storableServiceTier(record.serviceTier)) await this.threadTiers.write(thread.id, record, against, requestStartedAtMs);
        else await this.threadTiers.markUnknown(thread.id, { model: route.model }, against, requestStartedAtMs);
        const current = await this.threadTiers.read(thread.id);
        this.tierRecords.set(thread.id, current);
        // No readable tier means a peer marked it unknown (a failed CAS), so the answer's tier must not be forwarded again.
        if (current) { route.model = current.model; route.serviceTier = current.serviceTier; }
        else delete route.serviceTier;
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
      // A forgotten throwaway fork can still be loaded in the engine; it must stay memory-only.
      if (thread.ephemeral === true || this.evictedEphemeralIds.has(threadId)) this.trackEphemeral(threadId);
    }
    if (route.provider === gatewayProvider && !this.ephemeralThreads.has(threadId)) {
      const current = await this.threadTiers.read(threadId);
      if (current && (!this.tierRecords.has(threadId) || JSON.stringify(current) !== JSON.stringify(this.tierRecords.get(threadId)))) {
        route.model = current.model; route.serviceTier = current.serviceTier;
      } else if (!current && this.tierRecords.get(threadId)) delete route.serviceTier;
      this.tierRecords.set(threadId, current);
    }
    return route;
  }
  private trackEphemeral(threadId: string): void {
    this.ephemeralThreads.delete(threadId); this.ephemeralThreads.add(threadId);
    while (this.ephemeralThreads.size > maxEphemeralThreads) {
      const oldest = this.ephemeralThreads.values().next().value as string;
      this.forgetEphemeral(oldest);
      // Only the id stays: the fork may still be subscribed, and its notifications must not reach disk.
      this.evictedEphemeralIds.delete(oldest); this.evictedEphemeralIds.add(oldest);
      while (this.evictedEphemeralIds.size > maxEvictedEphemeralIds) this.evictedEphemeralIds.delete(this.evictedEphemeralIds.values().next().value as string);
    }
  }
  private forgetEphemeral(threadId: string): void {
    this.ephemeralThreads.delete(threadId); this.routes.delete(threadId); this.tierRecords.delete(threadId);
    this.activeTurns.delete(threadId); this.settingsVersions.delete(threadId); this.chatSnapshots.delete(threadId);
  }
  /** Provider family and model for diagnostics; no settings or content. */
  describeThread(threadId: string): { provider?: string; model?: string } {
    const route = this.routes.get(threadId);
    return route ? { provider: route.provider === gatewayProvider ? "gateway" : "native", ...(typeof route.model === "string" ? { model: route.model } : {}) } : {};
  }
  /** Only applied thread settings are durable; active-turn settings remain connection-local. */
  async observeNotification(message: ObjectValue): Promise<void> {
    const params = object(message.params);
    if (message.method === "thread/closed" && typeof params.threadId === "string" && this.ephemeralThreads.has(params.threadId)) this.forgetEphemeral(params.threadId);
    if (message.method === "thread/settings/updated" && typeof params.threadId === "string") {
      // The pinned SDK stamps the envelope before fan-out to clients on this host.
      const emittedAtMs = message.emittedAtMs;
      if (!Number.isSafeInteger(emittedAtMs) || Number(emittedAtMs) <= 0 || Number(emittedAtMs) > Date.now() + 1000) return;
      const settings = object(params.threadSettings);
      if (this.ephemeralThreads.has(params.threadId)) {
        // A throwaway fork's applied settings stay in its route; nothing about it is recorded durably.
        this.settingsVersions.set(params.threadId, (this.settingsVersions.get(params.threadId) || 0) + 1);
        if (settings.modelProvider === gatewayProvider && typeof settings.model === "string" && (settings.serviceTier === null || typeof settings.serviceTier === "string")) {
          // Only a tier a later fork or resume can forward is kept; an odd one leaves the route without a tier, as for a durable chat.
          const tier = savedTier(settings.serviceTier);
          this.routes.set(params.threadId, { provider: gatewayProvider, model: settings.model, ...(storableServiceTier(tier) ? { serviceTier: tier } : {}) });
        }
        return;
      }
      // A fork the cap evicted has no route to update, and nothing about it may be recorded.
      if (this.evictedEphemeralIds.has(params.threadId)) return;
      if (settings.modelProvider === gatewayProvider) await this.recordReasoning(params.threadId, { model: settings.model, effort: settings.effort, summary: settings.summary }, Number(emittedAtMs));
      if (settings.modelProvider !== gatewayProvider || typeof settings.model !== "string" || (settings.serviceTier !== null && typeof settings.serviceTier !== "string")) return;
      const record = { model: settings.model, serviceTier: recordableTier(this.extraModels, settings.model, savedTier(settings.serviceTier)), emittedAtMs: Number(emittedAtMs) };
      this.settingsVersions.set(params.threadId, (this.settingsVersions.get(params.threadId) || 0) + 1);
      // Duplicate notifications from slower shared clients cannot replace newer settings.
      const storable = storableServiceTier(record.serviceTier);
      const applied = storable ? await this.threadTiers.write(params.threadId, record, this.tierRecords.get(params.threadId) ?? null)
        // A tier the private store cannot hold is recorded as unknown, so no session start forwards an older tier.
        : await this.threadTiers.markUnknown(params.threadId, { model: settings.model, emittedAtMs: record.emittedAtMs });
      const current = await this.threadTiers.read(params.threadId);
      const route = this.routes.get(params.threadId);
      if (current) this.routes.set(params.threadId, { provider: gatewayProvider, ...current });
      // No readable tier: unknown (this notification or a newer one from a peer), so the route must not keep an older tier.
      else if (route) { if (!storable && applied) route.model = settings.model; delete route.serviceTier; }
      this.tierRecords.set(params.threadId, current);
    }
    if (message.method === "turn/completed" && typeof params.threadId === "string" && this.activeTurns.get(params.threadId)?.turnId === object(params.turn).id) this.activeTurns.delete(params.threadId);
  }
  /**
   * Recorded only once the SDK accepted the request, so a rejected request leaves no event. A loaded chat
   * ignores a session-start override and answers with the tier it kept, so nothing was dropped then.
   */
  private recordTierDrops(drops: TierDrop[], result: ObjectValue): void {
    if (result.serviceTier !== undefined && result.serviceTier !== null && result.serviceTier !== "default") return;
    for (const drop of drops) telemetry("service_tier_dropped", { model: drop.model, tier: loggableTier(this.extraModels, drop.tier), method: drop.method });
  }
  /**
   * At session start the SDK drops a tier the model lacks and starts Standard, so the gateway sends
   * serviceTier null. A tier that is not a string is left for the SDK to reject as invalid params.
   */
  private dropUnsupportedTier(params: ObjectValue, model: string, method: string, drops: TierDrop[]): ObjectValue {
    const tier = tierSelection(params);
    if (!tier || typeof tier.value !== "string" || offersServiceTier(this.extraModels, model, tier.value)) return params;
    const { service_tier: _dropped, ...config } = object(params.config);
    drops.push({ model, tier: tier.value, method });
    return { ...params, serviceTier: null, ...(params.config === undefined ? {} : { config }) };
  }
  /** A resumed or forked chat starts with its own tier; one its row lacks starts Standard. A tier the gateway never read is left to the SDK. */
  private inheritedTier(params: ObjectValue, route: ThreadRoute, model: string, method: string, drops: TierDrop[]): ObjectValue {
    if (tierSelection(params) || route.serviceTier === undefined) return params;
    if (route.serviceTier !== null && !offersServiceTier(this.extraModels, model, route.serviceTier)) {
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
  /**
   * Gateway defaults are saved privately; every other edit is the caller's own native
   * configuration and reaches the native engine as it was sent. A batch that carries both
   * validates the private part first, forwards the native part, and saves only once that
   * write succeeded, so a refusal at either step leaves both files untouched.
   * A request with no gateway default reads and writes no private file, but it waits in the
   * same queue: one connection's configuration writes must reach the native engine in send
   * order, and a write that fails must not hold back the writes queued behind it.
   */
  private async writeConfig(method: string, params: ObjectValue): Promise<ObjectValue> {
    const { privateEdits, nativeEdits } = partitionConfigEdits(configEdits(method, params));
    if (nativeEdits.length) {
      // The engine resolves a relative path in a native value against its own home, never against the
      // folder of the file this request happens to name, so a relative value is tried against that
      // home in both of its spellings: the one it is written with and the one its links resolve to.
      const identity: GatewayIdentity = { provider: gatewayProvider, isGatewayModel: value => typeof value === "string" && this.aliases.has(value),
        stateDirectory: resolve(this.config.stateDirectory), catalogPath: this.catalogPath, homeDirectory: homedir(), nativeHome: resolve(this.nativeHome) };
      const refusal = typeof params.filePath === "string" && params.filePath === this.preferencesPath ? gatewayTargetMessage
        : nativeWritesViolation(nativeEdits, identity);
      if (refusal) throw new AppServerRoutingError(refusal);
    }
    const queued = async (): Promise<ObjectValue> => privateEdits.length
      ? withPrivateFileLock(this.preferencesPath, async () => {
        await this.readPreferences();
        const preferences = this.planPreferences(params, privateEdits);
        if (!nativeEdits.length) return this.commitPreferences(preferences);
        // The native engine answers a mixed batch, so its result is what the caller sees.
        return this.backend(method, { ...params, edits: nativeEdits }).then(forwarded => this.commitPreferences(preferences, forwarded));
      })
      // No private part: the whole request belongs to the native engine and is forwarded unchanged.
      : this.backend(method, params);
    const operation = this.writes.then(queued);
    this.writes = operation.catch(() => undefined); return operation;
  }
  /** Checks a batch aimed at gateway defaults and returns the file it produces, without saving it. */
  private planPreferences(params: ObjectValue, edits: ObjectValue[]): ObjectValue {
    const modelEdit = edits.find(edit => edit.keyPath === "model");
    const chosen = modelEdit ? modelEdit.value : this.preferences.model;
    const local = edits.filter(edit => gatewayPreferenceKeys.has(String(edit.keyPath)));
    const desktopEdits = edits.filter(edit => isDesktopPreferenceKey(edit.keyPath));
    if (local.length && (typeof chosen !== "string" || !chosen)) throw new AppServerRoutingError("Select a model before saving its reasoning preferences");
    // Do not redirect writes explicitly aimed at a project or other profile.
    if (typeof params.filePath === "string" && params.filePath !== this.preferencesPath) throw new AppServerRoutingError("Gateway defaults are scoped to this adapter; choose a model without a custom config-file target");
    if (params.expectedVersion !== undefined && params.expectedVersion !== null) throw new AppServerRoutingError("Gateway default writes do not support a native config version guard");
    for (const edit of local) {
      if (!["replace", "upsert"].includes(String(edit.mergeStrategy)) || (edit.value !== null && typeof edit.value !== "string")) throw new AppServerRoutingError("Gateway defaults require string values with replace or upsert merge strategy");
      if (edit.keyPath === "service_tier" && edit.value !== null && typeof chosen === "string" && this.aliases.has(chosen) && !declaresServiceTier(this.extraModels, chosen, edit.value as string)) {
        throw new AppServerRoutingError("This gateway model does not offer that speed, so it cannot be the saved default. Choose Standard, or pick a model that offers it, then save again.", -32002);
      }
    }
    let desktop: ObjectValue;
    try { desktop = applyDesktopEdits(object(this.preferences.desktop), desktopEdits); }
    catch { throw new AppServerRoutingError("Gateway desktop display settings contain an unsupported value"); }
    const preferences: ObjectValue = { ...this.preferences, ...Object.fromEntries(local.map(edit => [String(edit.keyPath), edit.value])),
      ...(Object.keys(desktop).length ? { desktop } : {}) };
    if (modelEdit && chosen !== this.preferences.model && !local.some(edit => edit.keyPath === "service_tier")) delete preferences.service_tier;
    return preferences;
  }
  /** Saves the planned defaults; a mixed batch answers with what the native engine returned. */
  private async commitPreferences(preferences: ObjectValue, forwarded?: ObjectValue): Promise<ObjectValue> {
    await writePrivateJson(this.preferencesPath, preferences); this.preferences = preferences;
    return forwarded ?? { status: "ok", version: createHash("sha256").update(JSON.stringify(preferences)).digest("hex"), filePath: this.preferencesPath, overriddenMetadata: null };
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
    if (route.provider === gatewayProvider && params.serviceTierForTurn === "fast") forwarded = { ...params, serviceTierForTurn: "priority" };
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
    }
    // A native chat's request reaches the SDK exactly as the caller sent it: the SDK restores the chat's own model,
    // provider and effort, and any model or effort key added here would count as an override and defeat that restore.
    return forwarded;
  }
  async request(method: string, params: ObjectValue): Promise<ObjectValue> {
    // Neither gateway defaults nor the catalog apply to a fork that may carry no settings.
    const inherited = inheritsParentSettings(method, params);
    if (!inherited && ["model/list", "thread/start", "thread/resume", "thread/fork"].includes(method)) await this.readPreferences();
    if (this.source && !inherited && ["model/list", "thread/start", "thread/resume", "thread/fork", "turn/start", "thread/settings/update", "turn/settings/update"].includes(method)) {
      const requested = requestedModel(params) ?? (method === "thread/start" ? this.preferences.model : undefined);
      const strict = (typeof requested === "string" && !this.source.isNative(requested)) || params.modelProvider === gatewayProvider || (typeof params.threadId === "string" && this.routes.get(params.threadId)?.provider === gatewayProvider);
      this.extraModels = (await this.source.refresh(strict)).models;
      for (const model of this.extraModels) this.aliases.add(String(model.slug));
      if (typeof requested === "string" && !this.source.isNative(requested) && !this.aliases.has(requested)) throw new AppServerRoutingError("This model is absent from both the native and gateway catalogs; select an offered model");
    }
    if (method === "config/write") throw new AppServerRoutingError("Native Codex configuration is managed separately and cannot be changed by this adapter");
    if (method === "model/list") return this.models(params);
    if (method === "config/value/write" || method === "config/batchWrite") return this.writeConfig(method, params);
    let forwarded = params;
    const drops: TierDrop[] = [];
    if (method === "thread/start") {
      const model = requestedModel(params) ?? this.preferences.model;
      // The saved new-chat default applies first, so a Fast default the row no longer offers starts Standard.
      if (typeof model === "string" && this.aliases.has(model)) forwarded = this.modelRequest(this.dropUnsupportedTier(this.preferenceRequest(params, model), model, method, drops), model, true);
      else if (typeof model === "string") forwarded = { ...this.preferenceRequest(params, model), model, config: { ...(typeof this.preferences.model_reasoning_effort === "string" && this.preferences.model === model ? { model_reasoning_effort: this.preferences.model_reasoning_effort } : {}), ...object(params.config) } };
    } else if (!inherited && ["thread/resume", "thread/fork", "turn/start", "thread/settings/update", "turn/settings/update"].includes(method) && typeof params.threadId === "string") {
      // No SDK knows this chat: forward the request unchanged so the SDK gives its own answer.
      const threadRoute = await this.route(params.threadId);
      if (threadRoute) forwarded = await this.routedRequest(method, params, threadRoute, drops);
    }
    // Settled before the engine call: a close or cap eviction during the call must not make the chat durable.
    const wasEphemeral = typeof params.threadId === "string" && this.ephemeralThreads.has(params.threadId);
    const expectedTier = typeof params.threadId === "string" ? this.tierRecords.get(params.threadId) : undefined;
    const settingsVersion = typeof params.threadId === "string" ? this.settingsVersions.get(params.threadId) || 0 : 0;
    const requestStartedAtMs = Date.now();
    const result = await this.backend(method, forwarded);
    this.recordTierDrops(drops, result);
    if (method === "account/rateLimits/read") {
      try { return mergeGatewayUsage(result, await gatewayUsage(this.config)); }
      catch { return result; }
    }
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      await this.remember(result, forwarded, expectedTier, requestStartedAtMs, inherited);
      if (forwarded.modelProvider === gatewayProvider && result.modelProvider !== gatewayProvider) throw new AppServerRoutingError("The native engine did not apply the requested gateway provider; start a new chat");
    }
    // An applied settings change or a turn that carries one is durable from this request on.
    if (typeof params.threadId === "string" && !wasEphemeral && this.routes.get(params.threadId)?.provider === gatewayProvider && (method === "turn/start" || (method === "thread/settings/update" && result.status === "applied"))) {
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
      if (route && sentTier && (sentTier.value === null || typeof sentTier.value === "string")) {
        const sent = tierId(sentTier.value);
        if (storableServiceTier(sent)) route.serviceTier = sent; else delete route.serviceTier;
      }
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
    if (method === "thread/unsubscribe" && typeof params.threadId === "string" && this.ephemeralThreads.has(params.threadId)) this.forgetEphemeral(params.threadId);
    if (method === "config/read") {
      await this.readPreferences();
      const { desktop, ...modelPreferences } = this.preferences;
      return { ...result, config: { ...mergeDesktopPreferences(object(result.config), object(desktop)), ...modelPreferences, model_catalog_json: this.catalogPath } };
    }
    return result;
  }
}
