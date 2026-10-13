import { ProviderError } from "./providers/provider.js";
import { ResponsesTranslationError } from "./protocol/request.js";

export type ProviderAbortCause = "timeout" | "cancelled" | undefined;
const networkCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENETDOWN", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);
const diagnosticCodes = new Set([
  "timeout", "cancelled", "authentication", "invalid_request", "invalid_json", "request_too_large", "model_not_found", "busy", "usage_limit",
  "upstream_error", "upstream_unavailable", "provider_failed", "inference_failed", "incomplete", "invalid_tool_call", "cli_failed", "output_too_large",
  "inconsistent_stream", "unsupported_protocol", "invalid_stream", "invalid_output", "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota",
]);
const upstreamCodes = new Set([
  "unknown", "missing_terminal", "server_error", "server_is_overloaded", "rate_limit", "authentication_failed", "billing_error", "invalid_request",
  "rate_limit_exceeded", "slow_down", "insufficient_quota", "invalid_prompt", "invalid_encrypted_content", "invalid_request_error", "max_output_tokens",
  "content_filter", "context_length_exceeded", "invalid_api_key", "authentication_error", "token_expired", "unauthorized", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "native_tool_search", "native_mcp_wait", "unknown_tool", "unavailable_gateway_tool",
  "native_builtin_tool", "malformed_tool_call", "duplicate_tool_id", "nontext_custom_input", "required_tool_missing",
]);
const streamEvents = new Set([
  "response.created", "response.queued", "response.in_progress", "response.output_item.added", "response.output_item.done",
  "response.output_text.delta", "response.output_text.done", "response.content_part.added", "response.content_part.done",
  "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done",
  "response.reasoning_text.delta", "response.reasoning_text.done", "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done", "response.completed", "response.incomplete", "response.failed", "error", "unknown",
]);
function own(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return; }
}
function recordObject(value: unknown): boolean {
  try { return value !== null && typeof value === "object" && !Array.isArray(value); } catch { return false; }
}
function networkFailure(error: unknown): boolean {
  // Node fetch uses a static outer message even when its cause is unfamiliar.
  if (error instanceof TypeError && own(error, "message") === "fetch failed") return true;
  let current = error; const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth++) {
    seen.add(current); const code = own(current, "code");
    if (typeof code === "string" && networkCodes.has(code)) return true;
    current = own(current, "cause");
  }
  return false;
}

// Codex retries a failed stream up to five times. These failures repeat
// identically, so the stream reports Codex's non-retryable request error and
// the turn stops at once instead of re-running inference.
const permanentCodes = new Set(["invalid_request", "invalid_json", "request_too_large", "model_not_found", "unsupported_protocol", "authentication"]);
export function streamFailureCode(code: string): string { return permanentCodes.has(code) ? "invalid_prompt" : code; }

/** Forward only trusted typed errors or static transport messages. Never expose a raw exception. */
export function classifyProviderFailure(error: unknown, cause: ProviderAbortCause): ProviderError {
  if (cause === "timeout") return new ProviderError("timeout", "Provider request exceeded the gateway deadline", 504);
  if (cause === "cancelled") return new ProviderError("cancelled", "Provider request was cancelled", 499);
  if (error instanceof ProviderError) return error;
  if (error instanceof ResponsesTranslationError) return new ProviderError("invalid_request", "Responses request contains invalid or unsupported data", 400);
  if (networkFailure(error)) return new ProviderError("upstream_unavailable", "Provider connection failed or disconnected; retry when its connection is available", 503);
  return new ProviderError("provider_failed", "Provider transport or protocol failed before completion", 502);
}

export interface ProviderFailureDiagnosticInput {
  requestId: string;
  providerId?: string;
  modelAlias?: string;
  durationMs: number;
  failure: ProviderError;
  abortCause?: ProviderAbortCause;
}
/** A bounded metadata record; bodies, messages, stacks, URLs and credentials are absent. */
export function providerFailureDiagnostic(input: ProviderFailureDiagnosticInput): Record<string, string | number> {
  const failure = own(input, "failure"); const code = own(failure, "code"); const status = own(failure, "status"); const durationMs = own(input, "durationMs");
  const result: Record<string, string | number> = {
    event: "provider_failure", timestamp: new Date().toISOString(),
    durationMs: typeof durationMs === "number" && Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    code: typeof code === "string" && diagnosticCodes.has(code) ? code : "provider_failed",
    status: typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
  };
  const requestId = own(input, "requestId"); const providerId = own(input, "providerId"); const modelAlias = own(input, "modelAlias"); const abortCause = own(input, "abortCause");
  if (typeof requestId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId)) result.requestId = requestId;
  if (typeof providerId === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(providerId)) result.providerId = providerId;
  if (typeof modelAlias === "string" && /^[a-z0-9][a-z0-9/._:-]{0,127}$/i.test(modelAlias)) result.modelAlias = modelAlias;
  if (abortCause === "timeout" || abortCause === "cancelled") result.abortCause = abortCause;
  const upstream = own(failure, "upstream");
  if (upstream) {
    const upstreamCode = own(upstream, "code"); const event = own(upstream, "event"); const subtype = own(upstream, "subtype"); const upstreamRequestId = own(upstream, "requestId");
    if (typeof upstreamCode === "string" && upstreamCodes.has(upstreamCode)) result.upstreamCode = upstreamCode;
    if (typeof event === "string" && ["error", "response.failed", "response.incomplete", "unknown", "http", "eof", "claude.tool_use", "claude.assistant", "claude.result"].includes(event)) result.upstreamEvent = event;
    if (typeof subtype === "string" && ["success", "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries", "unknown"].includes(subtype)) result.upstreamSubtype = subtype;
    if (typeof upstreamRequestId === "string" && /^[a-z0-9_-]{1,128}$/i.test(upstreamRequestId)) result.upstreamRequestId = upstreamRequestId;
    const stream = own(upstream, "stream");
    if (recordObject(stream)) {
      for (const [key, field] of [["events", "upstreamEvents"], ["reasoningItems", "upstreamReasoningItems"], ["textDeltas", "upstreamTextDeltas"], ["toolCalls", "upstreamToolCalls"]]) {
        const count = own(stream, key);
        if (typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 1000000) result[field] = count;
      }
      const lastEvent = own(stream, "lastEvent");
      result.upstreamLastEvent = typeof lastEvent === "string" && streamEvents.has(lastEvent) ? lastEvent : "unknown";
    }
  }
  return result;
}
