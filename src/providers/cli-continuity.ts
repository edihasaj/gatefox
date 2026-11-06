import { ProviderError } from "./provider.js";

/** Final before a hidden one-shot fallback: a client must choose whether to retry/reseed. */
export class CliContinuityUnavailable extends ProviderError {
  constructor(provider: "Claude" | "Copilot" | "Grok", reason: string) {
    super("invalid_request", provider === "Grok" && reason === "persistent_session_unqualified"
      ? "Grok's one-shot mode (grokSessions.mode: oneshot) supports standalone requests only. Gateway stopped before replaying this conversation. Set grokSessions.mode to live (the default) to continue a conversation with tools, or select another model."
      : provider === "Claude" && reason === "session_dead"
      ? "Claude session continuation is unavailable (session_dead). Gateway stopped without automatically replaying the conversation. Compact this conversation to recover, or start a fresh chat. Waiting instead requires one uninterrupted idle hour; retrying restarts that wait."
      : `${provider} session continuation is unavailable (${reason}). Gateway stopped without automatically replaying the conversation. Retry after the provider is available, finish the other active turn, or start a fresh chat.`,
      400, { code: "session_continuity_unavailable", event: "gateway.session" });
  }
}

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
