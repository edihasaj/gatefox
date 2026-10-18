import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import { AppServerConnection, isId, object, type EngineStopReason, type Id, type Message } from "./app-server-connection.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { gatewayEngineHome, gatewayEnvironment } from "./gateway-engine-home.js";
import { ExecutionHostClient, nativeFallbackReason, type NativeFallbackReason, type NativeLaunchRecord } from "./execution-host-client.js";
import { nothingToJoin, type PrivateNativeLease } from "./native-execution-host-storage.js";
import { privateNativeOwnership, refusedFallback, underPrivateLease } from "./native-fallback.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import type { ExecutionRecord } from "./execution-host-engine.js";
import { canonicalJson, isReleaseSkew } from "./execution-host-engine.js";
import { homedir } from "node:os";
import { normalizeCodexFeatureArgs, normalizeCodexFeatureConfig } from "./codex-feature-compat.js";
import { sendWithStrictFeatureRetry } from "./gateway-feature-retry.js";
import { reportGatewayFeatureTrim, trimGatewayFeatureArgs, trimGatewayFeatureConfig, trimGatewayFeatureRequest, trimmedGatewayFeatures } from "./gateway-feature-schema.js";
import { gatewayFeatureArgs, nativeArguments, offersPriority } from "./gateway-engine-args.js";
import { GatewayCompaction, type GatewayCompactionSession } from "./gateway-compaction.js";
import { SharedNativeConnection, type NativeConnectionFactory, type NativeRpcConnection } from "./shared-native-connection.js";
import { readServicePlan } from "./service-plan.js";
import { gatewaySdkRuntime, type GatewaySdkRuntime } from "./gateway-sdk-runtime.js";
import { nativeThreadAbsent } from "./native-thread-absence.js";
import { withStagedQueueInput } from "./queued-attachments.js";
import { BoundedIdSet } from "./bounded-id-set.js";
import { telemetry } from "./telemetry.js";
import { NativeTurnTracker, nativeId } from "./native-turns.js";
import { ChatIdentity, hasParent, legacyGatewayProvider, noSlugs, threadFacts, type ChatKind, type EngineHint, type IdentityCatalogs } from "./chat-identity.js";
import { executorOverrides, nativeEnvironment, newChatProvider } from "./executor-identity.js";
import { ChatLoads, Reattacher, ReattachError, isHostFailure, markHostFailure } from "./executor-reattach.js";
import { AppServerChatList, type ChatListDiscovery, type ChatListSource } from "./app-server-chat-list.js";
import { NativeRuntimeStatus } from "./native-runtime-status.js";
import { AdapterRuntimeMetadata, type RuntimeMetadataSource } from "./adapter-runtime-metadata.js";

type RpcConnection = AppServerConnection | SocketAppServerConnection | NativeRpcConnection;
/**
 * `creating` counts this connection's thread/start and thread/fork requests the engine has not finished answering. `provider` is
 * the provider id the engine was launched to record new chats with, when this connection launched or acquired it.
 */
interface Engine { connection: RpcConnection; revision: string; aliases: Set<string>; threads: Set<string>; active: Map<string, string>; requests: number; creating?: number; shared?: boolean; detaching?: boolean; compaction?: GatewayCompactionSession; exitPending?: Promise<void>; provider?: string }
interface CompactionSnapshot { models: Message[]; settings: Message; args: string[] }

/** Socket clients of host-owned engines ignore the reason: only a process the adapter spawned can say why it stopped. */
function stopConnection(connection: RpcConnection, reason: EngineStopReason): void {
  if (connection instanceof AppServerConnection) connection.stop(reason); else connection.stop();
}

/** A stable native connection plus bounded gateway generations pinned to loaded chats. */
export class AppServerBackends {
  readonly native: NativeRpcConnection;
  private readonly engines: Engine[] = [];
  private readonly bindings = new Map<string, Engine>();
  private readonly approvals = new Map<string, { connection: RpcConnection; id: Id; fingerprint: string }>();
  private readonly answered = new Map<string, string>();
  private readonly reverse = new Map<RpcConnection, Map<Id, string>>();
  private serverSequence = 0;
  private initialized?: Message;
  private closing = false;
  private creating: Promise<unknown> = Promise.resolve();
  private poolPending?: Promise<ExecutionHostClient | undefined>;
  /** The last live host connection `pool()` handed out; a re-attach reads it, synchronously, for its reason. */
  private poolClient?: ExecutionHostClient;
  private nativeHost?: { client: ExecutionHostClient; record: NativeLaunchRecord };
  private sharedGateway?: boolean;
  private readonly compaction: GatewayCompaction;
  // Throwaway chats (composer prediction forks): their turns never write to the on-disk compaction store.
  private readonly ephemeralThreads = new BoundedIdSet(4096);
  private readonly nativeTurns = new NativeTurnTracker();
  private nativeExitPending?: Promise<void>;
  private leaseReleased?: Promise<void>;
  private finishNativeClosing!: () => void;
  private readonly nativeClosing = new Promise<void>(resolve => { this.finishNativeClosing = resolve; });
  /** Aborted by stop(), so a host wait this adapter started (a kick and up to 20 s of looking) ends with it. */
  private readonly stopped = new AbortController();
  /** This connection's chat classification; the router shares it, so both read one registry and one set of seen chats. */
  readonly identity: ChatIdentity;
  private readonly catalogs: IdentityCatalogs = { aliases: () => this.gatewayAliases(), nativeSlugs: () => this.catalog.nativeSlugs ?? noSlugs };
  /** Finds and verifies the package's gateway SDK; a test can stand in for it. */
  resolveRuntime: () => Promise<GatewaySdkRuntime | undefined> = () => gatewaySdkRuntime();
  private chatProvider?: string;
  /** How each gateway chat was loaded, and the one re-attach per chat at a time when its executor is gone. */
  private readonly loads = new ChatLoads();
  private readonly reattacher = new Reattacher();
  /** Read-only status bridge for mobile/native chat lists. It owns no gateway engine or chat binding. */
  private readonly chatList: AppServerChatList;
  private nativeStatus?: NativeRuntimeStatus;
  private runtimeMetadata?: AdapterRuntimeMetadata;
  /** A timed-out list caller must leave the host's single raw control RPC joinable. */
  private readonly generationFlights = new WeakMap<ExecutionHostClient, Promise<ExecutionRecord[]>>();
  static async create(executable: string, args: string[], config: GatewayConfig, settings: Message, overrides: Message,
    catalog: DesktopCatalog, emit: (message: Message, engine?: ChatKind) => Promise<void>, onNativeExit: () => void, configPath?: string, signal?: AbortSignal): Promise<AppServerBackends> {
    const plan = await readServicePlan(config.stateDirectory);
    const nativeHome = resolve(process.env.CODEX_HOME || homedir() + "/.codex");
    // A private native engine, with gateway chats on the shared host only when the plan shares them. A fallback engine runs only
    // under the native-home lease, taken before it is spawned and held until it exits (or given back if the spawn never happens).
    const privateNative = async (fallback?: NativeFallbackReason) => {
      const lease = await privateNativeOwnership(configPath, nativeHome, executable, fallback, plan);
      const backend = await underPrivateLease(lease, () => new AppServerBackends(executable, args, config, settings, overrides, catalog, emit, onNativeExit, configPath, undefined, lease),
        value => (value.native as AppServerConnection).pid ?? 0);
      backend.sharedGateway = plan ? plan.sharedExecutors === true : undefined; return backend;
    };
    if (object(plan).sharedNativeExecutor !== true) return privateNative();
    let client: ExecutionHostClient | undefined; let backend: AppServerBackends | undefined;
    try {
      if (!configPath || plan?.config !== resolve(configPath)) throw new Error("Shared native executor configuration does not match this adapter");
      try { client = await ExecutionHostClient.discover(configPath, nativeHome, executable, "native", true, signal); }
      catch (error) {
        if (signal?.aborted) throw error; // The session is ending: nothing falls back for it.
        // Only a host that stayed down through the wait, or one that shares gateway chats without native sharing, falls back;
        // a host that does not match, a changed socket and every other failure keep failing closed. A fallback that a live
        // native owner refuses reports the host's own failure, unless the refusal names a cause of its own.
        const fallback = nativeFallbackReason(error, plan.sharedExecutors === true); if (!fallback) throw error;
        return await privateNative(fallback).catch(refusal => { throw refusedFallback(fallback, error, refusal); });
      }
      if (plan.sharedExecutors && !client!.capabilities.includes("gateway")) throw new Error("The configured shared gateway executor is unavailable in this native host");
      const acquire = () => client!.acquireNative(nativeArguments(normalizeCodexFeatureArgs(args, settings), overrides), dirname(nativeHome));
      let record: NativeLaunchRecord;
      try { record = await acquire(); }
      catch (error) {
        // A host that came back while private engines hold the native home refuses native ownership until they have all ended:
        // this adapter joins them with an engine of its own. A host writer or an older release's engine still keeps it out.
        const fallback = signal?.aborted ? undefined : nativeFallbackReason(error, plan.sharedExecutors === true); if (!fallback) throw error;
        let joined: AppServerBackends | undefined;
        try { joined = await privateNative(fallback); }
        catch (refusal) {
          // No private engine was left to join (they ended, or the refusal came from a busy lock): the host may take the
          // home now, so it is asked once more; a second refusal fails the connection.
          if (!nothingToJoin(refusal) || signal?.aborted) throw refusedFallback(fallback, error, refusal);
        }
        if (joined) { client!.close(); client = undefined; return joined; }
        record = await acquire();
      }
      backend = new AppServerBackends(executable, args, config, settings, overrides, catalog, emit, onNativeExit, configPath,
        (_args, onMessage, onExit) => new SharedNativeConnection(record.socketPath, onMessage, onExit, process.cwd()));
      backend.nativeHost = { client: client!, record }; backend.sharedGateway = plan.sharedExecutors === true;
      await backend.native.ready; return backend;
    } catch (error) {
      await backend?.stop(); client?.close();
      throw Object.assign(new Error(error instanceof Error ? error.message : "Shared native executor connection failed"), { code: -32001 });
    }
  }
  constructor(private readonly executable: string, private readonly args: string[], private readonly config: GatewayConfig,
    private readonly settings: Message, private readonly overrides: Message, private readonly catalog: DesktopCatalog,
    private readonly emit: (message: Message, engine?: ChatKind) => Promise<void>, private readonly onNativeExit: () => void, private readonly configPath?: string,
    nativeFactory?: NativeConnectionFactory, private readonly nativeLease?: PrivateNativeLease) {
    this.identity = new ChatIdentity(config.stateDirectory, resolve(process.env.CODEX_HOME || homedir() + "/.codex"));
    this.args = normalizeCodexFeatureArgs(args, settings);
    this.settings = normalizeCodexFeatureConfig(settings);
    this.compaction = new GatewayCompaction(config.stateDirectory);
    this.chatList = new AppServerChatList({
      sources: signal => this.chatListSources(signal), initialized: () => this.initialized,
      emit: message => this.emit(message, "gateway"),
    });
    // Register only the added provider at runtime. Native account/model defaults stay intact.
    // The native exit record waits for the drain, because only then is the turn table final.
    const exited = (connection?: RpcConnection) => {
      this.leaseReleased = this.nativeLease?.release().catch(() => {}); // The engine is gone, so the native home is free again.
      this.nativeExitPending = this.nativeExited(connection).finally(() => { onNativeExit(); });
    };
    const nativeArgs = nativeArguments(this.args, overrides);
    this.native = nativeFactory ? nativeFactory(nativeArgs, message => this.forward(this.native, message), exited)
      : new AppServerConnection(executable, nativeArgs, message => this.forward(this.native, message), exited, nativeEnvironment(), "native");
  }
  /** One engine process always gets exactly one exit record, with the reason it stopped for. */
  private reportEngineExit(connection: RpcConnection, activeTurns: number): void {
    if (!(connection instanceof AppServerConnection)) return; // A host-owned shared engine has no process to explain here.
    const facts = connection.exitFacts;
    telemetry("engine_exit", { engine: connection.engine, code: facts.code, signal: facts.signal, uptimeMs: facts.uptimeMs,
      activeTurns, initiatedBy: facts.initiatedBy, reason: facts.reason });
  }
  private async nativeExited(connection?: RpcConnection): Promise<void> {
    // Drain before deciding which tasks lost their terminal event. Pending SDK
    // RPCs are already rejected at child close, so forwarding can finish.
    await Promise.race([this.native.drained, this.nativeClosing]);
    // Exactly one record per process, counting the turns that survived its last forwarded frames.
    this.reportEngineExit(connection ?? this.native, this.nativeTurns.active.size);
    this.nativeTurns.close();
    this.forgetConnection(this.native);
    const active = [...this.nativeTurns.active]; this.nativeTurns.clear();
    if (this.closing) return;
    // Socket loss does not prove SDK death. Only the matching host-owned SDK's
    // observed death of this exact SDK launch permits failure of observed turns.
    if (this.native.shared) {
      const confirmed = await Promise.race([this.nativeHost?.client.confirmedNativeDeath(this.nativeHost.record), this.nativeClosing.then(() => false)]);
      if (this.closing || !confirmed) return;
    }
    const error = { message: "The Codex engine stopped while this turn was running (the app may have restarted it). The chat's history is saved; send a message to continue, or reconnect this chat's computer if it stays unavailable.", codexErrorInfo: "internalServerError", additionalDetails: null };
    for (const [threadId, turn] of active) {
      if (this.closing) break;
      try { await Promise.race([this.emit({ method: "error", params: { threadId, turnId: turn.id, error, willRetry: false } }), this.nativeClosing]); } catch { /* The client may already be gone. */ }
      if (this.closing) break;
      try { await Promise.race([this.emit({ method: "turn/completed", params: { threadId, turn: { ...turn, items: [], itemsView: "notLoaded", status: "failed", error,
        completedAt: null, durationMs: null } } }), this.nativeClosing]); } catch { /* Shutdown still follows the attempted terminal delivery. */ }
    }
  }
  private async nativeRequest(method: string, params: Message): Promise<Message> {
    const revision = this.nativeTurns.revision;
    // A service-owned SDK lacks the desktop app's file grants, so attachments are staged for it.
    const native = this.native;
    const result = native.shared ? await withStagedQueueInput(this.config.stateDirectory, method, params, staged => native.request(method, staged)) : await native.request(method, params);
    this.identity.learnReply(method, result);
    if (["thread/unsubscribe", "thread/delete", "thread/archive"].includes(method) && nativeId(params.threadId)) {
      this.nativeTurns.delete(params.threadId); this.nativeTurns.revision++;
    }
    if (["thread/read", "thread/resume"].includes(method)) {
      const thread = object(result.thread); const id = nativeId(thread.id) ? thread.id : params.threadId;
      const turns = Array.isArray(thread.turns) ? thread.turns.map(object).filter(turn => turn.status === "inProgress" && nativeId(turn.id)) : [];
      if (nativeId(id) && Array.isArray(thread.turns) && revision === this.nativeTurns.revision) {
        for (const value of thread.turns) {
          const turn = object(value);
          if (nativeId(turn.id) && ["completed", "failed", "interrupted"].includes(String(turn.status))) this.nativeTurns.rememberCompleted(JSON.stringify([id, turn.id]));
        }
        this.nativeTurns.delete(id);
        if (turns.length === 1) { if (!this.closing) this.nativeTurns.observe({ method: "turn/started", params: { threadId: id, turn: turns[0] } }); }
        else this.nativeTurns.revision++;
      }
    }
    return result;
  }
  private forgetConnection(connection: RpcConnection): void {
    for (const [id, approval] of this.approvals) if (approval.connection === connection) this.approvals.delete(id);
    for (const id of this.reverse.get(connection)?.values() || []) this.answered.delete(id);
    this.reverse.delete(connection);
  }
  private async forward(connection: RpcConnection, message: Message): Promise<void> {
    const engine = this.engines.find(value => value.connection === connection);
    if (connection === this.native && !this.closing) this.nativeTurns.observe(message);
    // Private gateway SDKs belong to this adapter and publish the same read-only
    // runtime state as native. Host-owned shared SDKs use passive observers.
    if ((connection === this.native || engine && !engine.shared) && !this.closing) this.nativeStatus?.observe(message);
    const params = object(message.params);
    // A borrowed or regular gateway connection is forwarded below, but does not
    // pass through the passive socket observer. Record its status first so a
    // stale in-flight read cannot overwrite the event in a mobile list.
    if (engine && !this.closing) this.chatList.observeStatus(message, engine.revision);
    if (message.method === "thread/started") this.identity.learn(threadFacts(params.thread));
    if (engine) {
      engine.compaction?.observe(message);
      const thread = object(params.thread); const threadId = typeof params.threadId === "string" ? params.threadId : typeof thread.id === "string" ? thread.id : undefined;
      if (message.method === "thread/started" && threadId && thread.ephemeral === true) this.ephemeralThreads.add(threadId);
      // Every chat a gateway engine announces, a sub-agent included, is in the registry before the announcement goes on.
      // A chat this connection is still creating is recorded by its request, which alone knows whether it is throwaway.
      const subagent = message.method === "thread/started" && hasParent(thread);
      if (message.method === "thread/started" && threadId && !this.ephemeralThreads.has(threadId) && (subagent || !engine.creating)) {
        await this.identity.record(threadId, subagent ? "subagent" : "started");
      }
      if (!threadId || !this.ephemeralThreads.has(threadId)) await this.compaction.observe(message);
      if (message.method === "thread/started" && threadId) { engine.threads.add(threadId); this.bindings.set(threadId, engine); }
      if (message.method === "thread/closed" && threadId) { engine.threads.delete(threadId); this.ephemeralThreads.delete(threadId); engine.compaction?.forget(threadId); if (this.bindings.get(threadId) === engine) { this.bindings.delete(threadId); this.loads.forget(threadId); } }
      if (message.method === "turn/started" && threadId && typeof object(params.turn).id === "string") engine.active.set(threadId, String(object(params.turn).id));
      if (message.method === "turn/completed" && threadId && engine.active.get(threadId) === object(params.turn).id) engine.active.delete(threadId);
      // Executor account discovery is not the desktop's primary account state.
      if (!isId(message.id) && !threadId && message.method !== "serverRequest/resolved") return;
    }
    if (isId(message.id)) {
      let ids = this.reverse.get(connection); if (!ids) { ids = new Map(); this.reverse.set(connection, ids); }
      const fingerprint = createHash("sha256").update(canonicalJson(message)).digest("hex");
      const existing = ids.get(message.id);
      if (existing) {
        const pending = this.approvals.get(existing);
        if ((pending?.fingerprint || this.answered.get(existing)) !== fingerprint) throw new Error("Inconsistent pending Codex server request replay");
        // SDK resume can snapshot a callback just before its answer is applied.
        // Keep its fingerprint until the real resolved notification arrives.
        if (!pending) return;
        await this.emit({ ...message, id: existing }); return;
      }
      if (this.approvals.size + this.answered.size >= 256) throw new Error("Invalid or excessive pending Codex server requests");
      const id = `gateway-server-${++this.serverSequence}`;
      ids.set(message.id, id); this.approvals.set(id, { connection, id: message.id, fingerprint }); await this.emit({ ...message, id });
    } else if (message.method === "serverRequest/resolved") {
      const original = params.requestId; const ids = this.reverse.get(connection); const id = isId(original) ? ids?.get(original) : undefined;
      if (id) { ids!.delete(original as Id); this.approvals.delete(id); this.answered.delete(id); await this.emit({ ...message, params: { ...params, requestId: id } }); }
    // The engine's kind travels with its notification, so the router never has to read a provider id to place it.
    } else await this.emit(message, engine ? "gateway" : connection === this.native ? "native" : undefined);
  }
  reply(message: Message): boolean {
    if (typeof message.id !== "string") return false;
    const approval = this.approvals.get(message.id); if (!approval || approval.connection.closed) return false;
    this.approvals.delete(message.id); this.answered.set(message.id, approval.fingerprint);
    approval.connection.send({ ...message, id: approval.id }); return true;
  }
  notify(message: Message): void { this.native.send(message); }
  /**
   * The shared host's control connection. A live one clears the re-attach fail-fast window (a host that is answering is not
   * down), and every failure is marked as a host failure so a re-attach can tell it from a gateway or resume failure.
   */
  private async pool(): Promise<ExecutionHostClient | undefined> {
    try {
      const client = await this.lookupPool();
      if (client && !client.closed) this.reattacher.hostAvailable();
      return client;
    } catch (error) { return markHostFailure(error); }
  }
  /**
   * List-only generation discovery. Unlike pool(), this never kicks or waits for
   * host recovery: a mobile list must remain useful while the host is unavailable.
   */
  private async chatListSources(signal?: AbortSignal): Promise<ChatListDiscovery | undefined> {
    if (this.closing) return [];
    const normal = new Map<string, ChatListSource>();
    for (const engine of this.engines) if (!engine.connection.closed) {
      normal.set(engine.revision, { record: { revision: engine.revision, socketPath: "", aliases: [...engine.aliases] }, connection: engine.connection });
    }
    const incomplete = (): ChatListDiscovery | undefined => {
      const sources = [...normal.values()].slice(0, 4);
      return sources.length ? { sources, complete: false } : undefined;
    };
    if (this.sharedGateway === false || (this.sharedGateway !== true && !this.nativeHost && !this.poolClient)) return [...normal.values()].slice(0, 4);
    let client = this.nativeHost?.client ?? this.poolClient; let transient = false;
    if (!client || client.closed) {
      if (!this.configPath) return this.sharedGateway === true ? incomplete() : [...normal.values()].slice(0, 4);
      try {
        // Optional discovery is a single receipt/socket inspection. It never asks
        // the service to recover a stopped host and its client is not retained.
        client = await ExecutionHostClient.discover(this.configPath, resolve(process.env.CODEX_HOME || homedir() + "/.codex"), this.executable, "gateway", false, signal);
        transient = !!client;
      } catch { return incomplete(); }
    }
    if (!client || client.closed) return incomplete();
    if (signal?.aborted) { if (transient) client.close(); return incomplete(); }
    let timer: NodeJS.Timeout | undefined; let raw: Promise<ExecutionRecord[]> | undefined;
    try {
      const cancelled = new Promise<undefined>(resolve => signal?.addEventListener("abort", () => {
        resolve(undefined);
      }, { once: true }));
      raw = this.generations(client);
      const records = await Promise.race<ExecutionRecord[] | undefined>([raw, cancelled, new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), 1500).unref();
      })]);
      if (!records) return incomplete();
      for (const record of records) if (!normal.has(record.revision)) normal.set(record.revision, { record });
      return [...normal.values()].slice(0, 4);
    } catch { return incomplete(); }
    finally {
      clearTimeout(timer);
      // Transient clients own no generation leases. Closing one cancels its
      // pending status read; borrowed host clients keep their coalesced flight.
      if (transient) client.close();
    }
  }
  private generations(client: ExecutionHostClient): Promise<ExecutionRecord[]> {
    const current = this.generationFlights.get(client); if (current) return current;
    const work = client.generations(); this.generationFlights.set(client, work);
    void work.then(
      () => { if (this.generationFlights.get(client) === work) this.generationFlights.delete(client); },
      () => { if (this.generationFlights.get(client) === work) this.generationFlights.delete(client); },
    );
    return work;
  }
  /** Fetch all native loaded ids only for an exact, complete union; failure uses the native page unchanged. */
  private nativeLoadedFlight?: Promise<Set<string> | undefined>;
  private nativeLoadedIds(): Promise<Set<string> | undefined> {
    if (this.nativeLoadedFlight) return this.nativeLoadedFlight;
    const work = this.enumerateNativeLoadedIds().finally(() => { if (this.nativeLoadedFlight === work) this.nativeLoadedFlight = undefined; });
    this.nativeLoadedFlight = work; return work;
  }
  private async enumerateNativeLoadedIds(): Promise<Set<string> | undefined> {
    const ids = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
    try {
      for (let page = 0; page < 4; page++) {
        const result = await this.nativeRequest("thread/loaded/list", { limit: 500, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data) || result.data.some(id => typeof id !== "string")) return;
        for (const id of result.data) ids.add(id as string);
        if (result.nextCursor == null) return ids;
        if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) return;
        cursor = result.nextCursor; cursors.add(cursor);
      }
    } catch { /* A native failure must not replace its already returned page. */ }
    return;
  }
  private async loadedList(native: Message, params: Message): Promise<Message> {
    // The native request above is intentionally first: it preserves its validation
    // and error surface. Empty native lists need this small additional cursor check.
    if (params.cursor !== undefined && params.cursor !== null && !AppServerChatList.validCursor(params.cursor)) throw Object.assign(new Error(`invalid cursor: ${String(params.cursor)}`), { code: -32600 });
    let timer: NodeJS.Timeout | undefined;
    const nativeStatus = this.nativeStatus;
    const union = Promise.all([this.nativeLoadedIds(), this.chatList.loadedIds(), nativeStatus ? nativeStatus.loadedIds() : Promise.resolve([])]);
    const lists = await Promise.race([union, new Promise<[Set<string> | undefined, Set<string> | undefined, string[] | undefined]>(resolve => { timer = setTimeout(() => resolve([undefined, undefined, undefined]), 1900).unref(); })]);
    clearTimeout(timer);
    const [nativeIds, gatewayIds, peerIds] = lists;
    // No native-status bridge means no extra source. Once it exists, though,
    // undefined is an incomplete peer enumeration, not an empty successful one.
    if (!nativeIds || !gatewayIds || (nativeStatus && peerIds === undefined)) return native;
    const all = [...new Set([...nativeIds, ...gatewayIds, ...(peerIds ?? [])].map(id => AppServerChatList.validCursor(id) ? AppServerChatList.canonicalCursor(id) : id))].sort();
    const cursor = typeof params.cursor === "string" ? AppServerChatList.canonicalCursor(params.cursor) : undefined;
    let start = 0;
    if (cursor) { while (start < all.length && all[start] <= cursor) start++; }
    const requested = params.limit;
    const limit = typeof requested === "number" && Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : all.length;
    const data = all.slice(start, start + limit); const nextCursor = start + data.length < all.length ? data.at(-1) : null;
    return { ...native, data, nextCursor };
  }
  private async lookupPool(): Promise<ExecutionHostClient | undefined> {
    if (this.closing || this.sharedGateway === false) return;
    if (this.nativeHost) {
      if (!this.nativeHost.client.capabilities.includes("gateway")) return;
      if (this.nativeHost.client.closed) throw Object.assign(new Error("Shared executor host connection was lost; reconnect this chat's computer connection"), { code: -32001 });
      return this.nativeHost.client;
    }
    if (!this.configPath) {
      if (this.sharedGateway === true) throw Object.assign(new Error("Shared gateway execution requires this adapter's configuration path"), { code: -32001 });
      return;
    }
    // One discovery at a time: a caller that finds the settled one gone follows a newer attempt if another caller already
    // started one, and only a caller still seeing that same closed value starts the next. A discovery of its own per closed
    // generation would leak a control connection each, and the host takes at most eight.
    // stop() closes the connection it finds pending; a caller that wakes after it must not start or keep another, so every
    // await below is followed by a check of `closing`.
    const stopped = (client?: ExecutionHostClient): never => {
      if (client && !client.closed) client.close();
      throw Object.assign(new Error("Codex desktop connection is closing"), { code: -32001 });
    };
    for (;;) {
      const waiting = this.poolPending;
      if (!waiting) break;
      const existing = await waiting.catch(() => undefined);
      if (this.closing) return stopped(existing);
      if (existing && !existing.closed) { this.poolClient = existing; return existing; }
      if (this.poolPending !== waiting) continue;
      this.poolPending = undefined;
      break;
    }
    const pending = ExecutionHostClient.discover(this.configPath, resolve(process.env.CODEX_HOME || homedir() + "/.codex"), this.executable, "gateway", this.sharedGateway === true, this.stopped.signal)
      .catch(error => { if (this.sharedGateway === true) Object.assign(error, { code: -32001 }); throw error; });
    this.poolPending = pending;
    const client = await pending;
    if (this.closing) return stopped(client);
    if (client && !client.closed) this.poolClient = client;
    if (!client && this.poolPending === pending) this.poolPending = undefined;
    return client;
  }
  private async releaseIdleShared(keepRevision: string): Promise<void> {
    const operation = this.creating.then(async () => {
      for (let index = this.engines.length - 1; index >= 0; index--) {
        const old = this.engines[index];
        if (!old.shared || old.revision === keepRevision || old.requests || old.threads.size || old.active.size) continue;
        old.detaching = true; stopConnection(old.connection, "idle"); await old.connection.exited; this.engines.splice(index, 1);
        await (await this.pool())?.release(old.revision);
      }
    });
    this.creating = operation.catch(() => undefined); await operation;
  }
  private async shared(record: ExecutionRecord, snapshot?: CompactionSnapshot, provider?: string): Promise<Engine> {
    const ready = this.engines.find(engine => engine.shared && engine.revision === record.revision && !engine.connection.closed);
    if (ready) { ready.requests++; ready.provider ??= provider; return ready; }
    const operation = this.creating.then(async () => {
      if (this.closing || !this.initialized) throw new Error("Initialize an open adapter before attaching a gateway executor");
      const existing = this.engines.find(engine => engine.shared && engine.revision === record.revision && !engine.connection.closed);
      if (existing) { existing.requests++; existing.provider ??= provider; return existing; }
      for (let index = this.engines.length - 1; index >= 0; index--) {
        const old = this.engines[index];
        if (old.connection.closed || (!old.requests && !old.threads.size && !old.active.size)) {
          old.detaching = true; stopConnection(old.connection, "replaced"); await old.connection.exited; this.engines.splice(index, 1);
          if (old.shared && old.revision !== record.revision) await (await this.pool())?.release(old.revision);
        }
      }
      const engine: Engine = { connection: undefined!, revision: record.revision, aliases: new Set(record.aliases), threads: new Set(), active: new Map(), requests: 1, shared: true, ...(provider ? { provider } : {}) };
      const connection: SocketAppServerConnection = new SocketAppServerConnection(record.socketPath, message => this.forward(connection, message), () => {
        engine.exitPending = (async () => {
          await Promise.race([connection.drained, this.nativeClosing]);
          await engine.compaction?.close(); this.forgetConnection(connection);
          // Losing a shared client's socket never establishes that its SDK turn
          // failed. Frontend transport EOF requests normal ownership reconnect.
          if (!this.closing && !engine.detaching && !this.native.shared) for (const [threadId, turnId] of engine.active) {
            const error = { message: "Connection to the gateway executor was lost. Its turn may still be running. Resume this chat to reconnect.", codexErrorInfo: "internalServerError", additionalDetails: null };
            try { await Promise.race([this.emit({ method: "error", params: { threadId, turnId, error, willRetry: false } }), this.nativeClosing]); } catch { /* The client may already be gone. */ }
            if (this.closing) break;
          }
          engine.active.clear();
        })().catch(() => {}).then(() => { if (!this.closing && !engine.detaching && this.native.shared) this.onNativeExit(); });
      }, { drainOnClose: true });
      engine.connection = connection;
      engine.compaction = this.compaction.session({ models: snapshot?.models || [], settings: snapshot?.settings || {}, args: snapshot?.args || [], aliases: engine.aliases,
        shared: true, selectedModelCompaction: record.selectedModelCompaction, isGatewayThread: thread => this.isGatewayThread(thread),
        isActive: id => engine.active.has(id), request: (method, params) => connection.request(method, params) });
      this.engines.push(engine);
      try {
        await connection.request("initialize", { ...this.initialized, capabilities: { ...object(this.initialized.capabilities), experimentalApi: true } });
        connection.send({ method: "initialized", params: {} }); return engine;
      } catch (error) { stopConnection(connection, "spawn_error"); throw error; }
    });
    this.creating = operation.catch(() => undefined); return operation;
  }
  private async owner(threadId: string): Promise<Engine | undefined> {
    const record = await (await this.pool())?.find(threadId);
    return record ? this.shared(record) : undefined;
  }
  private async gateway(): Promise<Engine> {
    if (this.closing) throw new Error("Codex desktop connection is closing");
    if (!this.catalog.current().models.length) await this.catalog.refresh(true);
    const snapshot = this.catalog.current();
    const priority = offersPriority(snapshot.models);
    const runtime = await this.resolveRuntime();
    const provider = this.newChatProvider(runtime);
    // The identity is fixed for the connection; an executor that can no longer serve it fails closed instead of reaching OpenAI.
    if (provider !== newChatProvider(this.config, runtime)) throw Object.assign(new Error("The gateway executor changed while this desktop connection was open; reconnect to continue gateway chats"), { code: -32001 });
    const revision = createHash("sha256").update(snapshot.revision + (runtime?.binarySha256 || "") + provider).digest("hex");
    const pool = await this.pool();
    if (pool) {
      if (!this.initialized) throw new Error("Initialize the desktop connection before starting a gateway chat");
      const latest = object((await this.native.request("config/read", {})).config);
      const clientSettings = { ...this.settings, ...(latest.agents ? { agents: latest.agents } : {}) };
      const omitted = new Set(["desktop", "model", "model_provider", "model_catalog_json", "model_reasoning_effort", "model_reasoning_summary", "service_tier", "model_providers", "openai_api_key", "forced_login_method", "forced_chatgpt_workspace_id"]);
      // ChatGPT picks features by the native engine's version; the pinned gateway SDK is older, so trim both to its schema.
      const stats = { count: 0 };
      const settings = trimGatewayFeatureConfig(normalizeCodexFeatureConfig(Object.fromEntries(Object.entries(clientSettings).filter(([key, value]) => !omitted.has(key) && value !== undefined && value !== null))), stats);
      const forwarded: string[] = [];
      for (let index = 0; index < this.args.length; index++) {
        if (["-p", "--profile", "--listen"].includes(this.args[index])) { index++; continue; }
        if (!this.args[index].startsWith("--profile=") && !this.args[index].startsWith("--listen=") && this.args[index] !== "--stdio") forwarded.push(this.args[index]);
      }
      const overrides = { model: snapshot.models[0].slug, ...executorOverrides(provider, this.overrides), "features.step_model_switching": true, ...(priority ? { "features.fast_mode": true } : {}) };
      const args = trimGatewayFeatureArgs(normalizeCodexFeatureArgs([...gatewayFeatureArgs(forwarded, priority), ...Object.entries(overrides).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])], settings), stats);
      reportGatewayFeatureTrim("spawn", stats);
      const combined = this.catalog.combined(snapshot);
      const sdk = runtime ? { gatewaySdkSha256: runtime.binarySha256 } : {};
      const sharedRevision = createHash("sha256").update(canonicalJson({ catalog: combined, settings, args, ...sdk })).digest("hex");
      await this.releaseIdleShared(sharedRevision);
      const record = await pool.acquire({ revision: sharedRevision, args, settings, catalog: combined, aliases: snapshot.models.map(model => String(model.slug)), ...sdk }).catch(markHostFailure);
      return this.shared(record, { models: combined.models, settings, args }, provider);
    }
    if (!snapshot.models.length) throw new Error("No gateway models are currently offered; check the gateway catalog");
    const ready = this.engines.find(engine => engine.revision === revision && !engine.connection.closed);
    if (ready) { ready.requests++; return ready; }
    const operation = this.creating.then(async () => {
      if (this.closing) throw new Error("Codex desktop connection is closing");
      const existing = this.engines.find(engine => engine.revision === revision && !engine.connection.closed);
      if (existing) { existing.requests++; return existing; }
      for (let index = this.engines.length - 1; index >= 0; index--) {
        const old = this.engines[index];
        if (old.connection.closed || (!old.requests && !old.threads.size && !old.active.size)) { old.detaching = true; stopConnection(old.connection, "replaced"); await old.connection.exited; this.engines.splice(index, 1); }
      }
      if (this.engines.filter(engine => !engine.connection.closed).length >= 4) throw new Error("Four gateway catalog versions still have loaded chats. Close an older gateway chat before selecting a newly added model; native chats remain available.");
      if (!this.initialized) throw new Error("Initialize the desktop connection before starting a gateway chat");
      const latest = object((await this.native.request("config/read", {})).config);
      const settings = { ...this.settings, ...(latest.agents ? { agents: latest.agents } : {}) };
      const home = await gatewayEngineHome(resolve(this.config.stateDirectory, "desktop-generations", revision), settings);
      const path = resolve(this.config.stateDirectory, `desktop-catalog-${snapshot.revision}.json`);
      await writePrivateJson(path, this.catalog.combined(snapshot));
      const forwarded: string[] = [];
      for (let index = 0; index < this.args.length; index++) {
        if (["-p", "--profile"].includes(this.args[index])) { index++; continue; }
        if (!this.args[index].startsWith("--profile=")) forwarded.push(this.args[index]);
      }
      const overrides = { model: snapshot.models[0].slug, ...executorOverrides(provider, this.overrides), model_catalog_json: path,
        "features.step_model_switching": true, ...(priority ? { "features.fast_mode": true } : {}) };
      const args = trimmedGatewayFeatures("spawn", stats => trimGatewayFeatureArgs([...gatewayFeatureArgs(forwarded, priority), ...Object.entries(overrides).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])], stats));
      if (this.closing) throw new Error("Codex desktop connection is closing");
      const engine: Engine = { connection: undefined!, revision, aliases: new Set(snapshot.models.map(model => String(model.slug))), threads: new Set(), active: new Map(), requests: 1, provider };
      engine.connection = new AppServerConnection(runtime?.executable || this.executable, args, message => this.forward(engine.connection, message), connection => {
        this.reportEngineExit(connection, engine.active.size);
        void engine.compaction?.close();
        this.forgetConnection(engine.connection);
        if (!this.closing) for (const [threadId, id] of engine.active) void this.emit({ method: "turn/completed", params: { threadId, turn: { id, items: [], status: "failed", error: { message: "Gateway executor exited. Resume this chat to recover its saved history.", codexErrorInfo: "internalServerError", additionalDetails: null } } } });
        engine.active.clear();
      }, gatewayEnvironment(home), "gateway");
      engine.compaction = this.compaction.session({ models: snapshot.models, settings, args, aliases: engine.aliases,
        selectedModelCompaction: runtime?.selectedModelCompaction, isGatewayThread: thread => this.isGatewayThread(thread),
        isActive: id => engine.active.has(id), request: (method, params) => engine.connection.request(method, params) });
      this.engines.push(engine);
      try { await engine.connection.request("initialize", { ...this.initialized, capabilities: { ...object(this.initialized.capabilities), experimentalApi: true } }); engine.connection.send({ method: "initialized", params: {} }); }
      catch (error) { stopConnection(engine.connection, "spawn_error"); throw error; }
      return engine;
    });
    this.creating = operation.catch(() => undefined); return operation;
  }
  /** The provider id this connection records new gateway chats with, decided once from the configuration and the gateway SDK (docs/harness-identity.md). */
  private newChatProvider(runtime: GatewaySdkRuntime | undefined): string {
    return this.chatProvider ??= newChatProvider(this.config, runtime);
  }
  /**
   * Loads a chat whose gateway executor is gone onto a live one: the host is found again (a kick and its usual wait), the
   * generation that owns the chat or the current one is acquired, and the chat is resumed the way a desktop resume is:
   * with the load parameters the executor cannot restore from the chat's history, the SDK bringing back the model, the
   * provider id the chat is saved with and the approvals the chat last used. Nothing of a turn that died with the executor
   * is sent again. Requests that find the same chat's executor gone meanwhile share this one re-attach; the flight is
   * claimed before anything is awaited. The host's owner and generation rules still decide, so a chat never gets a second
   * writer.
   */
  private async reattach(threadId: string, closed: Engine): Promise<void> {
    // Synchronous state only, and the flight check that follows is synchronous too: awaiting a host lookup here would let
    // a request that arrives mid-lookup miss the running flight and report a reason the host lookup has already changed.
    const host = this.nativeHost?.client ?? this.poolClient;
    const reason = closed.shared && host && !host.closed ? "generation_retired" : "engine_closed";
    await this.reattacher.join(threadId, reason, async () => {
      // Only a failed host lookup (finding the host, or asking it) is "host_unavailable" and arms the fail-fast window; a
      // gateway() that refused for its own reasons (catalog, generation limit, a changed provider) is the chat's own failure.
      try { const target = await this.owner(threadId).catch(markHostFailure) ?? await this.gateway(); target.requests--; }
      catch (error) { throw isReleaseSkew(error) ? error : new ReattachError(isHostFailure(error) ? "host_unavailable" : "resume_failed"); }
      try { await this.request("thread/resume", this.loads.resumeParams(threadId)); }
      catch { throw new ReattachError("resume_failed"); }
    });
  }
  /** Gateway aliases this connection knows: the current catalog and every generation it still has loaded. */
  private gatewayAliases(): ReadonlySet<string> {
    const aliases = new Set(this.catalog.current().models.map(model => String(model.slug)));
    for (const engine of this.engines) for (const alias of engine.aliases) aliases.add(alias);
    return aliases;
  }
  /** A chat's kind from the SDK's record of it, after one registry read. */
  private async classify(thread: unknown, threadId: string, method: string): Promise<ChatKind> {
    return (await this.verdict(thread, threadId, method)).kind;
  }
  private async verdict(thread: unknown, threadId: string, method: string): Promise<ReturnType<ChatIdentity["classify"]>> {
    await this.identity.refresh();
    const facts = { ...threadFacts(thread), id: threadId };
    // Ancestors come from the native engine's saved records: every chat's rollout is in the shared home, gateway ones included.
    await this.identity.learnAncestors(facts, this.catalogs, async id => (await this.nativeRequest("thread/read", { threadId: id, includeTurns: false })).thread);
    return this.identity.classify(facts, this.catalogs, method);
  }
  /**
   * A gateway chat found only through its parent or its alias is written to the registry when it is routed, so it no longer
   * depends on its parent's record or its model: a sub-agent spawned while no desktop was connected, or a chat whose entry was
   * lost. A throwaway chat stays memory-only.
   */
  private async keep(thread: unknown, threadId: string, rule: string): Promise<void> {
    if ((rule !== "parent" && rule !== "alias") || object(thread).ephemeral === true || this.ephemeralThreads.has(threadId)) return;
    await this.identity.record(threadId, rule === "parent" ? "subagent" : "started");
  }
  /** The native engine's read of a chat, when its saved provider is native and the chat's classification agrees. */
  private async verifiedNative(method: string, params: Message): Promise<Message | undefined> {
    const result = await this.nativeRequest(method, params).catch(() => undefined);
    return result && nativeId(object(result.thread).modelProvider) && await this.classify(result.thread, String(params.threadId), method) === "native" ? result : undefined;
  }
  /** Synchronous, for compaction checks inside a request: the registry as of the connection's latest read. */
  private isGatewayThread(thread: Message): boolean {
    return this.identity.classify({ ...threadFacts(thread) }, this.catalogs, "compaction").kind === "gateway";
  }
  private runtimeMetadataSources(): RuntimeMetadataSource[] {
    return this.engines.filter(engine => !engine.shared && !engine.connection.closed).map(engine => {
      const connection = engine.connection;
      return { connection, current: () => !this.closing && this.engines.includes(engine) && engine.connection === connection && !engine.shared && !connection.closed };
    });
  }
  /** `hint` decides a thread/start; every other request follows the chat's binding, owner or classification. */
  async request(method: string, params: Message, hint?: EngineHint): Promise<Message> {
    if (method === "initialize") {
      const result = await this.native.request(method, params); this.initialized = params;
      if (!this.nativeStatus && !this.closing) {
        try {
          this.runtimeMetadata = new AdapterRuntimeMetadata(
            () => ({ connection: this.native, current: () => !this.closing && !this.native.closed }),
            () => this.runtimeMetadataSources(),
          );
          this.nativeStatus = new NativeRuntimeStatus({
            nativeHome: resolve(process.env.CODEX_HOME || homedir() + "/.codex"),
            // Supplemental snapshots must not reconcile the caller's turn table:
            // metadata-only SDK replies deliberately contain an empty turns list.
            // This deliberately bypasses nativeRequest(), which reconciles an
            // empty includeTurns:false reply with NativeTurnTracker.active.
            readOnlyNativeRequest: (read, input) => this.runtimeMetadata!.request(read, input),
            emitStatus: message => this.closing ? undefined : this.emit(message, "native"),
          });
          await this.nativeStatus.start();
        } catch { /* Supplemental status cannot stop the native connection. */ }
      }
      return result;
    }
    if (method === "thread/list") {
      const native = await this.nativeRequest(method, params);
      const local = this.nativeStatus ? await this.nativeStatus.hydrate(native) : native;
      return this.chatList.hydrate(local);
    }
    if (method === "thread/loaded/list") {
      const native = await this.nativeRequest(method, params);
      return this.loadedList(native, params);
    }
    // A live shared SDK is authoritative for active turns. Native disk metadata
    // may label that same gateway chat notLoaded or interrupted.
    if (method === "thread/read" && typeof params.threadId === "string" && !this.bindings.has(params.threadId)) {
      // While this adapter runs its own native engine because the host is down, a verified native chat never waits for that host.
      const early = this.nativeLease ? await this.verifiedNative(method, params) : undefined; if (early) return early;
      let owner: Engine | undefined;
      // An unavailable optional gateway execution host must not block an original
      // native chat. Only explicit non-gateway metadata permits this fallback.
      try { owner = await this.owner(params.threadId); }
      catch (error) { const result = await this.verifiedNative(method, params); if (result) return result; throw error; }
      if (owner) {
        try { const result = await owner.connection.request(method, params); this.identity.learnReply(method, result); return result; }
        finally { owner.requests--; }
      }
      return this.nativeRequest(method, params);
    }
    let engine: Engine | undefined; let reserved = false;
    if (method === "thread/start" && hint?.engine === "gateway") { engine = await this.gateway(); reserved = true; }
    else if (typeof params.threadId === "string") {
      engine = this.bindings.get(params.threadId);
      if (!engine && this.nativeLease && await this.verifiedNative("thread/read", { threadId: params.threadId, includeTurns: false })) return this.nativeRequest(method, params);
      if (!engine) {
        engine = await this.owner(params.threadId); reserved = !!engine;
        if (!engine) {
          const probe = await this.nativeRequest("thread/read", { threadId: params.threadId, includeTurns: false })
            .catch(error => { if (nativeThreadAbsent(error, String(params.threadId))) return undefined; throw error; });
          const found = probe && await this.verdict(probe.thread, params.threadId, method);
          if (found && found.kind === "gateway") { await this.keep(probe!.thread, params.threadId, found.rule); engine = await this.gateway(); reserved = true; }
        }
      }
    }
    if (!engine) return this.nativeRequest(method, params);
    if (engine.connection.closed) {
      if (reserved) engine.requests--;
      const threadId = String(params.threadId);
      if (method === "thread/resume") { engine = await this.owner(threadId) || await this.gateway(); reserved = true; }
      else if (method === "thread/unsubscribe") {
        // A re-attach of this chat that is running now would load the chat again after a local answer and undo the unload:
        // wait for it, then unload the chat where it landed. Otherwise the chat is loaded nowhere this connection can reach,
        // and unloading it asks nothing of a host: answer the SDK's own "not loaded" here, with the chat's local records
        // cleared, instead of waking a generation just to unload it.
        const flight = this.reattacher.running(threadId);
        if (flight) await flight.catch(() => undefined);
        const moved = flight ? this.bindings.get(threadId) : undefined;
        if (moved && !moved.connection.closed) { engine = moved; reserved = false; }
        else {
          engine.threads.delete(threadId);
          if (this.bindings.get(threadId) === engine) this.bindings.delete(threadId);
          this.ephemeralThreads.delete(threadId); engine.compaction?.forget(threadId); this.loads.forget(threadId);
          return { status: "notLoaded" };
        }
      }
      else {
        // The chat's executor is gone (its host restarted, or it exited): load the chat again on a live one and then send the
        // request there, as the user would by resuming. A throwaway chat lived only in the engine that is gone.
        const lost = Object.assign(new Error(engine.shared ? "The gateway executor connection was lost; resume this chat to reconnect to its saved or running session." : "The gateway executor exited; resume this chat before continuing. Ephemeral chats must be started again."), { code: -32001 });
        if (this.closing || this.ephemeralThreads.has(threadId)) throw lost;
        // The host's release-skew message is the reason to show: the service runs another release than this app.
        try { await this.reattach(threadId, engine); } catch (error) { throw isReleaseSkew(error) ? error : lost; }
        engine = this.bindings.get(threadId);
        if (!engine) throw lost;
        reserved = false;
      }
    }
    if (!reserved) engine.requests++;
    const creating = method === "thread/start" || method === "thread/fork";
    if (creating) engine.creating = (engine.creating ?? 0) + 1;
    try {
      // The router asks for a new gateway chat with the gateway's own provider id; the chat is recorded with the identity the
      // engine was launched with. An engine this connection did not launch (a shared host's, found by its chat) may run an SDK
      // that cannot serve `openai`, so its new chats keep the legacy id. A resumed chat keeps the provider the router read
      // from its record, so no saved chat is ever rewritten.
      if (creating && params.modelProvider === legacyGatewayProvider) {
        const provider = engine.provider ?? legacyGatewayProvider;
        if (provider !== legacyGatewayProvider) params = { ...params, modelProvider: provider };
      }
      // Only gateway engines get here; native requests returned above and are forwarded untouched.
      params = trimmedGatewayFeatures("request", stats => trimGatewayFeatureRequest(method, params, stats));
      const model = object(object(params.collaborationMode).settings).model ?? params.model;
      if (typeof model === "string" && !engine.aliases.has(model)) throw new Error("This loaded gateway chat uses an older catalog. Start a new chat to use a newly added model without interrupting it.");
      const compaction = await engine.compaction?.before(method, params);
      if (compaction?.intercepted) return compaction.result || {};
      const loaded = typeof params.threadId === "string" && engine.threads.has(params.threadId);
      const target = engine;
      const send = (sent: Message) => target.shared ? withStagedQueueInput(this.config.stateDirectory, method, sent, staged => target.connection.request(method, staged)) : target.connection.request(method, sent);
      // Retry inside the request accounting and compaction hooks above and below, so each runs once.
      const sent = await sendWithStrictFeatureRetry(method, params, send);
      const result = sent.result; params = sent.params;
      this.identity.learnReply(method, result);
      // A throwaway chat has no compaction row, and a rollback must not write a reset row for it.
      if (!(typeof params.threadId === "string" && this.ephemeralThreads.has(params.threadId))) await engine.compaction?.after(method, params);
      if (["thread/start", "thread/resume", "thread/fork"].includes(method) && typeof object(result.thread).id === "string") {
        const id = String(object(result.thread).id); engine.threads.add(id); this.bindings.set(id, engine);
        const ephemeral = object(result.thread).ephemeral === true || (method === "thread/fork" && params.experimentalPredictionMode === true) || (method !== "thread/resume" && params.ephemeral === true);
        if (ephemeral) this.ephemeralThreads.add(id);
        if (method !== "thread/resume" || !loaded) engine.compaction?.remember(id, params);
        // A new gateway chat is in the registry before its reply reaches the client; a throwaway one, flagged here or by
        // the engine's own announcement, stays memory-only.
        if (!this.ephemeralThreads.has(id) && method !== "thread/resume") await this.identity.record(id, method === "thread/start" ? "start" : "fork");
        // A new chat must carry the provider it was asked for; any other answer comes from an executor that ignored the request.
        if (creating && typeof params.modelProvider === "string" && result.modelProvider !== params.modelProvider) {
          throw new Error("The gateway executor did not record this chat with the requested provider; start a new chat");
        }
        if (!this.ephemeralThreads.has(id)) this.loads.remember(id, params);
      }
      if (["thread/unsubscribe", "thread/delete", "thread/archive"].includes(method) && typeof params.threadId === "string") {
        engine.threads.delete(params.threadId); this.bindings.delete(params.threadId); this.ephemeralThreads.delete(params.threadId); engine.compaction?.forget(params.threadId);
        this.loads.forget(params.threadId);
      }
      return result;
    } finally { engine.requests--; if (creating) engine.creating!--; }
  }
  /** Why the session ends travels to every owned engine; a plain call stays "session_end" for the adapter's own shutdown. */
  async stop(reason: EngineStopReason = "session_end"): Promise<void> {
    this.closing = true; this.stopped.abort(); this.finishNativeClosing(); stopConnection(this.native, reason);
    await this.nativeStatus?.stop();
    await this.chatList.stop();
    this.nativeHost?.client.close();
    const poolClosing = this.poolPending?.then(client => client?.close()).catch(() => {});
    await Promise.allSettled(this.engines.map(engine => engine.compaction?.close()));
    for (const engine of this.engines) stopConnection(engine.connection, reason);
    await this.creating;
    await Promise.allSettled([this.native.exited, ...this.engines.map(engine => engine.connection.exited)]);
    await Promise.allSettled(this.engines.map(engine => engine.exitPending));
    await this.nativeExitPending; await this.leaseReleased;
    // A release that failed when the engine exited (a busy lock, say) gets one more try; a finished one returns at once.
    if (this.leaseReleased) await this.nativeLease?.release().catch(() => {});
    // Dropping control connections releases leases and rejects stuck host RPCs;
    // the SDK retains loaded-chat ownership throughout client shutdown.
    await poolClosing;
  }
}
