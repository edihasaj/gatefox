import { object, type Message } from "./app-server-connection.js";

type Failure = "busy" | "failed" | "interrupted" | "timeout" | "closed" | "unconfirmed" | "shared" | "incompatible" | "goal" | "reconnect";
const messages: Record<Failure, string> = {
  busy: "This chat is busy. Wait for its current work before retrying compaction recovery.",
  failed: "Compaction recovery failed on the selected model. Your chat is preserved; retry when that model is available.",
  interrupted: "Compaction recovery was interrupted. Your chat is preserved; send your message again to retry.",
  timeout: "Compaction recovery timed out. Your chat is preserved; wait for its work to stop before retrying.",
  closed: "The gateway connection closed during compaction recovery. Resume this chat to retry.",
  unconfirmed: "The selected model or idle chat state could not be confirmed. Resume this chat before retrying compaction recovery.",
  shared: "This shared chat needs explicit compaction with the selected model. Automatic recovery cannot safely reserve idle work across connected clients.",
  incompatible: "These models use incompatible compaction settings. Start a new chat with the selected model.",
  goal: "Pause or finish the active goal before compaction recovery. Your goal and chat are preserved.",
  reconnect: "The SDK's compaction state could not be confirmed. Reconnect this chat's computer connection before continuing. Your saved history is preserved.",
};

export class CompactionRecoveryError extends Error {
  readonly code = -32001;
  constructor(readonly reason: Failure) { super(messages[reason]); this.name = "CompactionRecoveryError"; }
}

export interface CompactionRecoveryOptions {
  /** The underlying SDK RPC, never the adapter's recursive request router. */
  request: (method: string, params: Message) => Promise<Message>;
  aliases: ReadonlySet<string>;
  isActive: (threadId: string) => boolean;
  shouldRecover: (threadId: string, targetModel: string) => Promise<boolean> | boolean;
  /** Goals is enabled by default in the pinned SDK; skip only if confirmed off. */
  checkGoal?: boolean | ((threadId: string) => boolean | Promise<boolean>);
  /** Only true for a known terminal failed compaction, never unknown SDK errors. */
  allowFailedState?: (threadId: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
  cleanupMs?: number;
}

interface Barrier {
  threadId: string;
  targetModel: string;
  deadline: number;
  phase: "checking" | "starting" | "running";
  startIssued: boolean;
  startRejected?: boolean;
  candidateTurnId?: string;
  candidateTerminal?: { turnId: string; status: string };
  turnId?: string;
  itemCompleted: boolean;
  terminal?: string;
  interruptAcknowledged?: boolean;
  interruptSent?: boolean;
  detached?: boolean;
  failure?: CompactionRecoveryError;
  waiters: Set<() => void>;
  cleanup?: Promise<Message>;
}

/**
 * One adapter's idle recovery barrier. Call observe before awaiting notification
 * forwarding, and reject other turn/steer/settings requests while isBusy is true.
 * Shared executors require a host-wide admission lock: SDK compact/start has no
 * atomic idle precondition and can otherwise abort another client's new turn.
 */
export class CompactionRecovery {
  private readonly barriers = new Map<string, Barrier>();
  private closed = false;
  private readonly timeoutMs: number;
  private readonly cleanupMs: number;
  constructor(private readonly options: CompactionRecoveryOptions) {
    this.timeoutMs = bounded(options.timeoutMs, 600000, 900000);
    this.cleanupMs = bounded(options.cleanupMs, 5000, 10000);
  }

  isBusy(threadId: string): boolean { return this.barriers.has(threadId); }
  assertAvailable(threadId: string): void {
    const barrier = this.barriers.get(threadId);
    if (barrier) throw new CompactionRecoveryError(barrier.detached ? "reconnect" : "busy");
  }

  async prepare(threadId: string, targetModel: string, settings?: Message, inferred = false): Promise<void> {
    // Primary-account work and models outside this executor are never changed.
    if (!this.options.aliases.has(targetModel)) return;
    if (this.closed) throw new CompactionRecoveryError("closed");
    this.assertAvailable(threadId);
    if (this.barriers.size >= 32) throw new CompactionRecoveryError("busy");
    const barrier: Barrier = { threadId, targetModel, deadline: Date.now() + this.timeoutMs,
      phase: "checking", startIssued: false, itemCompleted: false, waiters: new Set() };
    this.barriers.set(threadId, barrier);
    try {
      const needed = await this.race(barrier, Promise.resolve(this.options.shouldRecover(threadId, targetModel)));
      this.check(barrier); if (!needed) return;
      this.assertIdle(barrier);
      let thread = await this.read(barrier);
      this.check(barrier);
      // Even a stale adapter binding cannot change a primary-account chat.
      if (thread.modelProvider !== "subscription_gateway") return;
      if (inferred && thread.model !== targetModel) {
        if (typeof thread.model !== "string") throw new CompactionRecoveryError("unconfirmed");
        if (!this.options.aliases.has(thread.model)) return;
        targetModel = thread.model; barrier.targetModel = targetModel;
        const stillNeeded = await this.race(barrier, Promise.resolve(this.options.shouldRecover(threadId, targetModel)));
        this.check(barrier); if (!stillNeeded) return;
      }
      await this.confirmIdle(barrier, thread);
      await this.confirmGoal(barrier);
      const tier = explicitThreadTier(settings);
      const reasoning = explicitReasoning(settings, targetModel);
      const matches = (value: Message) => value.model === targetModel && (!reasoning.confirm || value.reasoningEffort === reasoning.effort);
      if (thread.model !== targetModel || tier.present || Object.keys(reasoning.update).length) {
        // Keep an explicit Standard change in the same SDK operation as model.
        // Other caller settings remain on its original user-turn request.
        await this.rpc(barrier, "thread/settings/update", { threadId, ...(!inferred ? { model: targetModel } : {}), ...(tier.present ? { serviceTier: tier.value } : {}), ...reasoning.update });
        // A queued ACK is not an applied setting. No-op updates need no event.
        for (;;) {
          thread = await this.read(barrier);
          await this.confirmIdle(barrier, thread);
          if (matches(thread)) break;
          await this.changed(barrier, 100);
        }
      }
      await this.confirmGoal(barrier);
      thread = await this.read(barrier);
      await this.confirmIdle(barrier, thread);
      if (thread.modelProvider !== "subscription_gateway" || !matches(thread)) throw new CompactionRecoveryError("unconfirmed");
      this.assertIdle(barrier);
      // Register the barrier before issuing RPC: notifications can precede ACK.
      barrier.phase = "starting";
      await this.start(barrier);
      while (!barrier.itemCompleted || barrier.terminal !== "completed") {
        this.check(barrier);
        if (barrier.terminal && barrier.terminal !== "completed") throw new CompactionRecoveryError(barrier.terminal === "interrupted" ? "interrupted" : "failed");
        await this.changed(barrier, Math.max(1, barrier.deadline - Date.now()));
      }
      this.check(barrier);
    } catch (error) {
      barrier.failure ||= error instanceof CompactionRecoveryError ? error : new CompactionRecoveryError("failed");
      await this.cleanup(barrier);
      throw barrier.failure;
    } finally {
      // An unconfirmed late start could abort new work. Keep its admission
      // guard after returning a bounded error until its actual stop is known.
      barrier.detached = true; this.releaseStopped(barrier);
      this.wake(barrier);
    }
  }

  /** Observes only; the caller forwards this exact SDK notification unchanged. */
  observe(message: Message): void {
    const params = object(message.params);
    if (typeof params.threadId !== "string") return;
    const barrier = this.barriers.get(params.threadId); if (!barrier) return;
    const turn = object(params.turn);
    const turnId = typeof params.turnId === "string" ? params.turnId : typeof turn.id === "string" ? turn.id : undefined;
    if (message.method === "turn/started" && turnId) {
      if (!barrier.startIssued || barrier.turnId && barrier.turnId !== turnId) {
        barrier.failure ||= new CompactionRecoveryError("busy");
      } else barrier.candidateTurnId = turnId;
    }
    if (barrier.startIssued && turnId && object(params.item).type === "contextCompaction" && ["item/started", "item/completed"].includes(String(message.method))) {
      if (!barrier.turnId) {
        if (barrier.candidateTurnId && barrier.candidateTurnId !== turnId) barrier.failure ||= new CompactionRecoveryError("busy");
        barrier.turnId = turnId; barrier.phase = "running";
        if (barrier.candidateTerminal?.turnId === turnId) barrier.terminal = barrier.candidateTerminal.status;
      }
      if (barrier.turnId === turnId && message.method === "item/completed") barrier.itemCompleted = true;
    }
    if (message.method === "turn/completed" && turnId && turnId === barrier.turnId) {
      barrier.terminal = typeof turn.status === "string" ? turn.status : "failed";
    } else if (message.method === "turn/completed" && turnId && barrier.startIssued && turnId === barrier.candidateTurnId) {
      // CompactTask preparation may fail before its compaction item starts.
      // Return promptly, while retaining uncertainty about turn ownership.
      barrier.candidateTerminal = { turnId, status: typeof turn.status === "string" ? turn.status : "failed" };
      barrier.failure ||= new CompactionRecoveryError("reconnect");
    }
    this.wake(barrier);
    if (barrier.detached && barrier.turnId && !barrier.terminal && !barrier.interruptSent) {
      // The start arrived after the bounded cleanup window. Cancel only after
      // its contextCompaction marker proves ownership; preserve the guard.
      barrier.cleanup = undefined; void this.cleanup(barrier).then(() => this.releaseStopped(barrier));
    }
    this.releaseStopped(barrier);
  }

  /** undefined leaves ordinary SDK interrupts on their existing routing path. */
  async interceptInterrupt(threadId: string, _requestedTurnId?: string): Promise<Message | undefined> {
    const barrier = this.barriers.get(threadId); if (!barrier) return;
    barrier.failure ||= new CompactionRecoveryError("interrupted"); this.wake(barrier);
    // Use only the observed recovery turn, never an unrelated supplied turn ID.
    const result = await this.cleanup(barrier);
    if (barrier.startIssued && !barrier.terminal && !barrier.interruptAcknowledged && !(barrier.startRejected && !barrier.turnId)) throw new CompactionRecoveryError("timeout");
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    const barriers = [...this.barriers.values()];
    for (const barrier of barriers) { barrier.failure ||= new CompactionRecoveryError("closed"); this.wake(barrier); }
    await Promise.allSettled(barriers.map(barrier => this.cleanup(barrier)));
    this.barriers.clear();
  }

  private assertIdle(barrier: Barrier): void {
    this.check(barrier);
    if (this.options.isActive(barrier.threadId)) throw new CompactionRecoveryError("busy");
  }
  private async confirmIdle(barrier: Barrier, thread: Message): Promise<void> {
    this.assertIdle(barrier);
    const status = object(thread.status).type;
    if (status === "active") throw new CompactionRecoveryError("busy");
    // The pinned SDK retains SystemError after a failed turn; it is computed
    // only after loaded running/approval/input checks. Require known failure
    // provenance too, because the status can lag a newly starting SDK task.
    if (status === "systemError") {
      let known: boolean;
      try { known = await this.race(barrier, Promise.resolve(this.options.allowFailedState?.(barrier.threadId) ?? false)); }
      catch (error) { throw error instanceof CompactionRecoveryError ? error : new CompactionRecoveryError("unconfirmed"); }
      this.assertIdle(barrier); if (known === true) return;
    }
    if (status !== "idle") throw new CompactionRecoveryError("unconfirmed");
  }
  private async confirmGoal(barrier: Barrier): Promise<void> {
    let enabled: boolean | undefined;
    try { enabled = await this.race(barrier, Promise.resolve(typeof this.options.checkGoal === "function" ? this.options.checkGoal(barrier.threadId) : this.options.checkGoal)); }
    catch (error) { throw error instanceof CompactionRecoveryError ? error : new CompactionRecoveryError("unconfirmed"); }
    this.check(barrier);
    if (enabled === false) return;
    let result: Message;
    try { result = await this.rpc(barrier, "thread/goal/get", { threadId: barrier.threadId }); }
    catch (error) { throw error instanceof CompactionRecoveryError ? error : new CompactionRecoveryError("unconfirmed"); }
    this.check(barrier);
    if (result.goal === null) return;
    const goal = object(result.goal);
    if (goal.threadId !== barrier.threadId || !["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(goal.status))) throw new CompactionRecoveryError("unconfirmed");
    if (goal.status === "active") throw new CompactionRecoveryError("goal");
  }
  private async read(barrier: Barrier): Promise<Message> {
    const thread = object((await this.rpc(barrier, "thread/read", { threadId: barrier.threadId, includeTurns: false })).thread);
    if (thread.id !== barrier.threadId) throw new CompactionRecoveryError("unconfirmed");
    return thread;
  }
  private rpc(barrier: Barrier, method: string, params: Message): Promise<Message> {
    this.check(barrier); return this.race(barrier, this.options.request(method, params));
  }
  private start(barrier: Barrier): Promise<Message> {
    this.check(barrier); barrier.startIssued = true;
    let work: Promise<Message>;
    try { work = this.options.request("thread/compact/start", { threadId: barrier.threadId }); }
    catch (error) { work = Promise.reject(error); }
    const tracked = work.catch(error => {
      // A JSON-RPC rejection means the SDK refused to enqueue this command.
      // Connection/timeouts carry no numeric RPC code and remain uncertain.
      const code = Object.getOwnPropertyDescriptor(object(error), "code")?.value;
      barrier.startRejected = typeof code === "number" && Number.isSafeInteger(code) && code >= -32700 && code <= -32000;
      this.wake(barrier); this.releaseStopped(barrier); throw error;
    });
    return this.race(barrier, tracked);
  }
  private releaseStopped(barrier: Barrier): void {
    if (barrier.detached && (!barrier.startIssued || !!barrier.terminal || barrier.startRejected && !barrier.turnId) && this.barriers.get(barrier.threadId) === barrier) {
      this.barriers.delete(barrier.threadId); this.wake(barrier);
    }
  }
  private check(barrier: Barrier): void {
    if (barrier.failure) throw barrier.failure;
    if (this.closed) throw new CompactionRecoveryError("closed");
    if (Date.now() >= barrier.deadline) throw new CompactionRecoveryError("timeout");
  }
  private async race<T>(barrier: Barrier, work: Promise<T>): Promise<T> {
    this.check(barrier);
    let stop!: () => void; let timer!: NodeJS.Timeout;
    const guard = new Promise<never>((_, reject) => {
      stop = () => { try { this.check(barrier); } catch (error) { reject(error); } };
      barrier.waiters.add(stop);
      timer = setTimeout(() => reject(new CompactionRecoveryError("timeout")), Math.max(1, barrier.deadline - Date.now()));
    });
    try { return await Promise.race([work, guard]); }
    finally { clearTimeout(timer); barrier.waiters.delete(stop); }
  }
  private changed(barrier: Barrier, milliseconds: number): Promise<void> {
    return this.signal(barrier, Math.min(milliseconds, Math.max(1, barrier.deadline - Date.now())));
  }
  private signal(barrier: Barrier, milliseconds: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); barrier.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, milliseconds); barrier.waiters.add(done);
    });
  }
  private wake(barrier: Barrier): void { for (const waiter of [...barrier.waiters]) waiter(); }

  private cleanup(barrier: Barrier): Promise<Message> {
    if (barrier.cleanup) return barrier.cleanup;
    barrier.cleanup = (async () => {
      if (!barrier.startIssued || barrier.startRejected && !barrier.turnId) return {};
      const deadline = Date.now() + this.cleanupMs;
      while (!barrier.turnId && !barrier.terminal && Date.now() < deadline) await this.signal(barrier, Math.max(1, deadline - Date.now()));
      if (!barrier.turnId || barrier.terminal) return {};
      let result: Message = {};
      barrier.interruptSent = true;
      const interruption = Promise.resolve().then(() => this.options.request("turn/interrupt", { threadId: barrier.threadId, turnId: barrier.turnId }))
        .then(result => { barrier.interruptAcknowledged = true; return result; });
      let timer!: NodeJS.Timeout;
      try {
        result = await Promise.race([interruption, new Promise<Message>(resolve => { timer = setTimeout(() => resolve({}), Math.max(1, deadline - Date.now())); })]);
      } catch { /* The original failure remains authoritative; no raw SDK text. */ }
      finally { clearTimeout(timer); }
      while (!barrier.terminal && Date.now() < deadline) await this.signal(barrier, Math.max(1, deadline - Date.now()));
      return result;
    })();
    return barrier.cleanup;
  }
}

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) : fallback;
}

function explicitThreadTier(settings?: Message): { present: boolean; value?: string | null } {
  const config = object(settings?.config);
  const present = !!settings && Object.hasOwn(settings, "serviceTier") || Object.hasOwn(config, "service_tier");
  if (!present) return { present: false };
  const value = settings && Object.hasOwn(settings, "serviceTier") ? settings.serviceTier : config.service_tier;
  if (value !== null && typeof value !== "string") throw new CompactionRecoveryError("unconfirmed");
  return { present: true, value };
}

function explicitReasoning(settings: Message | undefined, model: string): { update: Message; confirm: boolean; effort?: string | null } {
  const update: Message = {};
  if (settings && Object.hasOwn(settings, "effort")) {
    if (settings.effort !== null && typeof settings.effort !== "string") throw new CompactionRecoveryError("unconfirmed");
    update.effort = settings.effort;
  }
  if (settings && Object.hasOwn(settings, "collaborationMode") && settings.collaborationMode !== null) {
    const mode = object(settings.collaborationMode); const selected = object(mode.settings);
    const effort = selected.reasoning_effort ?? null;
    if (typeof mode.mode !== "string" || selected.model !== model || effort !== null && typeof effort !== "string") throw new CompactionRecoveryError("unconfirmed");
    // The complete explicit mode has SDK precedence over top-level effort;
    // retaining it also preserves null/default effort and its instructions.
    update.collaborationMode = settings.collaborationMode;
    return { update, confirm: true, effort };
  }
  // Public top-level null leaves effort unchanged in the pinned SDK.
  return { update, confirm: typeof update.effort === "string", ...(typeof update.effort === "string" ? { effort: update.effort } : {}) };
}
