import { ProviderError } from "./provider.js";
import { claudeLimitMessage, type ClaudeLimit } from "./claude-usage.js";
import { claudeAuthenticationFailure } from "./claude-auth.js";
import { claudeRequestRejection } from "./claude-request-rejection.js";

const codes = new Set(["rate_limit", "authentication_failed", "billing_error", "server_error", "invalid_request", "unknown"]);
const subtypes = new Set(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]);
const billingMessage = "Claude billing or extra-usage credits are unavailable. Check your Claude billing settings and payment method, then retry.";
const maxCreditDiagnosticCharacters = 16 * 1024;
const maxCreditDiagnosticParts = 8;
const nativeCreditRefusal = /^(?:API Error:\s*)?(?:Credit balance is too low(?:[\s.,:;!?]|$)|Your credit balance is too low to access the Anthropic API(?:[\s.,:;!?]|$)|Insufficient credits(?:[\s.,:;!?]|$))/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function creditRefusalText(value: unknown): boolean {
  return typeof value === "string" && value.length <= maxCreditDiagnosticCharacters && nativeCreditRefusal.test(value.trim());
}
/** Inspect only bounded provider diagnostics inside a native failure envelope. */
function creditRefusal(message: Record<string, unknown>): boolean {
  if (message.type === "result" && message.is_error === true) {
    const errors = Array.isArray(message.errors) ? message.errors.slice(0, maxCreditDiagnosticParts - 1) : [];
    return [message.result, ...errors].some(creditRefusalText);
  }
  if (message.type !== "assistant" || typeof message.error !== "string") return false;
  const content = object(message.message)?.content;
  if (typeof content === "string") return creditRefusalText(content);
  if (!Array.isArray(content)) return false;
  return content.slice(0, maxCreditDiagnosticParts).some(value => {
    const block = object(value);
    return block?.type === "text" && creditRefusalText(block.text);
  });
}

/**
 * The CLI reports every 429 as `rate_limit`, including a subscriber capacity throttle it
 * marks transient. Only a rejected `rate_limit_event` for this request proves a subscription
 * limit, which is final; anything else is a throttle that Codex may retry.
 */
export function claudeRateLimit(limit: ClaudeLimit | undefined, upstream?: ProviderError["upstream"]): ProviderError {
  if (limit?.status === "rejected") return new ProviderError("usage_limit", claudeLimitMessage(limit), 429, upstream);
  return new ProviderError("rate_limit_exceeded", "Claude is temporarily limiting requests; retry shortly", 429, upstream);
}

/** Read native error discriminants and bounded credit refusals; normal assistant prose never qualifies. */
export function claudeFailure(message: Record<string, unknown>, limit?: ClaudeLimit): ProviderError | undefined {
  const assistant = message.type === "assistant" && typeof message.error === "string";
  const result = message.type === "result" && message.is_error === true;
  if (!assistant && !result) return;
  const authentication = claudeAuthenticationFailure(message); if (authentication) return authentication;
  const raw = assistant ? message.error : message.error_code;
  const code = typeof raw === "string" && codes.has(raw) ? raw : "unknown";
  const upstream = { code, event: assistant ? "claude.assistant" : "claude.result" };
  if (code === "rate_limit") return claudeRateLimit(message.apiErrorIsTransient === true ? undefined : limit, upstream);
  if (code === "authentication_failed") return new ProviderError("authentication", "Claude could not authenticate this request. Retry; if it persists, sign in again.", 401, { ...upstream, reason: "unknown" });
  if (code === "billing_error") return new ProviderError("insufficient_quota", billingMessage, 429, upstream);
  if (code === "server_error") return new ProviderError("upstream_unavailable", "Claude service is temporarily unavailable", 503, upstream);
  if (creditRefusal(message)) return new ProviderError("insufficient_quota", billingMessage, 429, upstream);
  const rejection = claudeRequestRejection(message); if (rejection) return rejection;
  if (code === "invalid_request") return new ProviderError("invalid_request", "Claude rejected this request. Review the request and chat history before trying again.", 400, upstream);
  const subtype = typeof message.subtype === "string" && subtypes.has(message.subtype) ? message.subtype : "unknown";
  return new ProviderError("inference_failed", "Claude inference did not complete", 502,
    { ...upstream, ...(result ? { subtype } : {}) });
}
