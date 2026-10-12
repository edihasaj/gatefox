import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderFailure, providerFailureDiagnostic } from "../provider-failure.js";
import { ProviderError, type ProviderStreamDiagnostic } from "../providers/provider.js";
import { ResponsesTranslationError } from "../protocol/request.js";

function withoutTimestamp(diagnostic: Record<string, string | number>): Record<string, string | number> {
  const { timestamp, ...metadata } = diagnostic;
  assert.equal(typeof timestamp, "string"); assert.match(String(timestamp), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(new Date(timestamp).toISOString(), timestamp); return metadata;
}

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
  assert.deepEqual(withoutTimestamp(providerFailureDiagnostic({ requestId: "12345678-1234-1234-1234-123456789abc", providerId: "codex", modelAlias: "codex/gpt-6.1-sol", durationMs: 2000, failure: new ProviderError("timeout", "Private provider message", 504), abortCause: "timeout" })), {
    event: "provider_failure", durationMs: 2000, code: "timeout", status: 504, requestId: "12345678-1234-1234-1234-123456789abc", providerId: "codex", modelAlias: "codex/gpt-6.1-sol", abortCause: "timeout",
  });
});

test("UTC timestamps are generated even when optional metadata is rejected", () => {
  const before = Date.now();
  const record = providerFailureDiagnostic(Object.assign({ requestId: "invalid", durationMs: NaN, failure: new ProviderError("private", "private", 0) }, { timestamp: "private timestamp" }));
  assert.deepEqual(withoutTimestamp(record), { event: "provider_failure", durationMs: 0, code: "provider_failed", status: 502 });
  assert.ok(Date.parse(String(record.timestamp)) >= before); assert.ok(Date.parse(String(record.timestamp)) <= Date.now());
});

test("EOF diagnostics retain only terminal metadata, bounded counts and public request IDs", () => {
  const secret = "private prompt tools credentials https://private.invalid";
  const stream = Object.assign({ events: 1000000, lastEvent: "response.output_item.done", reasoningItems: 0, textDeltas: 7, toolCalls: 2 }, { prompt: secret, toolArguments: secret, model: secret });
  const record = providerFailureDiagnostic({ requestId: "invalid", durationMs: 9537, failure: new ProviderError("incomplete", secret, 502, { code: "missing_terminal", event: "eof", requestId: "req_valid-123", stream }) });
  assert.deepEqual(withoutTimestamp(record), { event: "provider_failure", durationMs: 9537, code: "incomplete", status: 502,
    upstreamCode: "missing_terminal", upstreamEvent: "eof", upstreamRequestId: "req_valid-123", upstreamEvents: 1000000,
    upstreamReasoningItems: 0, upstreamTextDeltas: 7, upstreamToolCalls: 2, upstreamLastEvent: "response.output_item.done" });
  assert.ok(!JSON.stringify(record).includes(secret));
});

test("known API codes and typed invalid output remain diagnostic enums", () => {
  for (const code of ["rate_limit_exceeded", "slow_down", "insufficient_quota", "context_length_exceeded", "invalid_api_key", "authentication_error", "token_expired", "unauthorized", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded"]) {
    const record = providerFailureDiagnostic({ requestId: "invalid", durationMs: 1, failure: new ProviderError("invalid_output", "private body", 502, { code, event: "response.failed" }) });
    assert.equal(record.code, "invalid_output"); assert.equal(record.upstreamCode, code); assert.ok(!JSON.stringify(record).includes("private body"));
  }
});

test("stream diagnostics reject malformed counters and arbitrary event text without coercion", () => {
  let coercions = 0;
  const hostile = { toString() { coercions++; return "1"; }, toJSON() { throw new Error("private data"); } };
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, 1000001, Number.MAX_SAFE_INTEGER + 1, "1", 1n, new Number(1), hostile, null]) {
    const stream = { events: value, reasoningItems: value, textDeltas: 2, toolCalls: value, lastEvent: "response.private-data" } as unknown as ProviderStreamDiagnostic;
    const record = providerFailureDiagnostic({ requestId: "invalid", durationMs: 1, failure: new ProviderError("incomplete", "private data", 502, { stream }) });
    assert.equal(record.upstreamLastEvent, "unknown"); assert.equal(record.upstreamTextDeltas, 2);
    for (const field of ["upstreamEvents", "upstreamReasoningItems", "upstreamToolCalls"]) assert.ok(!Object.hasOwn(record, field));
    assert.ok(!JSON.stringify(record).includes("private-data"));
  }
  assert.equal(coercions, 0);
  for (const stream of [null, "private data", 1, [], () => {}]) {
    const record = providerFailureDiagnostic({ requestId: "invalid", durationMs: 1, failure: new ProviderError("incomplete", "private data", 502, { stream: stream as unknown as ProviderStreamDiagnostic }) });
    assert.ok(!Object.keys(record).some(key => key.startsWith("upstream"))); withoutTimestamp(record);
  }
});

test("metadata getters, inherited fields and hostile identifiers never reach diagnostics", () => {
  let reads = 0;
  const get = () => { reads++; throw new Error("private data"); };
  const stream = Object.create({ events: 10, reasoningItems: 1 }) as ProviderStreamDiagnostic;
  Object.defineProperties(stream, { lastEvent: { get }, textDeltas: { get }, toolCalls: { value: 0 } });
  const upstream = { code: "missing_terminal", event: "eof", stream };
  Object.defineProperty(upstream, "requestId", { get });
  const failure = new ProviderError("incomplete", "private data", 502, upstream);
  Object.defineProperty(failure, "code", { get });
  const identifier = (value: string) => ({ toString() { reads++; return value; }, toJSON() { throw new Error("private data"); } }) as unknown as string;
  const record = providerFailureDiagnostic({ requestId: identifier("12345678-1234-1234-1234-123456789abc"), providerId: identifier("codex"), modelAlias: identifier("codex/gpt-6.1-sol"), durationMs: 1, failure });
  assert.deepEqual(withoutTimestamp(record), { event: "provider_failure", durationMs: 1, code: "provider_failed", status: 502, upstreamCode: "missing_terminal", upstreamEvent: "eof", upstreamToolCalls: 0, upstreamLastEvent: "unknown" });
  assert.equal(reads, 0); assert.ok(!JSON.stringify(record).includes("private data"));
  Object.defineProperty(failure, "upstream", { get });
  assert.ok(!Object.keys(providerFailureDiagnostic({ requestId: "invalid", durationMs: 1, failure })).some(key => key.startsWith("upstream")));
  assert.equal(reads, 0);
});

test("unreadable stream proxies cannot replace diagnostics with an exception", () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private data"); } });
  for (const stream of [revoked.proxy, throwing]) {
    const record = providerFailureDiagnostic({ requestId: "invalid", durationMs: 1, failure: new ProviderError("incomplete", "private data", 502, { stream: stream as ProviderStreamDiagnostic }) });
    withoutTimestamp(record); assert.ok(!JSON.stringify(record).includes("private data"));
  }
});

test("upstream diagnostic enums survive while arbitrary tool names and failure details are discarded", () => {
  const diagnostic = (code: string, event: string) => providerFailureDiagnostic({ requestId: "invalid", durationMs: 1,
    failure: new ProviderError("invalid_tool_call", "private data", 502, { code, event, requestId: "private data" }) });
  assert.equal(diagnostic("native_tool_search", "claude.tool_use").upstreamCode, "native_tool_search");
  assert.equal(diagnostic("native_tool_search", "claude.tool_use").upstreamEvent, "claude.tool_use");
  assert.ok(!JSON.stringify(diagnostic("private data", "private data")).includes("private data"));
});
