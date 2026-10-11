import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../server.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
type Result = { status: string; usage: { total_tokens: number }; output: Array<{ type: string; input?: string }> };

test("chat API preserves custom calls, replay and reasoning, and rejects bad or truncated streams", async () => {
  let mode = "text"; let received: Record<string, unknown> = {};
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(req.headers.authorization, "Bearer fixture-key");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    const delta = (value: unknown) => emit({ model: mode === "wrong-model" ? "another-model" : "qwen", choices: [{ index: 0, delta: value, finish_reason: null }] });
    delta({ reasoning: "public thought" });
    if (["tool", "bad-json", "duplicate"].includes(mode)) {
      delta({ tool_calls: [{ index: 0, id: "call1", function: { name: "tool_0", arguments: '{"input":' } }] });
      delta({ tool_calls: [{ index: 0, function: { arguments: mode === "bad-json" ? "broken" : '"patch\\nproof"}' } }] });
      if (mode === "duplicate") delta({ tool_calls: [{ index: 1, id: "call1", function: { name: "tool_0", arguments: '{"input":"again"}' } }] });
    } else delta({ content: "wire-answer" });
    if (mode === "truncated") { res.end(); return; }
    emit({ model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: ["tool", "bad-json", "duplicate"].includes(mode) ? "tool_calls" : mode === "length" ? "length" : "stop" }] });
    emit({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } });
    res.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const directory = await mkdtemp(join(tmpdir(), "gateway-chat-wire-")); process.env.GATEWAY_CHAT_FIXTURE_KEY = "fixture-key";
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, providers: [{ id: "local", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: "GATEWAY_CHAT_FIXTURE_KEY", models: { "local/qwen": "qwen" }, modelMetadata: { "local/qwen": { reasoningEfforts: ["low", "high"] } } }] };
  const gateway = await startGateway(config); const token = await gatewayToken(directory);
  const send = (body: Record<string, unknown>) => fetch(`http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "local/qwen", input: "wire", ...body }) });
  try {
    const first = await (await send({ instructions: "instructions", input: [{ role: "user", content: "earlier context" }, { role: "developer", content: "late rules" }, { role: "user", content: "task" }], reasoning: { effort: "high" } })).json() as Result;
    assert.equal(first.status, "completed"); assert.equal(first.usage.total_tokens, 19);
    assert.ok(first.output.some((item: { type: string }) => item.type === "reasoning")); assert.equal(received.reasoning_effort, "high");
    const originalMessages = received.messages as Array<{ role: string; content: string }>;
    assert.equal(originalMessages[0]!.content, "instructions\n\nlate rules"); assert.equal(originalMessages.filter(message => message.role === "system").length, 1);
    const hidden = await (await send({ reasoning: { effort: "low", summary: "none" } })).json() as Result; assert.ok(!hidden.output.some((item: { type: string }) => item.type === "reasoning"));
    mode = "tool";
    const tools = [{ type: "custom", name: "apply_patch", format: { type: "text" } }];
    const tool = await (await send({ tools, tool_choice: { type: "custom", name: "apply_patch" } })).json() as Result;
    assert.equal(tool.output[1].type, "custom_tool_call"); assert.equal(tool.output[1].input, "patch\nproof");
    mode = "text";
    const replay = await (await send({ tools, input: [{ type: "custom_tool_call", call_id: "call1", name: "apply_patch", input: "patch\nproof" }, { type: "custom_tool_call_output", call_id: "call1", output: "patched" }, { role: "user", content: "follow up" }] })).json() as Result;
    assert.equal(replay.status, "completed");
    const messages = received.messages as Array<Record<string, unknown>>;
    assert.equal((messages[0]!.tool_calls as Array<{ function: { name: string } }>)[0]!.function.name, "tool_0"); assert.equal(messages[1]!.tool_call_id, "call1");
    for (const failure of ["wrong-model", "truncated", "length", "bad-json", "duplicate"]) {
      mode = failure; const response = await send({ tools, stream: true }); const wire = await response.text();
      if (failure === "wrong-model") { assert.equal(response.status, 502); assert.ok(wire.includes("model_route")); }
      else assert.ok(wire.includes("response.failed"), failure);
      assert.ok(!wire.includes("response.completed"), failure);
    }
    mode = "text"; assert.equal((await send({ reasoning: { effort: "max" } })).status, 400);
    assert.equal(((await (await send({})).json()) as Result).status, "completed");
  } finally { delete process.env.GATEWAY_CHAT_FIXTURE_KEY; gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
