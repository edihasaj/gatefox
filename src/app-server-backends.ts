import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { writePrivateJson, type GatewayConfig } from "./config.js";
import { AppServerConnection, isId, object, type Id, type Message } from "./app-server-connection.js";
import { DesktopCatalog } from "./desktop-catalog.js";
import { gatewayEngineHome, gatewayEnvironment } from "./gateway-engine-home.js";
import { titleTool, withTitleTool, handleTitleCall } from "./chat-titles.js";
import { agentExecutorSettings, readAgentPolicy } from "./agent-profiles.js";

interface Engine { connection: AppServerConnection; revision: string; aliases: Set<string>; threads: Set<string>; active: Map<string, string> }

/** A stable native connection plus bounded gateway generations pinned to loaded chats. */
export class AppServerBackends {
  readonly native: AppServerConnection;
  private readonly engines: Engine[] = [];
  private readonly bindings = new Map<string, Engine>();
  private readonly approvals = new Map<string, { connection: AppServerConnection; id: Id }>();
  private readonly reverse = new Map<AppServerConnection, Map<Id, string>>();
  private serverSequence = 0;
  private initialized?: Message;
  private closing = false;
  private creating: Promise<unknown> = Promise.resolve();
  constructor(private readonly executable: string, private readonly args: string[], private readonly config: GatewayConfig,
    private readonly settings: Message, private readonly overrides: Message, private readonly catalog: DesktopCatalog,
    private readonly emit: (message: Message) => Promise<void>, onNativeExit: () => void) {
    // Register only the added provider at runtime. Native account/model defaults stay intact.
    const registration = Object.entries(overrides).map(([key, value]) => [`-c`, `model_providers.subscription_gateway.${key}=${JSON.stringify(value)}`]).flat();
    this.native = new AppServerConnection(executable, [...args, ...registration], message => this.forward(this.native, message), () => onNativeExit());
  }
  private async forward(connection: AppServerConnection, message: Message): Promise<void> {
    const params = object(message.params); const engine = this.engines.find(value => value.connection === connection);
    if (engine) {
      const thread = object(params.thread); const threadId = typeof params.threadId === "string" ? params.threadId : typeof thread.id === "string" ? thread.id : undefined;
      if (message.method === "thread/started" && threadId) { engine.threads.add(threadId); this.bindings.set(threadId, engine); }
      if (message.method === "thread/closed" && threadId) { engine.threads.delete(threadId); if (this.bindings.get(threadId) === engine) this.bindings.delete(threadId); }
      if (message.method === "turn/started" && threadId && typeof object(params.turn).id === "string") engine.active.set(threadId, String(object(params.turn).id));
      if (message.method === "turn/completed" && threadId) engine.active.delete(threadId);
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
  private async gateway(): Promise<Engine> {
    if (this.closing) throw new Error("Codex desktop connection is closing");
    if (!this.catalog.current().models.length) await this.catalog.refresh(true);
    const snapshot = this.catalog.current();
    const revision = createHash("sha256").update(snapshot.revision + JSON.stringify(await readAgentPolicy(this.config.stateDirectory) || null)).digest("hex");
    if (!snapshot.models.length) throw new Error("No gateway models are currently offered; check the gateway catalog");
    const ready = this.engines.find(engine => engine.revision === revision && !engine.connection.closed);
    if (ready) return ready;
    const operation = this.creating.then(async () => {
      if (this.closing) throw new Error("Codex desktop connection is closing");
      const existing = this.engines.find(engine => engine.revision === revision && !engine.connection.closed);
      if (existing) return existing;
      for (let index = this.engines.length - 1; index >= 0; index--) {
        const old = this.engines[index];
        if (old.connection.closed || (!old.threads.size && !old.active.size)) { old.connection.stop(); await old.connection.exited; this.engines.splice(index, 1); }
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
        "features.step_model_switching": true,
        ...Object.fromEntries(Object.entries(this.overrides).map(([key, value]) => [`model_providers.subscription_gateway.${key}`, value])) };
      const args = [...forwarded, ...Object.entries(overrides).filter(([, value]) => value !== undefined).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])];
      if (this.closing) throw new Error("Codex desktop connection is closing");
      const engine: Engine = { connection: undefined!, revision, aliases: new Set(snapshot.models.map(model => String(model.slug))), threads: new Set(), active: new Map() };
      engine.connection = new AppServerConnection(this.executable, args, message => this.forward(engine.connection, message), () => {
        for (const [id, approval] of this.approvals) if (approval.connection === engine.connection) this.approvals.delete(id);
        this.reverse.delete(engine.connection);
        if (!this.closing) for (const [threadId, id] of engine.active) void this.emit({ method: "turn/completed", params: { threadId, turn: { id, items: [], status: "failed", error: { message: "Gateway executor exited. Resume this chat to recover its saved history.", codexErrorInfo: "internalServerError", additionalDetails: null } } } });
        engine.active.clear();
      }, gatewayEnvironment(home));
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
    if (method === "thread/read" && typeof params.threadId === "string" && !this.bindings.has(params.threadId)) return this.native.request(method, params);
    let engine: Engine | undefined;
    if (method === "thread/start" && params.modelProvider === "subscription_gateway") engine = await this.gateway();
    else if (typeof params.threadId === "string") {
      engine = this.bindings.get(params.threadId);
      if (!engine) {
        const thread = object((await this.native.request("thread/read", { threadId: params.threadId, includeTurns: false })).thread);
        if (thread.modelProvider === "subscription_gateway") engine = await this.gateway();
      }
    }
    if (!engine) return this.native.request(method, params);
    if (engine.connection.closed) {
      if (method !== "thread/resume") throw new Error("The gateway executor exited; resume this chat before continuing. Ephemeral chats must be started again.");
      engine = await this.gateway();
    }
    const model = object(object(params.collaborationMode).settings).model ?? params.model;
    if (typeof model === "string" && !engine.aliases.has(model)) throw new Error("This loaded gateway chat uses an older catalog. Start a new chat to use a newly added model without interrupting it.");
    const result = await engine.connection.request(method, method === "thread/start" ? withTitleTool(params) : params);
    if (["thread/start", "thread/resume", "thread/fork"].includes(method) && typeof object(result.thread).id === "string") {
      const id = String(object(result.thread).id); engine.threads.add(id); this.bindings.set(id, engine);
    }
    if (["thread/unsubscribe", "thread/delete", "thread/archive"].includes(method) && typeof params.threadId === "string") {
      engine.threads.delete(params.threadId); this.bindings.delete(params.threadId);
    }
    return result;
  }
  async stop(): Promise<void> {
    this.closing = true; this.native.stop(); for (const engine of this.engines) engine.connection.stop();
    await this.creating;
    await Promise.allSettled([this.native.exited, ...this.engines.map(engine => engine.connection.exited)]);
  }
}
