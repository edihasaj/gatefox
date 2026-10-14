import { basename, join, resolve, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { AppServerConnection, isId, object, type Message } from "./app-server-connection.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { accountDirectory, accountEnvironment, accountPinnedArgs, defaultNativeHome, prepareAccountHome } from "./account-engine-home.js";
import { acquireAccountLease } from "./account-lease.js";
import { emailHash, identityPath, nativeIdentityPath, readIdentity } from "./account-login.js";
import { writePrivateJson, type AccountEngineConfig, type GatewayConfig } from "./config.js";
import { telemetry } from "./telemetry.js";
import { accountProviderId, presentNotification, unavailableMessage, type AccountRoute, type AccountStatus } from "./account-routing.js";
import { accountRequestReply, isAccountNotification, isRateLimitsUpdated, parseUsageSnapshot, sanitizeRateLimits, usageFileContent, type AccountLimit, type AccountUsageSnapshot } from "./account-usage.js";

/** One signed app-server per account home, spawned lazily and reaped when idle. Timers and spawn are injectable. */
export interface AccountConnection { request(method: string, params: Message): Promise<Message>; send(message: Message): void; stop(): void; readonly closed: boolean }
export interface AccountEngineOptions {
  codex: string; nativeHome?: string; version?: string; baseArgs: string[]; configPath?: string;
  nativeRequest(method: string, params: Message): Promise<Message>;
  initializeParams?: Message;
  forward?(id: string, message: Message): Promise<void>;
  spawn?(options: { executable: string; args: string[]; env: NodeJS.ProcessEnv; onMessage: (message: Message) => Promise<void>; onExit: () => void }): AccountConnection;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
  idleTimeoutMs?: number; startWaitMs?: number; usageTimeoutMs?: number; startBackoffMs?: number;
}
export interface AccountHostModule { acquireAccountEngine(input: { configPath?: string; nativeHome: string; codex: string; accountId: string; descriptor: AccountEngineConfig }): Promise<{ socketPath: string } | undefined> }

interface EngineState {
  descriptor: AccountEngineConfig; label: string; status: AccountStatus; rows: Message[]; slugs: Set<string>;
  connection?: AccountConnection; release?: () => Promise<void>; starting?: Promise<void>; exit?: Promise<void>;
  threads: Set<string>; active: Map<string, string>; requests: number; reaper?: unknown; stopping: boolean; lastAttempt: number;
}

// Public model/list fields only; identity, auth and cache keys are never persisted.
const publicFields = ["model", "displayName", "description", "modelSpecialty", "hidden", "supportedReasoningEfforts", "defaultReasoningEffort", "inputModalities",
  "supportsPersonality", "multiAgentVersion", "multiAgentReasoningEffort", "additionalSpeedTiers", "serviceTiers", "defaultServiceTier", "availableAccessPrograms",
  "availabilityNux", "upgrade", "upgradeInfo", "isDefault", "contextWindow", "maxContextWindow", "supportsParallelToolCalls", "supportsSearchTool", "toolMode",
  "defaultReasoningLevel", "defaultReasoningSummary", "effectiveContextWindowPercent", "truncationPolicy", "autoCompactTokenLimit", "useResponsesLite", "supportsReasoningEffortUpdates"];

/** Desktop args minus -p/--profile, plus the pinned account provider. The gateway chat provider is never registered here. */
export function accountEngineArgs(baseArgs: string[], id: string, version: string | undefined, workspaceId?: string): string[] {
  const args: string[] = [];
  for (let index = 0; index < baseArgs.length; index++) {
    const arg = baseArgs[index];
    if (arg === "-p" || arg === "--profile") { index++; continue; }
    if (arg.startsWith("--profile=")) continue;
    args.push(arg);
  }
  const provider = accountProviderId(id);
  const setting = (key: string, value: unknown): string[] => ["-c", `${key}=${JSON.stringify(value)}`];
  return [...args, ...accountPinnedArgs(workspaceId),
    ...setting("features.memories", false), ...setting("model_provider", provider),
    ...setting(`model_providers.${provider}.name`, "OpenAI"),
    ...setting(`model_providers.${provider}.base_url`, "https://chatgpt.com/backend-api/codex"),
    ...setting(`model_providers.${provider}.wire_api`, "responses"),
    ...setting(`model_providers.${provider}.requires_openai_auth`, true),
    ...setting(`model_providers.${provider}.supports_websockets`, true),
    ...setting(`model_providers.${provider}.supports_standalone_web_search`, true),
    ...(version !== undefined ? setting(`model_providers.${provider}.http_headers.version`, version) : [])];
}

const DEFAULT_IDLE_MS = 10 * 60000; const DEFAULT_WAIT_MS = 20000; const DEFAULT_USAGE_MS = 2000; const DEFAULT_START_BACKOFF_MS = 5000;

export class AccountEngines {
  private readonly states = new Map<string, EngineState>();
  private readonly timers; private host?: Promise<AccountHostModule | undefined>; private closing = false;
  constructor(private readonly config: GatewayConfig, private readonly options: AccountEngineOptions) {
    this.timers = options.timers ?? { setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimeout: handle => clearTimeout(handle as NodeJS.Timeout), now: () => Date.now() };
    for (const descriptor of config.accountEngines ?? []) {
      if (descriptor.type && descriptor.type !== "codex") continue;
      this.states.set(descriptor.id, { descriptor, label: descriptor.label || descriptor.id, status: "idle", rows: [], slugs: new Set(),
        threads: new Set(), active: new Map(), requests: 0, stopping: false, lastAttempt: 0 });
    }
    void this.restore();
  }
  ids(): string[] { return [...this.states.keys()]; }
  label(id: string): string | undefined { return this.states.get(id)?.label; }
  status(id: string): AccountStatus {
    const state = this.states.get(id);
    if (!state) return "not_configured";
    if (state.status === "ready" && state.connection?.closed) this.fail(state, "failed");
    return state.status;
  }
  routes(): Map<string, AccountRoute> {
    const out = new Map<string, AccountRoute>();
    for (const [id, state] of this.states) out.set(id, { id, status: this.status(id), slugs: state.slugs });
    return out;
  }
  knownSlugs(id: string): ReadonlySet<string> { return this.states.get(id)?.slugs ?? new Set(); }
  rows(id: string): readonly Message[] { return this.states.get(id)?.rows ?? []; }
  threadOwner(threadId: string): string | undefined {
    for (const [id, state] of this.states) if (state.threads.has(threadId)) return id;
    return undefined;
  }
  /** A reserved handle for one account engine, or undefined while it cannot serve. */
  engine(id: string): { account: string; request(method: string, params: Message): Promise<Message>; closed: boolean } | undefined {
    const state = this.states.get(id);
    if (!state || state.status !== "ready" || !state.connection || state.connection.closed) return;
    return { account: id, request: (method, params) => this.request(id, method, params), closed: false };
  }
  /** Wait for a starting engine up to startWaitMs, then report the status the route must use. */
  async ensure(id: string, waitMs = this.options.startWaitMs ?? DEFAULT_WAIT_MS): Promise<AccountStatus> {
    const state = this.states.get(id);
    if (!state || this.closing) return state ? this.status(id) : "not_configured";
    if (state.status === "ready" && !state.connection?.closed) return "ready";
    if (state.status === "starting" && state.starting) { await this.settle(state.starting, waitMs); return this.status(id); }
    const now = this.timers.now();
    // A refused or failed start is retried on the next chat, not hammered within one.
    if ((state.status === "failed" || state.status === "busy_elsewhere" || state.status === "not_logged_in" || state.status === "identity_mismatch")
      && now - state.lastAttempt < (this.options.startBackoffMs ?? DEFAULT_START_BACKOFF_MS)) return state.status;
    state.lastAttempt = now;
    this.launch(state);
    await this.settle(state.starting ?? Promise.resolve(), waitMs);
    return this.status(id);
  }
  async request(id: string, method: string, params: Message): Promise<Message> {
    const status = await this.ensure(id);
    const state = this.states.get(id);
    if (!state || status !== "ready" || !state.connection || state.connection.closed)
      throw Object.assign(new Error(unavailableMessage(id, status)), { code: -32001 });
    state.requests++; this.quiet(state);
    try {
      const result = await state.connection.request(method, params);
      if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
        const thread = object(result.thread);
        if (typeof thread.id === "string" && (thread.modelProvider ?? result.modelProvider) === accountProviderId(id)) state.threads.add(thread.id);
      }
      if (["thread/unsubscribe", "thread/delete", "thread/archive"].includes(method) && typeof params.threadId === "string") {
        state.threads.delete(params.threadId); state.active.delete(params.threadId);
      }
      return result;
    } finally { state.requests--; this.quiet(state); }
  }
  /** One bounded live meter read; falls back to the persisted snapshot from the last capture. */
  async usage(id: string): Promise<AccountUsageSnapshot | undefined> {
    const state = this.states.get(id); if (!state) return;
    if (state.status === "ready" && state.connection && !state.connection.closed) {
      const result = await this.settle(state.connection.request("account/rateLimits/read", {}), this.options.usageTimeoutMs ?? DEFAULT_USAGE_MS);
      if (result) {
        void this.captureRateLimits(id, result);
        return { id, label: state.label, observedAt: Math.floor(this.timers.now() / 1000), limits: sanitizeRateLimits(result) };
      }
    }
    const persisted = await this.persistedUsage(id);
    return persisted && { id, label: state.label, ...persisted };
  }
  /** Persist numeric meter fields; used for captured updates and live reads. */
  async captureRateLimits(id: string, source: Message): Promise<void> {
    const state = this.states.get(id); if (!state) return;
    const limits = object(source.rateLimitsByLimitId) && Object.keys(object(source.rateLimitsByLimitId)).length
      ? sanitizeRateLimits(source)
      : typeof source.limitId === "string" ? sanitizeRateLimits({ rateLimitsByLimitId: { [source.limitId]: source } }) : [];
    if (!limits.length) return;
    await writePrivateJson(this.usagePath(id), usageFileContent(limits, Math.floor(this.timers.now() / 1000))).catch(() => {});
  }
  /** After the desktop initializes: record {version:1, emailSha256} when the native identity changes. */
  async recordNativeIdentity(read: () => Promise<Message>): Promise<void> {
    try {
      const account = object(object(await read()).account);
      if (account.type !== "chatgpt" || typeof account.email !== "string" || !account.email.trim()) return;
      const emailSha256 = emailHash(account.email);
      const saved = await readIdentity(nativeIdentityPath(this.config.stateDirectory)).catch(() => undefined);
      if (saved?.emailSha256 === emailSha256) return;
      await writePrivateJson(nativeIdentityPath(this.config.stateDirectory), { version: 1, emailSha256 });
    } catch { /* identity recording never breaks the adapter */ }
  }
  /** Upstream-to-alias rewrite for the adapter's emit path before anything reaches the desktop. */
  present(message: Message): Message { return presentNotification(message, this.routes()); }
  /** Every account meter for the desktop's account/rateLimits/read merge. */
  async usageSnapshots(): Promise<AccountUsageSnapshot[]> {
    return (await Promise.all(this.ids().map(id => this.usage(id)))).filter((row): row is AccountUsageSnapshot => row !== undefined && row.limits.length > 0);
  }
  async stop(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.states.values()].map(async state => { await this.shutdown(state, true); }));
  }

  // -- internals --
  private async restore(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.slugs.size || state.rows.length) continue;
      const rows = await this.persistedRows(state.descriptor.id);
      if (rows) { state.rows = rows; for (const row of rows) if (typeof row.model === "string") state.slugs.add(row.model); }
    }
  }
  private launch(state: EngineState): void {
    state.status = "starting"; state.stopping = false;
    state.starting = (async () => {
      try { await this.start(state); }
      catch (error) {
        const status: AccountStatus = (error as { accountStatus?: AccountStatus }).accountStatus ?? "failed";
        if (status === "identity_mismatch") telemetry("account_route_refused", { account: state.descriptor.id, reason: "identity" });
        this.fail(state, status);
      }
    })();
  }
  private async start(state: EngineState): Promise<void> {
    const id = state.descriptor.id;
    this.checkExecutable();
    const host = await this.hostModule();
    if (host) {
      const acquired = await host.acquireAccountEngine({ configPath: this.options.configPath, nativeHome: this.nativeHome(), codex: this.options.codex, accountId: id, descriptor: state.descriptor });
      if (acquired) {
      const connection = new SocketAppServerConnection(acquired.socketPath, message => this.receive(id, message), () => this.onExit(id));
        state.connection = connection; state.exit = connection.exited.then(() => undefined).catch(() => undefined);
        await connection.ready.catch(error => { connection.stop(); throw error; });
        await this.handshake(state, connection);
        telemetry("account_engine_started", { account: id, mode: "host" });
        state.status = "ready"; this.quiet(state); return;
      }
    }
    const release = await acquireAccountLease(this.config.stateDirectory, id, "connection");
    if (!release) throw Object.assign(new Error("held"), { accountStatus: "busy_elsewhere" as AccountStatus });
    state.release = release;
    try {
      const settings = object((await this.options.nativeRequest("config/read", { includeLayers: true })).config);
      const directory = await prepareAccountHome(this.config.stateDirectory, id, settings, this.nativeHome(), state.descriptor.workspaceId);
      const args = accountEngineArgs(this.options.baseArgs, id, this.options.version, state.descriptor.workspaceId);
      const env = accountEnvironment(directory);
      const connection = this.options.spawn
        ? this.options.spawn({ executable: this.options.codex, args, env, onMessage: message => this.receive(id, message), onExit: () => this.onExit(id) })
        : this.defaultSpawn(id, this.options.codex, args, env);
      state.connection = connection;
      await this.handshake(state, connection);
      telemetry("account_engine_started", { account: id, mode: "spawn" });
      state.status = "ready"; this.quiet(state);
    } catch (error) { await this.shutdown(state, false); throw error; }
  }
  /** initialize, initialized, the identity check and the public model rows; throws with accountStatus on refusal. */
  private async handshake(state: EngineState, connection: AccountConnection): Promise<void> {
    const id = state.descriptor.id;
    const params = this.options.initializeParams ?? { clientInfo: { name: "gateway_account_engine", title: "Gateway account engine", version: "0.1.0" } };
    await connection.request("initialize", { ...params, capabilities: { ...object(params.capabilities), experimentalApi: true } });
    connection.send({ method: "initialized", params: {} });
    const account = object(object(await connection.request("account/read", { refreshToken: false })).account);
    const expected = await readIdentity(identityPath(this.config.stateDirectory, id));
    if (!expected) throw Object.assign(new Error("not signed in"), { accountStatus: "not_logged_in" as AccountStatus });
    if (account.type !== "chatgpt" || typeof account.email !== "string" || !account.email.trim())
      throw Object.assign(new Error("no login in this home"), { accountStatus: "not_logged_in" as AccountStatus });
    const emailSha256 = emailHash(account.email);
    const native = await readIdentity(nativeIdentityPath(this.config.stateDirectory)).catch(() => undefined);
    if (emailSha256 !== expected.emailSha256 || (native && native.emailSha256 === emailSha256 && !state.descriptor.workspaceId))
      throw Object.assign(new Error("identity mismatch"), { accountStatus: "identity_mismatch" as AccountStatus });
    let cursor: unknown = null; const rows: Message[] = [];
    for (;;) {
      const page = await connection.request("model/list", { limit: 100, ...(cursor === null ? {} : { cursor }) });
      if (!Array.isArray(page.data)) throw new Error("Account engine returned an invalid model list");
      for (const row of page.data.map(object)) { rows.push(row); if (rows.length > 512) throw new Error("Account model catalog is too large"); }
      cursor = page.nextCursor;
      if (typeof cursor !== "string" || !cursor) break;
    }
    state.rows = rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => publicFields.includes(key))));
    state.slugs = new Set(state.rows.map(row => String(row.model)).filter(model => model && model !== "undefined"));
    await writePrivateJson(join(accountDirectory(this.config.stateDirectory, id), "public-models.json"), { version: 1, data: state.rows }).catch(() => {});
  }
  private async receive(id: string, message: Message): Promise<void> {
    const state = this.states.get(id); if (!state) return;
    if (isId(message.id) && typeof message.method === "string") {
      const reply = accountRequestReply(message);
      if (reply) { state.connection?.send(reply); return; }
      await this.options.forward?.(id, message); return;
    }
    if (isAccountNotification(message)) {
      if (isRateLimitsUpdated(message)) void this.captureRateLimits(id, object(message.params));
      return; // No account/* notification reaches the desktop: both accounts report limitId codex.
    }
    const params = object(message.params); const threadId = typeof params.threadId === "string" ? params.threadId : typeof object(params.thread).id === "string" ? String(object(params.thread).id) : undefined;
    if (message.method === "thread/started" && threadId && object(params.thread).modelProvider === accountProviderId(id)) state.threads.add(threadId);
    if (message.method === "thread/closed" && threadId) { state.threads.delete(threadId); state.active.delete(threadId); }
    if (message.method === "turn/started" && threadId && typeof object(params.turn).id === "string") state.active.set(threadId, String(object(params.turn).id));
    if (message.method === "turn/completed" && threadId && state.active.get(threadId) === object(params.turn).id) state.active.delete(threadId);
    this.quiet(state);
    await this.options.forward?.(id, message);
  }
  private onExit(id: string): void {
    const state = this.states.get(id); if (!state || state.stopping) return;
    if (state.status === "ready" || state.status === "starting") this.fail(state, "failed");
  }
  private fail(state: EngineState, status: AccountStatus): void {
    if (this.closing) return;
    void this.shutdown(state, false); state.status = status;
  }
  /** Stop the owned process, release the lease, and leave the account idle or refused. */
  private async shutdown(state: EngineState, final: boolean): Promise<void> {
    if (state.reaper !== undefined) { this.timers.clearTimeout(state.reaper); state.reaper = undefined; }
    state.stopping = true;
    state.connection?.stop();
    if (state.exit) await this.settle(state.exit, 3000);
    state.connection = undefined; state.exit = undefined;
    state.threads.clear(); state.active.clear();
    const release = state.release; state.release = undefined;
    await release?.().catch(() => {});
    if (final) state.status = "idle";
  }
  /** (Re)arm or disarm the 10-minute idle reaper around the current load. */
  private quiet(state: EngineState): void {
    if (this.closing || state.status !== "ready") return;
    if (state.requests || state.active.size || state.threads.size) {
      if (state.reaper !== undefined) { this.timers.clearTimeout(state.reaper); state.reaper = undefined; }
      return;
    }
    if (state.reaper !== undefined) return;
    state.reaper = this.timers.setTimeout(() => {
      state.reaper = undefined;
      if (state.status === "ready" && !state.requests && !state.active.size && !state.threads.size) {
        void this.shutdown(state, true).then(() => telemetry("account_engine_reaped", { account: state.descriptor.id }));
      }
    }, this.options.idleTimeoutMs ?? DEFAULT_IDLE_MS);
  }
  private defaultSpawn(id: string, executable: string, args: string[], env: NodeJS.ProcessEnv): AccountConnection {
    const connection = new AppServerConnection(executable, args, message => this.receive(id, message), () => this.onExit(id), env);
    this.states.get(id)!.exit = connection.exited.then(() => undefined).catch(() => undefined);
    return connection;
  }
  private checkExecutable(): void {
    const real = resolve(this.options.codex);
    if (basename(real) === "gateway-codex" || real.split(sep).includes("gateway-sdk")) throw new Error("Account engines run the desktop's signed codex, never the gateway's own build");
  }
  private nativeHome(): string { return this.options.nativeHome ?? defaultNativeHome(); }
  private usagePath(id: string): string { return join(accountDirectory(this.config.stateDirectory, id), "usage.json"); }
  private async persistedUsage(id: string): Promise<{ observedAt: number; limits: AccountLimit[] } | undefined> {
    const parsed = await readFile(this.usagePath(id), "utf8").then(text => JSON.parse(text) as unknown).catch(() => undefined);
    const saved = parseUsageSnapshot(parsed);
    return saved && this.timers.now() / 1000 - saved.observedAt < 86400 ? saved : undefined;
  }
  private async persistedRows(id: string): Promise<Message[] | undefined> {
    try {
      const value = object(JSON.parse(await readFile(join(accountDirectory(this.config.stateDirectory, id), "public-models.json"), "utf8")));
      if (value.version !== 1 || !Array.isArray(value.data) || value.data.length > 512) return;
      return value.data.map(object).filter(row => typeof row.model === "string").map(row => Object.fromEntries(Object.entries(row).filter(([key]) => publicFields.includes(key))));
    } catch { return undefined; }
  }
  private hostModule(): Promise<AccountHostModule | undefined> {
    this.host ??= (async () => {
      const specifier = "./account-engine-host.js"; // Provided by the shared execution host (A3) in dist, absent otherwise.
      try { return await import(specifier) as AccountHostModule; }
      catch { return undefined; } // The shared execution host (A3) is optional on this path.
    })();
    return this.host;
  }
  /** Await with a bounded, cancellable timer; undefined means the deadline passed. */
  private async settle<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    let handle: unknown;
    const winner = await Promise.race([promise.then((value): { value?: T } => ({ value }), (): { value?: T } => ({})),
      new Promise<{ value?: T }>(done => { handle = this.timers.setTimeout(() => done({}), ms); })]);
    this.timers.clearTimeout(handle);
    return winner.value;
  }
}
