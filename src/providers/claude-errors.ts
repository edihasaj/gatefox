import { ProviderError } from "./provider.js";
import { claudeLimitMessage, type ClaudeLimit } from "./claude-usage.js";

const codes = new Set(["rate_limit", "authentication_failed", "billing_error", "server_error", "invalid_request", "unknown"]);
const subtypes = new Set(["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"]);

/** Read native error discriminants; normal prose and private messages never qualify. */
export function claudeFailure(message: Record<string, unknown>, limit?: ClaudeLimit): ProviderError | undefined {
  const assistant = message.type === "assistant" && typeof message.error === "string";
  const result = message.type === "result" && message.is_error === true;
  if (!assistant && !result) return;
  const raw = assistant ? message.error : message.error_code;
  const code = typeof raw === "string" && codes.has(raw) ? raw : "unknown";
  const upstream = { code, event: assistant ? "claude.assistant" : "claude.result" };
  if (code === "rate_limit") return new ProviderError("usage_limit", claudeLimitMessage(limit), 429, upstream);
  if (code === "authentication_failed") return new ProviderError("authentication", "Claude subscription requires login", 401, upstream);
  if (code === "billing_error") return new ProviderError("insufficient_quota", "Claude provider quota is exhausted", 429, upstream);
  if (code === "server_error") return new ProviderError("upstream_unavailable", "Claude service is temporarily unavailable", 503, upstream);
  const subtype = typeof message.subtype === "string" && subtypes.has(message.subtype) ? message.subtype : "unknown";
  return new ProviderError("inference_failed", "Claude inference did not complete", 502,
    { ...upstream, ...(result ? { subtype } : {}) });
}
