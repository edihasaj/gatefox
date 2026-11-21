import { createHash, randomUUID } from "node:crypto";
import type { ChatToolSelection, InferenceEvent, OpenAITool, ResponsesRequest } from "../protocol/types.js";
import { registerActivityProbe, registerShutdownHook } from "../runtime-activity.js";
import { telemetry } from "../telemetry.js";
import { validateForcedChoice } from "./claude-calls.js";
import type { ClaudeMcpTool } from "./claude-control.js";
import { decide, ledgerEntries, type LedgerPhase } from "./claude-ledger.js";
import { renderConversation, renderItems, type ClaudeConversation, type ClaudeImages } from "./claude-render.js";
import { CliContinuityUnavailable } from "./cli-continuity.js";
import { AcpEndedStore, AcpEndedStoreError } from "./acp-ended-store.js";
import { AcpLiveSession, type AcpDriver, type AcpProvisioned, type AcpSessionEnd } from "./acp-live-session.js";
import { fixedAcpReason } from "./acp-reasons.js";
import { ProviderError } from "./provider.js";

/**
 * Live ACP sessions, shared by every provider that spends a subscription through a CLI speaking ACP (Grok, Gemini):
 * one long-lived CLI process per conversation. A request continues its conversation's session only when its history is
 * exactly what the session holds plus the new items. Anything else is refused: the gateway never replays a conversation
 * into a new process, because that would pay for the whole history again.
 */
export interface AcpLiveInput {
  /** Provider id; a session never crosses it. */
  scope: string; home: string; conversationId: string;
  model: string; effort?: string;
  command: string; system: string; builtinTools?: readonly string[];
  /** A request with no caller conversation identity: one turn, and never recorded in the ended-session store. */
  ephemeral?: boolean;
  env(catalogPath: string): NodeJS.ProcessEnv;
  /** Prepares a private, disposable CLI home inside the session's folder (see AcpSessionOptions.provision); `env` is then unused. */
  provision?(directory: string): Promise<AcpProvisioned>;
  /** The tools the CLI may call, and the same set as it lists them; `allTools` is the full caller catalog, which names the calls in history. */
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
export interface AcpLiveSettings { max: number; parkMinutes: number; toolWaitMinutes: number }

/** The shared session driver plus what the pool needs: its telemetry event, registry names and ended-record store. */
export interface AcpLiveDriver extends AcpDriver {
  /** Telemetry event name (`grok_session`, `gemini_session`). */
  event: string;
  /** Identifies this provider's session registry and its activity/shutdown hooks. */
  registry: string; activity: string;
  /** The persisted record of closed conversations for one provider home. */
  storeFor(home: string): AcpEndedStore;
}

interface Registry {
  interfaceVersion: 1;
  sessions: Map<string, AcpLiveSession>;
  /** Keys with an attach in progress. */
  starting: Set<string>;
  /** The persisted record of closed conversations, one store per provider home (see acp-ended-store.ts). */
  stores: Map<string, AcpEndedStore>;
}
type Plan = { kind: "prompt"; from: number } | { kind: "outputs"; outputs: Map<string, string> };
/** A session waiting on tool outputs it got longer ago than this gains nothing from keeping a restart away. */
const recentToolWait = 10 * 60 * 1000;
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Request kinds that are deliberately served outside the conversation's session. */
export const acpOneShotKinds = new Set<unknown>(["compaction", "prewarm", "memory", "auxiliary"]);

function registry(driver: AcpLiveDriver): Registry {
  const symbol = Symbol.for(`harness-gateway/${driver.registry}/v1`);
  const scope = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = scope[symbol];
  if (existing?.interfaceVersion === 1) return existing;
  const created: Registry = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), stores: new Map() };
  scope[symbol] = created;
  registerActivityProbe(driver.activity, () => created.starting.size > 0 || [...created.sessions.values()].some(session => session.state === "generating" ||
    (session.state === "awaiting_outputs" && Date.now() - session.lastUse < recentToolWait)));
  registerShutdownHook(driver.activity, () => closeAll(created, "shutdown"));
  // A gateway that exits without closing its sessions must not leave their CLIs or folders behind: each session registers its own
  // process-exit cleanup as it acquires them (acp-live-session.ts), so one still starting is covered too.
  return created;
}
const closeAll = async (reg: Registry, reason: string) => { await Promise.all([...reg.sessions.values()].map(session => session.close("closed", reason))); };

export function acpLive(driver: AcpLiveDriver, settings: AcpLiveSettings) {
  const reg = registry(driver);
  return {
    attach: (input: AcpLiveInput, signal: AbortSignal) => attach(driver, reg, settings, input, signal),
    /**
     * Closes every session and drops this process's copy of the ended-record stores (tests; shutdown uses the registry hook).
     * The files stay, so a store read afterwards is what a restarted gateway would read.
     */
    stop: async () => { await closeAll(reg, "stopped"); reg.stores.clear(); },
    sessions: (): AcpLiveSession[] => [...reg.sessions.values()],
  };
}

/** Why a conversation has no session after its last one ended this way. */
function endReason(session: AcpLiveSession): string | undefined {
  const end = session.end;
  if (!end) return undefined;
  // A rejected sign-in on a session's very first prompt that showed no sign of inference (no output, tool call, usage, permission
  // request or MCP call, see `observed`) spent nothing: signing in and repeating the request must work. Any sign keeps the record:
  // the charged work lives in the dead process and a replay would pay for it again.
  if (end.outcome === "crashed") return end.reason === "authentication_failed" && !session.observed ? undefined : "session_dead";
  if (end.outcome === "reaped") return end.reason ?? "reaped";
  return end.reason ?? "closed";
}

async function attach(driver: AcpLiveDriver, reg: Registry, settings: AcpLiveSettings, input: AcpLiveInput, signal: AbortSignal): Promise<AsyncIterable<InferenceEvent>> {
  if (signal.aborted) throw cancelled();
  // A conversation with no caller identity is a single turn of its own: its key can never be found again, so it is a
  // fresh session every time and the ended-record store is not involved.
  const key = sha([input.scope, input.home, input.model, input.effort ?? null, input.ephemeral ? `anon:${randomUUID()}` : input.conversationId]);
  const refuse = (reason: string): never => {
    // Only fixed codes reach telemetry and the client's message.
    const code = fixedAcpReason(reason);
    telemetry(driver.event, { outcome: "refused", missReason: code, provider: input.scope, model: input.model, threadKey: key.slice(0, 8), liveSessions: reg.sessions.size });
    throw new CliContinuityUnavailable(driver.label, code);
  };
  if (reg.starting.has(key)) return refuse("concurrent");
  reg.starting.add(key);
  try { return await place(driver, reg, settings, key, input, signal, refuse); }
  finally { reg.starting.delete(key); }
}

/** Slots in use as the attach for `key` sees them: every session, plus each earlier attach that has no session yet. */
function slotsTaken(reg: Registry, key: string): number {
  let taken = reg.sessions.size;
  for (const other of reg.starting) { if (other === key) break; if (!reg.sessions.has(other)) taken++; }
  return taken;
}

async function place(driver: AcpLiveDriver, reg: Registry, settings: AcpLiveSettings, key: string, input: AcpLiveInput, signal: AbortSignal, refuse: (reason: string) => never): Promise<AsyncIterable<InferenceEvent>> {
  const fingerprint = sha([input.system, input.catalog]);
  const { entries, messages } = ledgerEntries(input.request, input.allTools, input.leading);
  let session = reg.sessions.get(key); let plan: Plan; let reason: string | undefined; let parkedMs: number | undefined;
  const store = reg.stores.get(input.home) ?? reg.stores.set(input.home, driver.storeFor(input.home)).get(input.home)!;
  const ephemeral = input.ephemeral === true;
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
    if (!gone && !ephemeral) { try { gone = await store.lookup(key); } catch (error) { storeFault = error instanceof AcpEndedStoreError ? error.code : "ended_store_unavailable"; } }
    if (gone) return refuse(gone);
    if (entries.some(entry => entry.kind !== "m" || entry.assistant)) return refuse("session_missing");
    if (storeFault) return refuse(storeFault);
    for (let closing = [...reg.sessions.values()].find(other => other.state === "closed"); closing; closing = [...reg.sessions.values()].find(other => other.state === "closed")) await closing.finished;
    // Nothing is evicted for a newcomer: closing a parked conversation would lose its history, which cannot be replayed.
    if (slotsTaken(reg, key) >= settings.max) return refuse("capacity");
    // The conversation is recorded before its CLI starts, so no way of losing the process can reopen it. The reservation is
    // atomic across processes: when another request or process recorded the key since the lookup, its record refuses this one.
    let recorded: string | undefined;
    if (!ephemeral) {
      try { recorded = await store.reserve(key); } catch (error) { return refuse(error instanceof AcpEndedStoreError ? error.code : "ended_store_unavailable"); }
      if (recorded) return refuse(recorded);
    }
    try {
      session = await AcpLiveSession.start({ key, fingerprint, providerId: input.scope, model: input.model, effort: input.effort, command: input.command, system: input.system,
        builtinTools: input.builtinTools, ephemeral, tools: input.tools, catalog: input.catalog, env: input.env, provision: input.provision,
        onClose: (closed, outcome, why) => ended(driver, reg, store, closed, outcome, why) }, driver, signal);
    } catch (error) { if (!ephemeral) await store.release(key).catch(() => {}); throw error; }
    reg.sessions.set(key, session);
    plan = { kind: "prompt", from: 0 }; parkedMs = undefined;
  }
  const fresh = session.ledger.items.length === 0;
  if (signal.aborted) { await session.close("closed", "interrupted"); throw cancelled(); }
  return start(driver, reg, settings, session, input, entries.map(entry => entry.digest), plan, signal, fresh, { outcome: fresh ? "spawned" : "continued", parkedMs, threadKey: key.slice(0, 8) });
}

function start(driver: AcpLiveDriver, reg: Registry, settings: AcpLiveSettings, session: AcpLiveSession, input: AcpLiveInput, prefix: string[], plan: Plan, signal: AbortSignal, fresh: boolean, decision: Record<string, unknown>): AsyncIterable<InferenceEvent> {
  const text = (blocks: Array<Record<string, unknown>>) => [...blocks.map(block => String(block.text ?? "")), ...(input.forced ? [input.forced] : [])].join("\n\n");
  // A provider may frame the prompt before it reaches its CLI; the continuation ledger is keyed on the caller's history,
  // not on this text, so framing cannot make a later request look like a different conversation.
  const prompt = (blocks: Array<Record<string, unknown>>) => { const rendered = text(blocks); return driver.framePrompt ? driver.framePrompt(rendered) : rendered; };
  const begin = plan.kind === "outputs" ? { outputs: plan.outputs }
    : { prompt: prompt(fresh ? renderConversation(input.conversation, input.images, "text") : renderItems(input.conversation, input.images, plan.from, "text")) };
  session.timers(settings.parkMinutes * 60000, settings.toolWaitMinutes * 60000);
  const events = session.run({
    begin, prefix, signal, summaryVisible: input.summaryVisible,
    validate: calls => validateForcedChoice(calls, input.choice),
    onEnd: (outcome, tokens) => {
      if (tokens) input.observe?.({ inputTokens: tokens.input, cachedTokens: tokens.cacheRead });
      telemetry(driver.event, { ...decision, provider: input.scope, model: input.model, ...(outcome === "interrupted" ? { outcome: "interrupted" } : {}), failed: outcome === "failed" || undefined,
        liveSessions: reg.sessions.size, toolCalls: session.toolCalls, permissionsAllowed: session.allowed, permissionsDenied: session.denied, inputTokens: tokens?.input, outputTokens: tokens?.output });
    },
  });
  // A conversation with no caller identity can never be found again, so its session ends with its one turn (Grok's one-shot
  // rule). A turn that ended in tool calls hands them over and is closed too: the continuation is a different, unnamed
  // conversation with history, which the pool refuses as `session_missing`.
  if (session.ephemeral) void session.retire("closed");
  return events;
}

/** The session is gone: the conversation is recorded as closed (or released when nothing was spent). The close waits for the write. */
async function ended(driver: AcpLiveDriver, reg: Registry, store: AcpEndedStore, session: AcpLiveSession, outcome: AcpSessionEnd, reason?: string): Promise<void> {
  if (reg.sessions.get(session.key) === session) reg.sessions.delete(session.key);
  const why = endReason(session);
  telemetry(driver.event, { outcome, missReason: reason === undefined ? undefined : fixedAcpReason(reason), provider: session.providerId, model: session.model, threadKey: session.key.slice(0, 8), liveSessions: reg.sessions.size, parkedMs: Date.now() - session.lastUse });
  if (reg.sessions.has(session.key)) return;
  // A single-turn conversation with no caller identity is never recorded: nothing was owed to it.
  if (session.ephemeral) return;
  await (why ? store.finish(session.key, why) : store.release(session.key));
}
