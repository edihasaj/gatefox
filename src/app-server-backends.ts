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
import { sameSocketIdentity, socketIdentity, type SocketIdentity } from "./execution-host-storage.js";
import { CallbackHistoryFull, CallbackLedger, CallbackReplayed, PROTECTED_CALLBACKS } from "./callback-state.js";
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
import { parentOf } from "./gateway-chat-classifier.js";
import { executorOverrides, executorServesProvider, nativeEnvironment, newChatProvider } from "./executor-identity.js";
import { ChatLoads, Reattacher, ReattachError, isHostFailure, markHostFailure } from "./executor-reattach.js";
import { AppServerChatList, type ChatListDiscovery, type ChatListSource } from "./app-server-chat-list.js";
import { NativeRuntimeStatus } from "./native-runtime-status.js";
import { AdapterRuntimeMetadata, type RuntimeMetadataSource } from "./adapter-runtime-metadata.js";
import { requestedModel } from "./app-server-request-fields.js";
import { executableRunsCodeMode } from "./codex-native-rows.js";
import { replayCompletedDisplayItems } from "./executor-display-replay.js";

type RpcConnection = AppServerConnection | SocketAppServerConnection | NativeRpcConnection;
/**
 * `creating` counts this connection's thread/start and thread/fork requests the engine has not finished answering. `provider` is
 * the provider id the engine was launched to record new chats with, when this connection launched or acquired it.
 */
interface Engine { connection: RpcConnection; revision: string; aliases: Set<string>; threads: Set<string>; active: Map<string, string>; requests: number; creating?: number; shared?: boolean; detaching?: boolean; compaction?: GatewayCompactionSession; exitPending?: Promise<void>; provider?: string; socket?: SocketIdentity }
/** A server request awaiting (or recently given) an answer. `replayable` marks a threaded callback (approval or dynamic tool call) a warm resume may replay. */
interface Approval { connection: RpcConnection; id: Id; fingerprint: string; replayable: boolean; socket?: SocketIdentity; threadId?: string }
interface CompactionSnapshot { models: Message[]; settings: Message; args: string[] }
type ActiveRecovery = "recovered" | "superseded" | "failed";

/** Socket clients of host-owned engines ignore the reason: only a process the adapter spawned can say why it stopped. */
function stopConnection(connection: RpcConnection, reason: EngineStopReason): void {
  if (connection instanceof AppServerConnection) connection.stop(reason); else connection.stop();
}
/**
 * How long a lost host control connection still waits for frames the engine had already sent to reach the desktop app before
 * teardown stops waiting. It is only reached when the app has stopped reading: an engine socket that closes normally drains in
 * milliseconds, so this bounds the wedged case rather than delaying the normal one.
 */
const hostControlDrainMs = 250;

/** A stable native connection plus gateway generations pinned to loaded chats. */
export class AppServerBackends {
  readonly native: NativeRpcConnection;
  private readonly engines: Engine[] = [];
  private readonly bindings = new Map<string, Engine>();
  private readonly approvals = new Map<string, Approval>();
  /** A response can leave before the socket discovers it died; retain enough to expose the same approval on replay. Replayable approvals only. */
  private readonly uncertainApprovals = new Map<string, Approval>();
  /** Each connection's server-request ids: pending ones, bounded answered fingerprints and exact completed ids. */
  private readonly ledgers = new Map<RpcConnection, CallbackLedger>();
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
  /** Completed display items already delivered to this desktop connection. */
  private readonly completedItems = new BoundedIdSet(8192);
  /** Terminal turns forwarded to this desktop connection, keyed by chat and turn. */
  private readonly completedTurns = new BoundedIdSet(4096);
  /** One automatic recovery per turn/socket loss; a second loss reports normally instead of retrying in a loop. */
  private readonly recoveringTurns = new BoundedIdSet(4096);
  private readonly nativeTurns = new NativeTurnTracker();
  private nativeExitPending?: Promise<void>;
  private leaseReleased?: Promise<void>;
  private finishNativeClosing!: () => void;
  private readonly nativeClosing = new Promise<void>(resolve => { this.finishNativeClosing = resolve; });
  /** Resolved once a lost host control connection has had its bounded drain, so teardown cannot wedge on frontend output. */
  private finishHostControlDrain!: () => void;
  private hostControlDrained = false;
  private readonly hostControlDrain = new Promise<void>(resolve => { this.finishHostControlDrain = () => { this.hostControlDrained = true; resolve(); }; });
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
      const shared = backend; const control = client!;
      shared.nativeHost = { client: control, record }; shared.sharedGateway = plan.sharedExecutors === true;
      // The host drops this connection's leases and its record of our native ownership when the control socket closes, and the
      // engine may keep running without us. Nothing else watches that socket, so its close ends the session here.
      void control.exited.then(() => shared.hostControlLost()).catch(() => {});
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
    const exited = (connection?: RpcConnection) => this.observeEngineExit(connection);
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
    // A lost host control connection bounds this wait and the deliveries below through `hostControlDrain` (see
    // `hostControlLost`), never by resolving `nativeClosing`: that promise also short-circuits the death check.
    await Promise.race([this.native.drained, this.nativeClosing, this.hostControlDrain]);
    // Exactly one record per process, counting the turns that survived its last forwarded frames.
    this.reportEngineExit(connection ?? this.native, this.nativeTurns.active.size);
    this.nativeTurns.close();
    this.forgetConnection(this.native);
    const active = [...this.nativeTurns.active]; this.nativeTurns.clear();
    if (this.closing) return;
    // Socket loss does not prove SDK death. Only the matching host-owned SDK's
    // observed death of this exact SDK launch permits failure of observed turns.
    // The drain bound is deliberately absent from this race: a real death must still be confirmed and reported whenever the
    // app is reading. If the control socket closes during the check, that check ends on its own (a dead connection cannot
    // answer), and the deliveries below are then bounded by the timer `hostControlLost` arms.
    if (this.native.shared) {
      const confirmed = await Promise.race([this.nativeHost?.client.confirmedNativeDeath(this.nativeHost.record), this.nativeClosing.then(() => false)]);
      if (this.closing || !confirmed) return;
    }
    const error = { message: "The Codex engine stopped while this turn was running (the app may have restarted it). The chat's history is saved; send a message to continue, or reconnect this chat's computer if it stays unavailable.", codexErrorInfo: "internalServerError", additionalDetails: null };
    for (const [threadId, turn] of active) {
      if (this.closing) break;
      // Each frame is started before it is awaited, so a bound that has already fired still cannot swallow the report of a
      // confirmed death: the write goes out whenever the app reads again. The bound ends the loop rather than parking on it,
      // because a wedged frontend must not make every remaining turn wait behind it; the reconnecting app finds these chats
      // through their saved history.
      try { await Promise.race([this.emit({ method: "error", params: { threadId, turnId: turn.id, error, willRetry: false } }).catch(() => {}), this.nativeClosing, this.hostControlDrain]); } catch { /* The client may already be gone. */ }
      if (this.closing || this.hostControlDrained) break;
      try { await Promise.race([this.emit({ method: "turn/completed", params: { threadId, turn: { ...turn, items: [], itemsView: "notLoaded", status: "failed", error,
        completedAt: null, durationMs: null } } }).catch(() => {}), this.nativeClosing, this.hostControlDrain]); } catch { /* Shutdown still follows the attempted terminal delivery. */ }
      if (this.closing || this.hostControlDrained) break;
    }
  }
  /**
   * One loss of an engine connection, whatever its source: release the private native home, then end the session once the
   * exit is recorded. `connection` is the transport that reported it, when one knows.
   */
  private observeEngineExit(connection?: RpcConnection): void {
    this.leaseReleased = this.nativeLease?.release().catch(() => {}); // The engine is gone, so the native home is free again.
    this.nativeExitPending = this.nativeExited(connection).finally(() => { this.onNativeExit(); });
  }
  /**
   * The execution host closed this session's control connection while its own process kept running. That connection is what
   * the host keys our native ownership and generation leases to, so the session cannot continue: it ends exactly the way a
   * native engine exit ends, so the app reconnects and the new session discovers and acquires a fresh client. Turns already
   * running in the host-owned engine are not reported failed for this, because a lost control socket, like a lost engine
   * socket, is not proof that the SDK died (see `nativeExited`).
   */
  private hostControlLost(): void {
    if (this.closing || this.nativeHost?.client.closedByAdapter) return;
    telemetry("execution_host_control_lost", { sharedGateway: this.sharedGateway === true });
    // Closing the engine socket takes the existing exit path, which drains what the engine already sent before the session ends.
    if (!this.native.closed) stopConnection(this.native, "session_end");
    // Waiting for the engine's own frames is only half of that path: the exit also parks on the desktop app when the app has
    // stopped reading, whether it is a forwarded notification or the report of a confirmed engine death, and a session that
    // never ends is the failure this method exists to prevent. So every one of those waits is bounded. Resolving `nativeClosing`
    // here (what a deliberate stop does) was rejected on purpose: that promise also ends the `confirmedNativeDeath` check, so
    // cutting it short could lose a genuine death confirmation on an exit that has nothing to do with this connection. A frame
    // already handed to the writer is not cancelled by the grace, only deferred; one the loop never reaches is dropped, and the
    // reconnecting app finds those chats through their saved history. The session ending late is the worse failure, because
    // every chat on this machine waits behind it. The timer is armed whether or not this adapter had to close the engine socket
    // itself: when the socket died first, its exit path is the one that needs bounding.
    setTimeout(() => this.finishHostControlDrain(), hostControlDrainMs).unref();
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
  private forgetConnection(connection: RpcConnection, preserveApprovals = false): void {
    for (const [id, approval] of this.approvals) if (approval.connection === connection && !preserveApprovals) this.approvals.delete(id);
    for (const [id, approval] of this.uncertainApprovals) if (approval.connection === connection) {
      // A reply queued on a socket that just died is not proof the SDK received
      // it. Let a warm resume expose that approval again instead of hiding it.
      if (preserveApprovals) this.approvals.set(id, approval); else this.uncertainApprovals.delete(id);
    }
    this.ledgers.delete(connection);
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
      if (message.method === "turn/completed" && threadId && typeof object(params.turn).id === "string" && !isId(message.id)) {
        const key = `${threadId}\0${String(object(params.turn).id)}`;
        if (this.completedTurns.has(key)) return;
        if (this.recoveringTurns.has(key)) {
          await replayCompletedDisplayItems(
            (method, input) => engine.connection.request(method, input, 10_000), notice => this.emit(notice, "gateway"),
            () => !this.closing && this.bindings.get(threadId) === engine, threadId, String(object(params.turn).id), this.completedItems,
          );
          if (this.completedTurns.has(key) || this.closing || this.bindings.get(threadId) !== engine) return;
        }
        this.completedTurns.add(key); this.recoveringTurns.delete(key);
        // A resolved notification can be lost with the old socket. Once this
        // turn is terminal, no retained closed-socket callback can still be
        // legitimately replayed, so release its bounded recovery state.
        for (const [id, approval] of this.approvals) if (approval.threadId === threadId && approval.connection.closed) this.approvals.delete(id);
        // A terminal turn can no longer have a callback replayed, whatever its socket, so its answered entries are released too.
        for (const [id, approval] of this.uncertainApprovals) if (approval.threadId === threadId) this.uncertainApprovals.delete(id);
      }
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
      if (message.method === "item/completed" && threadId && typeof params.turnId === "string" && typeof object(params.item).id === "string") {
        this.completedItems.add(`${threadId}\0${params.turnId}\0${String(object(params.item).id)}`);
      }
      // Executor account discovery is not the desktop's primary account state.
      if (!isId(message.id) && !threadId && message.method !== "serverRequest/resolved") return;
    }
    if (isId(message.id)) {
      let ledger = this.ledgers.get(connection); if (!ledger) { ledger = new CallbackLedger(); this.ledgers.set(connection, ledger); }
      const fingerprint = createHash("sha256").update(canonicalJson(message)).digest("hex");
      const known = ledger.pendingId(message.id);
      if (known !== undefined) {
        if (this.approvals.get(known)?.fingerprint !== fingerprint) throw new Error("Inconsistent pending Codex server request replay");
        await this.emit({ ...message, id: known }); return;
      }
      const answered = ledger.answered(message.id);
      if (answered) {
        if (answered.fingerprint !== fingerprint) throw new Error("Inconsistent pending Codex server request replay");
        // SDK resume can snapshot a callback just before its answer is applied. Its answer is already on the way: show nothing.
        return;
      }
      // A finished callback whose fingerprint has aged out is refused, not run again: no prompt and no tool call.
      if (ledger.completed(message.id)) throw new CallbackReplayed();
      // A same-generation warm resume can replay an approval on a fresh socket
      // before its resume RPC resolves. Retain the desktop id rather than asking
      // the user twice; a different generation never reaches this branch with a
      // closed predecessor because normal reattach drops its old callbacks.
      const replay = [...this.approvals.entries()].find(([, approval]) => approval.connection.closed && approval.fingerprint === fingerprint
        && approval.socket && engine?.socket && sameSocketIdentity(approval.socket, engine.socket));
      if (replay && engine?.shared) {
        const [id, approval] = replay;
        const uncertain = this.uncertainApprovals.has(id);
        approval.connection = connection; approval.id = message.id; ledger.track(message.id, id);
        // A normal pending prompt remains visible in the desktop, so a warm
        // replay only restores the callback routing. An answer that may have
        // been lost with the old socket has no pending UI any more: show the
        // SDK's genuine replay under the original desktop request id.
        if (uncertain) await this.emit({ ...message, id });
        return;
      }
      // Only unanswered callbacks count here; answered ones live in the ledger's own bounded history.
      if (this.approvals.size >= 256) throw new Error("Invalid or excessive pending Codex server requests");
      ledger.admit(message.id);
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const replayable = Boolean(engine?.socket && threadId);
      // Replayable callbacks (threaded approvals and dynamic tool calls) keep a protected slot until their turn ends, because an
      // answer lost with its socket must come back under its own desktop id. When every slot is taken the new callback is refused;
      // pushing an old one out could let its replay run twice.
      if (replayable && this.protectedCallbacks() >= PROTECTED_CALLBACKS) throw new CallbackHistoryFull();
      const id = `gateway-server-${++this.serverSequence}`;
      ledger.track(message.id, id);
      this.approvals.set(id, { connection, id: message.id, fingerprint, replayable,
        ...(engine?.socket ? { socket: engine.socket } : {}), ...(threadId ? { threadId } : {}) });
      await this.emit({ ...message, id });
    } else if (message.method === "serverRequest/resolved") {
      const original = params.requestId; const ledger = this.ledgers.get(connection);
      const pendingId = isId(original) ? ledger?.pendingId(original) : undefined;
      let id = isId(original) ? ledger?.resolve(original, pendingId !== undefined ? this.approvals.get(pendingId)?.fingerprint ?? "" : "") : undefined;
      // A protected answered callback outlives the ledger's bounded fingerprints; its slot is retired here, once, by connection and id.
      if (!id && isId(original)) for (const [key, approval] of this.uncertainApprovals) if (approval.connection === connection && approval.id === original) { id = key; break; }
      if (id) { this.approvals.delete(id); this.uncertainApprovals.delete(id); await this.emit({ ...message, params: { ...params, requestId: id } }); }
    // The engine's kind travels with its notification, so the router never has to read a provider id to place it.
    } else await this.emit(message, engine ? "gateway" : connection === this.native ? "native" : undefined);
  }
  /** Threaded callbacks that are unanswered or answered-but-unconfirmed: each holds one protected slot until its turn ends or it resolves. */
  private protectedCallbacks(): number {
    let count = this.uncertainApprovals.size;
    for (const [id, approval] of this.approvals) if (approval.replayable && !this.uncertainApprovals.has(id)) count++;
    return count;
  }
  reply(message: Message): boolean {
    if (typeof message.id !== "string") return false;
    const approval = this.approvals.get(message.id); if (!approval || approval.connection.closed) return false;
    this.approvals.delete(message.id); this.uncertainApprovals.delete(message.id);
    this.ledgers.get(approval.connection)?.complete(approval.id, message.id, approval.fingerprint);
    // An answer that dies with its socket must be routed again on a warm resume, under the same desktop id, never as a new callback.
    // Admission reserved this slot (see protectedCallbacks), so nothing is ever pushed out to make room for it.
    if (approval.replayable) this.uncertainApprovals.set(message.id, approval);
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
      if (this.nativeHost.client.closed) throw Object.assign(new Error("Shared executor host connection was lost; this chat's computer connection is reconnecting"), { code: -32001 });
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
      const socket = await socketIdentity(record.socketPath);
      const engine: Engine = { connection: undefined!, revision: record.revision, aliases: new Set(record.aliases), threads: new Set(), active: new Map(), requests: 1, shared: true, ...(socket ? { socket } : {}), ...(provider ? { provider } : {}) };
      const connection: SocketAppServerConnection = new SocketAppServerConnection(record.socketPath, message => this.forward(connection, message), () => {
        engine.exitPending = (async () => {
          await Promise.race([connection.drained, this.nativeClosing]);
          const active = [...engine.active];
          const recoverable = !this.closing && !engine.detaching && !this.native.shared;
          await engine.compaction?.close(); this.forgetConnection(connection, !engine.detaching && !this.closing && !this.native.shared);
          // A shared socket is a client transport, not the executor. Rejoin every
          // known turn before telling the desktop it was lost; reattach never
          // repeats a turn or a tool result.
          if (recoverable) for (const [threadId, turnId] of active) {
            let failed = false;
            if (!this.ephemeralThreads.has(threadId)) {
              const outcome = await this.recoverActiveTurn(threadId, turnId, engine);
              if (outcome !== "failed") continue;
              failed = true;
            }
            // An unsubscribe, archive or a newer binding may have won while the
            // recovery was waiting. Its old turn must not surface as an error.
            if (this.closing || (!failed && this.bindings.get(threadId) !== engine) || this.completedTurns.has(`${threadId}\0${turnId}`)) continue;
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
  /**
   * The existing executor that owns a child's immediate parent. A V2 child can only
   * resume through the loaded parent's SDK runtime, so selecting the current
   * generation merely because the child itself is unloaded sends the request to the
   * wrong owner. This looks only one parent deep and never loads or resumes it.
   */
  private async parentOwner(thread: unknown): Promise<{ engine: Engine; reserved: boolean } | undefined> {
    const parentId = parentOf(threadFacts(thread) ?? {});
    if (!parentId) return undefined;
    const bound = this.bindings.get(parentId);
    if (bound && !bound.connection.closed) return { engine: bound, reserved: false };
    const owner = await this.owner(parentId);
    if (!owner) return undefined;
    if (owner.connection.closed) { owner.requests--; return undefined; }
    return { engine: owner, reserved: true };
  }
  private async gateway(): Promise<Engine> {
    if (this.closing) throw new Error("Codex desktop connection is closing");
    if (!this.catalog.current().models.length) await this.catalog.refresh(true);
    // Capture the request's catalog before awaiting the runtime. A concurrent start may refresh its own catalog while the
    // first lookup waits, but it must not change the first generation's observed model rows.
    const observed = this.catalog.current();
    const runtime = await this.resolveRuntime();
    // An adapter can outlive its original package. The selected runtime, rather than the adapter's module path, decides whether
    // this generation may advertise Code Mode: a gateway SDK only through its verified receipt, the desktop's Codex by its host.
    const snapshot = (this.catalog as DesktopCatalog & { snapshotForExecutor?: (value: typeof observed, codeMode: boolean) => typeof observed })
      .snapshotForExecutor?.(observed, runtime ? runtime.codeModeHost : executableRunsCodeMode(this.executable)) ?? observed;
    const priority = offersPriority(snapshot.models);
    const provider = this.newChatProvider(runtime);
    // The identity is fixed for the connection. A later verified SDK can still serve a legacy connection, but an openai
    // connection never falls through to a stock executor that could send its saved history to OpenAI.
    if (!executorServesProvider(provider, runtime)) throw Object.assign(new Error("The gateway executor changed while this desktop connection was open; reconnect to continue gateway chats"), { code: -32001 });
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
  private async reattach(threadId: string, closed: Engine, beforeResume?: (target: Engine) => void): Promise<void> {
    // Synchronous state only, and the flight check that follows is synchronous too: awaiting a host lookup here would let
    // a request that arrives mid-lookup miss the running flight and report a reason the host lookup has already changed.
    const host = this.nativeHost?.client ?? this.poolClient;
    const reason = closed.shared && host && !host.closed ? "generation_retired" : "engine_closed";
    await this.reattacher.join(threadId, reason, async () => {
      // Only a failed host lookup (finding the host, or asking it) is "host_unavailable" and arms the fail-fast window; a
      // gateway() that refused for its own reasons (catalog, generation limit, a changed provider) is the chat's own failure.
      let target: Engine;
      try { target = await this.owner(threadId).catch(markHostFailure) ?? await this.gateway(); target.requests--; beforeResume?.(target); }
      catch (error) { throw isReleaseSkew(error) ? error : new ReattachError(isHostFailure(error) ? "host_unavailable" : "resume_failed"); }
      try { await this.request("thread/resume", this.loads.resumeParams(threadId)); }
      catch { throw new ReattachError("resume_failed"); }
    });
  }
  /**
   * Rejoin a live shared executor after only this adapter's socket closed. The
   * desktop has not sent another request yet, so the turn state is read from the
   * owner before we decide whether it can remain active. A missing, changed or
   * unreadable turn is deliberately not guessed at.
   */
  private async recoverActiveTurn(threadId: string, turnId: string, closed: Engine): Promise<ActiveRecovery> {
    const key = `${threadId}\0${turnId}`;
    if (this.closing || this.ephemeralThreads.has(threadId) || this.bindings.get(threadId) !== closed) return "superseded";
    // A second loss of the same turn must not begin a retry storm, but it still
    // needs the normal reconnect error instead of silently clearing the turn.
    if (this.recoveringTurns.has(key)) return "failed";
    this.recoveringTurns.add(key);
    let expected: Engine | undefined;
    const failedOrSuperseded = (): ActiveRecovery => {
      const current = this.bindings.get(threadId);
      if (this.closing || !current) return "superseded";
      if (expected && current !== expected) return "superseded";
      if (!expected && current !== closed) return "superseded";
      if (current.active.get(threadId) !== undefined && current.active.get(threadId) !== turnId) return "superseded";
      return "failed";
    };
    try {
      await this.reattach(threadId, closed, target => { expected = target; });
      const rebound = this.bindings.get(threadId);
      if (this.closing) return "superseded";
      // `join` can attach us to a foreground reattach that already owned the
      // flight, so it never invokes this attempt's beforeResume hook. Its live
      // binding is still the authoritative target; a distinct target after our
      // own hook is an independent supersession.
      if (!rebound || expected && rebound !== expected || rebound.connection.closed) return failedOrSuperseded();
      expected ??= rebound;
      const page = await rebound.connection.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" }, 10_000);
      const turn = Array.isArray(page.data) ? page.data.map(object).find(value => value.id === turnId) : undefined;
      if (this.completedTurns.has(key)) return "recovered"; // A live terminal frame won the race; it already reached the desktop.
      if (!turn) return failedOrSuperseded();
      if (this.bindings.get(threadId) !== rebound || rebound.connection.closed || this.closing) return failedOrSuperseded();
    // Paginated histories retain exact item-completion timestamps. Replaying
    // only completed display items repairs text delivered during the socket gap;
    // unsupported legacy histories simply keep the normal resumed stream.
      const replayed = await replayCompletedDisplayItems(
        (method, params) => rebound.connection.request(method, params, 10_000), message => this.emit(message, "gateway"),
        () => !this.closing && this.bindings.get(threadId) === rebound, threadId, turnId, this.completedItems,
      );
      if (turn.status === "inProgress") {
        if (this.completedTurns.has(key)) return "recovered";
        if (this.closing || this.bindings.get(threadId) !== rebound) return "superseded";
        if (rebound.connection.closed || rebound.active.get(threadId) !== undefined && rebound.active.get(threadId) !== turnId) return failedOrSuperseded();
        rebound.active.set(threadId, turnId); return "recovered";
      }
      if (!["completed", "failed", "interrupted"].includes(String(turn.status)) || !replayed) return failedOrSuperseded();
    // The saved SDK turn is authoritative. Forwarding it uses the same active
    // table as a live notification, so a raced terminal frame is emitted once.
      await this.forward(rebound.connection, { method: "turn/completed", params: { threadId, turn } });
      return "recovered";
    } catch { return this.completedTurns.has(key) ? "recovered" : failedOrSuperseded(); }
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
  /**
   * Gateway executors carry native catalog rows for sub-agents. A typed native model is
   * therefore valid only when this executor's saved child metadata proves it is that
   * child's current row; aliases and arbitrary native rows stay fail-closed.
   */
  private async ownsSavedNativeChild(engine: Engine, threadId: string, model: string): Promise<boolean> {
    if (!this.catalog.isNative(model)) return false;
    const result = await engine.connection.request("thread/read", { threadId, includeTurns: false }).catch(() => undefined);
    const thread = object(result?.thread);
    // A shared rollout store can answer another child's row. The returned id and
    // this adapter's actual gateway classification are both part of ownership;
    // a parent-shaped native row by itself is never sufficient.
    return thread.id === threadId && thread.model === model && hasParent(thread) && this.isGatewayThread(thread);
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
          // The host's saved-thread store now serves several parents. Require the
          // exact requested row and let the gateway classifier validate its ancestry
          // before either the parent owner or a fresh generation can receive it.
          const found = probe && object(probe.thread).id === params.threadId && await this.verdict(probe.thread, params.threadId, method);
          if (found && found.kind === "gateway") {
            await this.keep(probe!.thread, params.threadId, found.rule);
            // Owner-mediated V2 resumes must stay with the loaded immediate parent's
            // SDK. Prefer that generation over the adapter's current catalog generation.
            const parent = method === "thread/resume" ? await this.parentOwner(probe!.thread) : undefined;
            if (parent) { engine = parent.engine; reserved = parent.reserved; }
            else { engine = await this.gateway(); reserved = true; }
          }
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
      // The desktop SDK treats config.model as a model override too. Keep this
      // precedence aligned with the router before deciding whether a frozen
      // executor may serve a native child row.
      const model = requestedModel(params);
      const savedNativeChild = typeof params.threadId === "string" && typeof model === "string" && !engine.aliases.has(model)
        && await this.ownsSavedNativeChild(engine, params.threadId, model);
      if (typeof model === "string" && !engine.aliases.has(model) && !savedNativeChild) throw new Error("This loaded gateway chat uses an older catalog. Start a new chat to use a newly added model without interrupting it.");
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
