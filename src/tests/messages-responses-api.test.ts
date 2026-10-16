import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";

test("real HTTP Responses upstream cap becomes native Messages max_tokens while Responses keeps its failure", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let partialTool = false;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    const output = partialTool ? [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "lookup", arguments: '{"x":', status: "incomplete" }]
      : [{ type: "message", id: "msg_1", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "Partial answer" }] }];
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "response.incomplete", response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } })}\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "messages-responses-"));
  const envKey = "MESSAGES_RESPONSES_FIXTURE_KEY"; assert.equal(process.env[envKey], undefined); process.env[envKey] = "fixture-only";
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "fixture", type: "responses-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, apiKeyEnv: envKey, models: { alias: "gpt-example" } }] });
  const gateway = await startGateway(config, undefined, undefined, { onFailure() {} });
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const token = await gatewayToken(directory);
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    const request = { model: "alias", max_tokens: 3, messages: [{ role: "user", content: "Say something" }] };
    const response = await post("/v1/messages", request);
    assert.equal(response.status, 200);
    const message = await response.json() as any;
    assert.equal(message.stop_reason, "max_tokens"); assert.equal(message.content[0].text, "Partial answer");
    assert.equal(message.usage.output_tokens, 3); assert.equal(bodies[0].max_output_tokens, 3);
    assert.equal(bodies[0].model, "gpt-example"); assert.equal(bodies[0].messages, undefined);
    const existing = await post("/v1/responses", { model: "alias", input: "hello", max_output_tokens: 3 });
    assert.equal(existing.status, 502);
    partialTool = true;
    const truncated = await post("/v1/messages", { ...request, tools: [{ name: "lookup", input_schema: { type: "object" } }] });
    assert.equal(truncated.status, 502); assert.equal((await truncated.json() as any).type, "error");
  } finally {
    delete process.env[envKey]; gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
});
