import type { ProviderError } from "./provider.js";
import { claudeAuthenticationFailure } from "./claude-auth.js";
import { claudeFailure } from "./claude-errors.js";

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
 * Provider capacity and quota answers: a usage or rate limit, unavailable billing credits or a temporary Claude outage.
 * They judge the account at that moment, never the CLI, so before any output they must not hold the thread as a crash.
 */
const limitCodes = new Set(["usage_limit", "rate_limit_exceeded", "insufficient_quota", "upstream_unavailable"]);
export const providerLimit = (error: unknown): error is ProviderError =>
  !!error && typeof error === "object" && limitCodes.has((error as ProviderError).code)
  && ["claude.assistant", "claude.result"].includes((error as ProviderError).upstream?.event ?? "");

/** The provider limit a CLI printed before it exited, when it is the first terminal frame in the unread lines. */
export function queuedLimit(queue: Array<Record<string, unknown>>): ProviderError | undefined {
  const terminal = queue.find(isTerminal);
  const failure = terminal ? claudeFailure(terminal) : undefined;
  return providerLimit(failure) ? failure : undefined;
}

/**
 * Whether a request's start and what it has read so far leave the CLI's history untouched: no native output, no
 * queued steering and no delivered tool results. Only then may an authentication failure skip the crash hold or retry.
 */
export const replaySafeStart = (attached: { output?: boolean; steered?: boolean; turn: { begin: object } }): boolean =>
  !attached.output && !attached.steered && !("outputs" in attached.turn.begin);
