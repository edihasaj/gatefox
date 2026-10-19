import { registerActivityProbe, registerShutdownHook } from "../runtime-activity.js";
import type { ClaudeSession } from "./claude-session.js";

/**
 * Process-wide live Claude sessions. An in-place upgrade loads a second copy of the
 * live module, so the registry lives on a global symbol and every loaded release
 * shares it while its interface version matches. A field a later release adds gets its
 * empty collection in `adopt`, so adopting an older registry keeps its warm sessions.
 * Any incompatible change to the registry or to ClaudeSession's public members must bump
 * the symbol version; the old version's sessions are then left to their own park timers.
 */
export interface SessionRegistry {
  interfaceVersion: 1;
  sessions: Map<string, ClaudeSession>;
  /** Keys with an attach in progress: deciding, applying effort or starting a process. */
  starting: Set<string>;
  /** How each key's last session ended, so the next spawn reports why it had none. */
  ended: Map<string, string>;
  /** Keys held to the one-shot path, so a hold keeps its reason when the ended log cycles. */
  replayUntil: Map<string, ReplayHold>;
  /** Completed live-mode requests per session key, used to avoid parking one-request threads. */
  warmups: Map<string, Warmup>;
  /** The provider scope that owns each live session key, so one provider can retire its own. */
  scopes: Map<string, string>;
}

/**
 * One thread's hold on the one-shot path: the idle time of the session that gave the thread up, and
 * the miss that gave it up. The reason rides with the hold so it cannot cycle out from under it.
 */
export type ReplayHold = { since: number; why: string };
export type Warmup = { count: number; lastTouched: number };

const symbol = Symbol.for("harness-gateway/claude-sessions/v1");
const recentToolWait = 10 * 60 * 1000;
/**
 * After an hour idle the cache is gone, and the CLI may clear old tool results server-side
 * (context_management clear_tool_uses after 65 idle minutes), so continuing saves nothing.
 */
export const idleMs = 60 * 60 * 1000;
export const warmupMs = 24 * 60 * 60 * 1000;
export const warmupLimit = 4096;

/**
 * The process-wide registry an earlier release left on the global symbol, upgraded in place, or
 * undefined when there is none or it speaks another interface version. Added fields get their maps
 * here, so adopting an older registry never leaves a live module writing into `undefined`.
 */
function adopt(): SessionRegistry | undefined {
  const existing = (globalThis as unknown as Record<symbol, Partial<SessionRegistry> | undefined>)[symbol];
  if (existing?.interfaceVersion !== 1) return;
  existing.replayUntil ??= new Map();
  existing.warmups ??= new Map();
  existing.scopes ??= new Map();
  return existing as SessionRegistry;
}

/** The shared registry, created (with its activity probe and shutdown hook) on first use. */
export function sessionRegistry(): SessionRegistry {
  const existing = adopt();
  if (existing) return existing;
  const registry: SessionRegistry = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), ended: new Map(), replayUntil: new Map(), warmups: new Map(), scopes: new Map() };
  (globalThis as unknown as Record<symbol, SessionRegistry>)[symbol] = registry;
  registerActivityProbe("claude_sessions", () => sessionsBusy(registry));
  registerShutdownHook("claude_sessions", () => closeSessions(registry, "shutdown", false));
  return registry;
}

/**
 * Busy while a session is generating, or waiting on tool outputs it got recently. A
 * session waiting longer gains nothing from its cache, and must not block upgrades forever.
 */
export function sessionsBusy(registry: SessionRegistry, now = Date.now()): boolean {
  return registry.starting.size > 0 || [...registry.sessions.values()].some(session => session.state === "generating" || session.state === "interrupting" ||
    (session.state === "awaiting_outputs" && now - session.lastUse < recentToolWait));
}

/**
 * Slots in use as the attach for `key` sees them: every session, plus each attach that began
 * before it and has no session yet. The starting set keeps insertion order, so with several
 * attaches racing for the last slots the earliest ones are admitted and the rest replay.
 */
export function slotsTaken(registry: SessionRegistry, key: string): number {
  let taken = registry.sessions.size;
  for (const other of registry.starting) {
    if (other === key) break;
    if (!registry.sessions.has(other)) taken++;
  }
  return taken;
}

/**
 * The least recently used session that may make room, and only once its cache has gone cold
 * (`idleMs` or more). A warm session still holds a cache worth more than the process that
 * owns it, so a full registry replays the newcomer instead of evicting one: see claude-live.ts.
 */
export function evictable(registry: SessionRegistry, now = Date.now(), evictAfter = idleMs): ClaudeSession | undefined {
  const cold = [...registry.sessions.values()].filter(session => now - session.lastUse >= evictAfter).sort((a, b) => a.lastUse - b.lastUse);
  return cold.find(session => session.state === "turn_done") ?? cold.find(session => session.state === "awaiting_outputs");
}

export function rememberEnd(registry: SessionRegistry, key: string, outcome: string): void {
  registry.ended.delete(key); registry.ended.set(key, outcome);
  if (registry.ended.size > 256) registry.ended.delete(registry.ended.keys().next().value!);
}

/** Holds a thread to the one-shot path until a session of its own could keep a cache again. */
export function pinReplay(registry: SessionRegistry, key: string, lastUse: number, why: string): void {
  registry.replayUntil.set(key, { since: lastUse, why }); rememberEnd(registry, key, why);
  if (registry.replayUntil.size > 256) registry.replayUntil.delete(registry.replayUntil.keys().next().value!);
}

/**
 * Why a thread is still held to the one-shot path, or undefined once a session may start again. A hold
 * an earlier release left in an adopted registry carried only the idle time and took its reason from
 * `ended`; such a hold is read the same way, and the next turn rewrites it with its own reason.
 */
export function replayPinned(registry: SessionRegistry, key: string, now = Date.now()): string | undefined {
  const held = registry.replayUntil.get(key) as ReplayHold | number | undefined;
  if (held === undefined) return;
  if (now - (typeof held === "number" ? held : held.since) >= idleMs) { registry.replayUntil.delete(key); registry.ended.delete(key); return; }
  return typeof held === "number" ? registry.ended.get(key) : held.why;
}

/** Drops expired entries in insertion order; every completed request moves its entry to the end. */
function pruneWarmups(registry: SessionRegistry, now: number): void {
  for (const [key, entry] of registry.warmups) {
    if (now - entry.lastTouched < warmupMs) break;
    registry.warmups.delete(key);
  }
}

/** Completed requests for this key in the last 24 hours. Reading never extends the retention window. */
export function warmupCompletions(registry: SessionRegistry, key: string, now = Date.now()): number {
  pruneWarmups(registry, now);
  return registry.warmups.get(key)?.count ?? 0;
}

/** Records a final `done`, retaining at most the newest 4096 thread keys. */
export function recordWarmupCompletion(registry: SessionRegistry, key: string, now = Date.now()): void {
  pruneWarmups(registry, now);
  const count = (registry.warmups.get(key)?.count ?? 0) + 1;
  registry.warmups.delete(key);
  registry.warmups.set(key, { count, lastTouched: now });
  while (registry.warmups.size > warmupLimit) registry.warmups.delete(registry.warmups.keys().next().value!);
}

/**
 * Closes idle and parked sessions. A running turn finishes first, and its session closes
 * when it ends; `everything` closes those at once too.
 */
export async function closeSessions(registry: SessionRegistry, reason: string, everything: boolean): Promise<void> {
  await Promise.all([...registry.sessions.values()].map(session => everything ? session.close("closed", reason) : session.retire(reason)));
}

/**
 * Retires every live session that one provider scope owns, without creating the registry or
 * loading the live module: a provider switched to replay calls this on its next request, so its
 * parked sessions end then and not when their park timers fire. Other providers' sessions stay.
 */
export function retireScope(scope: string, reason: string): void {
  const registry = adopt();
  if (!registry) return;
  // A registry from a release without scopes adopts with an empty one: those sessions are not
  // attributable to any provider here, so their own park timers are what closes them.
  for (const [key, session] of registry.sessions) if (registry.scopes.get(key) === scope) void session.retire(reason);
}
