import { createHash } from "node:crypto";
import type { ChatToolSelection, InferenceEvent, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import { registerActivityProbe, registerShutdownHook } from "../runtime-activity.js";
import { telemetry } from "../telemetry.js";
import { validateForcedChoice } from "./claude-calls.js";
import type { ClaudeMcpTool } from "./claude-control.js";
import { decide, ledgerEntries, type LedgerPhase } from "./claude-ledger.js";
import { renderConversation, renderItems, type ClaudeConversation, type ClaudeImages } from "./claude-render.js";
import { CliContinuityUnavailable } from "./cli-continuity.js";
import { GrokEndedStore, GrokEndedStoreError } from "./grok-ended-store.js";
import { GrokLiveSession, type GrokSessionEnd } from "./grok-live-session.js";
import { fixedReason } from "./grok-reasons.js";
import { ProviderError } from "./provider.js";

/**
 * Live Grok sessions: one long-lived `grok agent` process per conversation. A request continues its conversation's
 * session only when its history is exactly what the session holds plus the new items. Anything else is refused: the
 * gateway never replays a conversation into a new process, because that would pay for the whole history again.
 */
export interface GrokLiveInput {
  /** Provider id; a session never crosses it. */
  scope: string; home: string; conversationId: string;
  model: string; effort?: string;
  command: string; system: string; builtinTools: readonly string[];
  env(catalogPath: string): NodeJS.ProcessEnv;
  /** The tools Grok may call, and the same set as Grok lists it; `allTools` is the full caller catalog, which names the calls in history. */
  tools: OpenAITool[]; allTools: OpenAITool[]; catalog: ClaudeMcpTool[];
  choice?: ChatToolSelection;
  /** The final instruction for a forced or required tool choice. */
  forced?: string;
  request: ResponsesRequest;
  /** The translated messages after the leading instructions, with tool calls marked. */
  conversation: ClaudeConversation; images: ClaudeImages;
  /** Translated messages that moved into the system prompt; the ledger skips them. */
  leading: number;
  summaryVisible: boolean;
  observe?(usage: { inputTokens?: number; cachedTokens?: number }): void;
}
export interface GrokLiveSettings { max: number; parkMinutes: number; toolWaitMinutes: number }

interface Registry {
  interfaceVersion: 1;
  sessions: Map<string, GrokLiveSession>;
  /** Keys with an attach in progress. */
  starting: Set<string>;
  /** The persisted record of closed conversations, one store per Grok home (see grok-ended-store.ts). */
  stores: Map<string, GrokEndedStore>;
}
type Plan = { kind: "prompt"; from: number } | { kind: "outputs"; outputs: Map<string, string> };
const symbol = Symbol.for("harness-gateway/grok-sessions/v1");
/** A session waiting on tool outputs it got longer ago than this gains nothing from keeping a restart away. */
const recentToolWait = 10 * 60 * 1000;
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Request kinds that are deliberately served outside the conversation's session. */
export const grokOneShotKinds = new Set<unknown>(["compaction", "prewarm", "memory", "auxiliary"]);

function registry(): Registry {
  const scope = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = scope[symbol];
  if (existing?.interfaceVersion === 1) return existing;
  const created: Registry = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), stores: new Map() };
  scope[symbol] = created;
  registerActivityProbe("grok_sessions", () => created.starting.size > 0 || [...created.sessions.values()].some(session => session.state === "generating" ||
    (session.state === "awaiting_outputs" && Date.now() - session.lastUse < recentToolWait)));
  registerShutdownHook("grok_sessions", () => closeAll(created, "shutdown"));
  // A gateway that exits without closing its sessions must not leave their CLIs behind (they run in groups of their own).
  process.once("exit", () => { for (const session of created.sessions.values()) session.kill(); });
  return created;
}
const closeAll = async (reg: Registry, reason: string) => { await Promise.all([...reg.sessions.values()].map(session => session.close("closed", reason))); };

export function grokLive(settings: GrokLiveSettings) {
  const reg = registry();
  return {
    attach: (input: GrokLiveInput, signal: AbortSignal) => attach(reg, settings, input, signal),
    /**
     * Closes every session and drops this process's copy of the ended-record stores (tests; shutdown uses the registry hook).
     * The files stay, so a store read afterwards is what a restarted gateway would read.
     */
    stop: async () => { await closeAll(reg, "stopped"); reg.stores.clear(); },
    sessions: (): GrokLiveSession[] => [...reg.sessions.values()],
  };
}

/** Why a conversation has no session after its last one ended this way. */
function endReason(session: GrokLiveSession): string | undefined {
  const end = session.end;
  if (!end) return undefined;
  // A rejected sign-in on a session's very first prompt that showed no sign of inference (no output, tool call, usage, permission
  // request or MCP call, see `observed`) spent nothing: signing in and repeating the request must work. Any sign keeps the record:
  // the charged work lives in the dead process and a replay would pay for it again.
  if (end.outcome === "crashed") return end.reason === "authentication_failed" && !session.observed ? undefined : "session_dead";
  if (end.outcome === "reaped") return end.reason ?? "reaped";
  return end.reason ?? "closed";
}

async function attach(reg: Registry, settings: GrokLiveSettings, input: GrokLiveInput, signal: AbortSignal): Promise<AsyncIterable<InferenceEvent>> {
  if (signal.aborted) throw cancelled();
  const key = sha([input.scope, input.home, input.model, input.effort ?? null, input.conversationId]);
  const refuse = (reason: string): never => {
    // Only fixed codes reach telemetry and the client's message.
    const code = fixedReason(reason);
    telemetry("grok_session", { outcome: "refused", missReason: code, provider: input.scope, model: input.model, threadKey: key.slice(0, 8), liveSessions: reg.sessions.size });
    throw new CliContinuityUnavailable("Grok", code);
  };
  if (reg.starting.has(key)) return refuse("concurrent");
  reg.starting.add(key);
  try { return await place(reg, settings, key, input, signal, refuse); }
  finally { reg.starting.delete(key); }
}

/** Slots in use as the attach for `key` sees them: every session, plus each earlier attach that has no session yet. */
function slotsTaken(reg: Registry, key: string): number {
  let taken = reg.sessions.size;
  for (const other of reg.starting) { if (other === key) break; if (!reg.sessions.has(other)) taken++; }
  return taken;
}

async function place(reg: Registry, settings: GrokLiveSettings, key: string, input: GrokLiveInput, signal: AbortSignal, refuse: (reason: string) => never): Promise<AsyncIterable<InferenceEvent>> {
  const fingerprint = sha([input.system, input.catalog]);
  const { entries, messages } = ledgerEntries(input.request, input.allTools, input.leading);
  let session = reg.sessions.get(key); let plan: Plan; let reason: string | undefined; let parkedMs: number | undefined;
  const store = reg.stores.get(input.home) ?? reg.stores.set(input.home, GrokEndedStore.forHome(input.home)).get(input.home)!;
  if (session?.state === "closed") {
    // It is still ending; it no longer holds the conversation, and how it ended is why this request has no session.
    reg.sessions.delete(key); reason = endReason(session); await session.finished; session = undefined;
  }
  if (session) {
    if (session.state === "generating") return refuse("concurrent");
    parkedMs = Date.now() - session.lastUse;
    if (session.fingerprint !== fingerprint) return refuse("fingerprint_changed");
    const phase = session.state as LedgerPhase;
    let decision = decide(session.ledger, entries, messages, phase, session.pending);
    // The client may have replayed the turn's reasoning summary as assistant text; either form of the turn continues it.
    if (decision.kind === "reseed" && session.altLedger) { const alt = decide(session.altLedger, entries, messages, phase, session.pending); if (alt.kind !== "reseed" || (decision.kind === "reseed" && alt.divergedAt > decision.divergedAt)) decision = alt; }
    // A refused request never touches the session: it stays usable for the history it does hold.
    if (decision.kind === "reseed") return refuse(decision.reason);
    if (decision.kind === "continue_user") {
      if (messages !== input.conversation.length) return refuse("unexpected_tail");
      plan = { kind: "prompt", from: decision.from };
    } else {
      if (decision.outputs.some(entry => input.conversation[entry.first]?.role !== "tool" || input.conversation[entry.first]?.tool_call_id !== entry.callId)) return refuse("unexpected_tail");
      // A tool result cannot carry the choice line, so a forced, required or disabled choice cannot continue it.
      if (input.choice !== undefined && input.choice !== "auto") return refuse("forced_choice");
      plan = { kind: "outputs", outputs: new Map(decision.outputs.map(entry => [entry.callId!, String(input.conversation[entry.first].content ?? "")])) };
    }
  } else {
    // A conversation whose session ended is final, whatever it sends: the original request again would pay for the whole
    // conversation in a second process. A conversation with history and no session cannot be continued for the same reason.
    // The persisted record also covers a gateway that restarted since. A store that cannot answer refuses a new conversation (it
    // cannot tell whether it was already served) and says `session_missing` for one that carries history.
    let gone = reason; let storeFault: string | undefined;
    if (!gone) { try { gone = await store.lookup(key); } catch (error) { storeFault = error instanceof GrokEndedStoreError ? error.code : "ended_store_unavailable"; } }
    if (gone) return refuse(gone);
    if (entries.some(entry => entry.kind !== "m" || entry.assistant)) return refuse("session_missing");
    if (storeFault) return refuse(storeFault);
    for (let closing = [...reg.sessions.values()].find(other => other.state === "closed"); closing; closing = [...reg.sessions.values()].find(other => other.state === "closed")) await closing.finished;
    // Nothing is evicted for a newcomer: closing a parked conversation would lose its history, which cannot be replayed.
    if (slotsTaken(reg, key) >= settings.max) return refuse("capacity");
    // The conversation is recorded before its CLI starts, so no way of losing the process can reopen it. The reservation is
    // atomic across processes: when another request or process recorded the key since the lookup, its record refuses this one.
    let recorded: string | undefined;
    try { recorded = await store.reserve(key); } catch (error) { return refuse(error instanceof GrokEndedStoreError ? error.code : "ended_store_unavailable"); }
    if (recorded) return refuse(recorded);
    try {
      session = await GrokLiveSession.start({ key, fingerprint, providerId: input.scope, model: input.model, effort: input.effort, command: input.command, system: input.system,
        builtinTools: input.builtinTools, tools: input.tools, catalog: input.catalog, env: input.env, onClose: (closed, outcome, why) => ended(reg, store, closed, outcome, why) }, signal);
    } catch (error) { await store.release(key).catch(() => {}); throw error; }
    reg.sessions.set(key, session);
    plan = { kind: "prompt", from: 0 }; parkedMs = undefined;
  }
  const fresh = session.ledger.items.length === 0;
  if (signal.aborted) { await session.close("closed", "interrupted"); throw cancelled(); }
  return start(reg, settings, session, input, entries.map(entry => entry.digest), plan, signal, fresh, { outcome: fresh ? "spawned" : "continued", parkedMs, threadKey: key.slice(0, 8) });
}

function start(reg: Registry, settings: GrokLiveSettings, session: GrokLiveSession, input: GrokLiveInput, prefix: string[], plan: Plan, signal: AbortSignal, fresh: boolean, decision: Record<string, unknown>): AsyncIterable<InferenceEvent> {
  const text = (blocks: Array<Record<string, unknown>>) => [...blocks.map(block => String(block.text ?? "")), ...(input.forced ? [input.forced] : [])].join("\n\n");
  const begin = plan.kind === "outputs" ? { outputs: plan.outputs }
    : { prompt: text(fresh ? renderConversation(input.conversation, input.images, "text") : renderItems(input.conversation, input.images, plan.from, "text")) };
  session.timers(settings.parkMinutes * 60000, settings.toolWaitMinutes * 60000);
  return session.run({
    begin, prefix, signal, summaryVisible: input.summaryVisible,
    validate: calls => validateForcedChoice(calls, input.choice),
    onEnd: (outcome, tokens) => {
      if (tokens) input.observe?.({ inputTokens: tokens.input, cachedTokens: tokens.cacheRead });
      telemetry("grok_session", { ...decision, provider: input.scope, model: input.model, ...(outcome === "interrupted" ? { outcome: "interrupted" } : {}), failed: outcome === "failed" || undefined,
        liveSessions: reg.sessions.size, toolCalls: session.toolCalls, permissionsAllowed: session.allowed, permissionsDenied: session.denied, inputTokens: tokens?.input, outputTokens: tokens?.output });
    },
  });
}

/** The session is gone: the conversation is recorded as closed (or released when nothing was spent). The close waits for the write. */
async function ended(reg: Registry, store: GrokEndedStore, session: GrokLiveSession, outcome: GrokSessionEnd, reason?: string): Promise<void> {
  if (reg.sessions.get(session.key) === session) reg.sessions.delete(session.key);
  const why = endReason(session);
  telemetry("grok_session", { outcome, missReason: reason === undefined ? undefined : fixedReason(reason), provider: session.providerId, model: session.model, threadKey: session.key.slice(0, 8), liveSessions: reg.sessions.size, parkedMs: Date.now() - session.lastUse });
  if (reg.sessions.has(session.key)) return;
  await (why ? store.finish(session.key, why) : store.release(session.key));
}
