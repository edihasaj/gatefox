import { ProviderError } from "./provider.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
/** `contextTokens` are the counts a native "prompt is too long: N tokens > M maximum" message reported; the message text stays fixed. */
export const contextWindowFailure = (contextTokens?: { used: number; maximum: number }) =>
  new ProviderError("context_length_exceeded", "The request exceeds the model's context window", 400, contextTokens ? { contextTokens } : undefined);
const nativePromptTooLong = (value: unknown) => typeof value === "string" && /^(?:prompt is too long|prompt is too long: \d+ tokens > \d+ maximum)\.?$/i.test(value.trim());
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
  if (response.status !== 400 || !response.body) return;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > 64 * 1024) { await reader.cancel().catch(() => {}); return; }
      chunks.push(part.value);
    }
    try { return anthropicContextFailure(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { return; }
  } finally { reader.releaseLock(); }
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
  const overflow = texts.find(nativePromptTooLong);
  if (overflow !== undefined) return contextWindowFailure(promptTokens(overflow));
}

/** Copilot's session.error has structured categories; prose alone is insufficient. */
export function copilotContextFailure(data: Record<string, unknown>): ProviderError | undefined {
  if ([data.errorType, data.code, object(data.error).code].some(contextCode)) return contextWindowFailure();
}
