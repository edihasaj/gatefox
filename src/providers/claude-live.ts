import { createHash } from "node:crypto";
import type { ChatToolSelection } from "../protocol/types.js";
import { telemetry } from "../telemetry.js";
import { ProviderError } from "./provider.js";
import { choiceBlock } from "./claude-render.js";
import { decide, ledgerEntries, type LedgerDecision, type LedgerPhase } from "./claude-ledger.js";
import { relayContent, type RelayContent } from "./claude-relay.js";
import { ClaudeSession, SessionStartFailure, sweepSessionDirectories, type SessionEnd } from "./claude-session.js";
import { closeSessions, evictable, idleMs, pinReplay, rememberEnd, replayPinned, sessionRegistry, slotsTaken, type SessionRegistry } from "./claude-session-registry.js";
import { sessionKey, type ClaudeLiveInput, type ClaudeLiveOutcome, type ClaudeMissReason } from "./claude-live-contract.js";
import { systemPrefixOnly } from "./claude-usage.js";

/**
 * Live Claude sessions: one long-lived CLI process per Codex thread, loaded lazily by
 * claude.ts. A request continues its thread's session when the history extends what the
 * session holds; otherwise it reseeds the thread in a new process. Anything that fails
 * before output falls back to the one-shot path.
 */
type ReseedReason = ClaudeMissReason | "idle_expired" | "effort_rejected";
/**
 * A request's own provider settings. The cap counts every live session in the process, so a
 * provider with a lower cap may evict another provider's idle sessions; park time is per session.
 */
type Settings = { max: number; parkMinutes: number };
type Plan = Exclude<LedgerDecision, { kind: "reseed" }> | { kind: "seed" };

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const cancelled = () => new ProviderError("cancelled", "Request cancelled", 499);
const forced = (choice: ChatToolSelection | undefined) => choice === "required" || typeof choice === "object";
/**
 * Misses where a second process would rewrite the cache the one-shot path already holds, and
 * keep rewriting it: the thread replays until `idleMs` has passed and a session could keep a
 * cache of its own again. Divergent, dead and crashed sessions belong here; a changed model,
 * window or idle expiry is a normal one-time reseed.
 */
function pinned(reason: ReseedReason): ClaudeMissReason | undefined {
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

export function claudeLive(settings: Settings) {
  const registry = sessionRegistry(); const limits = { max: settings.max, parkMinutes: settings.parkMinutes };
  return {
    attach: (input: ClaudeLiveInput, signal: AbortSignal) => attach(registry, limits, input, signal),
    /** Closes every session at once and forgets how earlier ones ended (tests; shutdown uses the registry hook). */
    stop: async () => { await closeSessions(registry, "stopped", true); registry.ended.clear(); registry.replayUntil.clear(); registry.scopes.clear(); },
    sessions: (): ClaudeSession[] => [...registry.sessions.values()],
  };
}

async function attach(registry: SessionRegistry, settings: Settings, input: ClaudeLiveInput, signal: AbortSignal): Promise<ClaudeLiveOutcome> {
  if (signal.aborted) throw cancelled();
  const key = sessionKey(input.scope, input.threadId);
  if (registry.starting.has(key)) return { kind: "fallback", reason: "concurrent" };
  registry.starting.add(key);
  try { await (swept ??= sweepSessionDirectories()); return await place(registry, settings, key, input, signal); } finally { registry.starting.delete(key); }
}

async function place(registry: SessionRegistry, settings: Settings, key: string, input: ClaudeLiveInput, signal: AbortSignal): Promise<ClaudeLiveOutcome> {
  let session = registry.sessions.get(key);
  if (session?.state === "interrupting") await session.waitIdle(1500);
  if (session?.state === "generating" || session?.state === "interrupting") return { kind: "fallback", reason: "concurrent" };
  if (signal.aborted) throw cancelled();
  const { entries, messages } = ledgerEntries(input.request, input.tools, input.leading);
  const fingerprint = sha(JSON.stringify({ model: input.model, thinking: input.effort !== undefined, fast: input.fast, instructions: input.instructionsDigest, tools: input.toolsDigest }));
  const window = input.windowId ?? "";
  let reason: ReseedReason | undefined; let divergedAt: number | undefined; let plan: Plan | undefined; let parkedMs: number | undefined;
  if (session && session.state !== "closed") {
    parkedMs = Date.now() - session.lastUse;
    const decision = decide(session.ledger, entries, messages, session.state as LedgerPhase, session.pending);
    if (session.fingerprint !== fingerprint) reason = "fingerprint_changed";
    else if (session.window !== window) reason = "window_changed";
    else if (parkedMs >= idleMs) reason = "idle_expired";
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
    if (reason) {
      const dropped = session;
      registry.sessions.delete(key); session = undefined;
      const hold = pinned(reason);
      // A new process would pay that whole cache write again for one turn: answer this one from the one-shot path.
      if (hold) pinReplay(registry, key, dropped.lastUse, reason);
      void dropped.close("closed", reason);
      if (hold) return { kind: "fallback", reason: hold };
    }
  } else {
    session = undefined;
    const hold = replayPinned(registry, key);
    // Asking again starts the hour over: a thread that keeps talking has no use for a session that
    // would reseed it every turn, so the hold only lapses once the thread has actually gone quiet.
    if (hold !== undefined) { registry.replayUntil.set(key, { since: Date.now(), why: hold }); return { kind: "fallback", reason: heldReason(hold) }; }
    const ended = registry.ended.get(key);
    if (ended) reason = ended === "evicted" ? "evicted" : "session_dead";
  }
  if (signal.aborted) throw cancelled();
  if (!session || !plan) {
    // A session and an earlier attach that is still starting both hold a slot, so concurrent starts can never pass the cap.
    while (slotsTaken(registry, key) >= settings.max) {
      const victim = evictable(registry);
      // Nothing has gone cold yet: a warm session is worth more parked than its cache is worth rewriting.
      if (!victim) return { kind: "fallback", reason: "capacity" };
      registry.sessions.delete(victim.key); void victim.close("evicted");
    }
    // While this attach starts the session, the key's starting entry is its own: a failed start removes the thread directory.
    let booting = true;
    try {
      session = await ClaudeSession.start({
        key, fingerprint, window, effort: input.effort, args: input.spawn.args, env: input.spawn.env, mcpCatalog: input.spawn.mcpCatalog, systemPrompt: input.spawn.systemPrompt,
        keyInUse: () => registry.sessions.has(key) || (!booting && registry.starting.has(key)),
        onClose: (closed, outcome, why) => ended(registry, closed, outcome, why),
      }, signal);
      booting = false;
    } catch (error) {
      if (signal.aborted || (error instanceof ProviderError && error.code === "cancelled")) throw cancelled();
      return { kind: "fallback", reason: error instanceof SessionStartFailure ? error.reason : "spawn_failed" };
    }
    registry.sessions.set(key, session); registry.ended.delete(key); registry.replayUntil.delete(key);
    plan = { kind: "seed" }; parkedMs = undefined;
  }
  // A continued session records its scope too: a registry adopted from an earlier release had none,
  // and switching the provider to replay must retire that session along with the ones it started.
  registry.scopes.set(key, input.scope);
  return { kind: "stream", events: start(registry, settings, session, input, entries.map(entry => entry.digest), plan, signal, {
    outcome: plan.kind === "seed" ? reason ? "reseeded" : "spawned" : "continued", missReason: reason, divergedAt, parkedMs, threadKey: key.slice(0, 8),
  }) };
}

function start(registry: SessionRegistry, settings: Settings, session: ClaudeSession, input: ClaudeLiveInput, prefix: string[], plan: Plan, signal: AbortSignal, decision: Record<string, unknown>) {
  const forcedBlock = choiceBlock(input.choice, input.tools);
  const begin = plan.kind === "continue_outputs"
    ? { outputs: new Map<string, RelayContent[]>(plan.outputs.map(entry => [entry.callId!, relayContent(entry.item?.output)])) }
    : { user: [...input.render(plan.kind === "continue_user" ? plan.from : 0), ...(forcedBlock ? [forcedBlock] : [])] };
  session.park(settings.parkMinutes * 60000);
  return session.run({
    begin, prefix, stream: input.newStream(), tools: input.tools, choice: input.choice, fast: input.fast, signal,
    onUsage: input.onUsage, onContextWindow: input.onContextWindow,
    onEnd: (end, tokens) => telemetry("claude_session", {
      ...decision, ...(end === "interrupted" ? { outcome: "interrupted" } : {}), failed: end === "failed" || undefined,
      systemPrefixOnly: decision.outcome === "spawned" || decision.outcome === "reseeded" ? systemPrefixOnly(tokens?.cacheRead, tokens?.cacheWrite) : undefined,
      liveSessions: registry.sessions.size, perTurnEffort: session.perTurnEffort,
      inputTokens: tokens?.input, cacheReadTokens: tokens?.cacheRead, cacheWriteTokens: tokens?.cacheWrite, outputTokens: tokens?.output,
    }),
  });
}

function ended(registry: SessionRegistry, session: ClaudeSession, outcome: SessionEnd, reason?: string): void {
  if (registry.sessions.get(session.key) === session) registry.sessions.delete(session.key);
  if (!registry.sessions.has(session.key)) registry.scopes.delete(session.key);
  // A crash says the CLI died on us; another process would only die on the same cache write, so hold the thread.
  if (outcome === "crashed") pinReplay(registry, session.key, session.lastUse, outcome);
  else if (replayPinned(registry, session.key) === undefined) rememberEnd(registry, session.key, outcome);
  telemetry("claude_session", { outcome, missReason: reason, threadKey: session.key.slice(0, 8), liveSessions: registry.sessions.size, parkedMs: Date.now() - session.lastUse, exitSignal: session.exitSignal });
}
