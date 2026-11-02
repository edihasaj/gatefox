import { randomUUID } from "node:crypto";
import type { ProviderConfig } from "../config.js";
import type { InferenceEvent } from "../protocol/types.js";
import { echoDigests, type LedgerState } from "./claude-ledger.js";
import { openCopilot, type CopilotClient } from "./copilot-client.js";
import type { Prompt, ToolResult } from "./copilot-render.js";
import { reportException } from "../error-report.js";
import { record } from "./copilot-rpc.js";
import type { CopilotTurn } from "./copilot-turn.js";
import { ProviderError } from "./provider.js";
import { CliContinuityUnavailable } from "./cli-continuity.js";
import { telemetry } from "../telemetry.js";

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
  /** Bound confirmation of a requested effort change. */
  switchMs: 10000,
  /** How long the CLI may take to accept one tool result. */
  deliverMs: 15000,
};
/** Tool results handed over at once: well below the connection's limit of 32 requests in flight. */
const deliveryBatch = 16;
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
// Between requests the model must do nothing, so only these housekeeping events are accepted; anything else
// (output, a model call, a finished tool call, compaction) means the runtime is acting on its own and may be billing.
// CLI 1.0.97 sends `session.idle` right after `assistant.idle`, so it arrives once the finished request has detached.
const housekeeping = new Set(["session.info", "session.usage_info", "session.usage_checkpoint", "session.idle",
  "session.warning", "session.title_changed", "pending_messages.modified"]);
const modelHousekeeping = new Set(["model.call_finished", "model.model_call_success", "model.message", "model.response",
  "model.call_final_result", "model.turn_ended", "model.messages_snapshot", "model.log"]);
const acceptedBetweenRequests = (type: string, data: Record<string, unknown>) =>
  (housekeeping.has(type) || modelHousekeeping.has(type)) && (type !== "pending_messages.modified" || Object.keys(data).length === 0);
// The CLI announces a new session right after `session.create` answers; these are accepted until the first request attaches.
const lifecycle = new Set(["session.start", "session.managed_settings_resolved"]);
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
  /**
   * New conversation items as user messages (rendered into the session's folder, which holds their images), or the caller's tool outputs by call id.
   * `stopped` says the request is over: the rendering must write nothing more, since the folder is about to go.
   */
  begin: { prompts: (directory: string, stopped: () => boolean) => Promise<Prompt[]> }
    | { outputs: Map<string, string | ToolResult>; prompts?: (directory: string, stopped: () => boolean) => Promise<Prompt[]> };
  /** Ledger digests of this request's canonical input. */
  prefix: string[];
  turn: CopilotTurn;
  signal: AbortSignal;
  /** Called once: "ended", or why it did not end. */
  onEnd(outcome: "ended" | "interrupted" | "failed"): void;
}

interface Attached {
  live: LiveTurn; queue: Array<Record<string, unknown>>; wake?: () => void; error?: Error; onAbort: () => void;
  /** The request's running usage total once its queued usage was added after it ended early, until it is handed over. */
  usage?: InferenceEvent;
  /** Set when the request was cancelled: settles once the session is gone and the usage it reported meanwhile has been added. */
  over?: Promise<void>;
}

/**
 * One long-lived Copilot CLI process and session for one Codex thread. Native history stays in
 * the session: a caller tool call waits as a pending external tool request until Codex sends its
 * output. One event reader routes events to the attached request. Between requests only
 * housekeeping is accepted, plus the CLI's start-up announcements before the first request and
 * the confirmation of an effort change the gateway asked for; model output, a permission request,
 * a finished tool call or a foreign tool kills the session.
 *
 * The CLI keeps a log of the conversation, and the gateway the history's images, in the session's
 * private directory for as long as the session lives. That directory is 0700 and is removed
 * whenever the session ends, however it ends.
 */
export class CopilotLiveSession {
  /** Only the event router changes: its fields and helper methods retain the v1 instance ABI. */
  static adoptEventPolicy(session: CopilotLiveSession): void { session.route = CopilotLiveSession.prototype.route; }
  readonly queuedInputVersion = 1;
  reasoningLedgerVersion = 1;
  state: SessionState = "starting";
  readonly key: string; readonly fingerprint: string; readonly window: string; effort?: string;
  ledger: LedgerState = { items: [] }; pending: string[] = [];
  lastUse = Date.now();
  private client?: CopilotClient; private readonly sessionId = randomUUID();
  /** Pending external tool requests by the model's tool call id. */
  private readonly requests = new Map<string, string>();
  private attached?: Attached; private readonly waiters = new Set<() => void>();
  /** The cancelled request whose session is being aborted: the usage the CLI still reports for it is routed to it (see `route`). */
  private draining?: Attached;
  /** The event reader's end, which comes after the last event the CLI wrote was routed. Never rejects. */
  private pumping: Promise<void> = Promise.resolve();
  /** The messages being rendered into the session's folder; settled when the rendering ended, never rejected. */
  private rendering: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout; private parkMs = 30 * 60000; private toolWaitMs = 25 * 60000;
  private closing?: Promise<void>; private stopping?: Promise<void>; private retiring?: string; private stopped = false;
  /** Handed to the registry; only then does its end reach `onClose`. */
  private started = false;
  /** Whether a request has attached yet: the CLI's own start-up announcements are accepted until then. */
  private served = false;
  /**
   * An effort change in progress: the CLI confirms it with `session.model_change`, which may be routed after the change returns,
   * even after the next request attached. It stays until the confirmation is routed or that request ends.
   */
  private switching?: { model: string; effort: string };
  /** How the session ended, set when it starts to close. */
  end?: { outcome: SessionEnd; reason?: string };
  private constructor(private readonly options: SessionOptions) { this.key = options.key; this.fingerprint = options.fingerprint; this.window = options.window; this.effort = options.effort; }

  get pid(): number | undefined { return this.client?.rpc.pid; }
  get directory(): string | undefined { return this.client?.directory; }
  get providerId(): string { return this.options.config.id; }
  get model(): string { return String(this.options.create.model); }

  /** Spawns, authenticates and creates the session; a failure leaves no process or directory behind. */
  static async start(options: SessionOptions, signal: AbortSignal): Promise<CopilotLiveSession> {
    const session = new CopilotLiveSession(options);
    const abort = () => { void session.stop(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await session.boot(signal);
      if (signal.aborted) throw cancelled();
      // Something the session did during start-up already closed it; it is never handed out.
      if (session.state === "closed") throw new SessionStartFailure("spawn_failed");
      session.state = "turn_done"; session.started = true;
      return session;
    } catch (error) {
      await (session.closing ?? session.stop());
      if (signal.aborted) throw cancelled();
      throw new SessionStartFailure(error instanceof ProviderError && error.code === "timeout" ? "initialize_timeout" : "spawn_failed");
    } finally { signal.removeEventListener("abort", abort); }
  }

  private async boot(signal: AbortSignal): Promise<void> {
    const client = this.client = await openCopilot(this.options.config, signal, { kind: "live" });
    client.release();
    this.pumping = this.pump(client);
    await client.rpc.request("session.create", { sessionId: this.sessionId, ...this.options.create, workingDirectory: client.directory, configDir: client.directory }, sessionLimits.startMs);
    // Events reach the router a tick after the answer that followed them; route what the CLI sent so far while the
    // session is still starting, so one that misbehaved now is caught here and never handed to a request.
    await new Promise(resolve => setImmediate(resolve));
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
    this.switching = { model, effort };
    const rpc = this.client.rpc;
    const result = await rpc.request("session.model.switchTo", { sessionId: this.sessionId, modelId: model, reasoningEffort: effort }, sessionLimits.switchMs).catch(() => undefined);
    // A change that failed because the CLI is gone is the session's death, whether or not the event router has noticed yet.
    if (!result && rpc.closed) this.crash(new ProviderError("cli_failed", "Copilot CLI closed before completion"), "exited");
    if ((this.state as SessionState) === "closed") throw new CliContinuityUnavailable("Copilot", "effort_unconfirmed");
    const ok = result?.status === "applied" && result.deferred !== true;
    if (ok) this.effort = effort;
    else if (result?.status === "rejected" && this.switching) this.switching = undefined;
    else {
      const error = new CliContinuityUnavailable("Copilot", "effort_unconfirmed");
      if ((this.state as SessionState) !== "closed") this.violation(error, "effort_unconfirmed");
      throw error;
    }
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

  /** Attaches one request and starts it. The returned events end with `done`, or throw; a closed session fails at once. */
  run(live: LiveTurn): AsyncIterable<InferenceEvent> {
    if (this.state === "closed") return (async function* (): AsyncGenerator<InferenceEvent> { throw new ProviderError("cli_failed", "Copilot session closed", 502); })();
    const attached: Attached = { live, queue: [], onAbort: () => this.abort(attached) };
    // From here every event goes to the request; a late effort confirmation is still told apart (see `route`).
    this.attached = attached; this.state = "generating"; this.served = true; this.arm();
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
        // A request cancelled or failed while its consumer held an event stops here: it must not finish the turn.
        if (attached.error) throw attached.error;
        if (!step.end) continue;
        if (step.end === "tools") await this.handOver(attached);
        // The state changes before `done` leaves, so a fast follow-up never sees the session running.
        this.finish(attached, event ? undefined : "idle_missing");
        yield live.turn.done();
        return;
      }
    } catch (error) {
      // Spend the CLI reported before the request failed or was cancelled still counts, as one running total.
      yield* this.lateUsage(attached);
      throw this.failed(attached, error);
    } finally {
      // A consumer that stops reading mid-turn cancels the turn like an abort.
      if (this.attached === attached) this.abort(attached);
    }
  }

  private async begin(attached: Attached): Promise<void> {
    const { begin } = attached.live; const rpc = this.client!.rpc;
    // A cancelled or failed request (or a session that closed) sends nothing more: the session is being aborted, and a message
    // or a tool result delivered now would start a model call that nobody is waiting for. The check comes right before each send.
    const stillWanted = () => { if (attached.error) throw attached.error; };
    if (!("outputs" in begin)) {
      const render = begin.prompts(this.client!.directory, () => attached.error !== undefined);
      this.rendering = render.then(() => {}, () => {});
      // A rendering that failed because the session ended under it (its folder is gone) failed because of that.
      const messages = await render.catch(error => { throw attached.error ?? error; }); stillWanted();
      await rpc.request("session.sendMessages", { sessionId: this.sessionId, messages }, 30000); return;
    }
    if (begin.prompts) {
      const render = begin.prompts(this.client!.directory, () => attached.error !== undefined);
      this.rendering = render.then(() => {}, () => {});
      const messages = await render.catch(error => { throw attached.error ?? error; });
      for (const message of messages) {
        stillWanted();
        // Native immediate-mode admission queues steering at the active tool/model gap.
        // Acknowledgment must precede every tool result; rejection never falls back.
        await rpc.request("session.send", { sessionId: this.sessionId, ...message, mode: "immediate" }, sessionLimits.deliverMs)
          .catch(() => { throw attached.error ?? new CliContinuityUnavailable("Copilot", "steering_rejected"); });
      }
    }
    // Anything but a confirmed delivery (a refusal, an error reply, no answer in time, a full connection) means the
    // session may not hold the result. Nothing has been streamed yet, so the request falls back to one-shot.
    const rejected = () => new ProviderError("cli_failed", "Copilot did not accept a tool result", 502, { code: "delivery_rejected" });
    const deliver = async ([callId, result]: [string, string | ToolResult]) => {
      const requestId = this.requests.get(callId); if (!requestId) throw rejected();
      const answer = await rpc.request("session.tools.handlePendingToolCall", { sessionId: this.sessionId, requestId, result }, sessionLimits.deliverMs).catch(() => undefined);
      if (answer?.success !== true) throw rejected();
      this.requests.delete(callId);
    };
    const outputs = [...begin.outputs];
    for (let start = 0; start < outputs.length; start += deliveryBatch) { stillWanted(); await Promise.all(outputs.slice(start, start + deliveryBatch).map(deliver)); }
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

  /**
   * Adds one usage event to the request's totals and keeps the running total to hand over. The request reports every call it
   * added as one event, so each call must be added exactly once: here, and nowhere else.
   */
  private addUsage(attached: Attached, event: Record<string, unknown>): void {
    try { attached.usage = attached.live.turn.accept(event).events.at(-1) ?? attached.usage; } catch { /* The request is already failing; this usage is still counted if it was valid. */ }
  }

  /** Adds the usage that arrived but was not read when the request ended early to its totals, once. */
  private settleUsage(attached: Attached): void {
    for (const event of attached.queue.splice(0)) if (event.type === "assistant.usage") this.addUsage(attached, event);
  }

  /**
   * The usage the request has not handed over yet, as one running total, and, for a cancelled request, each usage the CLI
   * reports while its session is aborted (up to `abortMs`): it is handed over as it arrives, and the request ends once the
   * session is gone, so a process that leaves in between has it already.
   */
  private async *lateUsage(attached: Attached): AsyncGenerator<InferenceEvent> {
    let over = !attached.over; void attached.over?.then(() => { over = true; attached.wake?.(); });
    for (;;) {
      this.settleUsage(attached);
      if (attached.usage) { const usage = attached.usage; attached.usage = undefined; yield usage; continue; }
      if (over) return;
      await new Promise<void>(resolve => { attached.wake = () => { attached.wake = undefined; resolve(); }; });
    }
  }

  /** Waits until Copilot has announced a pending request for every call it just made, so the next request can answer them. */
  private async handOver(attached: Attached): Promise<void> {
    const ids = attached.live.turn.calls.map(call => call.id);
    const announced = await this.hasRequests(ids, sessionLimits.requestsMs);
    if (attached.error) throw attached.error;
    if (!announced) throw new ProviderError("invalid_tool_call", "Copilot did not hand over its tool requests", 502, { code: "tool_request_missing", event: "copilot.tool_use" });
    if ([...this.requests.keys()].some(id => !ids.includes(id))) throw new ProviderError("invalid_tool_call", "Copilot requested a tool call it did not announce", 502, { code: "unannounced_tool", event: "copilot.tool_use" });
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
    this.detach(attached); attached.error = cancelled(); this.settleUsage(attached); attached.wake?.(); this.wakeWaiters();
    // The CLI may still report the call it was making while it is aborted (up to `abortMs`); that usage is routed to this
    // request. The end is reported once the session is gone and the last event was routed, whether or not the consumer reads on.
    this.draining = attached;
    attached.over = this.close("closed", "interrupted").then(() => this.pumping).then(() => {
      this.draining = undefined; this.settleUsage(attached); attached.live.onEnd("interrupted");
    }).catch(error => reportException(error, "copilot_live_abort"));
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
    if (this.attached === attached) { this.attached = undefined; this.switching = undefined; }
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

  /** Whether a detached `session.model_change` confirms the effort change in progress (once). */
  private confirmsSwitch(data: Record<string, unknown>): boolean {
    const switching = this.switching;
    if (!switching || data.reasoningEffort !== switching.effort || (data.newModel !== undefined && data.newModel !== switching.model)) return false;
    this.switching = undefined;
    return true;
  }

  /** The session did something it must not: stop it before it can spend more (abort, then SIGKILL of the process group). */
  private violation(error: ProviderError, reason: string): void {
    if (this.attached) { this.attached.error = error; this.attached.wake?.(); }
    this.wakeWaiters();
    void this.close("crashed", reason, true);
  }

  private route(message: Record<string, unknown>): void {
    const params = record(message.params); if (params.sessionId !== this.sessionId) return;
    if (this.state === "closed") {
      const late = record(params.event);
      // The usage of every call the aborted CLI still reports goes straight into the request's totals: there is no queue to fill, so none is dropped.
      if (this.draining && late.type === "assistant.usage") { this.addUsage(this.draining, late); this.draining.wake?.(); }
      return;
    }
    const event = record(params.event); const data = record(event.data); const type = typeof event.type === "string" ? event.type : "";
    const reject = (reason: string, text = "Copilot did something beyond caller-dispatched inference") => {
      const known = new Set([...housekeeping, ...modelHousekeeping, ...lifecycle, ...completions, "model.call_start", "model.model_call_started", "model.turn_started",
        "assistant.turn_start", "assistant.turn_end", "assistant.message", "assistant.message_delta", "assistant.usage", "session.compaction_start", "session.truncation",
        "session.error", "session.model_change", "session.tools_updated", "session.mcp_server_status_changed", "tool.execution_progress", "pending_messages.modified"]);
      telemetry("copilot_session_violation", { reason, eventType: known.has(type) ? type : "unknown", state: this.state,
        pendingCalls: this.pending.length, attached: !!this.attached });
      this.violation(new ProviderError("invalid_tool_call", text), reason);
    };
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
    // The confirmation of an effort change may be routed after the request it was made for attached. One for another effort
    // than asked means the session runs at an effort nobody asked for: end it before its answer is read (the request, if it
    // has produced nothing, is served one-shot).
    if (type === "session.model_change" && this.switching) {
      if (this.confirmsSwitch(data)) return;
      return this.violation(new ProviderError("cli_failed", "Copilot confirmed another reasoning effort than the one requested", 502), "effort_mismatch");
    }
    const attached = this.attached;
    if (!attached) {
      if (acceptedBetweenRequests(type, data) || type === "tool.execution_start") return;
      if (!this.served && lifecycle.has(type)) return;
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
    this.state = "closed"; clearTimeout(this.timer); this.end = { outcome, reason };
    if (this.attached) { this.attached.error ??= new ProviderError("cli_failed", "Copilot session closed", 502); this.attached.wake?.(); }
    this.wakeWaiters();
    // It never rejects: nobody awaits most closes, and a bookkeeping failure in the registry must not end the process.
    return this.closing = this.stop(abort).then(() => { if (this.started) this.options.onClose(this, outcome, reason); }).catch(error => reportException(error, "copilot_live_close"));
  }

  /** Settles once a closing session's process is gone and its folder removed; at once for a session that is not closing. */
  get finished(): Promise<void> { return this.closing ?? Promise.resolve(); }

  /** Aborts the running turn if asked (at most `abortMs`), kills the process group and removes the directory; idempotent, and every caller waits for the same end. */
  stop(abort = false): Promise<void> {
    this.stopped = true; clearTimeout(this.timer);
    // Before the process exists there is nothing to wait for; a later call, once it does, still ends it.
    const client = this.client; if (!client) return Promise.resolve();
    return this.stopping ??= (async () => {
      if (abort) await client.rpc.request("session.abort", { sessionId: this.sessionId }, sessionLimits.abortMs).catch(() => {});
      // A rendering in progress writes into the folder: it stops at its next image (the request is over), and ends before the folder goes.
      await this.rendering;
      await client.close(undefined, true).catch(() => {});
    })();
  }
}
