import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { responsesHttpError } from "../providers/responses-errors.js";

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
