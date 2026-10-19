import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { readEvents } from "../protocol/sse.js";
import type { WireEvent } from "../protocol/types.js";

const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
const url = (server: Server) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;

test("streamed credit exhaustion reaches clients as a final failure and nonstream clients as HTTP 429", async () => {
  const privateMessage = "private provider account and prompt details";
  let calls = 0;
  let frame: Record<string, unknown>;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* Discard fixture input. */ }
    calls++;
    response.writeHead(200, { "Content-Type": "text/event-stream", "x-request-id": "req_credit_fixture" });
    response.end(`data: ${JSON.stringify(frame)}\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const key = "GATEWAY_CREDIT_ERROR_FIXTURE_KEY";
  assert.equal(Object.hasOwn(process.env, key), false);
  process.env[key] = "fixture-only";
  let gateway: Server | undefined;
  try {
    const directory = await mkdtemp(join(tmpdir(), "gateway-credit-error-"));
    const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, maxConcurrent: 1,
      providers: [{ id: "fixture", type: "responses-api", apiKeyEnv: key, baseUrl: url(upstream), models: { alias: "fixture" } }] });
    gateway = await startGateway(config, undefined, undefined, { onFailure: () => {} });
    const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
    const post = (stream: boolean) => fetch(`${url(gateway!)}/v1/responses`, { method: "POST", headers,
      body: JSON.stringify({ model: "alias", input: "fixture", stream }) });
    for (const error of [
      { code: "insufficient_quota" },
      { type: "usage_limit_reached" },
      { code: "rate_limit_exceeded", type: "credit_balance_exhausted" },
      { type: "billing_hard_limit_reached" },
    ]) {
      frame = { type: "response.failed", response: { error: { ...error, message: privateMessage } } };
      const before = calls;
      const response = await post(true);
      assert.equal(response.status, 200);
      const events: WireEvent[] = [];
      for await (const event of readEvents(response.body!)) events.push(event);
      assert.equal(calls, before + 1, "the gateway must not retry exhausted credits");
      assert.deepEqual(events.map(event => event.type), ["response.created", "response.failed"]);
      const failed = events.at(-1)!.response as { error: { code: string; message: string }; output: unknown[] };
      assert.equal(failed.error.code, "invalid_prompt", "Codex must stop stream retries");
      assert.match(failed.error.message, /credits|quota|usage limit/i);
      assert.deepEqual(failed.output, []);
      assert.ok(!JSON.stringify(events).includes(privateMessage));
      const plain = await post(false);
      assert.equal(plain.status, 429);
      const body = await plain.json() as { error: { code: string; message: string } };
      assert.ok(["usage_limit", "insufficient_quota"].includes(body.error.code));
      assert.match(body.error.message, /credits|quota|usage limit/i);
      assert.ok(!JSON.stringify(body).includes(privateMessage));
      assert.equal(calls, before + 2);
    }
  } finally {
    if (gateway) await close(gateway);
    await close(upstream);
    delete process.env[key];
  }
});
