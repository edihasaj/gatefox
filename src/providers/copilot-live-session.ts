import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { ProviderConfig } from "../config.js";
import type { InferenceEvent } from "../protocol/types.js";
import { echoDigests, type LedgerState } from "./claude-ledger.js";
import { openCopilot, type CopilotClient } from "./copilot-client.js";
import type { Prompt, ToolResult } from "./copilot-render.js";
import { record } from "./copilot-rpc.js";
import type { CopilotTurn } from "./copilot-turn.js";
import { ProviderError } from "./provider.js";

export type SessionState = "starting" | "generating" | "awaiting_outputs" | "turn_done" | "closed";
export type SessionEnd = "reaped" | "evicted" | "crashed" | "closed";
export class SessionStartFailure extends Error { constructor(readonly reason: "spawn_failed" | "initialize_timeout") { super(`Copilot session ${reason}`); } }

/** Startup and hand-over bounds, in milliseconds; tests shorten them. */
export const sessionLimits = {
  /** `session.create` and the handshake before it. */
  startMs: 20000,
  /** How long Copilot may take to announce a pending request for each tool call it just made. */
  requestsMs: 10000,
  /** How long `session.abort` may take before the process is killed anyway. */
  abortMs: 2000,
  /** How long a complete answer may wait for the session's idle event before the request ends without it. */
  idleMs: 5000,
  /** How long a continuation waits for the pending requests of the calls it answers. */
  pendingMs: 2000,
};
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
// Between requests the model must do nothing, so only these housekeeping events are accepted; anything else
// (output, a model call, a finished tool call, compaction) means the runtime is acting on its own and may be billing.
const housekeeping = new Set(["session.info", "session.usage_info", "session.usage_checkpoint"]);
const acceptedBetweenRequests = (type: string) => housekeeping.has(type) || (type.startsWith("model.") && type !== "model.call_start");
const completions = new Set(["tool.execution_complete", "external_tool.completed"]);

export interface SessionOptions {
  key: string; fingerprint: string; window: string; effort?: string;
  config: ProviderConfig;
  /** `session.create` parameters without the id and directories (copilot-create.ts sessionParams). */
  create: Record<string, unknown>;
  /** The native names of the caller's tools; the CLI may start and request no other tool. */
  toolNames: ReadonlySet<string>;
  /** Called once when a started session ends, for the registry and telemetry. */
  onClose(session: CopilotLiveSession, outcome: SessionEnd, reason?: string): void;
}

/** One request served by the session. */
export interface LiveTurn {
  /** New conversation items as user messages, or the caller's tool outputs by call id. */
  begin: { prompts: Prompt[] } | { outputs: Map<string, string | ToolResult> };
  /** Ledger digests of this request's canonical input. */
  prefix: string[];
  turn: CopilotTurn;
  signal: AbortSignal;
  /** Called once: "ended", or why it did not end. */
  onEnd(outcome: "ended" | "interrupted" | "failed"): void;
}

interface Attached { live: LiveTurn; queue: Array<Record<string, unknown>>; wake?: () => void; error?: Error; onAbort: () => void }

/**
 * One long-lived Copilot CLI process and session for one Codex thread. Native history stays in
 * the session: a caller tool call waits as a pending external tool request until Codex sends its
 * output. One event reader routes events to the attached request. Between requests only
 * housekeeping is accepted; model output, a permission request, a finished tool call or a foreign
 * tool kills the session.
 *
 * The CLI keeps a log of the conversation in the session's private directory for as long as the
 * session lives. That directory is 0700 and is removed whenever the session ends, however it ends.
 */
export class CopilotLiveSession {
  state: SessionState = "starting";
  readonly key: string; readonly fingerprint: string; readonly window: string; effort?: string;
  ledger: LedgerState = { items: [] }; pending: string[] = [];
  lastUse = Date.now();
  private client?: CopilotClient; private readonly sessionId = randomUUID();
  /** Pending external tool requests by the model's tool call id. */
  private readonly requests = new Map<string, string>();
  private attached?: Attached; private readonly waiters = new Set<() => void>();
  private timer?: NodeJS.Timeout; private parkMs = 30 * 60000; private toolWaitMs = 25 * 60000;
  private closing?: Promise<void>; private retiring?: string; private stopped = false;
  private constructor(private readonly options: SessionOptions) { this.key = options.key; this.fingerprint = options.fingerprint; this.window = options.window; this.effort = options.effort; }

  get pid(): number | undefined { return this.client?.rpc.pid; }
  get directory(): string | undefined { return this.client?.directory; }

  /** Spawns, authenticates and creates the session; a failure leaves no process or directory behind. */
  static async start(options: SessionOptions, signal: AbortSignal): Promise<CopilotLiveSession> {
    const session = new CopilotLiveSession(options);
    const abort = () => { void session.stop(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await session.boot(signal);
      if (signal.aborted) throw cancelled();
      session.state = "turn_done";
      return session;
    } catch (error) {
      await session.stop();
      if (signal.aborted) throw cancelled();
      throw new SessionStartFailure(error instanceof ProviderError && error.code === "timeout" ? "initialize_timeout" : "spawn_failed");
    } finally { signal.removeEventListener("abort", abort); }
  }

  private async boot(signal: AbortSignal): Promise<void> {
    const client = this.client = await openCopilot(this.options.config, signal, { kind: "live", privateTmp: true });
    client.release();
    void this.pump(client);
    await client.rpc.request("session.create", { sessionId: this.sessionId, ...this.options.create, workingDirectory: client.directory, configDir: client.directory }, sessionLimits.startMs);
  }

  /** Sets how long the session waits when parked and when it waits for tool outputs (tool wait must stay under Copilot's 30 minutes). */
  timers(parkMs: number, toolWaitMs: number): void { this.parkMs = parkMs; this.toolWaitMs = toolWaitMs; if (this.state !== "closed" && this.state !== "starting") this.arm(); }

  /** The idle timer for the current state; a running turn pushes it back. */
  private arm(): void {
    clearTimeout(this.timer);
    // Copilot fails a pending tool request after 30 minutes and then calls the model on its own: close first.
    const waiting = this.state === "awaiting_outputs";
    const wait = waiting ? Math.min(this.toolWaitMs, this.parkMs) : this.parkMs;
    this.timer = setTimeout(() => { if (this.state === "generating") this.arm(); else void this.close("reaped", waiting ? "tool_wait_expired" : undefined); }, wait);
    this.timer.unref();
  }

  /** Closes the session now, or when its running turn ends. */
  retire(reason: string): Promise<void> {
    if (this.state === "generating") { this.retiring = reason; return Promise.resolve(); }
    return this.close("closed", reason);
  }

  /** Changes effort between turns, keeping the cached prefix. */
  async applyEffort(model: string, effort: string): Promise<boolean> {
    if (this.state !== "turn_done" || !this.client) return false;
    const result = await this.client.rpc.request("session.model.switchTo", { sessionId: this.sessionId, modelId: model, reasoningEffort: effort }, 10000).catch(() => undefined);
    const ok = result?.status === "applied" && result.deferred !== true;
    if (ok) this.effort = effort;
    return ok && this.state === "turn_done";
  }

  /** Whether Copilot has announced a pending request for each of these calls, waiting up to `ms` for the rest. */
  async hasRequests(ids: readonly string[], ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!ids.every(id => this.requests.has(id))) {
      const left = deadline - Date.now();
      if (left <= 0 || this.state === "closed") return false;
      await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); }; const timer = setTimeout(done, left); this.waiters.add(done); });
    }
    return true;
  }

  /** Attaches one request and starts it. The returned events end with `done`, or throw. */
  run(live: LiveTurn): AsyncIterable<InferenceEvent> {
    const attached: Attached = { live, queue: [], onAbort: () => this.abort(attached) };
    this.attached = attached; this.state = "generating"; this.arm();
    live.signal.addEventListener("abort", attached.onAbort, { once: true });
    return this.events(attached);
  }

  private async *events(attached: Attached): AsyncGenerator<InferenceEvent> {
    const { live } = attached;
    try {
      if (live.signal.aborted) throw cancelled();
      await this.begin(attached);
      for (;;) {
        // A complete answer is due its idle event within moments; without it the answer still stands.
        const event = await this.next(attached, live.turn.answered ? sessionLimits.idleMs : undefined);
        const step = event ? live.turn.accept(event) : { events: [], end: "idle" as const };
        yield* step.events;
        if (!step.end) continue;
        if (step.end === "tools") await this.handOver(attached);
        // The state changes before `done` leaves, so a fast follow-up never sees the session running.
        this.finish(attached, event ? undefined : "idle_missing");
        yield live.turn.done();
        return;
      }
    } catch (error) {
      // Spend the CLI reported before the request failed or was cancelled still counts.
      yield* this.queuedUsage(attached);
      throw this.failed(attached, error);
    } finally {
      // A consumer that stops reading mid-turn cancels the turn like an abort.
      if (this.attached === attached) this.abort(attached);
    }
  }

  private async begin(attached: Attached): Promise<void> {
    const { begin } = attached.live; const rpc = this.client!.rpc;
    if ("outputs" in begin) {
      await Promise.all([...begin.outputs].map(async ([callId, result]) => {
        const requestId = this.requests.get(callId);
        const rejected = () => new ProviderError("cli_failed", "Copilot did not accept a tool result", 502, { code: "delivery_rejected" });
        if (!requestId) throw rejected();
        const answer = await rpc.request("session.tools.handlePendingToolCall", { sessionId: this.sessionId, requestId, result }, 15000);
        if (answer.success !== true) throw rejected();
        this.requests.delete(callId);
      }));
    } else await rpc.request("session.sendMessages", { sessionId: this.sessionId, messages: begin.prompts }, 30000);
  }

  /** The next event of the attached request, or undefined once `timeoutMs` passes without one. */
  private next(attached: Attached, timeoutMs?: number): Promise<Record<string, unknown> | undefined> {
    if (attached.error) return Promise.reject(attached.error);
    if (attached.queue.length) return Promise.resolve(attached.queue.shift()!);
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => { attached.wake = undefined; resolve(undefined); }, timeoutMs);
      attached.wake = () => { clearTimeout(timer); attached.wake = undefined; if (attached.error) reject(attached.error); else resolve(attached.queue.shift()!); };
    });
  }

  /** The usage events that arrived but were not read when the request ended early. */
  private *queuedUsage(attached: Attached): Generator<InferenceEvent> {
    for (const event of attached.queue.splice(0)) {
      if (event.type !== "assistant.usage") continue;
      try { yield* attached.live.turn.accept(event).events; } catch { /* The request is already failing; this usage is still counted if it was valid. */ }
    }
  }

  /** Waits until Copilot has announced a pending request for every call it just made, so the next request can answer them. */
  private async handOver(attached: Attached): Promise<void> {
    const ids = attached.live.turn.calls.map(call => call.id);
    const announced = await this.hasRequests(ids, sessionLimits.requestsMs);
    if (attached.error) throw attached.error;
    if (!announced) throw new ProviderError("invalid_tool_call", "Copilot did not hand over its tool requests", 502);
    if ([...this.requests.keys()].some(id => !ids.includes(id))) throw new ProviderError("invalid_tool_call", "Copilot requested a tool call it did not announce", 502);
  }

  private finish(attached: Attached, closeWith?: string): void {
    const { live } = attached; const calls = live.turn.calls;
    this.detach(attached);
    this.ledger = { items: [...live.prefix, ...echoDigests(live.turn.text, calls)] };
    this.pending = calls.map(call => call.id); this.state = calls.length ? "awaiting_outputs" : "turn_done";
    this.arm();
    live.onEnd("ended");
    if (closeWith) void this.close("closed", closeWith);
    else if (this.retiring) void this.close("closed", this.retiring);
  }

  /** Cancels the attached request. Its tool requests and half-written answer are not worth keeping, so the process goes. */
  private abort(attached: Attached): void {
    if (this.attached !== attached) return;
    this.detach(attached); attached.error = cancelled(); attached.wake?.(); this.wakeWaiters();
    attached.live.onEnd("interrupted");
    void this.close("closed", "interrupted");
  }

  /** A stream failure closes the session at once: the CLI must not act on a foreign or failed turn. */
  private failed(attached: Attached, error: unknown): unknown {
    if (this.attached === attached) {
      this.detach(attached); attached.live.onEnd("failed");
      void this.close("crashed", error instanceof ProviderError ? error.upstream?.code ?? error.code : "failed");
    }
    return error;
  }

  private detach(attached: Attached): void {
    if (this.attached === attached) this.attached = undefined;
    attached.live.signal.removeEventListener("abort", attached.onAbort);
    this.lastUse = Date.now();
  }

  private wakeWaiters(): void { for (const wake of [...this.waiters]) wake(); }

  private async pump(client: CopilotClient): Promise<void> {
    try {
      for await (const message of client.rpc.notifications()) this.route(message);
      this.crash(new ProviderError("cli_failed", "Copilot CLI closed before completion"), "exited");
    } catch (error) { this.crash(error instanceof ProviderError ? error : new ProviderError("cli_failed", "Copilot CLI failed"), error instanceof ProviderError ? error.code : "failed"); }
  }

  /** Fails the attached request and ends the session; an end we asked for is not a crash. */
  private crash(error: ProviderError, reason: string): void {
    if (this.state === "closed" || this.stopped) return;
    if (this.attached) { this.attached.error = error; this.attached.wake?.(); }
    this.wakeWaiters();
    void this.close("crashed", reason, false);
  }

  /** The session did something it must not: stop it before it can spend more (abort, then SIGKILL of the process group). */
  private violation(error: ProviderError, reason: string): void {
    if (this.attached) { this.attached.error = error; this.attached.wake?.(); }
    this.wakeWaiters();
    void this.close("crashed", reason, true);
  }

  private route(message: Record<string, unknown>): void {
    const params = record(message.params); if (params.sessionId !== this.sessionId || this.state === "closed") return;
    const event = record(params.event); const data = record(event.data); const type = typeof event.type === "string" ? event.type : "";
    const reject = (reason: string, text = "Copilot did something beyond caller-dispatched inference") => this.violation(new ProviderError("invalid_tool_call", text), reason);
    if (event.agentId) return this.violation(new ProviderError("invalid_stream", "Copilot emitted an unexpected sub-agent event"), "sub_agent");
    if (type === "permission.requested") return reject("permission", "Copilot requested execution beyond caller-dispatched inference");
    if (type === "tool.execution_start" || type === "external_tool.requested") {
      const id = data.toolCallId;
      if (typeof data.toolName !== "string" || !this.options.toolNames.has(data.toolName) || typeof id !== "string" || !id) return reject("foreign_tool", "Copilot used a tool the caller did not offer");
      if (!this.attached && !this.pending.includes(id)) return reject("unannounced_tool", "Copilot used a tool call nobody is waiting for");
      if (type === "external_tool.requested") {
        if (typeof data.requestId !== "string" || !data.requestId) return reject("foreign_tool", "Copilot used a tool the caller did not offer");
        this.requests.set(id, data.requestId); this.wakeWaiters();
        return;
      }
    }
    const attached = this.attached;
    if (!attached) {
      if (acceptedBetweenRequests(type) || type === "tool.execution_start") return;
      // A finished tool call nobody answered is the 30-minute timeout (or a failure); the runtime's own model call follows within seconds.
      return reject(completions.has(type) ? "unattended_completion" : "unattended_output", "Copilot acted outside a request");
    }
    attached.queue.push(event);
    if (attached.queue.length > 100000) this.violation(new ProviderError("output_too_large", "Copilot event backlog exceeds its limit"), "backlog");
    attached.wake?.();
  }

  /**
   * Ends the session: kills the process group, removes its directory, and tells the registry. Safe to call twice.
   * A session that may still be working (generating, waiting on tools, or misbehaving) is told to abort first.
   */
  close(outcome: SessionEnd, reason?: string, abort = this.state === "generating" || this.state === "awaiting_outputs"): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closed"; clearTimeout(this.timer);
    if (this.attached) { this.attached.error ??= new ProviderError("cli_failed", "Copilot session closed", 502); this.attached.wake?.(); }
    this.wakeWaiters();
    return this.closing = this.stop(abort).then(() => this.options.onClose(this, outcome, reason));
  }

  /** Aborts the running turn if asked (at most `abortMs`), kills the process group and removes the directory; idempotent. */
  async stop(abort = false): Promise<void> {
    this.stopped = true; clearTimeout(this.timer);
    const client = this.client; if (!client) return;
    if (abort) await client.rpc.request("session.abort", { sessionId: this.sessionId }, sessionLimits.abortMs).catch(() => {});
    await client.close(undefined, true).catch(() => {});
  }

  /** For a gateway that is exiting right now: no awaiting, so only synchronous calls. */
  emergencyStop(): void {
    this.stopped = true;
    this.client?.rpc.kill();
    if (this.client) { try { rmSync(this.client.directory, { recursive: true, force: true }); } catch { /* Best effort; the next gateway sweeps it. */ } }
  }
}
