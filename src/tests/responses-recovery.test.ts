import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent } from "../protocol/types.js";

async function fixture(frames: (attempt: number) => unknown[]) {
  let attempts = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const frame of frames(++attempts)) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const env = "GATEWAY_RECOVERY_FIXTURE_KEY"; process.env[env] = "fixture-only";
  const provider = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, models: { test: "test" } });
  return { provider, attempts: () => attempts, close: async () => { delete process.env[env]; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const failed = (code: string) => ({ type: "response.failed", response: { error: { code, message: "private caller data" } } });
const complete = [{ type: "response.output_text.delta", delta: "recovered" }, { type: "response.completed", response: { status: "completed" } }];
const collect = async (provider: ResponsesAPI, signal = new AbortController().signal) => {
  const events: InferenceEvent[] = []; for await (const event of provider.infer({ model: "test", input: "fixture" }, signal)) events.push(event); return events;
};

test("transient failure before output retries once and returns only the successful output", async () => {
  const f = await fixture(attempt => attempt === 1 ? [failed("server_error")] : complete);
  try { assert.deepEqual((await collect(f.provider)).map(event => event.type), ["text", "done"]); assert.equal(f.attempts(), 2); }
  finally { await f.close(); }
});
test("persistent transient errors exhaust one retry, while quota and unknown failures never retry", async () => {
  for (const code of ["server_is_overloaded", "insufficient_quota", "unknown"]) {
    const f = await fixture(() => [failed(code)]);
    try { await assert.rejects(collect(f.provider)); assert.equal(f.attempts(), code === "server_is_overloaded" ? 2 : 1); }
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
