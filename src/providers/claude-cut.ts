import { ProviderError } from "./provider.js";

/**
 * A connection that breaks mid-message (sleep, network change) makes Claude Code close the message itself and mark
 * its `message_stop` line with `abandoned_blocks`. Blocks from `from_block_index` on never finished. The CLI then
 * resumes the reply in the same turn, runs the calls that did finish, or prints a synthetic error when it gives up.
 * Observed with 2.1.299 and 2.1.326.
 */
export function abandonedFrom(message: Record<string, unknown>): number | undefined {
  const marker = message.abandoned_blocks;
  if (marker === undefined || marker === null) return;
  const from = typeof marker === "object" ? (marker as { from_block_index?: unknown }).from_block_index : undefined;
  // An unreadable marker still says the message was cut, so nothing in it is trusted as finished.
  return Number.isSafeInteger(from) && (from as number) >= 0 ? from as number : 0;
}

/** Retryable: thrown only while no tool call of the request has been forwarded. */
export const cutFailure = () => new ProviderError("upstream_unavailable",
  "The connection to Claude was lost mid-response, for example because the computer slept or changed networks. No tool calls from this response were forwarded; retry.",
  503, { code: "stream_interrupted", event: "claude.stream" });

export function isCutFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const value = error as { code?: unknown; upstream?: { code?: unknown; event?: unknown } };
  return value.code === "upstream_unavailable" && value.upstream?.code === "stream_interrupted" && value.upstream.event === "claude.stream";
}

/** A failure to resume a cut message; login, billing, limit and request errors keep their own meaning. */
export const failedToResume = (failure: ProviderError): boolean =>
  failure.upstream?.code === "server_error" || (failure.code === "inference_failed" && failure.upstream?.code === "unknown");

/** The CLI's own one-line "Connection lost mid-response" message; it carries no model output and no call. */
export function isCutNotice(message: Record<string, unknown>): boolean {
  if (message.type !== "assistant" || message.is_api_error_message !== true || message.error !== "server_error") return false;
  const native = message.message as { model?: unknown; content?: unknown } | undefined;
  return native?.model === "<synthetic>" && Array.isArray(native.content)
    && native.content.every(block => block && typeof block === "object" && (block as { type?: unknown }).type === "text");
}
