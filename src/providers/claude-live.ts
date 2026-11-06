import { createHash } from "node:crypto";
import type { ChatToolSelection } from "../protocol/types.js";
import { telemetry } from "../telemetry.js";
import { ProviderError } from "./provider.js";
import { choiceBlock } from "./claude-render.js";
import { decide, interleavedToolContinuation, ledgerEntries, messagesAfterTools, queuedToolContinuation, type LedgerDecision, type LedgerPhase, type LedgerEntry } from "./claude-ledger.js";
import { relayContent, type RelayContent } from "./claude-relay.js";
import { ClaudeSession, SessionStartFailure, sweepSessionDirectories, type SessionEnd } from "./claude-session.js";
import { closeSessions, evictable, idleMs, pinReplay, recordWarmupCompletion, rememberEnd, replayPinned, sessionRegistry, slotsTaken, warmupCompletions, type SessionRegistry } from "./claude-session-registry.js";
import { ClaudeSessionPreserved, sessionKey, type ClaudeLiveInput, type ClaudeLiveOutcome, type ClaudeMissReason } from "./claude-live-contract.js";
import { systemPrefixOnly } from "./claude-usage.js";
import { fingerprintChange, fingerprintParts, type FingerprintChange, type FingerprintParts } from "./claude-fingerprint-parts.js";

/**
 * Live Claude sessions: one long-lived CLI process per identified conversation, loaded
 * lazily by claude.ts. Compatible history continues; validated replacements reseed.
 * Mismatches preserve and refuse; eligible pre-output CLI failures may fall back.
 */
type ReseedReason = ClaudeMissReason | "idle_expired" | "effort_rejected";
/**
 * A request's own provider settings. The cap counts every live session in the process, so a
 * provider with a lower cap may evict another provider's idle sessions; park time is per session.
 */
type Settings = { max: number; parkMinutes: number; warmup: number };
type Plan = Exclude<LedgerDecision, { kind: "reseed" }> | { kind: "seed" }
  | { kind: "continue_outputs_with_messages"; outputs: LedgerEntry[]; from: number; indices?: number[] };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
/** What each live session's fingerprint was made of, so a fingerprint reseed can report which part changed (diagnostics only). */
const sessionParts = new WeakMap<ClaudeSession, FingerprintParts>();
// Bump when rendered replay semantics change so adopted sessions reseed safely once.
const replayContractRevision = 2;
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const forced = (choice: ChatToolSelection | undefined) => choice === "required" || typeof choice === "object";
/**
 * Request mismatches must be refused before closing the live CLI or spending on replay.
 * A changed model, window or idle expiry remains a normal one-time reseed.
 */
function preserved(reason: ReseedReason): ClaudeSessionPreserved["missReason"] | undefined {
  switch (reason) {
    case "prefix_diverged": case "unexpected_tail": case "forced_choice": case "effort_midturn": return reason;
    default: return;
  }
}
/** What a held key reports when it replays: the miss that held it, or a session that simply died. */
const heldReason = (why: string | undefined): ClaudeMissReason =>
  why === "prefix_diverged" || why === "unexpected_tail" || why === "forced_choice" || why === "effort_midturn" ? why : "session_dead";
// Session files of a gateway process that died without closing its sessions are removed once per process.
let swept: Promise<void> | undefined;

export function claudeLive(settings: Omit<Settings, "warmup"> & { warmup?: number }) {
  const registry = sessionRegistry(); const limits: Settings = { max: settings.max, parkMinutes: settings.parkMinutes, warmup: settings.warmup ?? 1 };
  return {
    attach: (input: ClaudeLiveInput, signal: AbortSignal) => attach(registry, limits, input, signal),
    complete: (scope: string, threadId: string) => recordWarmupCompletion(registry, sessionKey(scope, threadId)),
    /** Closes every session at once and forgets how earlier ones ended (tests; shutdown uses the registry hook). */
    stop: async () => { await closeSessions(registry, "stopped", true); registry.ended.clear(); registry.replayUntil.clear(); registry.warmups.clear(); registry.scopes.clear(); },
    sessions: (): ClaudeSession[] => [...registry.sessions.values()],
  };
}

/** Refreshes a replay hold exactly when a cold request reaches it. */
function replayFallback(registry: SessionRegistry, key: string): Extract<ClaudeLiveOutcome, { kind: "fallback" }> | undefined {
  const hold = replayPinned(registry, key);
  const mismatch = hold && preserved(hold as ReseedReason);
  if (mismatch) throw new ClaudeSessionPreserved(mismatch, false);
  // Asking again starts the hour over: a thread that keeps talking has no use for a session that
  // would reseed it every turn, so the hold only lapses once the thread has actually gone quiet.
  if (hold !== undefined) { registry.replayUntil.set(key, { since: Date.now(), why: hold }); return { kind: "fallback", reason: heldReason(hold) }; }
}

/** A thread without an open session cannot reserve capacity while it is held or still warming up. */
function coldFallback(registry: SessionRegistry, settings: Settings, key: string): Extract<ClaudeLiveOutcome, { kind: "fallback" }> | undefined {
  const replay = replayFallback(registry, key);
  if (replay) return replay;
  if (warmupCompletions(registry, key) < settings.warmup) return { kind: "fallback", reason: "warmup" };
}

async function attach(registry: SessionRegistry, settings: Settings, input: ClaudeLiveInput, signal: AbortSignal): Promise<ClaudeLiveOutcome> {
  if (signal.aborted) throw cancelled();
  const key = sessionKey(input.scope, input.threadId);
  if (registry.starting.has(key)) return { kind: "fallback", reason: "concurrent" };
  const session = registry.sessions.get(key);
  const cold = !session || session.state === "closed";
  // Keep cold fallbacks out of `starting`: they neither own nor need a live-session slot.
  if (cold) {
    const fallback = coldFallback(registry, settings, key);
    if (fallback) return fallback;
  }
  registry.starting.add(key);
  registry.scopes.set(key, input.scope);
  try { await (swept ??= sweepSessionDirectories()); return await place(registry, settings, key, input, signal, { afterWarmup: cold && settings.warmup > 0 }); } finally {
    registry.starting.delete(key); registry.retiringStarts?.delete(key);
    if (!registry.sessions.has(key)) registry.scopes.delete(key);
  }
}

async function place(registry: SessionRegistry, settings: Settings, key: string, input: ClaudeLiveInput, signal: AbortSignal, admission: { afterWarmup: boolean }): Promise<ClaudeLiveOutcome> {
  let session = registry.sessions.get(key);
  if (session?.state === "interrupting") await session.waitIdle(1500);
  if (session?.state === "generating" || session?.state === "interrupting") return { kind: "fallback", reason: "concurrent" };
  if (signal.aborted) throw cancelled();
  const { entries, messages } = ledgerEntries(input.request, input.tools, input.leading);
  const fingerprint = sha(JSON.stringify({ replayContractRevision, model: input.model, thinking: input.effort !== undefined, fast: input.fast, instructions: input.instructionsDigest, tools: input.toolsDigest }));
  const parts = fingerprintParts({ model: input.model, effort: input.effort, fast: input.fast, instructionsDigest: input.instructionsDigest, mcpCatalog: input.spawn.mcpCatalog });
  let change: FingerprintChange | undefined;
  const window = input.windowId ?? "";
  let reason: ReseedReason | undefined; let divergedAt: number | undefined; let plan: Plan | undefined; let parkedMs: number | undefined;
  if (session && session.state !== "closed") {
    parkedMs = Date.now() - session.lastUse;
    const decision = decide(session.ledger, entries, messages, session.state as LedgerPhase, session.pending);
    if (session.fingerprint !== fingerprint) { reason = "fingerprint_changed"; change = fingerprintChange(sessionParts.get(session), parts); }
    else if (session.window !== window) reason = "window_changed";
    else if (parkedMs >= idleMs) reason = "idle_expired";
    else if (decision.kind === "reseed") {
      const queued = decision.reason === "unexpected_tail" && session.state === "awaiting_outputs"
        ? queuedToolContinuation(entries, decision.divergedAt, session.pending, messages) : undefined;
      // A steer recorded before the outputs, or a subagent report between them: the outputs go first, then the messages.
      const interleaved = !queued && decision.reason === "unexpected_tail" && session.state === "awaiting_outputs" && input.renderAt
        ? interleavedToolContinuation(entries, decision.divergedAt, session.pending, messages) : undefined;
      const continuable = session.queuedInputVersion === 1 && messages === input.conversation.length && input.effort === session.effort;
      if (queued && continuable) {
        plan = { kind: "continue_outputs_with_messages", ...queued };
      } else if (interleaved && continuable) {
        plan = { kind: "continue_outputs_with_messages", outputs: interleaved.outputs, from: interleaved.indices[0], indices: interleaved.indices };
      } else reason = decision.reason === "prefix_diverged" && session.compacted ? "context_compacted"
        : decision.reason === "prefix_diverged" && input.callerHistoryReplacement && session.state === "turn_done" && !session.pending.length
          ? "client_history_replaced"
        // Outputs with caller messages that could not continue in place reseed, as the outputs-first shape always did.
        : decision.reason === "unexpected_tail" && session.state === "awaiting_outputs"
          && (messagesAfterTools(entries, decision.divergedAt, session.pending) || interleavedToolContinuation(entries, decision.divergedAt, session.pending, messages))
          ? "messages_after_tools" : decision.reason;
      divergedAt = decision.divergedAt;
    }
    // The tail renders from the conversation; a count that does not match the translation is not trusted.
    else if (decision.kind === "continue_user" && messages !== input.conversation.length) reason = "unexpected_tail";
    // Tool outputs go through the relay, so there is no user message to state a forced choice in.
    else if (decision.kind === "continue_outputs" && forced(input.choice)) reason = "forced_choice";
    else if (input.effort !== undefined && input.effort !== session.effort) {
      if (session.state === "awaiting_outputs") reason = "effort_midturn";
      else {
        input.replayBudget?.beforeRequest("continued");
        if (!(await session.applyEffort(input.effort))) reason = "effort_rejected";
      }
    }
    if (!reason && decision.kind !== "reseed") plan = decision;
    if (reason) {
      const mismatch = preserved(reason);
      if (mismatch) {
        telemetry("claude_session", { outcome: "preserved", missReason: mismatch, threadKey: key.slice(0, 8), liveSessions: registry.sessions.size });
        throw new ClaudeSessionPreserved(mismatch);
      }
      // Validate the replacement before retiring the existing session. A refused or
      // cancelled request must leave its CLI, ledger and pending relay calls intact.
      input.replayBudget?.beforeRequest("seed");
      if (signal.aborted) throw cancelled();
      const dropped = session;
      registry.sessions.delete(key); session = undefined;
      void dropped.close("closed", reason);
    }
  } else {
    session = undefined;
    const fallback = replayFallback(registry, key);
    if (fallback) return fallback;
    const ended = registry.ended.get(key);
    if (ended) reason = ended === "evicted" ? "evicted" : "session_dead";
  }
  if (signal.aborted) throw cancelled();
  if (!session || !plan) {
    input.replayBudget?.beforeRequest("seed");
    // A session and an earlier attach that is still starting both hold a slot, so concurrent starts can never pass the cap.
    while (slotsTaken(registry, key) >= settings.max) {
      const victim = evictable(registry);
      // Nothing has gone cold yet: a warm session is worth more parked than its cache is worth rewriting.
      if (!victim) return { kind: "fallback", reason: "capacity" };
      registry.sessions.delete(victim.key); void victim.close("evicted");
    }
    try {
      session = await ClaudeSession.start({
        key, fingerprint, window, effort: input.effort, args: input.spawn.args, env: input.spawn.env, mcpCatalog: input.spawn.mcpCatalog, systemPrompt: input.spawn.systemPrompt,
        onClose: (closed, outcome, why) => ended(registry, closed, outcome, why),
      }, signal);
    } catch (error) {
      if (signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) throw cancelled();
      return { kind: "fallback", reason: error instanceof SessionStartFailure ? error.reason : "spawn_failed" };
    }
    registry.sessions.set(key, session); registry.ended.delete(key); registry.replayUntil.delete(key); sessionParts.set(session, parts);
    plan = { kind: "seed" }; parkedMs = undefined;
  }
  // A continued session records its scope too: a registry adopted from an earlier release had none,
  // and switching the provider to replay must retire that session along with the ones it started.
  registry.scopes.set(key, input.scope);
  if (plan.kind !== "seed") input.replayBudget?.beforeRequest("continued");
  session.compacted = false;
  const events = start(registry, settings, session, input, entries.map(entry => entry.digest), plan, signal, {
    outcome: plan.kind === "seed" ? reason ? "reseeded" : "spawned" : "continued", missReason: reason, divergedAt, parkedMs, threadKey: key.slice(0, 8),
    afterWarmup: plan.kind === "seed" && !reason && admission.afterWarmup || undefined, ...(change ?? {}),
  });
  // Scope changes must also retire a CLI whose initialization was still pending.
  // Start the accepted turn first so retirement drains it rather than interrupting it.
  if (registry.retiringStarts?.has(key)) void session.retire("mode_replay");
  return { kind: "stream", events };
}

function start(registry: SessionRegistry, settings: Settings, session: ClaudeSession, input: ClaudeLiveInput, prefix: string[], plan: Plan, signal: AbortSignal, decision: Record<string, unknown>) {
  const forcedBlock = choiceBlock(input.choice, input.tools);
  const begin = plan.kind === "continue_outputs" || plan.kind === "continue_outputs_with_messages"
    ? { outputs: new Map<string, RelayContent[]>(plan.outputs.map(entry => [entry.callId!, relayContent(entry.item?.output)])),
      ...(plan.kind === "continue_outputs_with_messages"
        ? { user: [...(plan.indices && input.renderAt ? input.renderAt(plan.indices) : input.render(plan.from)), ...(forcedBlock ? [forcedBlock] : [])] } : {}) }
    : { user: [...input.render(plan.kind === "continue_user" ? plan.from : 0), ...(forcedBlock ? [forcedBlock] : [])] };
  session.park(settings.parkMinutes * 60000);
  return session.run({
    begin, prefix, stream: input.newStream(), tools: input.tools, choice: input.choice, fast: input.fast, signal,
    onUsage: input.onUsage, onContextWindow: input.onContextWindow,
    onEnd: (end, tokens) => {
      input.replayBudget?.record(tokens, { refused: end === "refused" });
      telemetry("claude_session", {
        ...decision, ...(end === "interrupted" ? { outcome: "interrupted" } : {}), failed: end === "failed" || end === "refused" || undefined,
        systemPrefixOnly: decision.outcome === "spawned" || decision.outcome === "reseeded" ? systemPrefixOnly(tokens?.cacheRead, tokens?.cacheWrite) : undefined,
        liveSessions: registry.sessions.size, perTurnEffort: session.perTurnEffort,
        inputTokens: tokens?.input, cacheReadTokens: tokens?.cacheRead, cacheWriteTokens: tokens?.cacheWrite, outputTokens: tokens?.output,
      });
    },
  });
}

function ended(registry: SessionRegistry, session: ClaudeSession, outcome: SessionEnd, reason?: string): void {
  if (registry.sessions.get(session.key) === session) registry.sessions.delete(session.key);
  if (!registry.sessions.has(session.key) && !registry.starting.has(session.key)) registry.scopes.delete(session.key);
  // A crash says the CLI died on us; another process would only die on the same cache write, so hold the thread.
  if (outcome === "crashed") pinReplay(registry, session.key, session.lastUse, outcome);
  else if (replayPinned(registry, session.key) === undefined) rememberEnd(registry, session.key, outcome);
  telemetry("claude_session", { outcome, missReason: reason, threadKey: session.key.slice(0, 8), liveSessions: registry.sessions.size, parkedMs: Date.now() - session.lastUse, exitSignal: session.exitSignal });
}
