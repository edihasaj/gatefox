import { oauthErrorCodes } from "./auth/chatgpt.js";
import { ProviderError } from "./providers/provider.js";
import { classifyNetworkFailure, diagnosticNetworkCodes, transientNetworkCodes } from "./provider-network.js";
import { ResponsesTranslationError, translationItemTypes, translationReasons } from "./protocol/request.js";

export type ProviderAbortCause = "timeout" | "cancelled" | "shutdown" | undefined;
const networkCodes: ReadonlySet<string> = new Set([...transientNetworkCodes, ...diagnosticNetworkCodes]);
const diagnosticCodes = new Set([
  "timeout", "cancelled", "authentication", "invalid_request", "invalid_json", "request_too_large", "model_not_found", "busy", "usage_limit",
  "upstream_error", "upstream_unavailable", "provider_failed", "inference_failed", "incomplete", "invalid_tool_call", "cli_failed", "output_too_large",
  "inconsistent_stream", "unsupported_protocol", "invalid_stream", "invalid_output", "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota",
  "upstream_rejected", "provider_unreachable",
]);
const upstreamCodes = new Set([
  "unknown", "missing_terminal", "server_error", "server_is_overloaded", "rate_limit", "authentication_failed", "billing_error", "invalid_request",
  "rate_limit_exceeded", "slow_down", "insufficient_quota", "invalid_prompt", "invalid_encrypted_content", "invalid_request_error", "max_output_tokens",
  "content_filter", "context_length_exceeded", "invalid_api_key", "authentication_error", "token_expired", "unauthorized", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "native_tool_search", "native_mcp_wait", "unknown_tool", "unavailable_gateway_tool",
  "native_builtin_tool", "malformed_tool_call", "duplicate_tool_id", "nontext_custom_input", "required_tool_missing",
  "cyber_policy", "bio_policy", "misalignment_policy_violation", "usage_not_included", "forced_tool_mismatch", "tool_choice_none",
  "usage_limit_reached", "subscription_sharing_usage_limit_exceeded", "subscription_sharing_unsupported_capability", "billing_hard_limit_reached", "billing_not_active",
]);
const claudeCredentialReasons = new Set(["login_unavailable", "session_expired", "credential_revoked", "upstream_rejected", "unknown"]);
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
/** A fixed failure class, or nothing. An arbitrary caller string never becomes a diagnostic value. */
function allowlisted(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

// Codex retries a failed stream up to five times unless its code is one Codex treats
// as final. These failures repeat identically, so the stream reports such a code and
// the turn stops at once instead of re-running inference.
const permanentCodes = new Set(["invalid_request", "invalid_json", "request_too_large", "model_not_found", "unsupported_protocol", "authentication", "usage_limit", "insufficient_quota"]);
const finalUpstreamCodes = new Set(["cyber_policy", "bio_policy", "misalignment_policy_violation", "usage_not_included", "invalid_prompt"]);
const rejectedStatuses = new Set([400, 404, 413, 422]);
/** The error code a failed stream sends to Codex. */
export function streamFailureCode(error: ProviderError): string {
  const upstream = own(error, "upstream"); const upstreamCode = own(upstream, "code"); const httpStatus = own(upstream, "httpStatus");
  if (permanentCodes.has(error.code)) return "invalid_prompt";
  if (error.code === "upstream_rejected") return typeof upstreamCode === "string" && finalUpstreamCodes.has(upstreamCode) ? upstreamCode : "invalid_prompt";
  if (error.code === "upstream_error" && typeof httpStatus === "number" && rejectedStatuses.has(httpStatus)) return "invalid_prompt";
  return error.code;
}

/** Forward only trusted typed errors or static transport messages. Never expose a raw exception. */
export function classifyProviderFailure(error: unknown, cause: ProviderAbortCause): ProviderError {
  if (cause === "timeout") return new ProviderError("timeout", "Provider request exceeded the gateway deadline", 504);
  if (cause === "cancelled") return new ProviderError("cancelled", "Provider request was cancelled", 499);
  if (cause === "shutdown") return new ProviderError("upstream_unavailable", "Gateway is restarting; retry shortly", 503);
  try { if (error instanceof ProviderError) return error; } catch { /* A hostile Proxy is an unknown failure. */ }
  try { if (error instanceof ResponsesTranslationError) return new ProviderError("invalid_request", "Responses request contains invalid or unsupported data", 400); } catch { /* fall through */ }
  // A bare Node fetch wrapper remains compatible. Detailed raw transport
  // normalization belongs only to ResponsesAPI's post-credential boundaries.
  const network = classifyNetworkFailure(error);
  if (network.kind === "transient" || network.kind === "diagnostic") return new ProviderError("upstream_unavailable", "Provider connection failed or disconnected; retry when its connection is available", 503);
  return new ProviderError("provider_failed", "Provider transport or protocol failed before completion", 502);
}

export interface ProviderFailureDiagnosticInput {
  requestId: string;
  providerId?: string;
  modelAlias?: string;
  durationMs: number;
  failure: ProviderError;
  abortCause?: ProviderAbortCause;
  /** Why a request could not be translated, when the failure was a translation error. */
  reason?: string;
  /** Allowlisted Responses item or tool type the translation rejected. */
  itemType?: string;
  /** The gateway's own fixed refusal class (`unsupported_compaction`), when the request was refused by a gateway rule rather than translated. */
  translation_reason?: string;
}
/**
 * The gateway's own compaction rule, sent as a fixed final failure. Codex's remote
 * compaction control item (`compaction_trigger`) reaches the executor, not a provider,
 * so its message is written here and never carries caller text.
 */
export const unsupportedCompactionMessage = "This gateway serves compaction inside the gateway executor; this Codex build sent remote compaction, which the gateway does not support yet.";
/** The gateway-rule refusal classes a failure may carry as `translation_reason`. */
const gatewayRefusalReasons: ReadonlySet<string> = new Set(["unsupported_compaction"]);
/** A ProviderError whose failure telemetry records the fixed `translation_reason`. */
class UnsupportedCompactionFailure extends ProviderError { readonly translationReason = "unsupported_compaction" as const;
  constructor() { super("invalid_request", unsupportedCompactionMessage, 400); } }
export function unsupportedCompactionFailure(): ProviderError { return new UnsupportedCompactionFailure(); }

/** The translation classes a failure may carry; empty for every other error. */
export function translationFailureFields(error: unknown): Record<string, string> {
  if (error instanceof UnsupportedCompactionFailure) return { translation_reason: error.translationReason };
  if (!(error instanceof ResponsesTranslationError)) return {};
  const reason = allowlisted(own(error, "reason"), translationReasons); const itemType = allowlisted(own(error, "itemType"), translationItemTypes);
  return { ...(reason ? { reason } : {}), ...(itemType ? { itemType } : {}) };
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
  if (abortCause === "timeout" || abortCause === "cancelled" || abortCause === "shutdown") result.abortCause = abortCause;
  const reason = allowlisted(own(input, "reason"), translationReasons); const itemType = allowlisted(own(input, "itemType"), translationItemTypes);
  if (reason) result.reason = reason; if (itemType) result.itemType = itemType;
  const refusal = allowlisted(own(input, "translation_reason"), gatewayRefusalReasons);
  if (refusal) result.translation_reason = refusal;
  const upstream = own(failure, "upstream");
  if (upstream) {
    const upstreamCode = own(upstream, "code"); const event = own(upstream, "event"); const subtype = own(upstream, "subtype"); const upstreamRequestId = own(upstream, "requestId");
    if (typeof upstreamCode === "string" && (upstreamCodes.has(upstreamCode) || networkCodes.has(upstreamCode) || (event === "oauth_refresh" && (oauthErrorCodes.has(upstreamCode) || upstreamCode === "other" || upstreamCode === "none")))) result.upstreamCode = upstreamCode;
    if (typeof event === "string" && ["error", "response.failed", "response.incomplete", "unknown", "http", "eof", "network", "oauth_refresh", "claude.tool_use", "claude.assistant", "claude.result", "grok.tool_use", "grok.assistant", "grok.result"].includes(event)) result.upstreamEvent = event;
    const stage = own(upstream, "stage");
    if (event === "network" && (stage === "connect" || stage === "stream" || stage === "unknown")) result.upstreamStage = stage;
    if (upstreamCode === "authentication_failed" && (event === "claude.assistant" || event === "claude.result")) {
      const reason = allowlisted(own(upstream, "reason"), claudeCredentialReasons);
      if (reason) result.upstreamReason = reason;
    }
    if (upstreamCode === "invalid_request" && (event === "claude.assistant" || event === "claude.result") && own(upstream, "reason") === "reasoning_extraction") result.upstreamReason = "reasoning_extraction";
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
