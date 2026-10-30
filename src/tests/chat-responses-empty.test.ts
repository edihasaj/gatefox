import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway } from "../server.js";
import { readEvents } from "../protocol/sse.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

test("reasoning-only Chat Responses fails on the wire and records spend instead of success", async () => {
  let attempts = 0;
  const upstream = createServer((_request, response) => {
    attempts++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of [
      { model: "qwen-flash", choices: [{ index: 0, delta: { reasoning_content: "plan next action" } }] },
      { model: "qwen-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const directory = await mkdtemp(join(tmpdir(), "chat-responses-empty-"));
  const key = `GATEWAY_CHAT_EMPTY_${Math.random().toString(16).slice(2)}`;
  process.env[key] = "fixture";
  configureTelemetry(directory, "server");
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, providers: [{
    id: "fixture", type: "chat-completions-api", models: { alias: "qwen-flash" }, apiKeyEnv: key,
    baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
  }] };
  const gateway = await startGateway(config, undefined, undefined, { onFailure: () => {} });
  try {
    for (const stream of [true, false]) {
      const response = await fetch(`http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "alias", input: "fixture", stream }),
      });
      if (stream) {
        const events = []; for await (const event of readEvents(response.body!)) events.push(event);
        assert.equal(events.at(-1)?.type, "response.failed");
        assert.equal(events.some(event => event.type === "response.completed"), false);
      } else {
        assert.equal(response.status, 502);
        assert.equal((await response.json() as { error: { code: string } }).error.code, "incomplete");
      }
    }
    assert.equal(attempts, 2, "one upstream request per client request");
    await flushTelemetry(); const entries = await readTelemetry(directory, 0);
    const failed = entries.filter(event => event.event === "request_failed");
    assert.equal(failed.length, 2);
    for (const event of failed) {
      assert.equal(event.code, "incomplete");
      assert.equal(event.inputTokens, 100); assert.equal(event.outputTokens, 5);
    }
    assert.equal(entries.some(event => event.event === "request_completed"), false);
  } finally {
    delete process.env[key]; gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
    await flushTelemetry(); await rm(directory, { recursive: true, force: true });
  }
});
