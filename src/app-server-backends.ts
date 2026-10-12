import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import { AppServerConnection, isId, object, type Id, type Message } from "./app-server-connection.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { gatewayEngineHome, gatewayEnvironment } from "./gateway-engine-home.js";
import { titleTool, withTitleTool, handleTitleCall } from "./chat-titles.js";
import { agentExecutorSettings, readAgentPolicy } from "./agent-profiles.js";
import { ExecutionHostClient } from "./execution-host-client.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import type { ExecutionRecord } from "./execution-host-engine.js";
import { canonicalJson } from "./execution-host-engine.js";
import { homedir } from "node:os";
import { normalizeCodexFeatureArgs, normalizeCodexFeatureConfig } from "./codex-feature-compat.js";
import { readPublicServiceTierMetadata } from "./model-service-tiers.js";
import { GatewayCompaction, type GatewayCompactionSession } from "./gateway-compaction.js";

type RpcConnection = AppServerConnection | SocketAppServerConnection;
interface Engine { connection: RpcConnection; revision: string; aliases: Set<string>; threads: Set<string>; active: Map<string, string>; requests: number; shared?: boolean; compaction?: GatewayCompactionSession }
interface CompactionSnapshot { models: Message[]; settings: Message; args: string[] }
interface NativeTurn { id: string; rootTurnId: string | null; startedAt: number | null }
const nativeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");

function offersPriority(models: Message[]): boolean {
  return models.some(model => readPublicServiceTierMetadata(model).serviceTiers?.some(tier => tier.id === "priority"));
}

function gatewayFeatureArgs(args: string[], priority: boolean): string[] {
  if (!priority) return args;
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    // SDK feature toggles are appended after -c overrides, regardless of their CLI position.
    if (["--enable", "--disable"].includes(arg) && args[index + 1] === "fast_mode") { index++; continue; }
    if (["--enable=fast_mode", "--disable=fast_mode"].includes(arg)) continue;
    result.push(arg);
  }
  return result;
}

/** A stable native connection plus bounded gateway generations pinned to loaded chats. */
export class AppServerBackends {
  readonly native: AppServerConnection;
  private readonly engines: Engine[] = [];
  private readonly bindings = new Map<string, Engine>();
  private readonly approvals = new Map<string, { connection: RpcConnection; id: Id }>();
  private readonly reverse = new Map<RpcConnection, Map<Id, string>>();
  private serverSequence = 0;
  private initialized?: Message;
  private closing = false;
  private creating: Promise<unknown> = Promise.resolve();
  private poolPending?: Promise<ExecutionHostClient | undefined>;
  private readonly compaction: GatewayCompaction;
  private readonly nativeActive = new Map<string, NativeTurn>();
  private readonly nativeCompleted = new Set<string>();
  private nativeExitPending?: Promise<void>;
  private finishNativeClosing!: () => void;
  private readonly nativeClosing = new Promise<void>(resolve => { this.finishNativeClosing = resolve; });
  constructor(private readonly executable: string, private readonly args: string[], private readonly config: GatewayConfig,
    private readonly settings: Message, private readonly overrides: Message, private readonly catalog: DesktopCatalog,
    private readonly emit: (message: Message) => Promise<void>, onNativeExit: () => void, private readonly configPath?: string) {
    this.args = normalizeCodexFeatureArgs(args, settings);
    this.settings = normalizeCodexFeatureConfig(settings);
    this.compaction = new GatewayCompaction(config.stateDirectory);
    // Register only the added provider at runtime. Native account/model defaults stay intact.
    const registration = Object.entries(overrides).map(([key, value]) => [`-c`, `model_providers.subscription_gateway.${key}=${JSON.stringify(value)}`]).flat();
    this.native = new AppServerConnection(executable, [...this.args, ...registration], message => this.forward(this.native, message), () => {
      this.nativeExitPending = this.nativeExited().finally(() => { onNativeExit(); });
    });
  }
  private observeNative(message: Message): void {
    if (this.closing || isId(message.id)) return;
    const params = object(message.params); const turn = object(params.turn);
    if (!nativeId(params.threadId) || !nativeId(turn.id)) return;
    const key = JSON.stringify([params.threadId, turn.id]);
    if (message.method === "turn/started" && turn.status === "inProgress") {
      if (this.nativeCompleted.has(key)) return;
      if (!this.nativeActive.has(params.threadId) && this.nativeActive.size >= 256) throw new Error("Too many active native Codex turns");
      this.nativeActive.set(params.threadId, { id: turn.id, rootTurnId: nativeId(turn.rootTurnId) ? turn.rootTurnId : null,
        startedAt: typeof turn.startedAt === "number" && Number.isFinite(turn.startedAt) ? turn.startedAt : null });
    }
    if (message.method === "turn/completed" && ["completed", "failed", "interrupted"].includes(String(turn.status))) {
      if (this.nativeActive.get(params.threadId)?.id === turn.id) this.nativeActive.delete(params.threadId);
      this.nativeCompleted.add(key);
      if (this.nativeCompleted.size > 512) this.nativeCompleted.delete(this.nativeCompleted.values().next().value!);
    }
  }
  private async nativeExited(): Promise<void> {
    // Drain before deciding which tasks lost their terminal event. Pending SDK
    // RPCs are already rejected at child close, so forwarding can finish.
    await Promise.race([this.native.drained, this.nativeClosing]);
    for (const [id, approval] of this.approvals) if (approval.connection === this.native) this.approvals.delete(id);
    this.reverse.delete(this.native);
    const active = [...this.nativeActive]; this.nativeActive.clear(); this.nativeCompleted.clear();
    if (this.closing) return;
    const error = { message: "Native Codex executor exited while this turn was running. Reconnect this chat's computer connection to continue from its saved history.", codexErrorInfo: "internalServerError", additionalDetails: null };
    for (const [threadId, turn] of active) {
      if (this.closing) break;
      try { await Promise.race([this.emit({ method: "error", params: { threadId, turnId: turn.id, error, willRetry: false } }), this.nativeClosing]); } catch { /* The client may already be gone. */ }
      if (this.closing) break;
      try { await Promise.race([this.emit({ method: "turn/completed", params: { threadId, turn: { ...turn, items: [], itemsView: "notLoaded", status: "failed", error,
        completedAt: null, durationMs: null } } }), this.nativeClosing]); } catch { /* Shutdown still follows the attempted terminal delivery. */ }
    }
  }
  private async forward(connection: RpcConnection, message: Message): Promise<void> {
    if (connection === this.native) this.observeNative(message);
    const params = object(message.params); const engine = this.engines.find(value => value.connection === connection);
    if (engine) {
      engine.compaction?.observe(message);
      await this.compaction.observe(message);
      const thread = object(params.thread); const threadId = typeof params.threadId === "string" ? params.threadId : typeof thread.id === "string" ? thread.id : undefined;
      if (message.method === "thread/started" && threadId) { engine.threads.add(threadId); this.bindings.set(threadId, engine); }
      if (message.method === "thread/closed" && threadId) { engine.threads.delete(threadId); if (this.bindings.get(threadId) === engine) this.bindings.delete(threadId); }
      if (message.method === "turn/started" && threadId && typeof object(params.turn).id === "string") engine.active.set(threadId, String(object(params.turn).id));
      if (message.method === "turn/completed" && threadId && engine.active.get(threadId) === object(params.turn).id) engine.active.delete(threadId);
      // Executor account discovery is not the desktop's primary account state.
      if (!isId(message.id) && !threadId && message.method !== "serverRequest/resolved") return;
    }
    if (isId(message.id)) {
      if (engine && message.method === "item/tool/call" && params.tool === titleTool && params.namespace == null) {
        const bound = typeof params.threadId === "string" && engine.threads.has(params.threadId);
        // Keep draining this connection while its title RPC waits for a reply.
        const operation = bound ? handleTitleCall(params, (method, args) => connection.request(method, args))
          : Promise.reject(new Error("Chat title request belongs to another chat"));
        void operation.catch(() => ({ success: false, contentItems: [{ type: "inputText", text: "The current chat title could not be read or updated." }] }))
          .then(result => connection.send({ id: message.id, result })); return;
      }
      let ids = this.reverse.get(connection); if (!ids) { ids = new Map(); this.reverse.set(connection, ids); }
      if (this.approvals.size >= 256 || ids.has(message.id)) throw new Error("Invalid or excessive pending Codex server requests");
      const id = `gateway-server-${++this.serverSequence}`;
      ids.set(message.id, id); this.approvals.set(id, { connection, id: message.id }); await this.emit({ ...message, id });
    } else if (message.method === "serverRequest/resolved") {
      const original = params.requestId; const ids = this.reverse.get(connection); const id = isId(original) ? ids?.get(original) : undefined;
      if (id) { ids!.delete(original as Id); this.approvals.delete(id); await this.emit({ ...message, params: { ...params, requestId: id } }); }
    } else await this.emit(message);
  }
  reply(message: Message): boolean {
    if (typeof message.id !== "string") return false;
    const approval = this.approvals.get(message.id); if (!approval || approval.connection.closed) return false;
    this.approvals.delete(message.id); approval.connection.send({ ...message, id: approval.id }); return true;
  }
  notify(message: Message): void { this.native.send(message); }
  private async pool(): Promise<ExecutionHostClient | undefined> {
    if (!this.configPath) return;
    if (this.poolPending) {
      const existing = await this.poolPending.catch(() => undefined);
      if (existing && !existing.closed) return existing;
      this.poolPending = undefined;
    }
    const pending = ExecutionHostClient.discover(this.configPath, resolve(process.env.CODEX_HOME || homedir() + "/.codex"), this.executable);
    this.poolPending = pending;
    const client = await pending;
    if (!client && this.poolPending === pending) this.poolPending = undefined;
    return client;
  }
  private async releaseIdleShared(keepRevision: string): Promise<void> {
    const operation = this.creating.then(async () => {
      for (let index = this.engines.length - 1; index >= 0; index--) {
        const old = this.engines[index];
        if (!old.shared || old.revision === keepRevision || old.requests || old.threads.size || old.active.size) continue;
        old.connection.stop(); await old.connection.exited; this.engines.splice(index, 1);
        await (await this.pool())?.release(old.revision);
      }
    });
    this.creating = operation.catch(() => undefined); await operation;
  }
  private async shared(record: ExecutionRecord, snapshot?: CompactionSnapshot): Promise<Engine> {
    const ready = this.engines.find(engine => engine.shared && engine.revision === record.revision && !engine.connection.closed);
    if (ready) { ready.requests++; return ready; }
    const operation = this.creating.then(async () => {
      if (this.closing || !this.initialized) throw new Error("Initialize an open adapter before attaching a gateway executor");
      const existing = this.engines.find(engine => engine.shared && engine.revision === record.revision && !engine.connection.closed);
      if (existing) { existing.requests++; return existing; }
      for (let index = this.engines.length - 1; index >= 0; index--) {
        const old = this.engines[index];
        if (old.connection.closed || (!old.requests && !old.threads.size && !old.active.size)) {
          old.connection.stop(); await old.connection.exited; this.engines.splice(index, 1);
          if (old.shared && old.revision !== record.revision) await (await this.pool())?.release(old.revision);
        }
      }
      const engine: Engine = { connection: undefined!, revision: record.revision, aliases: new Set(record.aliases), threads: new Set(), active: new Map(), requests: 1, shared: true };
      const connection: SocketAppServerConnection = new SocketAppServerConnection(record.socketPath, message => this.forward(connection, message), () => {
        void engine.compaction?.close();
        for (const [id, approval] of this.approvals) if (approval.connection === connection) this.approvals.delete(id);
        this.reverse.delete(connection);
        if (!this.closing) for (const [threadId, id] of engine.active) void this.emit({ method: "turn/completed", params: { threadId, turn: { id, items: [], status: "failed", error: { message: "Gateway executor connection closed. Resume this chat to reconnect to its saved or running session.", codexErrorInfo: "internalServerError", additionalDetails: null } } } });
        engine.active.clear();
      });
      engine.connection = connection;
      engine.compaction = this.compaction.session({ models: snapshot?.models || [], settings: snapshot?.settings || {}, args: snapshot?.args || [], aliases: engine.aliases,
        shared: true, isActive: id => engine.active.has(id), request: (method, params) => connection.request(method, params) });
      this.engines.push(engine);
      try {
        await connection.request("initialize", { ...this.initialized, capabilities: { ...object(this.initialized.capabilities), experimentalApi: true } });
        connection.send({ method: "initialized", params: {} }); return engine;
      } catch (error) { connection.stop(); throw error; }
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
    const revision = createHash("sha256").update(snapshot.revision + JSON.stringify(await readAgentPolicy(this.config.stateDirectory) || null)).digest("hex");
    const pool = await this.pool();
    if (pool) {
      if (!this.initialized) throw new Error("Initialize the desktop connection before starting a gateway chat");
      const latest = object((await this.native.request("config/read", {})).config);
      const agents = await agentExecutorSettings(this.config, { ...this.settings, ...(latest.agents ? { agents: latest.agents } : {}) });
      const omitted = new Set(["desktop", "model", "model_provider", "model_catalog_json", "model_reasoning_effort", "model_reasoning_summary", "service_tier", "model_providers", "openai_api_key", "forced_login_method", "forced_chatgpt_workspace_id"]);
      const settings = normalizeCodexFeatureConfig(Object.fromEntries(Object.entries(agents.settings).filter(([key, value]) => !omitted.has(key) && value !== undefined && value !== null)));
      const forwarded: string[] = [];
      for (let index = 0; index < this.args.length; index++) {
        if (["-p", "--profile", "--listen"].includes(this.args[index])) { index++; continue; }
        if (!this.args[index].startsWith("--profile=") && !this.args[index].startsWith("--listen=") && this.args[index] !== "--stdio") forwarded.push(this.args[index]);
      }
      const overrides = { model: snapshot.models[0].slug, model_provider: "subscription_gateway", "features.step_model_switching": true, ...(priority ? { "features.fast_mode": true } : {}),
        ...Object.fromEntries(Object.entries(this.overrides).map(([key, value]) => [`model_providers.subscription_gateway.${key}`, value])) };
      const args = normalizeCodexFeatureArgs([...gatewayFeatureArgs(forwarded, priority), ...Object.entries(overrides).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])], settings);
      const combined = this.catalog.combined(snapshot);
      const sharedRevision = createHash("sha256").update(canonicalJson({ catalog: combined, settings, args, agentsDirectory: agents.directory || null })).digest("hex");
      await this.releaseIdleShared(sharedRevision);
      const record = await pool.acquire({ revision: sharedRevision, args, settings, catalog: combined, aliases: snapshot.models.map(model => String(model.slug)), agentsDirectory: agents.directory });
      return this.shared(record, { models: combined.models, settings, args });
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
        if (old.connection.closed || (!old.requests && !old.threads.size && !old.active.size)) { old.connection.stop(); await old.connection.exited; this.engines.splice(index, 1); }
      }
      if (this.engines.filter(engine => !engine.connection.closed).length >= 4) throw new Error("Four gateway catalog versions still have loaded chats. Close an older gateway chat before selecting a newly added model; native chats remain available.");
      if (!this.initialized) throw new Error("Initialize the desktop connection before starting a gateway chat");
      const latest = object((await this.native.request("config/read", {})).config);
      const settings = { ...this.settings, ...(latest.agents ? { agents: latest.agents } : {}) };
      const agents = await agentExecutorSettings(this.config, settings);
      const home = await gatewayEngineHome(resolve(this.config.stateDirectory, "desktop-generations", revision), agents.settings, agents.directory);
      const path = resolve(this.config.stateDirectory, `desktop-catalog-${snapshot.revision}.json`);
      await writePrivateJson(path, this.catalog.combined(snapshot));
      const forwarded: string[] = [];
      for (let index = 0; index < this.args.length; index++) {
        if (["-p", "--profile"].includes(this.args[index])) { index++; continue; }
        if (!this.args[index].startsWith("--profile=")) forwarded.push(this.args[index]);
      }
      const overrides = { model: snapshot.models[0].slug, model_provider: "subscription_gateway", model_catalog_json: path,
        "features.step_model_switching": true, ...(priority ? { "features.fast_mode": true } : {}),
        ...Object.fromEntries(Object.entries(this.overrides).map(([key, value]) => [`model_providers.subscription_gateway.${key}`, value])) };
      const args = [...gatewayFeatureArgs(forwarded, priority), ...Object.entries(overrides).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])];
      if (this.closing) throw new Error("Codex desktop connection is closing");
      const engine: Engine = { connection: undefined!, revision, aliases: new Set(snapshot.models.map(model => String(model.slug))), threads: new Set(), active: new Map(), requests: 1 };
      engine.connection = new AppServerConnection(this.executable, args, message => this.forward(engine.connection, message), () => {
        void engine.compaction?.close();
        for (const [id, approval] of this.approvals) if (approval.connection === engine.connection) this.approvals.delete(id);
        this.reverse.delete(engine.connection);
        if (!this.closing) for (const [threadId, id] of engine.active) void this.emit({ method: "turn/completed", params: { threadId, turn: { id, items: [], status: "failed", error: { message: "Gateway executor exited. Resume this chat to recover its saved history.", codexErrorInfo: "internalServerError", additionalDetails: null } } } });
        engine.active.clear();
      }, gatewayEnvironment(home));
      engine.compaction = this.compaction.session({ models: snapshot.models, settings: agents.settings, args, aliases: engine.aliases,
        isActive: id => engine.active.has(id), request: (method, params) => engine.connection.request(method, params) });
      this.engines.push(engine);
      try { await engine.connection.request("initialize", { ...this.initialized, capabilities: { ...object(this.initialized.capabilities), experimentalApi: true } }); engine.connection.send({ method: "initialized", params: {} }); }
      catch (error) { engine.connection.stop(); throw error; }
      return engine;
    });
    this.creating = operation.catch(() => undefined); return operation;
  }
  async request(method: string, params: Message): Promise<Message> {
    if (method === "initialize") {
      const result = await this.native.request(method, params); this.initialized = params; return result;
    }
    // Saved metadata is shared locally and needs no inference connection or model discovery.
    if (method === "thread/read" && typeof params.threadId === "string" && !this.bindings.has(params.threadId)) {
      try { return await this.native.request(method, params); }
      catch (error) {
        // A newly loaded SDK chat may have no rollout file until its first turn.
        const owner = await this.owner(params.threadId); if (!owner) throw error;
        try { return await owner.connection.request(method, params); }
        finally { owner.requests--; }
      }
    }
    let engine: Engine | undefined; let reserved = false;
    if (method === "thread/start" && params.modelProvider === "subscription_gateway") { engine = await this.gateway(); reserved = true; }
    else if (typeof params.threadId === "string") {
      engine = this.bindings.get(params.threadId);
      if (!engine) {
        engine = await this.owner(params.threadId); reserved = !!engine;
        if (!engine) {
          const thread = object((await this.native.request("thread/read", { threadId: params.threadId, includeTurns: false })).thread);
          if (thread.modelProvider === "subscription_gateway") { engine = await this.gateway(); reserved = true; }
        }
      }
    }
    if (!engine) return this.native.request(method, params);
    if (engine.connection.closed) {
      if (reserved) engine.requests--;
      if (method !== "thread/resume") throw new Error("The gateway executor exited; resume this chat before continuing. Ephemeral chats must be started again.");
      engine = await this.owner(String(params.threadId)) || await this.gateway(); reserved = true;
    }
    if (!reserved) engine.requests++;
    try {
      const model = object(object(params.collaborationMode).settings).model ?? params.model;
      if (typeof model === "string" && !engine.aliases.has(model)) throw new Error("This loaded gateway chat uses an older catalog. Start a new chat to use a newly added model without interrupting it.");
      const compaction = await engine.compaction?.before(method, params);
      if (compaction?.intercepted) return compaction.result || {};
      const loaded = typeof params.threadId === "string" && engine.threads.has(params.threadId);
      const result = await engine.connection.request(method, method === "thread/start" ? withTitleTool(params) : params);
      await engine.compaction?.after(method, params);
      if (["thread/start", "thread/resume", "thread/fork"].includes(method) && typeof object(result.thread).id === "string") {
        const id = String(object(result.thread).id); engine.threads.add(id); this.bindings.set(id, engine);
        if (method !== "thread/resume" || !loaded) engine.compaction?.remember(id, params);
      }
      if (["thread/unsubscribe", "thread/delete", "thread/archive"].includes(method) && typeof params.threadId === "string") {
        engine.threads.delete(params.threadId); this.bindings.delete(params.threadId);
      }
      return result;
    } finally { engine.requests--; }
  }
  async stop(): Promise<void> {
    this.closing = true; this.finishNativeClosing(); this.native.stop();
    await Promise.allSettled(this.engines.map(engine => engine.compaction?.close()));
    for (const engine of this.engines) engine.connection.stop();
    await this.creating;
    await Promise.allSettled([this.native.exited, ...this.engines.map(engine => engine.connection.exited)]);
    await this.nativeExitPending;
    (await this.poolPending?.catch(() => undefined))?.close();
  }
}
