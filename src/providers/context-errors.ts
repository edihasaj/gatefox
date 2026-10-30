import { ProviderError } from "./provider.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** `contextTokens` are the counts a native "prompt is too long: N tokens > M maximum" message reported; the message text stays fixed. */
export const contextWindowFailure = (contextTokens?: { used: number; maximum: number }) =>
  new ProviderError("context_length_exceeded", "The request exceeds the model's context window", 400, contextTokens ? { contextTokens } : undefined);
const nativePromptTooLong = (value: unknown) => typeof value === "string" && /^(?:prompt is too long|prompt is too long: \d+ tokens > \d+ maximum)\.?$/i.test(value.trim());
/** The Claude CLI also prints a longer form ("Prompt is too long · …") for a conversation it cannot compact; inside a native CLI error envelope that is still an overflow. */
const cliPromptTooLong = (value: unknown) => nativePromptTooLong(value) || (typeof value === "string" && /^prompt is too long\s*[·:\u2014-]/i.test(value.trim()));
/** The token counts of a native overflow message; nothing when it carries none or they are not safe integers. */
function promptTokens(value: unknown): { used: number; maximum: number } | undefined {
  const match = typeof value === "string" ? /^prompt is too long: (\d+) tokens > (\d+) maximum\.?$/i.exec(value.trim()) : null;
  if (!match) return;
  const [used, maximum] = [Number(match[1]), Number(match[2])];
  return Number.isSafeInteger(used) && Number.isSafeInteger(maximum) ? { used, maximum } : undefined;
}
const contextCode = (value: unknown) => value === "context_length_exceeded";

/** Anthropic documents this exact invalid_request_error as input context overflow. */
export function anthropicContextFailure(value: unknown): ProviderError | undefined {
  const error = object(object(value).error);
  if (contextCode(error.code) || (error.type === "invalid_request_error" && nativePromptTooLong(error.message))) return contextWindowFailure(promptTokens(error.message));
}

/** Bound failure metadata before parsing; no upstream message is exposed. */
export async function anthropicHttpContextFailure(response: Response): Promise<ProviderError | undefined> {
  if (response.status !== 400) return;
  const body = await boundedJson(response);
  return body === undefined ? undefined : anthropicContextFailure(body);
}

/** A 400 body of at most 64 KiB, parsed; nothing when it is larger, empty or not JSON. */
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 64 * 1024) { await reader.cancel().catch(() => {}); return; }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return; }
  } finally { reader.releaseLock(); }
}

/**
 * vLLM and other OpenAI-compatible Chat servers report input overflow as a plain 400 whose message reads "This model's
 * maximum context length is N tokens. However, … your prompt contains at least M input tokens …" (vLLM) or "… your messages
 * resulted in M tokens" (OpenAI's older form), with no `context_length_exceeded` code. Recognized so Codex's compaction can
 * trim history instead of resending the same request. Only the counts are kept; the message text never leaves this function.
 */
export function chatContextFailure(value: unknown): ProviderError | undefined {
  const error = object(object(value).error);
  if (contextCode(error.code)) return contextWindowFailure();
  const message = typeof error.message === "string" ? error.message : "";
  const maximum = /maximum context length is (\d+) tokens/i.exec(message);
  if (!maximum) return;
  const used = /prompt contains (?:at least )?(\d+) input tokens|messages resulted in (\d+) tokens/i.exec(message);
  const counts = used ? { used: Number(used[1] ?? used[2]), maximum: Number(maximum[1]) } : undefined;
  return contextWindowFailure(counts && Number.isSafeInteger(counts.used) && Number.isSafeInteger(counts.maximum) ? counts : undefined);
}

/** The Chat transport's 400 check; reads a copy, so the original response stays available for ordinary error mapping. */
export async function chatHttpContextFailure(response: Response): Promise<ProviderError | undefined> {
  if (response.status !== 400) return;
  const body = await boundedJson(response.clone());
  return body === undefined ? undefined : chatContextFailure(body);
}

/** Only native error envelopes qualify, never ordinary assistant prose. */
export function claudeContextFailure(message: Record<string, unknown>): ProviderError | undefined {
  const resultError = message.type === "result" && message.is_error === true;
  const assistantError = message.type === "assistant" && message.error === "invalid_request";
  if (!resultError && !assistantError) return;
  if (resultError && (message.terminal_reason === "prompt_too_long" || contextCode(message.error_code) || contextCode(object(message.error).code))) return contextWindowFailure();
  if (resultError && message.subtype !== "error_during_execution") return;
  const texts = resultError ? [message.result, ...(Array.isArray(message.errors) ? message.errors : [])]
    : (Array.isArray(object(message.message).content) ? object(message.message).content as unknown[] : []).flatMap(part => object(part).type === "text" ? [object(part).text] : []);
  const overflow = texts.find(cliPromptTooLong);
  if (overflow !== undefined) return contextWindowFailure(promptTokens(overflow));
}

/** Copilot's session.error has structured categories; prose alone is insufficient. */
export function copilotContextFailure(data: Record<string, unknown>): ProviderError | undefined {
  if ([data.errorType, data.code, object(data.error).code].some(contextCode)) return contextWindowFailure();
}
