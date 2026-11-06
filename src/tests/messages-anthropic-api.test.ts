import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";

test("native Messages through Anthropic HTTP preserves system boundaries, adaptive thinking, usage and stop sequence", async () => {
  let body: Record<string, unknown> | undefined;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const events = [
      { type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "stop_sequence", stop_sequence: "END" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(join(tmpdir(), "messages-anthropic-"));
  const envKey = "MESSAGES_ANTHROPIC_FIXTURE_KEY"; assert.equal(process.env[envKey], undefined); process.env[envKey] = "fixture-only";
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "fixture", type: "anthropic-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, apiKeyEnv: envKey, models: { alias: "claude-example" } }] });
  const gateway = await startGateway(config, undefined, undefined, { onFailure() {} });
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const token = await gatewayToken(directory);
  try {
    for (const later of [false, true]) {
      const messages = later ? [
        { role: "user", content: "Start" },
        { role: "assistant", content: [{ type: "tool_use", id: "earlier-call", name: "lookup", input: { query: "fixture" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "earlier-call", content: "found" }] },
        { role: "system", content: "Apply this rule after the result" },
        { role: "assistant", content: "Prior answer" },
        { role: "user", content: "hello" },
        { role: "system", content: "Apply the latest rule", output_config: { effort: "low" } },
      ] : [{ role: "user", content: "hello" }];
      const response = await fetch(base + "/v1/messages?beta=true", { method: "POST", headers: { "x-api-key": token }, body: JSON.stringify({
        model: "alias", max_tokens: 16, messages,
        ...(later ? { tools: [{ name: "lookup", input_schema: { type: "object", properties: { query: { type: "string" } } } }] } : {}),
        system: [{ type: "text", text: "attribution fixture" }, { type: "text", text: "Keep caller instructions", cache_control: { type: "ephemeral" } }],
        thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "high" }, stop_sequences: ["END"],
      }) });
      assert.equal(response.status, 200);
      const result = await response.json() as any;
      assert.deepEqual(body!.thinking, { type: "adaptive" });
      assert.deepEqual(body!.system, [{ type: "text", text: "attribution fixture" }, { type: "text", text: "Keep caller instructions", cache_control: { type: "ephemeral" } }]);
      const outbound = body!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
      assert.deepEqual(outbound.map(message => message.role), messages.map(message => message.role));
      if (later) {
        assert.deepEqual(outbound[1].content, [{ type: "tool_use", id: "earlier-call", name: "tool_0", input: { query: "fixture" } }]);
        assert.deepEqual(outbound[2].content, [{ type: "tool_result", tool_use_id: "earlier-call", content: "found" }]);
        assert.deepEqual(outbound[3].content, [{ type: "text", text: "Apply this rule after the result" }]);
        assert.deepEqual(outbound.at(-1)!.content, [{ type: "text", text: "Apply the latest rule", cache_control: { type: "ephemeral" } }]);
      } else assert.deepEqual(outbound.at(-1)!.content.at(-1), { type: "text", text: "hello", cache_control: { type: "ephemeral" } });
      assert.deepEqual(body!.output_config, { effort: later ? "low" : "high" });
      assert.equal(body!.max_tokens, 16); assert.deepEqual(body!.stop_sequences, ["END"]);
      assert.equal(result.stop_reason, "stop_sequence"); assert.equal(result.stop_sequence, "END");
      assert.deepEqual(result.usage, { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 });
    }
  } finally {
    delete process.env[envKey]; gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
});
