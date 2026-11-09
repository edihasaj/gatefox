import type { ProviderError } from "./provider.js";
import { claudeAuthenticationFailure } from "./claude-auth.js";

/** Whether a native stream line is model output: visible text, hidden reasoning or tool use. message_start and housekeeping are not. */
export function isNativeOutput(message: Record<string, unknown>, event: unknown): boolean {
  // The parser treats an assistant frame as a failure only when `error` is a string; null or false frames are successes.
  return event === "content_block_start" || event === "content_block_delta" || (message.type === "assistant" && typeof message.error !== "string");
}

/** A frame that ends a request: any result, or an assistant frame with a string `error`, as the parser sees one. */
const isTerminal = (message: Record<string, unknown>): boolean =>
  message.type === "result" || (message.type === "assistant" && typeof message.error === "string");

/**
 * The authentication failure a CLI printed before it exited, found in lines the reader has not consumed yet. Only
 * the first terminal frame counts: a success, billing, rate or request error ahead of a login failure is never
 * replaced by it. Output frames before it are already recorded on the request, not judged here.
 */
export function queuedAuthentication(queue: Array<Record<string, unknown>>): ProviderError | undefined {
  const terminal = queue.find(isTerminal);
  return terminal ? claudeAuthenticationFailure(terminal) : undefined;
}

/**
 * Whether a request's start and what it has read so far leave the CLI's history untouched: no native output, no
 * queued steering and no delivered tool results. Only then may an authentication failure skip the crash hold or retry.
 */
export const replaySafeStart = (attached: { output?: boolean; steered?: boolean; turn: { begin: object } }): boolean =>
  !attached.output && !attached.steered && !("outputs" in attached.turn.begin);
