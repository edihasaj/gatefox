import { registerActivityProbe, registerShutdownHook } from "../runtime-activity.js";
import type { ClaudeSession } from "./claude-session.js";

/**
 * Process-wide live Claude sessions. An in-place upgrade loads a second copy of the
 * live module, so the registry lives on a global symbol and every loaded release
 * shares it while its interface version matches. Any incompatible change to the
 * registry or to ClaudeSession's public members must bump the symbol version; the
 * old version's sessions are then left to their own park timers.
 */
export interface SessionRegistry {
  interfaceVersion: 1;
  sessions: Map<string, ClaudeSession>;
  /** Keys with an attach in progress: deciding, applying effort or starting a process. */
  starting: Set<string>;
  /** How each key's last session ended, so the next spawn reports why it had none. */
  ended: Map<string, string>;
}

const symbol = Symbol.for("harness-gateway/claude-sessions/v1");
const recentToolWait = 10 * 60 * 1000;

/** The shared registry, created (with its activity probe and shutdown hook) on first use. */
export function sessionRegistry(): SessionRegistry {
  const scope = globalThis as unknown as Record<symbol, Partial<SessionRegistry> | undefined>;
  const existing = scope[symbol];
  if (existing?.interfaceVersion === 1) return existing as SessionRegistry;
  const registry: SessionRegistry = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), ended: new Map() };
  scope[symbol] = registry;
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

/** The least recently used session that may make room: finished turns first, then tool waits, never a running turn. */
export function evictable(registry: SessionRegistry): ClaudeSession | undefined {
  const sessions = [...registry.sessions.values()].sort((a, b) => a.lastUse - b.lastUse);
  return sessions.find(session => session.state === "turn_done") ?? sessions.find(session => session.state === "awaiting_outputs");
}

export function rememberEnd(registry: SessionRegistry, key: string, outcome: string): void {
  registry.ended.delete(key); registry.ended.set(key, outcome);
  if (registry.ended.size > 256) registry.ended.delete(registry.ended.keys().next().value!);
}

/**
 * Closes idle and parked sessions. A running turn finishes first, and its session closes
 * when it ends; `everything` closes those at once too.
 */
export async function closeSessions(registry: SessionRegistry, reason: string, everything: boolean): Promise<void> {
  await Promise.all([...registry.sessions.values()].map(session => everything ? session.close("closed", reason) : session.retire(reason)));
}
