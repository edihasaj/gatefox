import { ProviderError, type ProviderStreamDiagnostic } from "./provider.js";
import type { WireEvent } from "../protocol/types.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const contextError = () => new ProviderError("context_length_exceeded", "The request exceeds the model's context window", 400);
const errorBodyLimit = 64 * 1024;
const knownCodes = new Set(["server_error", "server_is_overloaded", "rate_limit_exceeded", "slow_down", "insufficient_quota", "invalid_prompt", "invalid_encrypted_content", "invalid_request_error", "max_output_tokens", "content_filter", "context_length_exceeded", "invalid_api_key", "authentication_error", "token_expired", "unauthorized", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
  "cyber_policy", "bio_policy", "misalignment_policy_violation", "usage_not_included"]);
// The upstream rejected this exact request, so a retry repeats the failure. Each class has a
// fixed message; upstream prose may quote caller data and is never forwarded.
const rejections: Record<string, string> = {
  invalid_prompt: "Provider rejected the request as invalid",
  invalid_encrypted_content: "Provider rejected the replayed reasoning state",
  cyber_policy: "Provider flagged the request for possible cybersecurity risk",
  bio_policy: "Provider flagged the request for possible biological risk",
  misalignment_policy_violation: "Provider blocked the request under its misalignment policy",
  usage_not_included: "The provider plan does not include this usage",
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

/** Read only bounded error metadata. Upstream messages may contain caller data. */
async function httpErrorCode(response: Response): Promise<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > errorBodyLimit) { await reader.cancel().catch(() => {}); return; }
      chunks.push(next.value);
    }
    try { return object(object(JSON.parse(Buffer.concat(chunks).toString("utf8"))).error).code; }
    catch { return; }
  } finally { reader.releaseLock(); }
}

export async function responsesHttpError(response: Response): Promise<ProviderError> {
  // Status-based authentication and capacity errors remain authoritative.
  if ([401, 403].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    return new ProviderError("authentication", "Provider login is missing or expired", response.status);
  }
  const code = await httpErrorCode(response);
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const milliseconds = header && header.length <= 128 ? (/^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : undefined;
    // A named throttle, or an unnamed 429 that asks for a short wait, clears by itself;
    // anything else is a usage limit, which Codex treats as final.
    const throttle = ["rate_limit_exceeded", "slow_down"].includes(String(code)) ||
      (typeof code !== "string" && milliseconds !== undefined && Number.isFinite(milliseconds) && milliseconds <= 60000);
    if (throttle) return new ProviderError("rate_limit_exceeded", "Provider usage limit reached", 429,
      { code: typeof code === "string" ? code : "rate_limit_exceeded", event: "http", retryAfterMs: milliseconds !== undefined && Number.isFinite(milliseconds) ? Math.max(1000, milliseconds) : 1000 });
    return new ProviderError("usage_limit", "Provider usage limit reached", 429);
  }
  if ([500, 502, 503, 504].includes(response.status)) return new ProviderError("upstream_unavailable", "Provider temporarily failed; retry when it is available", 503,
    { code: typeof code === "string" && knownCodes.has(code) ? code : "unknown", event: "http" });
  if (code === "context_length_exceeded") return contextError();
  const upstream = { code: typeof code === "string" && knownCodes.has(code) ? code : "unknown", event: "http", httpStatus: response.status, ...requestIdOf(response.headers.get("x-request-id")) };
  return rejected(code, upstream) ?? new ProviderError("upstream_error", `Provider returned HTTP ${response.status}`, response.status === 400 ? 400 : 502, upstream);
}

export function responsesStreamError(event: ObjectValue, requestId?: string): ProviderError {
  const response = object(event.response);
  const code = object(response.error).code ?? object(event.error).code ?? event.code ?? object(response.incomplete_details).reason;
  const upstream = { code: typeof code === "string" && knownCodes.has(code) ? code : "unknown",
    event: ["error", "response.failed", "response.incomplete"].includes(String(event.type)) ? String(event.type) : "unknown", ...requestIdOf(requestId) };
  if (code === "server_error" || code === "server_is_overloaded") return new ProviderError("upstream_unavailable", "Provider temporarily failed; retry when it is available", 503, upstream);
  if (code === "context_length_exceeded") return contextError();
  if (code === "rate_limit_exceeded" || code === "slow_down") return new ProviderError("rate_limit_exceeded", "Provider usage limit reached", 429);
  if (["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"].includes(String(code))) {
    return new ProviderError("insufficient_quota", "Provider quota is exhausted", 429);
  }
  if (["invalid_api_key", "authentication_error", "token_expired", "unauthorized"].includes(String(code))) {
    return new ProviderError("authentication", "Provider login is missing or expired", 401);
  }
  // content_filter, max_output_tokens and unknown codes keep a class that native Codex also retries.
  return rejected(code, upstream) ?? new ProviderError("inference_failed", "Provider inference did not complete", 502, upstream);
}
