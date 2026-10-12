import { ProviderError } from "./provider.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const contextError = () => new ProviderError("context_length_exceeded", "The request exceeds the model's context window", 400);
const errorBodyLimit = 64 * 1024;
const knownCodes = new Set(["server_error", "server_is_overloaded", "rate_limit_exceeded", "slow_down", "insufficient_quota", "invalid_prompt", "invalid_encrypted_content", "invalid_request_error", "max_output_tokens", "content_filter", "context_length_exceeded", "invalid_api_key", "authentication_error", "token_expired", "unauthorized", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"]);

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
  if ([401, 403, 429].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    return response.status === 429
      ? new ProviderError("usage_limit", "Provider usage limit reached", 429)
      : new ProviderError("authentication", "Provider login is missing or expired", response.status);
  }
  if (await httpErrorCode(response) === "context_length_exceeded") return contextError();
  return new ProviderError("upstream_error", `Provider returned HTTP ${response.status}`, response.status === 400 ? 400 : 502);
}

export function responsesStreamError(event: ObjectValue, requestId?: string): ProviderError {
  const response = object(event.response);
  const code = object(response.error).code ?? object(event.error).code ?? event.code ?? object(response.incomplete_details).reason;
  const upstream = { code: typeof code === "string" && knownCodes.has(code) ? code : "unknown",
    event: ["error", "response.failed", "response.incomplete"].includes(String(event.type)) ? String(event.type) : "unknown",
    ...(requestId && /^[a-z0-9_-]{1,128}$/i.test(requestId) ? { requestId } : {}) };
  if (code === "server_error" || code === "server_is_overloaded") return new ProviderError("upstream_unavailable", "Provider temporarily failed; retry when it is available", 503, upstream);
  if (code === "context_length_exceeded") return contextError();
  if (code === "rate_limit_exceeded" || code === "slow_down") return new ProviderError("rate_limit_exceeded", "Provider usage limit reached", 429);
  if (["insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"].includes(String(code))) {
    return new ProviderError("insufficient_quota", "Provider quota is exhausted", 429);
  }
  if (["invalid_api_key", "authentication_error", "token_expired", "unauthorized"].includes(String(code))) {
    return new ProviderError("authentication", "Provider login is missing or expired", 401);
  }
  return new ProviderError("inference_failed", "Provider inference did not complete", 502, upstream);
}
