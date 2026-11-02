import type { ProviderConfig } from "../config.js";
import type { ChatToolSelection, InferenceEvent, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import { registerActivityProbe, registerShutdownHook } from "../runtime-activity.js";
import { telemetry } from "../telemetry.js";
import { decide, ledgerEntries, queuedToolContinuation, type LedgerEntry, type LedgerPhase } from "./claude-ledger.js";
import type { ClaudeConversation, ClaudeImages } from "./claude-render.js";
import { sessionKey } from "./claude-live-contract.js";
import { CopilotLiveSession, SessionStartFailure, sessionLimits, type SessionEnd, type SessionState } from "./copilot-live-session.js";
import { choiceLine, copilotPrompts, copilotToolResult, fitsInline, imagesByItem, type NativeTool, type ToolResult } from "./copilot-render.js";
import type { CopilotTurn } from "./copilot-turn.js";
import { ProviderError } from "./provider.js";
import { CliContinuityUnavailable, CopilotSessionPreserved } from "./cli-continuity.js";
import { copilotContinuationLedger } from "./copilot-ledger-compat.js";

/**
 * Live Copilot sessions: one long-lived CLI process per Codex thread. A request continues its thread's
 * session when the history extends what the session holds. When it does not, or the session's settings
 * changed, the thread is reseeded in a new process (one cache write, which a one-shot request pays on
 * every call). Anything that fails before output falls back to the one-shot path.
 */
export type CopilotMissReason = "no_thread" | "request_kind" | "concurrent" | "capacity" | "spawn_failed" | "initialize_timeout" | "delivery_rejected" | "stream_failed" | "attach_failed" |
  "fingerprint_changed" | "window_changed" | "prefix_diverged" | "unexpected_tail" | "forced_choice" | "effort_midturn" | "effort_rejected" | "tool_request_missing" | "large_tool_result" |
  "session_dead" | "evicted" | "reaped" | "interrupted" | "tool_wait_expired" | "idle_missing";

export interface CopilotLiveInput {
  /** Provider identity; a session never crosses it. */
  scope: string; threadId: string; windowId?: string;
  callerHistoryReplacement?: boolean;
  model: string;
  /** The requested effort; absent leaves the session's own. */
  effort?: string;
  /** Digest of everything the CLI fixes at creation (copilot-create.ts sessionFingerprint). */
  fingerprint: string;
  /** `session.create` parameters without the id and directories. */
  create: Record<string, unknown>;
  config: ProviderConfig;
  /** The full caller catalog, for the ledger. */
  catalog: OpenAITool[];
  /** The same tools under the names the CLI sees (the session's own tools are `create.tools`). */
  native: NativeTool[];
  choice?: ChatToolSelection;
  /** The restored Responses request. */
  request: ResponsesRequest;
  /** The translated messages after the leading instructions, with tool calls marked and images replaced by labels. */
  conversation: ClaudeConversation;
  images: ClaudeImages;
  /** Translated messages that moved into the system message; the ledger skips them. */
  leading: number;
  newTurn(): CopilotTurn;
}
export type CopilotLiveOutcome = { kind: "stream"; events: AsyncIterable<InferenceEvent> } | { kind: "fallback"; reason: CopilotMissReason };

export interface CopilotLiveSettings { max: number; parkMinutes: number; toolWaitMinutes: number }

interface Registry {
  interfaceVersion: 1;
  sessions: Map<string, CopilotLiveSession>;
  /** Keys with an attach in progress: deciding, applying effort or starting a process. */
  starting: Set<string>;
  /** How each key's last session ended, so the next spawn reports why it had none. */
  ended: Map<string, string>;
  /** The provider scope that owns each key, so one provider can retire its own sessions. */
  scopes: Map<string, string>;
  /** Why each key that was starting when its scope was retired must retire the session it gets. Absent in a registry an older release created. */
  retired?: Map<string, string>;
}
type Plan = Exclude<ReturnType<typeof decide>, { kind: "reseed" }> | { kind: "seed" }
  | { kind: "continue_outputs_with_messages"; outputs: LedgerEntry[]; from: number };
const symbol = Symbol.for("harness-gateway/copilot-sessions/v1");
const recentToolWait = 10 * 60 * 1000;
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);

function registry(): Registry {
  const scope = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = scope[symbol];
  if (existing?.interfaceVersion === 1) {
    for (const session of existing.sessions.values()) CopilotLiveSession.adoptEventPolicy(session);
    return existing;
  }
  const created: Registry = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), ended: new Map(), scopes: new Map() };
  scope[symbol] = created;
  // Busy while a session generates, or waits on tool outputs it got recently; a longer wait gains nothing from its cache.
  registerActivityProbe("copilot_sessions", () => created.starting.size > 0 || [...created.sessions.values()].some(session => session.state === "generating" ||
    (session.state === "awaiting_outputs" && Date.now() - session.lastUse < recentToolWait)));
  registerShutdownHook("copilot_sessions", () => closeAll(created, "shutdown"));
  // A gateway that exits without closing its sessions is covered by copilot-client.ts, whose exit handler kills every CLI it started.
  return created;
}

const closeAll = async (reg: Registry, reason: string) => { await Promise.all([...reg.sessions.values()].map(session => session.close("closed", reason))); };

export function copilotLive(settings: CopilotLiveSettings) {
  const reg = registry();
  return {
    attach: (input: CopilotLiveInput, signal: AbortSignal) => attach(reg, settings, input, signal),
    /** Closes every session and forgets how earlier ones ended (tests; shutdown uses the registry hook). */
    stop: async () => { await closeAll(reg, "stopped"); reg.ended.clear(); reg.scopes.clear(); },
    sessions: (): CopilotLiveSession[] => [...reg.sessions.values()],
  };
}

/** Retires every live session whose provider scope `reason` names, without creating the registry. */
export function retireCopilotScopes(reason: (scope: string) => string | undefined): void {
  const reg = (globalThis as unknown as Record<symbol, Registry | undefined>)[symbol];
  if (reg?.interfaceVersion !== 1) return;
  for (const [key, session] of reg.sessions) { const scope = reg.scopes.get(key); const why = scope === undefined ? undefined : reason(scope); if (why) void session.retire(why); }
  // A session that is still starting is in no map yet. The attach that starts it retires it as soon as its request runs.
  for (const key of reg.starting) { const scope = reg.scopes.get(key); const why = scope === undefined ? undefined : reason(scope); if (why) (reg.retired ??= new Map()).set(key, why); }
}

/** Retires every live session one provider scope owns: a provider switched to one-shot calls this. */
export const retireCopilotScope = (scope: string, reason: string): void => retireCopilotScopes(owner => owner === scope ? reason : undefined);

async function attach(reg: Registry, settings: CopilotLiveSettings, input: CopilotLiveInput, signal: AbortSignal): Promise<CopilotLiveOutcome> {
  if (signal.aborted) throw cancelled();
  const key = sessionKey(input.scope, input.threadId);
  if (reg.starting.has(key)) return { kind: "fallback", reason: "concurrent" };
  reg.starting.add(key); reg.scopes.set(key, input.scope);
  try { return await place(reg, settings, key, input, signal); }
  finally { reg.starting.delete(key); reg.retired?.delete(key); if (!reg.sessions.has(key)) reg.scopes.delete(key); }
}

/** Slots in use as the attach for `key` sees them: every session, plus each earlier attach that has no session yet. */
function slotsTaken(reg: Registry, key: string): number {
  let taken = reg.sessions.size;
  for (const other of reg.starting) { if (other === key) break; if (!reg.sessions.has(other)) taken++; }
  return taken;
}

/**
 * The session to make room: one that is already closing (waiting for it evicts nobody), else the least recently used
 * one that is parked after a finished turn, else the least recently used one waiting for tool outputs. A running
 * session is never evicted, nor one whose own request is being placed.
 */
function evictable(reg: Registry): CopilotLiveSession | undefined {
  const idle = [...reg.sessions.values()].filter(session => session.state !== "generating" && session.state !== "starting" && !reg.starting.has(session.key)
    && (session.state === "closed" || Date.now() - session.lastUse >= 30 * 60 * 1000)).sort((a, b) => a.lastUse - b.lastUse);
  return idle.find(session => session.state === "closed") ?? idle.find(session => session.state === "turn_done") ?? idle.find(session => session.state === "awaiting_outputs");
}

/** Why a thread has no session after its last one ended this way, for the next spawn to report; undefined when the end needs no explanation. */
function endReason(end: CopilotLiveSession["end"]): CopilotMissReason | undefined {
  if (!end) return undefined;
  if (end.outcome === "crashed") return "session_dead";
  if (end.reason === "interrupted" || end.reason === "tool_wait_expired" || end.reason === "idle_missing") return end.reason;
  return end.outcome === "evicted" || end.outcome === "reaped" ? end.outcome : undefined;
}

async function place(reg: Registry, settings: CopilotLiveSettings, key: string, input: CopilotLiveInput, signal: AbortSignal): Promise<CopilotLiveOutcome> {
  let session = reg.sessions.get(key);
  if (session) CopilotLiveSession.adoptEventPolicy(session);
  if (session?.state === "generating") return { kind: "fallback", reason: "concurrent" };
  const { entries, messages } = ledgerEntries(input.request, input.catalog, input.leading);
  const window = input.windowId ?? "";
  let reason: CopilotMissReason | undefined; let divergedAt: number | undefined; let plan: Plan | undefined; let parkedMs: number | undefined;
  let outputs: Map<string, string | ToolResult> | undefined;
  if (session?.state === "closed") {
    // It is still ending (an abort, then the kill). It no longer holds the thread or a slot, and how it ended is why
    // this request starts over. Its process and folder are gone before a new one starts.
    reg.sessions.delete(key); reason = endReason(session.end);
    await session.finished; session = undefined;
  } else if (session) {
    parkedMs = Date.now() - session.lastUse;
    const ledger = copilotContinuationLedger(session, input.request, input.catalog, input.leading, entries);
    const decision = decide(ledger, entries, messages, session.state as LedgerPhase, session.pending);
    if (session.fingerprint !== input.fingerprint) reason = "fingerprint_changed";
    else if (session.window !== window) reason = "window_changed";
    else if (decision.kind === "reseed") {
      const queued = decision.reason === "unexpected_tail" && session.state === "awaiting_outputs"
        ? queuedToolContinuation(entries, decision.divergedAt, session.pending, messages) : undefined;
      if (queued && session.queuedInputVersion === 1 && messages === input.conversation.length && input.effort === session.effort) {
        outputs = toolResults(input, queued.outputs);
        if (!queued.outputs.every(entry => input.conversation[entry.first]?.role === "tool" && input.conversation[entry.first]?.tool_call_id === entry.callId)) reason = "unexpected_tail";
        else if (![...outputs.values()].every(fitsInline)) reason = "large_tool_result";
        else if (!(await session.hasRequests(session.pending, sessionLimits.pendingMs))) reason = "tool_request_missing";
        else plan = { kind: "continue_outputs_with_messages", ...queued };
      } else reason = decision.reason;
      divergedAt = decision.divergedAt;
    }
    // The tail renders from the conversation; a count that does not match the translation is not trusted.
    else if (decision.kind === "continue_user" && messages !== input.conversation.length) reason = "unexpected_tail";
    else if (decision.kind === "continue_outputs" && decision.outputs.some(entry => { const message = input.conversation[entry.first]; return message?.role !== "tool" || message.tool_call_id !== entry.callId; })) reason = "unexpected_tail";
    // A tool result cannot carry the choice line, so a forced, required or disabled choice starts the thread over.
    else if (decision.kind === "continue_outputs" && input.choice !== undefined && input.choice !== "auto") reason = "forced_choice";
    // Images in a tool result travel inline; past the budget they would not fit one RPC message, while a seed sends them as files.
    else if (decision.kind === "continue_outputs" && ![...(outputs = toolResults(input, decision.outputs)).values()].every(fitsInline)) reason = "large_tool_result";
    else if (decision.kind === "continue_outputs" && !(await session.hasRequests(session.pending, sessionLimits.pendingMs))) reason = "tool_request_missing";
    else if (input.effort !== undefined && input.effort !== session.effort) {
      if (session.state === "awaiting_outputs") reason = "effort_midturn";
      else if (!(await session.applyEffort(input.model, input.effort))) reason = "effort_rejected";
    }
    // A crash, a violation or a timer can end the session during the waits above; that, not what the wait saw, is why the thread starts over.
    if ((session.state as SessionState) === "closed") throw new CliContinuityUnavailable("Copilot", "session_dead");
    if (!reason && decision.kind !== "reseed") plan = decision;
    if (reason) {
      const ownedReplacement = reason === "prefix_diverged" && input.callerHistoryReplacement && session.state === "turn_done" && !session.pending.length;
      if (!ownedReplacement && ["prefix_diverged", "unexpected_tail", "forced_choice", "effort_midturn", "effort_rejected", "tool_request_missing"].includes(reason)) {
        telemetry("copilot_session", { outcome: "preserved", missReason: reason, provider: input.config.id, model: input.model, threadKey: key.slice(0, 8), liveSessions: reg.sessions.size });
        throw new CopilotSessionPreserved(reason);
      }
      // One new process costs the cache write that every one-shot request pays, and the thread then keeps it. The old
      // process and its folder are gone before the new one starts (at most `abortMs` for a running turn, then SIGKILL).
      reg.sessions.delete(key); await session.close("closed", reason); session = undefined;
    }
  } else {
    const ended = reg.ended.get(key);
    if (ended) reason = ended as CopilotMissReason;
  }
  if (signal.aborted) throw cancelled();
  if (!session || !plan) {
    // A session and an earlier attach that is still starting both hold a slot, so concurrent starts can never pass the cap.
    // An evicted session is gone, process and folder, before its replacement starts.
    while (slotsTaken(reg, key) >= settings.max) {
    const victim = evictable(reg);
      if (!victim) return { kind: "fallback", reason: "capacity" };
      // The victim stays in the registry until it is gone (its close removes it): it still holds a slot and a process, and
      // its thread's next request finds it closing and waits for it, so that request reseeds as `evicted` instead of
      // spawning beside a process that is still ending.
      await victim.close("evicted");
      if (signal.aborted) throw cancelled();
    }
    try {
      session = await CopilotLiveSession.start({ key, fingerprint: input.fingerprint, window, effort: input.effort, config: input.config, create: input.create, toolNames: new Set(input.native.map(({ name }) => name)),
        onClose: (closed, outcome, why) => ended(reg, closed, outcome, why) }, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) throw cancelled();
      return { kind: "fallback", reason: error instanceof SessionStartFailure ? error.reason : "spawn_failed" };
    }
    // `attach` registered the scope before anything started, and `ended` keeps it while an attach is starting for the key.
    reg.sessions.set(key, session); reg.ended.delete(key);
    plan = { kind: "seed" }; parkedMs = undefined;
  }
  const events = start(reg, settings, session, input, entries.map(entry => entry.digest), plan, outputs, signal, {
    outcome: plan.kind === "seed" ? reason ? "reseeded" : "spawned" : "continued", missReason: reason, divergedAt, parkedMs, threadKey: key.slice(0, 8),
  });
  // Its provider was removed or changed while this session was starting: the request that started it is its last (the session
  // is running now, so it closes when the request ends).
  const retired = reg.retired?.get(key); if (retired) void session.retire(retired);
  return { kind: "stream", events };
}

/** The caller's tool outputs by call id, as `session.tools.handlePendingToolCall` takes them. */
function toolResults(input: CopilotLiveInput, entries: LedgerEntry[]): Map<string, string | ToolResult> {
  const owned = imagesByItem(input.images);
  return new Map(entries.map(entry => [entry.callId!, copilotToolResult(input.conversation[entry.first], owned.get(entry.first))]));
}

function start(reg: Registry, settings: CopilotLiveSettings, session: CopilotLiveSession, input: CopilotLiveInput, prefix: string[],
  plan: Plan, outputs: Map<string, string | ToolResult> | undefined, signal: AbortSignal, decision: Record<string, unknown>): AsyncIterable<InferenceEvent> {
  const prompts = (from: number) => (directory: string, stopped: () => boolean) => copilotPrompts(input.conversation, input.images, from, choiceLine(input.choice, input.native), directory, input.native, stopped);
  const begin = plan.kind === "continue_outputs" || plan.kind === "continue_outputs_with_messages"
    ? { outputs: outputs ?? toolResults(input, plan.outputs), ...(plan.kind === "continue_outputs_with_messages" ? { prompts: prompts(plan.from) } : {}) }
    : { prompts: prompts(plan.kind === "continue_user" ? plan.from : 0) };
  session.timers(settings.parkMinutes * 60000, settings.toolWaitMinutes * 60000);
  const turn = input.newTurn();
  // An accepted turn commits the corrected full prefix when it finishes. A
  // refused request never edits the retained ledger or its compatibility mark.
  session.reasoningLedgerVersion = 1;
  return session.run({
    begin, prefix, turn, signal,
    onEnd: end => {
      const done = turn.done() as Extract<InferenceEvent, { type: "done" }>;
      telemetry("copilot_session", { ...decision, provider: input.config.id, model: input.model, ...(end === "interrupted" ? { outcome: "interrupted" } : {}), failed: end === "failed" || undefined, liveSessions: reg.sessions.size,
        inputTokens: done.usage.input_tokens, cacheReadTokens: done.usage.input_tokens_details?.cached_tokens, cacheWriteTokens: done.accounting?.cacheWriteTokens,
        outputTokens: done.usage.output_tokens, reasoningTokens: done.accounting?.reasoningTokens, nanoAiu: done.accounting?.nanoAiu, initiator: done.accounting?.initiator, toolCalls: turn.calls.length });
    },
  });
}

function ended(reg: Registry, session: CopilotLiveSession, outcome: SessionEnd, reason?: string): void {
  if (reg.sessions.get(session.key) === session) reg.sessions.delete(session.key);
  // A thread whose next session is starting keeps its scope: the attach that is starting it owns the entry.
  if (!reg.sessions.has(session.key) && !reg.starting.has(session.key)) reg.scopes.delete(session.key);
  // Remember why the thread has no session, so its next spawn reports it.
  const why = endReason({ outcome, reason });
  if (why && !reg.sessions.has(session.key)) { reg.ended.delete(session.key); reg.ended.set(session.key, why); if (reg.ended.size > 256) reg.ended.delete(reg.ended.keys().next().value!); }
  telemetry("copilot_session", { outcome, missReason: reason, provider: session.providerId, model: session.model, threadKey: session.key.slice(0, 8), liveSessions: reg.sessions.size, parkedMs: Date.now() - session.lastUse });
}
