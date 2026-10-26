import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent } from "../protocol/types.js";
import { ProviderError } from "../providers/provider.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

async function fixture(frames: (attempt: number) => unknown[] | { status: number; code: string; retryAfter?: string }) {
  let attempts = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    const result = frames(++attempts);
    if (!Array.isArray(result)) {
      res.writeHead(result.status, { "Content-Type": "application/json", ...(result.retryAfter ? { "Retry-After": result.retryAfter } : {}) });
      res.end(JSON.stringify({ error: { code: result.code, message: "private caller data" } })); return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const frame of result) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = "GATEWAY_RECOVERY_FIXTURE_KEY"; process.env[env] = "fixture-only";
  const provider = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, models: { test: "test" } });
  return { provider, attempts: () => attempts, close: async () => { delete process.env[env]; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const failed = (code: string) => ({ type: "response.failed", response: { error: { code, message: "private caller data" } } });
const error = (code: string) => ({ type: "error", error: { code, message: "private caller data" } });
const complete = [{ type: "response.output_text.delta", delta: "recovered" }, { type: "response.completed", response: { status: "completed" } }];
const collect = async (provider: ResponsesAPI, signal = new AbortController().signal) => {
  const events: InferenceEvent[] = []; for await (const event of provider.infer({ model: "test", input: "fixture" }, signal)) events.push(event); return events;
};

test("transient failure before output retries once and returns only the successful output", async () => {
  const f = await fixture(attempt => attempt === 1 ? [failed("server_error")] : complete);
  try {
    const events = await collect(f.provider);
    assert.deepEqual(events.filter(event => event.type === "text").map(event => event.text), ["recovered"]);
    assert.equal(events.filter(event => event.type === "done").length, 1); assert.equal(f.attempts(), 2);
  }
  finally { await f.close(); }
});
test("persistent retryable stream errors exhaust one retry, while quota never retries", async () => {
  for (const code of ["server_is_overloaded", "insufficient_quota", "unknown"]) {
    const f = await fixture(() => [failed(code)]);
    try { await assert.rejects(collect(f.provider)); assert.equal(f.attempts(), code === "insufficient_quota" ? 1 : 2); }
    finally { await f.close(); }
  }
});
test("text or opaque reasoning already published prevents replay of a partial response", async () => {
  for (const output of [{ type: "response.output_text.delta", delta: "partial" }, { type: "response.output_item.added", item: { type: "reasoning", id: "rs_fixture", summary: [] } }]) {
    const f = await fixture(() => [output, failed("server_error")]);
    try { await assert.rejects(collect(f.provider)); assert.equal(f.attempts(), 1); }
    finally { await f.close(); }
  }
});
test("cancellation during backoff prevents a second request", async () => {
  const f = await fixture(() => [failed("server_error")]); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(collect(f.provider, controller.signal)); assert.equal(f.attempts(), 1); }
  finally { clearTimeout(timer); await f.close(); }
});

test("temporary HTTP server errors recover and rate limits honor Retry-After before output", async () => {
  for (const initial of [{ status: 503, code: "server_error" }, { status: 429, code: "rate_limit_exceeded", retryAfter: "1.2" }]) {
    const f = await fixture(attempt => attempt === 1 ? initial : complete); const start = Date.now();
    try { await collect(f.provider); assert.equal(f.attempts(), 2); assert.ok(Date.now() - start >= (initial.retryAfter ? 1200 : 1000)); }
    finally { await f.close(); }
  }
});
test("HTTP quota, unspecified 429, and rate limits needing a long wait never retry", async () => {
  for (const initial of [{ status: 429, code: "insufficient_quota" }, { status: 429, code: "unknown" }, { status: 429, code: "rate_limit_exceeded", retryAfter: "121" }]) {
    const f = await fixture(() => initial);
    try { await assert.rejects(collect(f.provider)); assert.equal(f.attempts(), 1); }
    finally { await f.close(); }
  }
});

test("an unknown error event retries once before output and records provider_retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-responses-retry-"));
  configureTelemetry(directory, "test");
  const f = await fixture(attempt => attempt === 1 ? [error("unrecognized_upstream_failure")] : complete);
  const since = Date.now();
  try {
    const events = await collect(f.provider);
    assert.deepEqual(events.filter(event => event.type === "text").map(event => event.text), ["recovered"]);
    assert.equal(f.attempts(), 2);
    await flushTelemetry();
    assert.equal((await readTelemetry(directory, since)).filter(event => event.event === "provider_retry").length, 1);
  } finally {
    await f.close(); await flushTelemetry(); await rm(directory, { recursive: true, force: true });
  }
});

test("an unknown error event after text output does not retry", async () => {
  const f = await fixture(() => [{ type: "response.output_text.delta", delta: "partial" }, error("unrecognized_upstream_failure")]);
  try {
    await assert.rejects(collect(f.provider), (caught: unknown) => caught instanceof ProviderError && caught.code === "inference_failed");
    assert.equal(f.attempts(), 1);
  } finally { await f.close(); }
});

test("context and authentication error events never retry", async () => {
  for (const code of ["context_length_exceeded", "invalid_api_key"]) {
    const f = await fixture(() => [error(code)]);
    try {
      await assert.rejects(collect(f.provider));
      assert.equal(f.attempts(), 1);
    } finally { await f.close(); }
  }
});
