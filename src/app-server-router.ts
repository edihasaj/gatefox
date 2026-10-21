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
import { declaresServiceTier, recordableTier } from "./app-server-tier-offers.js";
import { dropUnsupportedTier, inheritedTier, recordTierDrops, type TierDrop } from "./app-server-tier-requests.js";
import { storableServiceTier, ThreadServiceTiers, type ThreadServiceTier } from "./thread-service-tiers.js";
import { ThreadReasoningStore, isModelName, isReasoningEffort, isReasoningSummary, type ThreadReasoningSelection } from "./thread-reasoning.js";
import { ResumeReasoning, fitEffort, type ReasoningChoice, type ThreadReasonSnapshot } from "./resume-reasoning.js";
import { homedir } from "node:os";
import { telemetry } from "./telemetry.js";
import { nativeThreadAbsent } from "./native-thread-absence.js";
import type { ClassifyThread } from "./gateway-chat-classifier.js";
import { ChatIdentity, hasParent, legacyGatewayProvider as gatewayProvider, noSlugs, threadFacts, type ChatKind, type EngineHint, type IdentityCatalogs } from "./chat-identity.js";
import { configEffort, enumEffort, object, requestedEffort, requestedModel, savedTier, tierId, tierSelection } from "./app-server-request-fields.js";
import { gatewayModelList } from "./app-server-model-list.js";
import { AppServerRoutingError } from "./app-server-routing-error.js";
import { gatewayProviderIds, nativeIdentityProvider, savedChatProvider } from "./executor-identity.js";

export { AppServerRoutingError };
type ObjectValue = Record<string, unknown>;
/** One engine request. `hint` names the engine a thread/start is for; the backends never infer it from the provider id. */
export type BackendRequest = (method: string, params: ObjectValue, hint?: EngineHint) => Promise<ObjectValue>;
/** `kind` decides every gateway rule; `provider` is only what the chat was saved with, reported as its identity. */
type ThreadRoute = { kind: ChatKind; provider?: string; model?: string; serviceTier?: string | null; nativeChildModel?: string };
const createsThread = new Set(["thread/start", "thread/resume", "thread/fork"]);
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
  private readonly identity: ChatIdentity;
  private readonly catalogs: IdentityCatalogs = { aliases: () => this.aliases, nativeSlugs: () => this.source?.nativeSlugs ?? noSlugs };
  /** The native engine's default provider, read once per connection for chat lists and read again after a configuration write. */
  private nativeDefault?: Promise<string>;
  /** `identity` is the connection's, shared with its backends so both classify from one registry read and one set of seen chats. */
  constructor(private readonly config: GatewayConfig, private readonly backend: BackendRequest, catalogPath?: string, private readonly source?: DesktopCatalog,
    private readonly nativeHome = resolve(process.env.CODEX_HOME || homedir() + "/.codex"), identity?: ChatIdentity) {
    this.identity = identity ?? new ChatIdentity(config.stateDirectory, nativeHome);
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
  /**
   * `routed` is the kind of engine the request was sent to: the start hint, or the route of the chat it resumed or forked.
   * A reply the router did not route itself (a resume by path, a prediction fork of a chat it never saw) is classified.
   */
  private async remember(method: string, result: ObjectValue, params: ObjectValue, expected: ThreadServiceTier | undefined, requestStartedAtMs: number,
    inherited: boolean, routed: ChatKind | undefined): Promise<void> {
    const thread = object(result.thread);
    if (typeof thread.id !== "string") return;
    // A prediction fork is throwaway: only its in-memory route is kept, never a durable record.
    const ephemeral = inherited || thread.ephemeral === true || this.evictedEphemeralIds.has(thread.id);
    if (ephemeral) this.trackEphemeral(thread.id);
    // A fork belongs with the chat it came from, so its parent answers when the router has no route for that chat.
    const parent = method === "thread/fork" && typeof params.threadId === "string" ? { parentThreadId: params.threadId } : {};
    const kind = routed ?? await this.classify({ ...parent, ...threadFacts(thread, result), id: thread.id }, method);
    // Only a gateway chat's reasoning is ever read back; a native chat keeps its own in the SDK.
    if (!ephemeral && kind === "gateway") {
      const config = object(params.config);
      await this.recordReasoning(thread.id, { model: typeof result.model === "string" ? result.model : params.model,
        effort: result.reasoningEffort ?? config.model_reasoning_effort, summary: result.reasoningSummary ?? config.model_reasoning_summary }, requestStartedAtMs);
    }
    if (typeof result.modelProvider === "string") {
      const tier = Object.hasOwn(result, "serviceTier") ? result.serviceTier : tierSelection(params)?.value;
      const previous = this.routes.get(thread.id);
      const model = typeof result.model === "string" ? result.model : typeof thread.model === "string" ? thread.model : undefined;
      // A sub-agent may use a native catalog row inside its gateway executor. This fact is
      // authoritative only when the SDK's thread metadata records a parent; later resume
      // replies can omit source, so retain the already-proven row only when it still matches.
      const nativeChildModel = this.nativeChildModel(thread, kind, model) ?? (previous?.nativeChildModel === model ? model : undefined);
      const route: ThreadRoute = { kind, provider: result.modelProvider, ...(typeof result.model === "string" ? { model: result.model } : {}),
        ...(tier === null || (typeof tier === "string" && storableServiceTier(tierId(tier))) ? { serviceTier: tierId(tier) as string | null } : {}),
        ...(nativeChildModel ? { nativeChildModel } : {}) };
      this.routes.set(thread.id, route);
      // SDK snapshots are authoritative; requested values alone cannot establish durable settings.
      if (!ephemeral && route.kind === "gateway" && typeof route.model === "string" && (result.serviceTier === null || typeof result.serviceTier === "string")) {
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
  /** Classification after one registry read; the parent rule reads only chats this connection has seen. */
  private async classify(thread: ClassifyThread, method: string): Promise<ChatKind> {
    await this.identity.refresh();
    await this.identity.learnAncestors(thread, this.catalogs, async id => (await this.backend("thread/read", { threadId: id, includeTurns: false })).thread);
    return this.identity.classify(thread, this.catalogs, method).kind;
  }
  private async route(threadId: string, method: string): Promise<ThreadRoute | undefined> {
    let route = this.routes.get(threadId);
    if (!route) {
      let probe: ObjectValue;
      try { probe = await this.backend("thread/read", { threadId, includeTurns: false }); }
      catch (error) { if (nativeThreadAbsent(error, threadId)) return undefined; throw error; }
      const thread = object(probe.thread);
      if (typeof thread.modelProvider !== "string") throw new AppServerRoutingError("Cannot determine this chat's provider");
      this.identity.learnReply("thread/read", probe);
      // The saved record decides, never the request: a native chat resumed with no model stays native.
      const kind = await this.classify({ ...threadFacts(thread), id: threadId }, method);
      const model = typeof thread.model === "string" ? thread.model : undefined;
      route = { kind, provider: thread.modelProvider, ...(model ? { model } : {}), ...(this.nativeChildModel(thread, kind, model) ? { nativeChildModel: model } : {}) };
      this.routes.set(threadId, route);
      this.chatSnapshots.set(threadId, { path: thread.path, effort: thread.reasoningEffort });
      // A forgotten throwaway fork can still be loaded in the engine; it must stay memory-only.
      if (thread.ephemeral === true || this.evictedEphemeralIds.has(threadId)) this.trackEphemeral(threadId);
    }
    if (route.kind === "gateway" && !this.ephemeralThreads.has(threadId)) {
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
  /**
   * Engine kind and model for diagnostics; no settings or content. A gateway chat also says which provider id it was saved
   * with: `legacy` for the gateway's own id, `openai` for the native identity.
   */
  describeThread(threadId: string): { provider?: string; model?: string; identity?: string } {
    const route = this.routes.get(threadId);
    if (!route) return {};
    const identity = route.kind === "gateway" && typeof route.provider === "string" ? { identity: route.provider === gatewayProvider ? "legacy" : "openai" } : {};
    return { provider: route.kind, ...(typeof route.model === "string" ? { model: route.model } : {}), ...identity };
  }
  /** A notification's chat kind: the engine that sent it, else the chat's route, else its classification. */
  private async notifiedKind(threadId: string, settings: ObjectValue, engine?: ChatKind): Promise<ChatKind> {
    const route = this.routes.get(threadId);
    if (engine || route) return engine ?? route!.kind;
    return this.classify({ id: threadId, ...(typeof settings.modelProvider === "string" ? { modelProvider: settings.modelProvider } : {}),
      ...(typeof settings.model === "string" ? { model: settings.model } : {}) }, "thread/settings/updated");
  }
  /** The provider id a settings notification names, or the one the chat's route already holds. */
  private savedProvider(threadId: string, settings: ObjectValue): { provider?: string } {
    const provider = typeof settings.modelProvider === "string" ? settings.modelProvider : this.routes.get(threadId)?.provider;
    return typeof provider === "string" ? { provider } : {};
  }
  /**
   * Only applied thread settings are durable; active-turn settings remain connection-local. `engine` is the kind of engine
   * that emitted the message, so a gateway chat is recognized whatever provider id it carries.
   */
  async observeNotification(message: ObjectValue, engine?: ChatKind): Promise<void> {
    const params = object(message.params);
    if (message.method === "thread/started") this.identity.learn(threadFacts(params.thread));
    if (message.method === "thread/closed" && typeof params.threadId === "string" && this.ephemeralThreads.has(params.threadId)) this.forgetEphemeral(params.threadId);
    if (message.method === "thread/settings/updated" && typeof params.threadId === "string") {
      // The pinned SDK stamps the envelope before fan-out to clients on this host.
      const emittedAtMs = message.emittedAtMs;
      if (!Number.isSafeInteger(emittedAtMs) || Number(emittedAtMs) <= 0 || Number(emittedAtMs) > Date.now() + 1000) return;
      const settings = object(params.threadSettings);
      // Only settings on a gateway alias are kept: a resume or fork can restore no other model on a gateway chat.
      const servable = typeof settings.model === "string" && this.aliases.has(settings.model);
      if (this.ephemeralThreads.has(params.threadId)) {
        // A throwaway fork's applied settings stay in its route; nothing about it is recorded durably.
        this.settingsVersions.set(params.threadId, (this.settingsVersions.get(params.threadId) || 0) + 1);
        if (servable && typeof settings.model === "string" && (settings.serviceTier === null || typeof settings.serviceTier === "string") && await this.notifiedKind(params.threadId, settings, engine) === "gateway") {
          // Only a tier a later fork or resume can forward is kept; an odd one leaves the route without a tier, as for a durable chat.
          const tier = savedTier(settings.serviceTier);
          this.routes.set(params.threadId, { kind: "gateway", ...this.savedProvider(params.threadId, settings), model: settings.model, ...(storableServiceTier(tier) ? { serviceTier: tier } : {}) });
        }
        return;
      }
      // A fork the cap evicted has no route to update, and nothing about it may be recorded.
      if (this.evictedEphemeralIds.has(params.threadId)) return;
      const gateway = servable && await this.notifiedKind(params.threadId, settings, engine) === "gateway";
      if (gateway) await this.recordReasoning(params.threadId, { model: settings.model, effort: settings.effort, summary: settings.summary }, Number(emittedAtMs));
      if (!gateway || typeof settings.model !== "string" || (settings.serviceTier !== null && typeof settings.serviceTier !== "string")) return;
      const record = { model: settings.model, serviceTier: recordableTier(this.extraModels, settings.model, savedTier(settings.serviceTier)), emittedAtMs: Number(emittedAtMs) };
      this.settingsVersions.set(params.threadId, (this.settingsVersions.get(params.threadId) || 0) + 1);
      // Duplicate notifications from slower shared clients cannot replace newer settings.
      const storable = storableServiceTier(record.serviceTier);
      const applied = storable ? await this.threadTiers.write(params.threadId, record, this.tierRecords.get(params.threadId) ?? null)
        // A tier the private store cannot hold is recorded as unknown, so no session start forwards an older tier.
        : await this.threadTiers.markUnknown(params.threadId, { model: settings.model, emittedAtMs: record.emittedAtMs });
      const current = await this.threadTiers.read(params.threadId);
      const route = this.routes.get(params.threadId);
      if (current) this.routes.set(params.threadId, { kind: "gateway", ...this.savedProvider(params.threadId, settings), ...current });
      // No readable tier: unknown (this notification or a newer one from a peer), so the route must not keep an older tier.
      else if (route) { if (!storable && applied) route.model = settings.model; delete route.serviceTier; }
      this.tierRecords.set(params.threadId, current);
    }
    if (message.method === "turn/completed" && typeof params.threadId === "string" && this.activeTurns.get(params.threadId)?.turnId === object(params.turn).id) this.activeTurns.delete(params.threadId);
  }
  /**
   * A chat list that asks only for the native engine's default provider, by naming it or by naming none, also gets the chats
   * saved with the gateway's own id, so a client that lists the native identity (the phone, through the relay) sees every
   * gateway chat without any saved chat being rewritten. Every other list reaches the engine as it was sent: an empty list
   * already means every provider, a parent or ancestor filter lists every provider, and a chosen set of providers is the
   * caller's choice. The native default is read from the engine's configuration, `openai` when it names none, once per
   * connection and again after a configuration write.
   */
  private async listRequest(params: ObjectValue): Promise<ObjectValue> {
    const requested = params.modelProviders;
    const omitted = requested === undefined || requested === null;
    if (omitted && (typeof params.parentThreadId === "string" || typeof params.ancestorThreadId === "string")) return params;
    if (!omitted && (!Array.isArray(requested) || requested.length !== 1 || typeof requested[0] !== "string")) return params;
    const native = await (this.nativeDefault ??= this.backend("config/read", {}).then(result => {
      const configured = object(result.config).model_provider;
      return typeof configured === "string" && configured ? configured : nativeIdentityProvider;
    }, () => { this.nativeDefault = undefined; return nativeIdentityProvider; }));
    if (native === gatewayProvider || (!omitted && (requested as string[])[0] !== native)) return params;
    return { ...params, modelProviders: [native, gatewayProvider] };
  }
  private preferenceRequest(params: ObjectValue, model: string): ObjectValue {
    if (tierSelection(params) || this.preferences.model !== model || !Object.hasOwn(this.preferences, "service_tier")) return params;
    return { ...params, serviceTier: this.preferences.service_tier };
  }
  /** A native row is servable by a gateway executor only for its own saved, parent-spawned child. */
  private nativeChildModel(thread: ObjectValue, kind: ChatKind, model: string | undefined): string | undefined {
    return kind === "gateway" && typeof model === "string" && this.source?.isNative(model) === true && hasParent(thread) ? model : undefined;
  }
  private allowsSavedNativeChild(route: ThreadRoute, model: unknown): boolean {
    return typeof model === "string" && route.nativeChildModel === model;
  }
  /** Whether the SDK will skip its persisted-session restore for a resume. */
  private resumeOverride(params: ObjectValue): boolean {
    const config = object(params.config);
    return params.model !== undefined && params.model !== null
      || params.modelProvider !== undefined && params.modelProvider !== null
      || Object.hasOwn(config, "model") || Object.hasOwn(config, "model_reasoning_effort");
  }
  /**
   * A gateway-owned sub-agent may deliberately run a native catalog row. Its SDK
   * restore has the same gate as every other chat, but the gateway executor can
   * have different launch defaults. When the caller opens that gate without
   * selecting a different model or provider, repeat the child's own saved
   * identity and only recover reasoning we can actually observe.
   */
  private async nativeChildResume(params: ObjectValue, route: ThreadRoute): Promise<ObjectValue> {
    // The child's own settings are forwarded as the caller saved them. The gateway no longer forces
    // `web_search` off: the Codex 2 route forwards the hosted tool and every other route drops it.
    if (!this.resumeOverride(params)) return params;
    const model = route.nativeChildModel!;
    if (typeof params.modelProvider === "string" && typeof route.provider === "string" && params.modelProvider !== route.provider) {
      throw new AppServerRoutingError("This Codex version cannot change a loaded chat between native and gateway providers. Start a new chat with the selected model. Reset to default selects a model; it does not reload the model list. Your account and existing chat are unchanged.", -32002);
    }
    let forwarded: ObjectValue = params;
    // A null or absent typed model does not select a new child model. The config
    // remains untouched: the SDK receives the caller's explicit config as well.
    if (params.model === undefined || params.model === null) forwarded = { ...forwarded, model };
    // The executor launch provider is not the child's provider. Do not let an
    // otherwise harmless effort/config override turn this child into that default.
    if ((params.modelProvider === undefined || params.modelProvider === null) && typeof route.provider === "string") {
      forwarded = { ...forwarded, modelProvider: route.provider };
    }
    const config = object(params.config);
    if (!Object.hasOwn(config, "model_reasoning_effort") && requestedEffort(params) === undefined) {
      const restored = await this.reasoning.recover(String(params.threadId), model, () => this.threadSnapshot(String(params.threadId)));
      if (restored) {
        const nextConfig: ObjectValue = { ...config, model_reasoning_effort: restored.effort };
        if (!Object.hasOwn(config, "model_reasoning_summary") && params.summary === undefined && restored.summary) nextConfig.model_reasoning_summary = restored.summary;
        forwarded = { ...forwarded, config: nextConfig };
      }
    }
    return forwarded;
  }
  /**
   * `provider` is the provider id the request names: the gateway's own id asks for a new gateway chat, which the backends record
   * with the connection's identity, and a resumed chat names the id it was saved with.
   */
  private modelRequest(params: ObjectValue, model: string, newChat = false, restored?: ReasoningChoice | null, provider = gatewayProvider): ObjectValue {
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
    // The caller's `web_search` config passes through untouched: Codex 2 rows offer hosted search and the gateway drops it elsewhere.
    return { ...selected, model, modelProvider: provider,
      config: { ...reasoning, ...object(params.config), model_catalog_json: this.catalogPath } };
  }
  private assertSameProvider(route: ThreadRoute, model: unknown): void {
    if (typeof model !== "string") return;
    if ((route.kind === "gateway") !== this.aliases.has(model) && !this.allowsSavedNativeChild(route, model)) {
      throw new AppServerRoutingError("This Codex version cannot change a loaded chat between native and gateway providers. Start a new chat with the selected model. Reset to default selects a model; it does not reload the model list. Your account and existing chat are unchanged.", -32002);
    }
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
    // A native write may change the engine's default provider, so the next chat list reads it again.
    const operation = this.writes.then(queued).finally(() => { if (nativeEdits.length) this.nativeDefault = undefined; });
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
    this.assertSameProvider(route, requestedModel(params));
    const sessionStart = method === "thread/resume" || method === "thread/fork";
    // Inside a running chat the SDK keeps the chat's chosen tier and leaves it off an outgoing request only
    // while the model lacks it, so the gateway neither clears nor injects a tier here. The SDK also accepts a
    // tier the model does not offer. Its per-turn field reads "priority", so the legacy "fast" alias is mapped.
    if (route.kind === "gateway" && params.serviceTierForTurn === "fast") forwarded = { ...params, serviceTierForTurn: "priority" };
    if (sessionStart && route.kind === "gateway") {
      // A route learned from a settings notification may not know the saved provider; the chat's record does, and a resume must name it.
      if (method === "thread/resume" && typeof route.provider !== "string") {
        const saved = object((await this.backend("thread/read", { threadId: params.threadId, includeTurns: false })).thread).modelProvider;
        if (typeof saved === "string") route.provider = saved;
      }
      const model = requestedModel(params) ?? route.model;
      const sameModel = model === route.model;
      // The desktop records sub-agents on native catalog rows. Their own saved metadata
      // proves the executor owns that row, but it is not a gateway alias. A clean resume
      // stays byte-for-byte; an SDK restore override must repeat only that child's state.
      if (this.allowsSavedNativeChild(route, model)) {
        return method === "thread/resume" ? this.nativeChildResume(forwarded, route) : forwarded;
      }
      if (typeof model !== "string" || !this.aliases.has(model)) throw new AppServerRoutingError("This gateway chat needs a currently configured model alias");
      const inherited = inheritedTier(this.extraModels, dropUnsupportedTier(this.extraModels, params, model, method, drops), route.serviceTier, model, method, drops);
      // A typed model override disables the engine's persisted-settings restore,
      // so the gateway supplies the chat's own reasoning for the model it keeps.
      let restored: ReasoningChoice | null | undefined = null;
      if (!sameModel) restored = undefined;
      else if (configEffort(params) === undefined) restored = await this.restoredReasoning(String(params.threadId), model, method);
      // A resume keeps the provider the chat was saved with, so it never rewrites the chat's record; a fork is a new chat.
      forwarded = this.modelRequest(inherited, model, false, restored, method === "thread/resume" ? savedChatProvider(route.provider) : gatewayProvider);
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
      const strict = (typeof requested === "string" && !this.source.isNative(requested)) || params.modelProvider === gatewayProvider || (typeof params.threadId === "string" && this.routes.get(params.threadId)?.kind === "gateway");
      this.extraModels = (await this.source.refresh(strict)).models;
      for (const model of this.extraModels) this.aliases.add(String(model.slug));
      if (typeof requested === "string" && !this.source.isNative(requested) && !this.aliases.has(requested)) throw new AppServerRoutingError("This model is absent from both the native and gateway catalogs; select an offered model");
    }
    if (method === "config/write") throw new AppServerRoutingError("Native Codex configuration is managed separately and cannot be changed by this adapter");
    if (method === "model/list") return gatewayModelList(params, this.backend, this.aliases, this.extraModels, this.preferences.model);
    if (method === "thread/list") return this.backend(method, await this.listRequest(params));
    if (method === "config/value/write" || method === "config/batchWrite") return this.writeConfig(method, params);
    let forwarded = params;
    const drops: TierDrop[] = [];
    // The kind of engine this request goes to, when the router decides it: a new chat's, or the routed chat's.
    let routed: ChatKind | undefined;
    if (method === "thread/start") {
      const model = requestedModel(params) ?? this.preferences.model;
      const alias = typeof model === "string" && this.aliases.has(model);
      // The saved new-chat default applies first, so a Fast default the row no longer offers starts Standard.
      if (alias) forwarded = this.modelRequest(dropUnsupportedTier(this.extraModels, this.preferenceRequest(params, model), model, method, drops), model, true);
      else if (typeof model === "string") forwarded = { ...this.preferenceRequest(params, model), model, config: { ...(typeof this.preferences.model_reasoning_effort === "string" && this.preferences.model === model ? { model_reasoning_effort: this.preferences.model_reasoning_effort } : {}), ...object(params.config) } };
      // A gateway alias, or a caller that names the gateway's own provider id, starts a gateway chat; "openai" never does.
      routed = alias || params.modelProvider === gatewayProvider ? "gateway" : "native";
    } else if (!inherited && ["thread/resume", "thread/fork", "turn/start", "thread/settings/update", "turn/settings/update"].includes(method) && typeof params.threadId === "string") {
      // No SDK knows this chat: forward the request unchanged so the SDK gives its own answer.
      const threadRoute = await this.route(params.threadId, method);
      if (threadRoute) forwarded = await this.routedRequest(method, params, threadRoute, drops);
      routed = threadRoute?.kind;
    } else if (inherited && typeof params.threadId === "string") routed = this.routes.get(params.threadId)?.kind;
    // Settled before the engine call: a close or cap eviction during the call must not make the chat durable.
    const wasEphemeral = typeof params.threadId === "string" && this.ephemeralThreads.has(params.threadId);
    const expectedTier = typeof params.threadId === "string" ? this.tierRecords.get(params.threadId) : undefined;
    const settingsVersion = typeof params.threadId === "string" ? this.settingsVersions.get(params.threadId) || 0 : 0;
    const requestStartedAtMs = Date.now();
    const result = await this.backend(method, forwarded, method === "thread/start" ? { engine: routed! } : undefined);
    recordTierDrops(this.extraModels, drops, result);
    if (method === "account/rateLimits/read") {
      try { return mergeGatewayUsage(result, await gatewayUsage(this.config)); }
      catch { return result; }
    }
    if (createsThread.has(method)) {
      await this.remember(method, result, forwarded, expectedTier, requestStartedAtMs, inherited, routed);
      // A gateway chat is recorded with one of the ids a gateway executor serves; any other answer came from an engine that ignored the request.
      if (forwarded.modelProvider === gatewayProvider && !gatewayProviderIds.has(String(result.modelProvider))) throw new AppServerRoutingError("The native engine did not apply the requested gateway provider; start a new chat");
    }
    // An applied settings change or a turn that carries one is durable from this request on.
    if (typeof params.threadId === "string" && !wasEphemeral && this.routes.get(params.threadId)?.kind === "gateway" && (method === "turn/start" || (method === "thread/settings/update" && result.status === "applied"))) {
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
