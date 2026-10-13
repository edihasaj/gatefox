import { createHash } from "node:crypto";
import type { ChatToolSelection } from "../protocol/types.js";
import { telemetry } from "../telemetry.js";
import { ProviderError } from "./provider.js";
import { choiceBlock } from "./claude-render.js";
import { decide, ledgerEntries, type LedgerDecision, type LedgerPhase } from "./claude-ledger.js";
import { relayContent, type RelayContent } from "./claude-relay.js";
import { ClaudeSession, SessionStartFailure, sweepSessionDirectories, type SessionEnd } from "./claude-session.js";
import { closeSessions, evictable, rememberEnd, sessionRegistry, type SessionRegistry } from "./claude-session-registry.js";
import type { ClaudeLiveInput, ClaudeLiveOutcome, ClaudeMissReason } from "./claude-live-contract.js";

/**
 * Live Claude sessions: one long-lived CLI process per Codex thread, loaded lazily by
 * claude.ts. A request continues its thread's session when the history extends what the
 * session holds; otherwise it reseeds the thread in a new process. Anything that fails
 * before output falls back to the one-shot path.
 */
type ReseedReason = ClaudeMissReason | "idle_expired" | "effort_rejected" | "forced_choice";
type Plan = Exclude<LedgerDecision, { kind: "reseed" }> | { kind: "seed" };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
// After an hour idle the cache is gone, and the CLI may clear old tool results server-side
// (context_management clear_tool_uses after 65 idle minutes), so continuing saves nothing.
const idleLimitMs = 60 * 60 * 1000;
const forced = (choice: ChatToolSelection | undefined) => choice === "required" || typeof choice === "object";
// Session files of a gateway process that died without closing its sessions are removed once per process.
let swept: Promise<void> | undefined;

export function claudeLive(settings: { max: number; parkMinutes: number }) {
  const registry = sessionRegistry(); registry.settings = { max: settings.max, parkMinutes: settings.parkMinutes };
  return {
    attach: (input: ClaudeLiveInput, signal: AbortSignal) => attach(registry, input, signal),
    /** Closes every session at once and forgets how earlier ones ended (tests; shutdown uses the registry hook). */
    stop: async () => { await closeSessions(registry, "stopped", true); registry.ended.clear(); },
    sessions: (): ClaudeSession[] => [...registry.sessions.values()],
  };
}

async function attach(registry: SessionRegistry, input: ClaudeLiveInput, signal: AbortSignal): Promise<ClaudeLiveOutcome> {
  if (signal.aborted) throw cancelled();
  const key = sha(`${input.scope}\0${input.threadId}`);
  if (registry.starting.has(key)) return { kind: "fallback", reason: "concurrent" };
  registry.starting.add(key);
  try { await (swept ??= sweepSessionDirectories()); return await place(registry, key, input, signal); } finally { registry.starting.delete(key); }
}

async function place(registry: SessionRegistry, key: string, input: ClaudeLiveInput, signal: AbortSignal): Promise<ClaudeLiveOutcome> {
  let session = registry.sessions.get(key);
  if (session?.state === "interrupting") await session.waitIdle(1500);
  if (session?.state === "generating" || session?.state === "interrupting") return { kind: "fallback", reason: "concurrent" };
  if (signal.aborted) throw cancelled();
  const { entries, messages } = ledgerEntries(input.request, input.tools);
  const fingerprint = sha(JSON.stringify({ model: input.model, thinking: input.effort !== undefined, fast: input.fast, instructions: input.instructionsDigest, tools: input.toolsDigest }));
  const window = input.windowId ?? "";
  let reason: ReseedReason | undefined; let divergedAt: number | undefined; let plan: Plan | undefined; let parkedMs: number | undefined;
  if (session && session.state !== "closed") {
    parkedMs = Date.now() - session.lastUse;
    const decision = decide(session.ledger, entries, messages, session.state as LedgerPhase, session.pending);
    if (session.fingerprint !== fingerprint) reason = "fingerprint_changed";
    else if (session.window !== window) reason = "window_changed";
    else if (parkedMs >= idleLimitMs) reason = "idle_expired";
    else if (decision.kind === "reseed") { reason = decision.reason; divergedAt = decision.divergedAt; }
    // The tail renders from the conversation; a count that does not match the translation is not trusted.
    else if (decision.kind === "continue_user" && messages !== input.conversation.length) reason = "unexpected_tail";
    // Tool outputs go through the relay, so there is no user message to state a forced choice in.
    else if (decision.kind === "continue_outputs" && forced(input.choice)) reason = "forced_choice";
    else if (input.effort !== undefined && input.effort !== session.effort) {
      if (session.state === "awaiting_outputs") reason = "effort_midturn";
      else if (!(await session.applyEffort(input.effort))) reason = "effort_rejected";
    }
    if (!reason && decision.kind !== "reseed") plan = decision;
    if (reason) { registry.sessions.delete(key); void session.close("closed", reason); session = undefined; }
  } else {
    session = undefined;
    const ended = registry.ended.get(key);
    if (ended) reason = ended === "evicted" ? "evicted" : "session_dead";
  }
  if (signal.aborted) throw cancelled();
  if (!session || !plan) {
    while (registry.sessions.size >= registry.settings.max) {
      const victim = evictable(registry);
      if (!victim) return { kind: "fallback", reason: "capacity" };
      registry.sessions.delete(victim.key); void victim.close("evicted");
    }
    try {
      session = await ClaudeSession.start({
        key, fingerprint, window, effort: input.effort, args: input.spawn.args, env: input.spawn.env, mcpCatalog: input.spawn.mcpCatalog,
        keyInUse: () => registry.sessions.has(key) || registry.starting.has(key),
        onClose: (closed, outcome, why) => ended(registry, closed, outcome, why),
      }, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) throw cancelled();
      return { kind: "fallback", reason: error instanceof SessionStartFailure ? error.reason : "spawn_failed" };
    }
    registry.sessions.set(key, session); registry.ended.delete(key);
    plan = { kind: "seed" }; parkedMs = undefined;
  }
  return { kind: "stream", events: start(registry, session, input, entries.map(entry => entry.digest), plan, signal, {
    outcome: plan.kind === "seed" ? reason ? "reseeded" : "spawned" : "continued", missReason: reason, divergedAt, parkedMs,
  }) };
}

function start(registry: SessionRegistry, session: ClaudeSession, input: ClaudeLiveInput, prefix: string[], plan: Plan, signal: AbortSignal, decision: Record<string, unknown>) {
  const forcedBlock = choiceBlock(input.choice, input.tools);
  const begin = plan.kind === "continue_outputs"
    ? { outputs: new Map<string, RelayContent[]>(plan.outputs.map(entry => [entry.callId!, relayContent(entry.item?.output)])) }
    : { user: [...input.render(plan.kind === "continue_user" ? plan.from : 0), ...(forcedBlock ? [forcedBlock] : [])] };
  session.park(registry.settings.parkMinutes * 60000);
  return session.run({
    begin, prefix, stream: input.newStream(), tools: input.tools, choice: input.choice, fast: input.fast, signal,
    onUsage: input.onUsage, onContextWindow: input.onContextWindow,
    onEnd: (end, tokens) => telemetry("claude_session", {
      ...decision, ...(end === "interrupted" ? { outcome: "interrupted" } : {}), failed: end === "failed" || undefined,
      liveSessions: registry.sessions.size, perTurnEffort: session.perTurnEffort,
      inputTokens: tokens?.input, cacheReadTokens: tokens?.cacheRead, cacheWriteTokens: tokens?.cacheWrite, outputTokens: tokens?.output,
    }),
  });
}

function ended(registry: SessionRegistry, session: ClaudeSession, outcome: SessionEnd, reason?: string): void {
  if (registry.sessions.get(session.key) === session) registry.sessions.delete(session.key);
  rememberEnd(registry, session.key, outcome);
  telemetry("claude_session", { outcome, missReason: reason, liveSessions: registry.sessions.size, parkedMs: Date.now() - session.lastUse, exitSignal: session.exitSignal });
}
