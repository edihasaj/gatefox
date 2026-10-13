import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { responsesHttpError, responsesStreamError } from "../providers/responses-errors.js";

const privateMessage = "upstream secret or caller prompt must not escape";
async function failure(status: number, value: unknown): Promise<ProviderError> {
  const upstream = createServer((_request, response) => {
    if (status === 200) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(value)}\n\n`);
    } else { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const key = "GATEWAY_RESPONSES_ERROR_FIXTURE_KEY"; const previous = process.env[key]; process.env[key] = "fixture-only";
  const provider = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: key, baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, models: { test: "test" } });
  try {
    let caught: unknown;
    try { for await (const _event of provider.infer({ model: "test", input: "fixture" }, new AbortController().signal)) {} }
    catch (error) { caught = error; }
    assert.ok(caught instanceof ProviderError); assert.ok(!caught.message.includes(privateMessage)); return caught;
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}

test("Responses HTTP context failures retain the code needed for SDK compaction recovery", async () => {
  const error = await failure(400, { error: { code: "context_length_exceeded", message: privateMessage } });
  assert.equal(error.code, "context_length_exceeded"); assert.equal(error.status, 400);
});

test("Responses stream context failures survive failed, error, and incomplete event shapes", async () => {
  const events = [
    { type: "response.failed", response: { error: { code: "context_length_exceeded", message: privateMessage } } },
    { type: "error", code: "context_length_exceeded", message: privateMessage },
    { type: "error", error: { code: "context_length_exceeded", message: privateMessage } },
    { type: "response.incomplete", response: { incomplete_details: { reason: "context_length_exceeded" } } },
  ];
  for (const event of events) {
    const error = await failure(200, event); assert.equal(error.code, "context_length_exceeded"); assert.equal(error.status, 400);
  }
});

test("Responses authentication and capacity HTTP statuses cannot be replaced by body codes", async () => {
  for (const status of [401, 403, 429]) {
    const error = await failure(status, { error: { code: "context_length_exceeded", message: privateMessage } });
    assert.equal(error.code, status === 429 ? "usage_limit" : "authentication"); assert.equal(error.status, status);
  }
});

test("Responses stream rate, quota, and authentication failures stay distinct", async () => {
  for (const [code, expected, status] of [["rate_limit_exceeded", "rate_limit_exceeded", 429], ["insufficient_quota", "insufficient_quota", 429], ["invalid_api_key", "authentication", 401]] as const) {
    const error = await failure(200, { type: "response.failed", response: { error: { code, message: privateMessage } } });
    assert.equal(error.code, expected); assert.equal(error.status, status);
  }
});

test("Unrecognized upstream codes and messages are not passed to gateway clients", async () => {
  const http = await failure(400, { error: { code: privateMessage, message: privateMessage } }); assert.equal(http.code, "upstream_error");
  const stream = await failure(200, { type: "response.failed", response: { error: { code: privateMessage, message: privateMessage } } }); assert.equal(stream.code, "inference_failed");
});

test("Responses HTTP error parsing stops at its byte budget and releases the body", async () => {
  let reads = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(64 * 1024 + 1)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const error = await responsesHttpError(new Response(body, { status: 400 }));
  assert.equal(error.code, "upstream_error"); assert.equal(reads, 1); assert.equal(cancelled, true);
});

test("Malformed upstream error bodies remain safe HTTP failures", async () => {
  const error = await responsesHttpError(new Response("not-json " + privateMessage, { status: 400 }));
  assert.equal(error.code, "upstream_error"); assert.ok(!error.message.includes(privateMessage));
});

test("Responses transient failures keep safe upstream diagnostics, excluding private messages", () => {
  const error = responsesStreamError({ type: "response.failed", response: { error: { code: "server_error", message: privateMessage } } }, "12345678-1234-1234-1234-123456789abc");
  assert.equal(error.code, "upstream_unavailable"); assert.equal(error.status, 503);
  assert.deepEqual(error.upstream, { code: "server_error", event: "response.failed", requestId: "12345678-1234-1234-1234-123456789abc" });
  assert.ok(!JSON.stringify(error).includes(privateMessage));
  assert.equal(responsesStreamError({ type: "response.failed", response: { error: { code: privateMessage } } }).upstream?.code, "unknown");
});

const rejectedCodes = ["invalid_prompt", "invalid_encrypted_content", "cyber_policy", "bio_policy", "misalignment_policy_violation", "usage_not_included"];
test("Upstream rejections that would repeat identically become upstream_rejected with the exact code", async () => {
  const messages = new Set<string>();
  for (const code of rejectedCodes) {
    for (const event of [{ type: "response.failed", response: { error: { code, message: privateMessage } } }, { type: "error", code, message: privateMessage }]) {
      const stream = await failure(200, event);
      assert.equal(stream.code, "upstream_rejected"); assert.equal(stream.status, 400);
      assert.deepEqual(stream.upstream, { code, event: event.type }); messages.add(stream.message);
    }
    for (const status of [400, 404, 422]) {
      const http = await failure(status, { error: { code, message: privateMessage } });
      assert.equal(http.code, "upstream_rejected"); assert.equal(http.status, 400);
      assert.deepEqual(http.upstream, { code, event: "http", httpStatus: status }); assert.ok(!JSON.stringify(http).includes(privateMessage));
    }
  }
  // Each class keeps its own fixed message, so the caller can tell a policy refusal from a malformed request.
  assert.equal(messages.size, rejectedCodes.length);
});

test("Content filter, output limits, and unknown stream codes keep the retryable inference class", async () => {
  for (const event of [{ type: "response.failed", response: { error: { code: "content_filter", message: privateMessage } } },
    { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }, { type: "error", code: "invalid_request_error", message: privateMessage }]) {
    const error = await failure(200, event); assert.equal(error.code, "inference_failed"); assert.equal(error.status, 502);
  }
});

test("Other HTTP errors keep upstream_error and their status, and carry the upstream HTTP status", async () => {
  for (const [status, code, expected] of [[400, "invalid_request_error", 400], [404, privateMessage, 502], [413, undefined, 502], [422, "content_filter", 502]] as const) {
    const error = await failure(status, { error: { code, message: privateMessage } });
    assert.equal(error.code, "upstream_error"); assert.equal(error.status, expected);
    assert.deepEqual(error.upstream, { code: code === "invalid_request_error" || code === "content_filter" ? code : "unknown", event: "http", httpStatus: status });
  }
  const tracked = await responsesHttpError(new Response(JSON.stringify({ error: { code: "invalid_prompt", message: privateMessage } }), { status: 400, headers: { "x-request-id": "req_fixture-1" } }));
  assert.deepEqual(tracked.upstream, { code: "invalid_prompt", event: "http", httpStatus: 400, requestId: "req_fixture-1" });
  const untracked = await responsesHttpError(new Response("{}", { status: 404, headers: { "x-request-id": "not a request id" } }));
  assert.deepEqual(untracked.upstream, { code: "unknown", event: "http", httpStatus: 404 });
});

test("Rate, quota, and server HTTP classes are unchanged by rejection codes", async () => {
  assert.equal((await failure(429, { error: { code: "usage_not_included" } })).code, "usage_limit");
  assert.equal((await failure(403, { error: { code: "cyber_policy" } })).code, "authentication");
  const server = await responsesHttpError(new Response(JSON.stringify({ error: { code: "invalid_prompt" } }), { status: 500 }));
  assert.equal(server.code, "upstream_unavailable"); assert.deepEqual(server.upstream, { code: "invalid_prompt", event: "http" });
});

test("An HTTP 4xx whose body names a server error reaches the upstream once", async () => {
  let hits = 0;
  const upstream = createServer((_request, response) => { hits++; response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: { code: "server_is_overloaded", message: privateMessage } })); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const key = "GATEWAY_RESPONSES_ERROR_FIXTURE_KEY"; const previous = process.env[key]; process.env[key] = "fixture-only";
  const provider = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: key, baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, models: { test: "test" } });
  try {
    await assert.rejects(async () => { for await (const _event of provider.infer({ model: "test", input: "fixture" }, new AbortController().signal)) {} }, ProviderError);
    assert.equal(hits, 1);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("An unnamed HTTP 429 with a short Retry-After stays retryable; others are usage limits", async () => {
  const throttle = await responsesHttpError(new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429, headers: { "retry-after": "2" } }));
  assert.equal(throttle.code, "rate_limit_exceeded"); assert.equal(throttle.upstream?.retryAfterMs, 2000);
  assert.equal((await responsesHttpError(new Response("{}", { status: 429 }))).code, "usage_limit");
  assert.equal((await responsesHttpError(new Response("{}", { status: 429, headers: { "retry-after": "3600" } }))).code, "usage_limit");
  assert.equal((await responsesHttpError(new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429, headers: { "retry-after": "2" } }))).code, "usage_limit");
});
