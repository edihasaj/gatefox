import type { ProviderConfig } from "../config.js";
import type { ChatToolSelection, InferenceEvent, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import { registerActivityProbe, registerShutdownHook } from "../runtime-activity.js";
import { telemetry } from "../telemetry.js";
import { decide, ledgerEntries, type LedgerPhase } from "./claude-ledger.js";
import { itemText, type ClaudeConversation } from "./claude-render.js";
import { sessionKey } from "./claude-live-contract.js";
import { CopilotLiveSession, SessionStartFailure, sweepLiveDirectories, type SessionEnd, type SessionState } from "./copilot-live-session.js";
import type { CopilotTurn } from "./copilot-turn.js";
import { ProviderError } from "./provider.js";

/**
 * Live Copilot sessions: one long-lived CLI process per Codex thread. A request continues its thread's
 * session when the history extends what the session holds. When it does not, or the session's settings
 * changed, the thread is reseeded in a new process (one cache write, which a one-shot request pays on
 * every call). Anything that fails before output falls back to the one-shot path.
 */
export type CopilotMissReason = "no_thread" | "request_kind" | "images" | "forced_choice" | "concurrent" | "capacity" | "spawn_failed" | "stream_failed" |
  "fingerprint_changed" | "window_changed" | "prefix_diverged" | "unexpected_tail" | "effort_midturn" | "effort_rejected" | "session_dead" | "evicted" | "reaped" | "interrupted";

export interface CopilotLiveInput {
  /** Provider identity; a session never crosses it. */
  scope: string; threadId: string; windowId?: string;
  model: string;
  /** The requested effort; absent leaves the session's own. */
  effort?: string;
  /** Digest of everything the CLI fixes at creation (copilot-create.ts sessionFingerprint). */
  fingerprint: string;
  /** `session.create` parameters without the id and directories. */
  create: Record<string, unknown>;
  config: ProviderConfig;
  /** The full caller catalog, for the ledger; the session's own tools are `create.tools`. */
  catalog: OpenAITool[];
  toolCount: number;
  choice?: ChatToolSelection;
  /** The restored Responses request. */
  request: ResponsesRequest;
  /** The translated messages after the leading instructions, with tool calls marked (no images). */
  conversation: ClaudeConversation;
  /** Translated messages that moved into the system message; the ledger skips them. */
  leading: number;
  newTurn(): CopilotTurn;
}
export type CopilotLiveOutcome = { kind: "stream"; events: AsyncIterable<InferenceEvent> } | { kind: "fallback"; reason: CopilotMissReason };

export interface CopilotLiveSettings { max: number; parkMinutes: number; toolWaitMinutes: number }
/** A session idle this long has lost its cache (Copilot keeps it 30 minutes), so it is the one to evict. */
export const liveLimits = { coldMs: 30 * 60000 };
/** Lets a test run the once-per-process sweep of a dead gateway's session folders again. */
export function resetLiveSweep(): void { swept = undefined; }

interface Registry {
  interfaceVersion: 1;
  sessions: Map<string, CopilotLiveSession>;
  /** Keys with an attach in progress: deciding, applying effort or starting a process. */
  starting: Set<string>;
  /** How each key's last session ended, so the next spawn reports why it had none. */
  ended: Map<string, string>;
  /** The provider scope that owns each key, so one provider can retire its own sessions. */
  scopes: Map<string, string>;
}
type Plan = Exclude<ReturnType<typeof decide>, { kind: "reseed" }> | { kind: "seed" };
const symbol = Symbol.for("harness-gateway/copilot-sessions/v1");
const recentToolWait = 10 * 60 * 1000;
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
let swept: Promise<void> | undefined;

function registry(): Registry {
  const scope = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = scope[symbol];
  if (existing?.interfaceVersion === 1) return existing;
  const created: Registry = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), ended: new Map(), scopes: new Map() };
  scope[symbol] = created;
  // Busy while a session generates, or waits on tool outputs it got recently; a longer wait gains nothing from its cache.
  registerActivityProbe("copilot_sessions", () => created.starting.size > 0 || [...created.sessions.values()].some(session => session.state === "generating" ||
    (session.state === "awaiting_outputs" && Date.now() - session.lastUse < recentToolWait)));
  registerShutdownHook("copilot_sessions", () => closeAll(created, "shutdown"));
  // A gateway that exits without closing its sessions still must not leave a CLI or its prompt log behind.
  process.once("exit", () => { for (const session of created.sessions.values()) session.emergencyStop(); });
  return created;
}

const closeAll = async (reg: Registry, reason: string) => { await Promise.all([...reg.sessions.values()].map(session => session.close("closed", reason))); };

export function copilotLive(settings: CopilotLiveSettings) {
  const reg = registry();
  return {
    attach: (input: CopilotLiveInput, signal: AbortSignal) => attach(reg, settings, input, signal),
    /** Ends a thread's session at once (a request that cannot use it, such as a forced tool choice). */
    release: async (scope: string, threadId: string, reason: string) => {
      const key = sessionKey(scope, threadId); const session = reg.sessions.get(key);
      if (!session || session.state === "generating") return;
      reg.sessions.delete(key); await session.close("closed", reason);
    },
    /** Closes every session and forgets how earlier ones ended (tests; shutdown uses the registry hook). */
    stop: async () => { await closeAll(reg, "stopped"); reg.ended.clear(); reg.scopes.clear(); },
    sessions: (): CopilotLiveSession[] => [...reg.sessions.values()],
  };
}

/** Retires every live session one provider scope owns, without creating the registry: a provider switched to one-shot calls this. */
export function retireCopilotScope(scope: string, reason: string): void {
  const reg = (globalThis as unknown as Record<symbol, Registry | undefined>)[symbol];
  if (reg?.interfaceVersion !== 1) return;
  for (const [key, session] of reg.sessions) if (reg.scopes.get(key) === scope) void session.retire(reason);
}

async function attach(reg: Registry, settings: CopilotLiveSettings, input: CopilotLiveInput, signal: AbortSignal): Promise<CopilotLiveOutcome> {
  if (signal.aborted) throw cancelled();
  const key = sessionKey(input.scope, input.threadId);
  if (reg.starting.has(key)) return { kind: "fallback", reason: "concurrent" };
  reg.starting.add(key);
  try { await (swept ??= sweepLiveDirectories()); return await place(reg, settings, key, input, signal); } finally { reg.starting.delete(key); }
}

/** Slots in use as the attach for `key` sees them: every session, plus each earlier attach that has no session yet. */
function slotsTaken(reg: Registry, key: string): number {
  let taken = reg.sessions.size;
  for (const other of reg.starting) { if (other === key) break; if (!reg.sessions.has(other)) taken++; }
  return taken;
}

/** The least recently used session whose cache has gone cold; a warm session is worth more parked than rewritten. */
function evictable(reg: Registry): CopilotLiveSession | undefined {
  const cold = [...reg.sessions.values()].filter(session => session.state !== "generating" && Date.now() - session.lastUse >= liveLimits.coldMs).sort((a, b) => a.lastUse - b.lastUse);
  return cold.find(session => session.state === "turn_done") ?? cold[0];
}

async function place(reg: Registry, settings: CopilotLiveSettings, key: string, input: CopilotLiveInput, signal: AbortSignal): Promise<CopilotLiveOutcome> {
  let session = reg.sessions.get(key);
  if (session?.state === "generating") return { kind: "fallback", reason: "concurrent" };
  const { entries, messages } = ledgerEntries(input.request, input.catalog, input.leading);
  const window = input.windowId ?? "";
  let reason: CopilotMissReason | undefined; let divergedAt: number | undefined; let plan: Plan | undefined; let parkedMs: number | undefined;
  if (session && session.state !== "closed") {
    parkedMs = Date.now() - session.lastUse;
    const decision = decide(session.ledger, entries, messages, session.state as LedgerPhase, session.pending);
    if (session.fingerprint !== input.fingerprint) reason = "fingerprint_changed";
    else if (session.window !== window) reason = "window_changed";
    else if (decision.kind === "reseed") { reason = decision.reason; divergedAt = decision.divergedAt; }
    // The tail renders from the conversation; a count that does not match the translation is not trusted.
    else if (decision.kind === "continue_user" && messages !== input.conversation.length) reason = "unexpected_tail";
    else if (decision.kind === "continue_outputs" && decision.outputs.some(entry => { const message = input.conversation[entry.first]; return message?.role !== "tool" || message.tool_call_id !== entry.callId; })) reason = "unexpected_tail";
    else if (input.effort !== undefined && input.effort !== session.effort) {
      if (session.state === "awaiting_outputs") reason = "effort_midturn";
      else if (!(await session.applyEffort(input.model, input.effort))) reason = "effort_rejected";
    }
    if (!reason && (session.state as SessionState) === "closed") reason = "session_dead";
    if (!reason && decision.kind !== "reseed") plan = decision;
    if (reason) {
      // One new process costs the cache write that every one-shot request pays, and the thread then keeps it.
      reg.sessions.delete(key); void session.close("closed", reason); session = undefined;
    }
  } else {
    session = undefined;
    const ended = reg.ended.get(key);
    if (ended) reason = ended as CopilotMissReason;
  }
  if (signal.aborted) throw cancelled();
  if (!session || !plan) {
    // A session and an earlier attach that is still starting both hold a slot, so concurrent starts can never pass the cap.
    while (slotsTaken(reg, key) >= settings.max) {
      const victim = evictable(reg);
      if (!victim) return { kind: "fallback", reason: "capacity" };
      reg.sessions.delete(victim.key); void victim.close("evicted");
    }
    try {
      session = await CopilotLiveSession.start({ key, fingerprint: input.fingerprint, window, effort: input.effort, config: input.config, create: input.create, toolCount: input.toolCount,
        onClose: (closed, outcome, why) => ended(reg, closed, outcome, why) }, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) throw cancelled();
      return { kind: "fallback", reason: error instanceof SessionStartFailure ? error.reason : "spawn_failed" };
    }
    reg.sessions.set(key, session); reg.ended.delete(key);
    plan = { kind: "seed" }; parkedMs = undefined;
  }
  reg.scopes.set(key, input.scope);
  return { kind: "stream", events: start(reg, settings, session, input, entries.map(entry => entry.digest), plan, signal, {
    outcome: plan.kind === "seed" ? reason ? "reseeded" : "spawned" : "continued", missReason: reason, divergedAt, parkedMs, threadKey: key.slice(0, 8),
  }) };
}

const prompts = (input: CopilotLiveInput, from: number) => input.conversation.slice(from).map((item, offset) => itemText(item, from + offset + 1));

function start(reg: Registry, settings: CopilotLiveSettings, session: CopilotLiveSession, input: CopilotLiveInput, prefix: string[],
  plan: Plan, signal: AbortSignal, decision: Record<string, unknown>): AsyncIterable<InferenceEvent> {
  // The CLI takes a result string; an empty one gets a placeholder so the pending request is still answered.
  const text = (index: number) => { const message = input.conversation[index]; return (message.content ?? message.parts?.map(part => "text" in part ? part.text : "").join("\n") ?? "") || "(no output)"; };
  const begin = plan.kind === "continue_outputs" ? { outputs: new Map<string, string>(plan.outputs.map(entry => [entry.callId!, text(entry.first)])) }
    : { prompts: prompts(input, plan.kind === "continue_user" ? plan.from : 0) };
  session.timers(settings.parkMinutes * 60000, settings.toolWaitMinutes * 60000);
  const turn = input.newTurn();
  return session.run({
    begin, prefix, turn, signal,
    onEnd: end => {
      const done = turn.done() as Extract<InferenceEvent, { type: "done" }>;
      telemetry("copilot_session", { ...decision, ...(end === "interrupted" ? { outcome: "interrupted" } : {}), failed: end === "failed" || undefined, liveSessions: reg.sessions.size,
        inputTokens: done.usage.input_tokens, cacheReadTokens: done.usage.input_tokens_details?.cached_tokens, cacheWriteTokens: done.accounting?.cacheWriteTokens,
        outputTokens: done.usage.output_tokens, nanoAiu: done.accounting?.nanoAiu, toolCalls: turn.calls.length });
    },
  });
}

function ended(reg: Registry, session: CopilotLiveSession, outcome: SessionEnd, reason?: string): void {
  if (reg.sessions.get(session.key) === session) reg.sessions.delete(session.key);
  if (!reg.sessions.has(session.key)) reg.scopes.delete(session.key);
  // Remember why the thread has no session, so its next spawn reports it.
  const why = outcome === "crashed" ? "session_dead" : outcome === "evicted" || outcome === "reaped" ? outcome : reason === "interrupted" ? "interrupted" : undefined;
  if (why && !reg.sessions.has(session.key)) { reg.ended.delete(session.key); reg.ended.set(session.key, why); if (reg.ended.size > 256) reg.ended.delete(reg.ended.keys().next().value!); }
  telemetry("copilot_session", { outcome, missReason: reason, threadKey: session.key.slice(0, 8), liveSessions: reg.sessions.size, parkedMs: Date.now() - session.lastUse });
}
