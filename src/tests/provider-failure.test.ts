import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderFailure, providerFailureDiagnostic } from "../provider-failure.js";
import { ProviderError } from "../providers/provider.js";
import { ResponsesTranslationError } from "../protocol/request.js";

test("known provider failures retain their typed status and code", () => {
  for (const error of [new ProviderError("authentication", "Provider login is missing or expired", 401), new ProviderError("usage_limit", "Provider usage limit reached", 429), new ProviderError("context_length_exceeded", "Provider context limit reached", 400)]) assert.equal(classifyProviderFailure(error, undefined), error);
  const translated = classifyProviderFailure(new ResponsesTranslationError("invalid fixture input"), undefined);
  assert.equal(translated.code, "invalid_request"); assert.equal(translated.status, 400);
});

test("deadline aborts and user cancellation never become misleading login failures", () => {
  const aborted = new DOMException("request detail must remain private", "AbortError");
  const timeout = classifyProviderFailure(aborted, "timeout"); assert.equal(timeout.code, "timeout"); assert.equal(timeout.status, 504);
  const cancelled = classifyProviderFailure(aborted, "cancelled"); assert.equal(cancelled.code, "cancelled"); assert.equal(cancelled.status, 499);
  assert.equal(classifyProviderFailure(new ProviderError("cli_failed", "Worker exited during abort"), "timeout").code, "timeout");
});

test("fetch and recognized nested network failures produce retryable connection errors", () => {
  for (const error of [new TypeError("fetch failed"), new Error("secret", { cause: Object.assign(new Error("private URL"), { code: "ECONNRESET" }) }), Object.assign(new Error("private TLS certificate detail"), { code: "CERT_HAS_EXPIRED" })]) {
    const failure = classifyProviderFailure(error, undefined); assert.equal(failure.code, "upstream_unavailable"); assert.equal(failure.status, 503);
  }
  const malformed = Object.assign(new TypeError("Malformed UTF-8 payload detail"), { code: "ERR_ENCODING_INVALID_ENCODED_DATA" });
  assert.equal(classifyProviderFailure(malformed, undefined).code, "provider_failed");
});

test("untrusted error messages, URLs, tokens and getters never reach responses or diagnostics", () => {
  const secret = "Bearer sk-private-fixture-token https://private.invalid/?key=fixture";
  const hostile = new SyntaxError(secret); hostile.stack = secret;
  const failure = classifyProviderFailure(hostile, undefined); assert.equal(failure.code, "provider_failed"); assert.equal(failure.status, 502);
  assert.ok(!failure.message.includes("login")); assert.ok(!failure.message.includes(secret));
  const getter = Object.defineProperty({}, "cause", { get() { throw new Error(secret); } });
  assert.equal(classifyProviderFailure(getter, undefined).code, "provider_failed");
  const translation = classifyProviderFailure(new ResponsesTranslationError(secret), undefined); assert.ok(!translation.message.includes(secret));
  const record = providerFailureDiagnostic({ requestId: secret, providerId: secret, modelAlias: secret, durationMs: 120000.7, failure: new ProviderError(secret, secret, 12345), abortCause: "timeout" });
  assert.equal(record.durationMs, 120001); assert.equal(record.code, "provider_failed"); assert.equal(record.status, 502); assert.equal(record.abortCause, "timeout");
  assert.ok(!JSON.stringify(record).includes(secret)); assert.ok(!Object.hasOwn(record, "message"));
});

test("diagnostics retain only caller-owned identifiers and bounded failure metadata", () => {
  assert.deepEqual(providerFailureDiagnostic({ requestId: "12345678-1234-1234-1234-123456789abc", providerId: "codex", modelAlias: "codex/gpt-6.1-sol", durationMs: 2000, failure: new ProviderError("timeout", "Private provider message", 504), abortCause: "timeout" }), {
    event: "provider_failure", durationMs: 2000, code: "timeout", status: 504, requestId: "12345678-1234-1234-1234-123456789abc", providerId: "codex", modelAlias: "codex/gpt-6.1-sol", abortCause: "timeout",
  });
});

test("upstream diagnostic enums survive while arbitrary tool names and failure details are discarded", () => {
  const diagnostic = (code: string, event: string) => providerFailureDiagnostic({ requestId: "invalid", durationMs: 1,
    failure: new ProviderError("invalid_tool_call", "private data", 502, { code, event, requestId: "private data" }) });
  assert.equal(diagnostic("native_tool_search", "claude.tool_use").upstreamCode, "native_tool_search");
  assert.equal(diagnostic("native_tool_search", "claude.tool_use").upstreamEvent, "claude.tool_use");
  assert.ok(!JSON.stringify(diagnostic("private data", "private data")).includes("private data"));
});
