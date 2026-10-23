import { ProviderError, type ProviderStreamDiagnostic } from "./provider.js";
import type { WireEvent } from "../protocol/types.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const contextError = () => new ProviderError("context_length_exceeded", "The request exceeds the model's context window", 400);
const errorBodyLimit = 64 * 1024;
const knownCodes = new Set(["server_error", "server_is_overloaded", "rate_limit_exceeded", "slow_down", "insufficient_quota", "invalid_prompt", "invalid_encrypted_content", "invalid_request_error", "max_output_tokens", "content_filter", "context_length_exceeded", "invalid_api_key", "authentication_error", "token_expired", "unauthorized", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
  "cyber_policy", "bio_policy", "misalignment_policy_violation", "usage_not_included", "usage_limit_reached", "subscription_sharing_usage_limit_exceeded", "subscription_sharing_unsupported_capability",
  "billing_hard_limit_reached", "billing_not_active", "billing_error"]);
// The upstream rejected this exact request, so a retry repeats the failure. Each class has a
// fixed message; upstream prose may quote caller data and is never forwarded.
const rejections: Record<string, string> = {
  invalid_prompt: "Provider rejected the request as invalid",
  invalid_encrypted_content: "Provider rejected the replayed reasoning state",
  cyber_policy: "Provider flagged the request for possible cybersecurity risk",
  bio_policy: "Provider flagged the request for possible biological risk",
  misalignment_policy_violation: "Provider blocked the request under its misalignment policy",
  usage_not_included: "The provider plan does not include this usage",
  subscription_sharing_unsupported_capability: "The ChatGPT subscription-sharing endpoint does not support a requested capability. Use a supported gateway tool or native Codex.",
};
const rejected = (code: unknown, upstream: NonNullable<ProviderError["upstream"]>) => typeof code === "string" && Object.hasOwn(rejections, code) ?
  new ProviderError("upstream_rejected", rejections[code], 400, { ...upstream, code }) : undefined;
const requestIdOf = (value: string | null | undefined) => value && /^[a-z0-9_-]{1,128}$/i.test(value) ? { requestId: value } : {};
const streamEventTypes = new Set(["response.created", "response.queued", "response.in_progress", "response.output_item.added", "response.output_item.done",
  "response.output_text.delta", "response.output_text.done", "response.content_part.added", "response.content_part.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done",
  "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done", "response.reasoning_text.delta", "response.reasoning_text.done", "response.function_call_arguments.delta", "response.function_call_arguments.done",
  "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done", "response.completed", "response.incomplete", "response.failed", "error"]);
const count = (value: number) => Number.isFinite(value) ? Math.min(1000000, Math.max(0, Math.floor(value))) : 0;
/** Track protocol shape only. Unknown types may contain private text, so retain no raw value. */
export function observeResponsesStream(stream: ProviderStreamDiagnostic, event: WireEvent): void {
  stream.events = count(stream.events + 1); stream.lastEvent = streamEventTypes.has(event.type) ? event.type : "unknown";
  if (event.type === "response.output_text.delta") stream.textDeltas = count(stream.textDeltas + 1);
  if (["response.output_item.added", "response.output_item.done"].includes(event.type) && object(event.item).type === "reasoning") stream.reasoningItems = count(stream.reasoningItems + 1);
}
export function responsesEOFError(stream: ProviderStreamDiagnostic, requestId?: string): ProviderError {
  return new ProviderError("incomplete", "Provider stream ended without completion", 502, { code: "missing_terminal", event: "eof",
    ...requestIdOf(requestId),
    stream: { events: count(stream.events), reasoningItems: count(stream.reasoningItems), textDeltas: count(stream.textDeltas), toolCalls: count(stream.toolCalls),
      ...(stream.lastEvent === undefined ? {} : { lastEvent: streamEventTypes.has(stream.lastEvent) ? stream.lastEvent : "unknown" }) } });
}

// A 429 that names one of these classes is a usage, billing or plan limit and does not clear by
// itself. The ChatGPT backend and Anthropic put the class in error.type rather than error.code.
const quotaClasses = new Set(["insufficient_quota", "usage_limit_reached", "subscription_sharing_usage_limit_exceeded", "usage_not_included", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "billing_hard_limit_reached", "billing_not_active", "billing_error"]);
// Plan usage windows that reset on their own schedule. ChatGPT reports a shared subscription that ran out as
// subscription_sharing_usage_limit_exceeded with type invalid_request_error; its message names the account limit.
const usageWindows = new Set(["usage_limit_reached", "subscription_sharing_usage_limit_exceeded"]);
const usageLimitMessage = (name: unknown) => name === "subscription_sharing_usage_limit_exceeded"
  ? "This ChatGPT account reached its usage limit for gateway subscription sharing. Try again after it resets, or choose another account."
  : "Provider usage limit reached";
// Named per-minute throttles, including the names OpenAI-compatible Chat Completions servers use.
const throttleClasses = new Set(["rate_limit_exceeded", "slow_down", "rate_limit_error", "too_many_requests", "limit_requests", "limit_burst_rate"]);

/** Read only bounded error metadata. Upstream messages may contain caller data. */
async function httpErrorFields(response: Response): Promise<{ code?: unknown; type?: unknown }> {
  if (!response.body) return {};
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > errorBodyLimit) { await reader.cancel().catch(() => {}); return {}; }
      chunks.push(next.value);
    }
    try { const error = object(object(JSON.parse(Buffer.concat(chunks).toString("utf8"))).error); return { code: error.code, type: error.type }; }
    catch { return {}; }
  } finally { reader.releaseLock(); }
}

export async function responsesHttpError(response: Response): Promise<ProviderError> {
  // Status-based authentication and capacity errors remain authoritative.
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    return new ProviderError("authentication", "Provider login is missing or expired", response.status);
  }
  const { code, type } = await httpErrorFields(response);
  const names = [code, type].filter((name): name is string => typeof name === "string");
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const milliseconds = header && header.length <= 128 ? (/^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : undefined;
    const short = milliseconds !== undefined && Number.isFinite(milliseconds) && milliseconds <= 60000;
    // A named quota class is a usage limit, which Codex treats as final, even with a short wait.
    // A named throttle, or any other 429 that asks for a wait of at most 60 s, clears by itself.
    const throttle = !names.some(name => quotaClasses.has(name)) && (short || names.some(name => throttleClasses.has(name)));
    if (throttle) return new ProviderError("rate_limit_exceeded", "Provider usage limit reached", 429,
      { code: typeof code === "string" && knownCodes.has(code) ? code : "rate_limit_exceeded", event: "http",
        retryAfterMs: milliseconds !== undefined && Number.isFinite(milliseconds) ? Math.max(1000, milliseconds) : 1000 });
    const quota = names.find(name => quotaClasses.has(name));
    return new ProviderError("usage_limit", usageLimitMessage(quota), 429, {
      code: quota ?? names.find(name => knownCodes.has(name)) ?? "unknown", event: "http", httpStatus: 429, ...requestIdOf(response.headers.get("x-request-id")),
    });
  }
  if ([500, 502, 503, 504].includes(response.status)) return new ProviderError("upstream_unavailable", "Provider temporarily failed; retry when it is available", 503,
    { code: typeof code === "string" && knownCodes.has(code) ? code : "unknown", event: "http" });
  if (names.includes("context_length_exceeded")) return contextError();
  const rejection = names.find(name => Object.hasOwn(rejections, name));
  const upstream = { code: rejection ?? names.find(name => knownCodes.has(name)) ?? "unknown", event: "http", httpStatus: response.status, ...requestIdOf(response.headers.get("x-request-id")) };
  return rejected(rejection, upstream) ?? new ProviderError("upstream_error", `Provider returned HTTP ${response.status}`, response.status === 400 ? 400 : 502, upstream);
}

export function responsesStreamError(event: ObjectValue, requestId?: string): ProviderError {
  const response = object(event.response);
  const responseError = object(response.error), eventError = object(event.error);
  const reason = object(response.incomplete_details).reason;
  // Providers may put exhaustion in type beside a generic or throttling code.
  // Read only fixed discriminants; event.type itself is the SSE envelope.
  const quota = [responseError.code, responseError.type, eventError.code, eventError.type, event.code, reason]
    .find(value => typeof value === "string" && quotaClasses.has(value));
  const rejection = [responseError.code, responseError.type, eventError.code, eventError.type, event.code, reason]
    .find(value => typeof value === "string" && Object.hasOwn(rejections, value));
  const code = quota ?? rejection ?? responseError.code ?? eventError.code ?? event.code ??
    responseError.type ?? eventError.type ?? reason;
  const upstream = { code: typeof code === "string" && knownCodes.has(code) ? code : "unknown",
    event: ["error", "response.failed", "response.incomplete"].includes(String(event.type)) ? String(event.type) : "unknown", ...requestIdOf(requestId) };
  if (typeof quota === "string" && usageWindows.has(quota)) return new ProviderError("usage_limit", usageLimitMessage(quota), 429, upstream);
  // A plan exclusion keeps its existing rejection code and message below.
  if (quota && quota !== "usage_not_included") return new ProviderError("insufficient_quota", "Provider credits or quota are exhausted", 429, upstream);
  if (code === "server_error" || code === "server_is_overloaded") return new ProviderError("upstream_unavailable", "Provider temporarily failed; retry when it is available", 503, upstream);
  if (code === "context_length_exceeded") return contextError();
  if (typeof code === "string" && throttleClasses.has(code)) return new ProviderError("rate_limit_exceeded", "Provider usage limit reached", 429);
  if (["invalid_api_key", "authentication_error", "token_expired", "unauthorized"].includes(String(code))) {
    return new ProviderError("authentication", "Provider login is missing or expired", 401);
  }
  // content_filter, max_output_tokens and unknown codes keep a class that native Codex also retries.
  return rejected(code, upstream) ?? new ProviderError("inference_failed", "Provider inference did not complete", 502, upstream);
}
