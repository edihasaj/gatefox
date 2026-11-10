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

/**
 * Chat server overflow wording. Shared with the rejection classifier so a 400 recorded as `context_length` always reaches the
 * client as `context_length_exceeded`; on 9–10 November 2026 48 Qwen overflows were recorded as context_length but surfaced as
 * a plain upstream_error, which ended the turn instead of starting compaction. Wording counts only when the server sent no
 * string error code of its own (vLLM sends a numeric 400); an explicit different code keeps its meaning.
 */
export const chatContextMessage = (message: string, code?: unknown) => typeof code !== "string" && /maximum context length|context window|prompt is too long/i.test(message);
/**
 * vLLM's answer when the prompt fills the whole window: the default output budget becomes zero. The gateway never forwards
 * a zero max_tokens (it rejects max_output_tokens below 1), so this wording always means the input has no room left.
 */
export const chatNoOutputRoom = (message: string) => /max_(?:completion_)?tokens must be at least 1, got 0\b/i.test(message);

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
export async function boundedJson(response: Response): Promise<unknown> {
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
  const message = typeof error.message === "string" ? error.message.slice(0, 4096) : "";
  if (chatNoOutputRoom(message)) return contextWindowFailure();
  const maximum = /maximum context length is (\d+) tokens/i.exec(message);
  if (!maximum) return chatContextMessage(message, error.code) ? contextWindowFailure() : undefined;
  const used = /prompt contains (?:at least )?(\d+) input tokens|messages resulted in (\d+) tokens/i.exec(message);
  const counts = used ? { used: Number(used[1] ?? used[2]), maximum: Number(maximum[1]) } : undefined;
  return contextWindowFailure(counts && Number.isSafeInteger(counts.used) && Number.isSafeInteger(counts.maximum) ? counts : undefined);
}

/** Only native error envelopes qualify, never ordinary assistant prose. */
export function claudeContextFailure(message: Record<string, unknown>): ProviderError | undefined {
  const resultError = message.type === "result" && message.is_error === true;
  const assistantError = message.type === "assistant" && message.error === "invalid_request";
  if (!resultError && !assistantError) return;
  const texts = resultError ? [message.result, ...(Array.isArray(message.errors) ? message.errors : [])]
    : (Array.isArray(object(message.message).content) ? object(message.message).content as unknown[] : []).flatMap(part => object(part).type === "text" ? [object(part).text] : []);
  // The counts come only from the CLI's exact native overflow form; the error text itself is never kept.
  const counted = () => texts.map(promptTokens).find(Boolean);
  if (resultError && (message.terminal_reason === "prompt_too_long" || contextCode(message.error_code) || contextCode(object(message.error).code))) return contextWindowFailure(counted());
  if (resultError && message.subtype !== "error_during_execution") return;
  const overflow = texts.find(cliPromptTooLong);
  if (overflow !== undefined) return contextWindowFailure(promptTokens(overflow) ?? counted());
}

/** Copilot's session.error has structured categories; prose alone is insufficient. */
export function copilotContextFailure(data: Record<string, unknown>): ProviderError | undefined {
  if ([data.errorType, data.code, object(data.error).code].some(contextCode)) return contextWindowFailure();
}
