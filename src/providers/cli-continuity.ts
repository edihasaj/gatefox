import { ProviderError } from "./provider.js";

/** The CLI providers that hold a live session per conversation and refuse rather than replay one. */
export type CliContinuityProvider = "Claude" | "Copilot" | "Grok" | "Gemini";

/** Final before a hidden one-shot fallback: a client must choose whether to retry/reseed. */
export class CliContinuityUnavailable extends ProviderError {
  constructor(provider: CliContinuityProvider, reason: string) {
    super("invalid_request", provider === "Grok" && reason === "persistent_session_unqualified"
      ? "Grok's one-shot mode (grokSessions.mode: oneshot) supports standalone requests only. Gateway stopped before replaying this conversation. Set grokSessions.mode to live (the default) to continue a conversation with tools, or select another model."
      : provider === "Claude" && reason === "capacity"
      ? "GateFox's local Claude live-session pool is full (capacity). Increase claudeSessions.max or wait for parked sessions to expire. Finishing a turn or starting a fresh chat does not free a parked slot. Gateway stopped without automatically replaying the conversation."
      : provider === "Claude" && reason === "session_dead"
      ? "Claude session continuation is unavailable (session_dead). Gateway stopped without automatically replaying the conversation. Recover this chat with gatefox claude-sessions recover, compact it, or start a fresh chat. The crash hold expires one hour after failure; blocked retries do not extend it."
      : `${provider} session continuation is unavailable (${reason}). Gateway stopped without automatically replaying the conversation. Retry after the provider is available, finish the other active turn, or start a fresh chat.`,
      400, { code: "session_continuity_unavailable", event: "gateway.session" });
  }
}

const startTimeouts = new Map<string, { count: number; at: number }>();
/** How often one chat may retry a Claude start timeout before it is final, and how long an old timeout counts. */
export const startTimeoutLimits = { retries: 2, windowMs: 15 * 60 * 1000 };
/** Nothing reached Claude when its CLI never finished starting, so the client may retry; repeated timeouts stay final. */
export function claudeStartTimeout(key: string, now = Date.now()): ProviderError {
  const last = startTimeouts.get(key);
  const count = last && now - last.at < startTimeoutLimits.windowMs ? last.count + 1 : 1;
  startTimeouts.delete(key); startTimeouts.set(key, { count, at: now });
  if (startTimeouts.size > 256) startTimeouts.delete(startTimeouts.keys().next().value!);
  if (count > startTimeoutLimits.retries) return new CliContinuityUnavailable("Claude", "initialize_timeout");
  return new ProviderError("upstream_unavailable", "Claude Code did not start in time; this computer may be overloaded. Nothing was sent to Claude; retry.",
    503, { code: "session_start_timeout", event: "gateway.session" });
}
export function claudeStarted(key: string): void { startTimeouts.delete(key); }

/** Request kinds deliberately served outside the ordinary live conversation. */
export const standaloneCliReasons = new Set(["warmup", "no_thread", "request_kind"]);

/** Anonymous first questions are standalone; historical turns need explicit caller identity. */
export const unidentifiedCliHistory = (messages: readonly { role: string }[]): boolean =>
  messages.some(message => message.role === "assistant" || message.role === "tool");

/** Retain a usable native session rather than destroying it on an unexplained mismatch. */
export class CopilotSessionPreserved extends ProviderError {
  constructor(readonly missReason: string) {
    super("invalid_request", "Copilot's live session was preserved. This request cannot safely continue its history or pending tools. Resume with matching history and settings, compact, or start a fresh chat. Gateway did not replay the conversation.",
      400, { code: "copilot_session_preserved", event: "copilot.session" });
  }
}
