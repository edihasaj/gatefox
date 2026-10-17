import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../server.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

// One request that declares a tool in additional_tools and again in tools is validated by the server and then translated by the
// provider. It must be reported once, and still succeed. Fixture values only; state lives in a private folder.
test("the gateway reports a merged tool declaration once per request and serves the request", async () => {
  const bodies: Array<{ tools?: Array<{ function: { description: string } }> }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ model: "qwen", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] });
    emit({ model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    emit({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const directory = await mkdtemp(join(tmpdir(), "gateway-merge-server-")); process.env.GATEWAY_MERGE_FIXTURE_KEY = "fixture-key";
  configureTelemetry(directory, "test");
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, providers: [{ id: "local", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: "GATEWAY_MERGE_FIXTURE_KEY", models: { "local/qwen": "qwen" } }] };
  const gateway = await startGateway(config); const token = await gatewayToken(directory);
  const fn = (description: string) => ({ type: "function", name: "exec", description, parameters: { type: "object", properties: {} } });
  try {
    const response = await fetch(`http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`, { method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "local/qwen", input: [{ type: "additional_tools", tools: [fn("from history")] }, { role: "user", content: "go" }], tools: [fn("current")] }) });
    assert.equal(response.status, 200); assert.equal(((await response.json()) as { status: string }).status, "completed");
    assert.deepEqual(bodies[0].tools!.map(tool => tool.function.description), ["current"]);
    await flushTelemetry();
    const events = (await readTelemetry(directory, 0)).filter(event => event.event === "tool_declarations_merged");
    assert.equal(events.length, 1, "validation and provider translation report one request once");
    assert.deepEqual([events[0].replaced, events[0].identical], [1, 0]);
  } finally {
    delete process.env.GATEWAY_MERGE_FIXTURE_KEY; gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve()));
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await flushTelemetry(); await rm(directory, { recursive: true, force: true });
  }
});
