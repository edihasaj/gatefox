import { ProviderError } from "./provider.js";

const maxParts = 8;
const maxCharacters = 16 * 1024;
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Classify a fixed native refusal marker; never retain or expose its diagnostic prose. */
export function claudeRequestRejection(message: Record<string, unknown>): ProviderError | undefined {
  const assistant = message.type === "assistant" && message.error === "invalid_request";
  const result = message.type === "result" && message.is_error === true &&
    (message.error_code === undefined || message.error_code === "invalid_request");
  if (!assistant && !result) return;
  const content = object(message.message)?.content;
  const diagnostics = result ? [message.result, ...(Array.isArray(message.errors) ? message.errors.slice(0, maxParts - 1) : [])]
    : typeof content === "string" ? [content]
    : Array.isArray(content) ? content.slice(0, maxParts).flatMap(part => object(part)?.type === "text" ? [object(part)?.text] : []) : [];
  if (!diagnostics.some(value => typeof value === "string" && value.length <= maxCharacters &&
    /^API Error:\s/.test(value) && /^Details: `\[reasoning_extraction\]`\s*$/m.test(value))) return;
  return new ProviderError("invalid_request",
    "Claude refused this chat under its private-reasoning protection policy (reasoning_extraction). Retrying the same request will not help. Review the request and chat history before trying again.",
    400, { code: "invalid_request", event: assistant ? "claude.assistant" : "claude.result", reason: "reasoning_extraction" });
}
