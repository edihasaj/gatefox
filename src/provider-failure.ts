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
  "inconsistent_stream", "unsupported_protocol", "invalid_stream", "output_too_large", "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota",
]);
function own(value: unknown, key: string): unknown {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return; }
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
  const result: Record<string, string | number> = {
    event: "provider_failure",
    durationMs: Number.isFinite(input.durationMs) ? Math.max(0, Math.round(input.durationMs)) : 0,
    code: diagnosticCodes.has(input.failure.code) ? input.failure.code : "provider_failed",
    status: Number.isInteger(input.failure.status) && input.failure.status >= 400 && input.failure.status <= 599 ? input.failure.status : 502,
  };
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId)) result.requestId = input.requestId;
  if (input.providerId && /^[a-z][a-z0-9_-]{0,63}$/.test(input.providerId)) result.providerId = input.providerId;
  if (input.modelAlias && /^[a-z0-9][a-z0-9/._:-]{0,127}$/i.test(input.modelAlias)) result.modelAlias = input.modelAlias;
  if (input.abortCause === "timeout" || input.abortCause === "cancelled") result.abortCause = input.abortCause;
  const upstream = input.failure.upstream;
  if (upstream) {
    const codes = new Set(["unknown", "server_error", "server_is_overloaded", "invalid_prompt", "invalid_encrypted_content", "invalid_request_error", "max_output_tokens", "content_filter", "native_tool_search", "native_mcp_wait", "unknown_tool", "malformed_tool_call", "duplicate_tool_id", "nontext_custom_input", "required_tool_missing"]);
    if (codes.has(upstream.code || "")) result.upstreamCode = upstream.code!;
    if (["error", "response.failed", "response.incomplete", "unknown", "http", "claude.tool_use", "claude.result"].includes(upstream.event || "")) result.upstreamEvent = upstream.event!;
    if (upstream.requestId && /^[a-z0-9_-]{1,128}$/i.test(upstream.requestId)) result.upstreamRequestId = upstream.requestId;
  }
  return result;
}
