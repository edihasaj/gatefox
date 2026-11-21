/**
 * Fixed vocabularies for everything the shared ACP session code (acp-live.ts, acp-live-session.ts) records or reports.
 * Text from a CLI (a stop reason, an error code, a message) never reaches telemetry or a persisted record: it is mapped
 * through these lists first. Each provider re-exports them under its own names (grok-reasons.ts, gemini-reasons.ts).
 */
export const acpStopReasons = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const;
export type AcpStopReason = typeof acpStopReasons[number] | "unknown";

/** The ACP `stopReason` as a fixed code; anything that is not a known string becomes `unknown`. */
export function acpStopReason(value: unknown): AcpStopReason {
  return typeof value === "string" ? acpStopReasons.find(known => known === value) ?? "unknown" : "unknown";
}

/**
 * Why a conversation has no session, or why a session ended: the only values that may appear as `missReason`, in a refusal
 * message or in the persisted ended-record store. `other` stands for any reason outside this list.
 */
export const acpEndReasons = [
  // The conversation's last session ended this way (see endReason in acp-live.ts).
  "parked", "tool_wait_expired", "session_dead", "session_lost", "interrupted", "closed", "shutdown", "stopped", "authentication_failed",
  // The live-session ledger and the pool refused the request.
  "prefix_diverged", "unexpected_tail", "fingerprint_changed", "forced_choice", "concurrent", "session_missing", "capacity",
  // A request the transport will not serve at all: a standalone-only mode was asked for a continued conversation, or a
  // conversation identity is required and absent, or the request kind is served outside a conversation's session.
  "request_kind", "conversation_id_required",
  // The ended-record store could not vouch for the conversation.
  "ended_store_unavailable", "ended_store_full",
  // Why a session was closed or failed (crash and violation causes), plus the stop reasons above.
  "exited", "invalid_frame", "failed", "unattended_stop", "unattended_output", "backlog", "unannounced_tool", "invalid_tool_call", "call_abandoned",
  "permission_denied_limit", "tool_request_missing", "stop_with_calls", "cli_failed", "timeout", "output_too_large", "invalid_stream", "inference_failed",
  "authentication", "rate_limit", "billing_error", "server_error", "overloaded", "invalid_request", "max_output_tokens", "unknown",
  ...acpStopReasons,
] as const;
export type AcpEndReason = typeof acpEndReasons[number] | "other";
const known = new Set<string>(acpEndReasons);

/** A reason as one of the fixed codes, or `other`. */
export const fixedAcpReason = (value: unknown): AcpEndReason => typeof value === "string" && known.has(value) ? value as AcpEndReason : "other";
