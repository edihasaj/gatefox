import { resolve } from "node:path";
import { homedir } from "node:os";
import { object, type Message } from "./app-server-connection.js";
import { CompactionRecovery, CompactionRecoveryError } from "./compaction-recovery.js";
import { CompactionStateStore } from "./compaction-state.js";
import { readCompactionUsage } from "./compaction-rollout.js";
import { CompactionPolicy } from "./compaction-policy.js";

export interface GatewayCompactionOptions {
  models: readonly Message[];
  settings: Message;
  args: string[];
  aliases: ReadonlySet<string>;
  shared?: boolean;
  isActive: (threadId: string) => boolean;
  request: (method: string, params: Message) => Promise<Message>;
}

/** Public metadata only; native account/configuration and SDK history stay owned by Codex. */
export class GatewayCompaction {
  private readonly nativeHome = resolve(process.env.CODEX_HOME || homedir() + "/.codex");
  private readonly store: CompactionStateStore;
  private warned = false;
  constructor(stateDirectory: string) { this.store = new CompactionStateStore(stateDirectory, this.nativeHome); }

  session(options: GatewayCompactionOptions): GatewayCompactionSession {
    return new GatewayCompactionSession(options, this.store, this.nativeHome, () => this.warn());
  }

  async observe(message: Message): Promise<void> {
    try { await this.store.observe(message); }
    catch {
      // Optional recovery metadata must not tear down a valid provider stream.
      this.warn();
    }
  }
  private warn(): void {
    if (!this.warned) { this.warned = true; process.stderr.write("gateway: Compaction recovery metadata is unavailable\n"); }
  }
}

export class GatewayCompactionSession {
  private readonly policy: CompactionPolicy;
  private readonly recovery: CompactionRecovery;
  private readonly checks = new Map<string, Set<{ cancelled: boolean }>>();
  private closed = false;
  constructor(private readonly options: GatewayCompactionOptions, private readonly store: CompactionStateStore, private readonly nativeHome: string, private readonly warn: () => void) {
    this.policy = new CompactionPolicy(options.models, options.settings, options.args);
    this.recovery = new CompactionRecovery({ request: options.request, aliases: options.aliases, isActive: options.isActive,
      checkGoal: threadId => this.policy.goalsEnabled(threadId),
      allowFailedState: async threadId => (await this.readState(threadId))?.compaction?.status === "failed",
      shouldRecover: (threadId, model) => this.shouldRecover(threadId, model) });
  }

  observe(message: Message): void { this.recovery.observe(message); }
  remember(threadId: string, params: Message): void { this.policy.remember(threadId, object(params.config)); }
  close(): Promise<void> {
    this.closed = true;
    for (const checks of this.checks.values()) for (const check of checks) check.cancelled = true;
    return this.recovery.close();
  }
  async after(method: string, params: Message): Promise<void> {
    if (method !== "thread/rollback" || typeof params.threadId !== "string") return;
    try { await this.store.reset(params.threadId); } catch { this.warn(); }
  }

  async before(method: string, params: Message): Promise<{ intercepted: boolean; result?: Message }> {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return { intercepted: false };
    if (method === "turn/interrupt") {
      const checks = this.checks.get(threadId);
      for (const check of checks || []) check.cancelled = true;
      const result = await this.recovery.interceptInterrupt(threadId, typeof params.turnId === "string" ? params.turnId : undefined);
      // Cancelling an unsent message needs no invented SDK turn or completion.
      if (result === undefined && checks?.size && !this.options.isActive(threadId)) return { intercepted: true, result: {} };
      return { intercepted: result !== undefined, ...(result !== undefined ? { result } : {}) };
    }
    // Closing a chat is still available; uncertain SDK work requires reconnecting
    // its owning connection rather than pretending this guard has been cleared.
    if (!isRead(method) && method !== "thread/unsubscribe") this.recovery.assertAvailable(threadId);
    // Preserve SDK steering and ordinary turns when no recovery is required.
    if (method !== "turn/start" || this.options.isActive(threadId)) return { intercepted: false };
    if (this.closed) throw new CompactionRecoveryError("closed");
    const checks = this.checks.get(threadId) || new Set<{ cancelled: boolean }>();
    if (checks.size >= 32 || !this.checks.has(threadId) && this.checks.size >= 32) throw new CompactionRecoveryError("busy");
    const check = { cancelled: false }; checks.add(check); this.checks.set(threadId, checks);
    try {
      const requested = object(object(params.collaborationMode).settings).model ?? params.model;
      const model = typeof requested === "string" ? requested
        : object((await this.options.request("thread/read", { threadId, includeTurns: false })).thread).model;
      if (check.cancelled) throw new CompactionRecoveryError("interrupted");
      if (typeof model !== "string" || !this.options.aliases.has(model)) return { intercepted: false };
      // Healthy turns must not acquire a recovery barrier during metadata reads.
      const recover = await this.shouldRecover(threadId, model);
      if (check.cancelled) throw new CompactionRecoveryError("interrupted");
      if (!recover || this.options.isActive(threadId)) return { intercepted: false };
      await this.recovery.prepare(threadId, model, params, typeof requested !== "string");
      if (check.cancelled) throw new CompactionRecoveryError("interrupted");
      return { intercepted: false };
    } catch (error) {
      if (check.cancelled) throw new CompactionRecoveryError("interrupted");
      throw error;
    } finally {
      checks.delete(check); if (!checks.size) this.checks.delete(threadId);
    }
  }

  private async shouldRecover(threadId: string, model: string): Promise<boolean> {
    const thread = object((await this.options.request("thread/read", { threadId, includeTurns: false })).thread);
    if (thread.id !== threadId || thread.modelProvider !== "subscription_gateway") return false;
    let state = await this.readState(threadId);
    if (!state?.usage && typeof thread.path === "string") {
      const usage = await readCompactionUsage(this.nativeHome, threadId, thread.path);
      if (usage && (!state || usage.emittedAtMs > state.emittedAtMs)) state = { ...state, emittedAtMs: usage.emittedAtMs, usage };
    }
    const decision = this.policy.decision(threadId, model, state, typeof thread.model === "string" ? thread.model : undefined);
    if (decision.action === "reject") throw new CompactionRecoveryError("incompatible");
    if (decision.action !== "compact") return false;
    // SDK compact/start aborts active work and has no atomic idle check. Until
    // shared ownership supplies an admission lock, do not race another client.
    if (this.options.shared) throw new CompactionRecoveryError("shared");
    return true;
  }
  private async readState(threadId: string) {
    try { return await this.store.read(threadId); } catch { this.warn(); return undefined; }
  }
}

function isRead(method: string): boolean {
  return /\/(read|get|list|status)$/.test(method);
}
