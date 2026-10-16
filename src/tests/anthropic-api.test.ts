import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startGateway } from "../server.js";
import { gatewayToken } from "../config.js";
import { readEvents } from "../protocol/sse.js";

test("Anthropic API wire path preserves images, replay and native custom calls, and refuses incomplete or invalid turns", async () => {
  const key = "GATEWAY_TEST_ANTHROPIC_KEY"; const before = process.env[key]; process.env[key] = "fixture-only";
  let mode = "text"; let stop = "end_turn"; let disconnected = false;
  const requests: Array<Record<string, unknown>> = [];
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    assert.equal(req.url, "/messages"); assert.equal(req.headers["x-api-key"], "fixture-only");
    requests.push(JSON.parse(body)); res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } });
    emit({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "public reasoning" } });
    if (mode === "tool" || mode === "duplicate" || mode === "bad-json" || mode === "foreign") {
      const name = mode === "foreign" ? "unlisted" : "tool_0";
      emit({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call1", name, input: {} } });
      emit({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: mode === "bad-json" ? "{" : '{"input":"patch\\n' } });
      if (mode !== "bad-json") emit({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'proof"}' } });
      emit({ type: "content_block_stop", index: 1 });
      if (mode === "duplicate") emit({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call1", name, input: {} } });
    } else emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer-proof" } });
    if (mode === "hang") { res.on("close", () => { disconnected = true; }); return; }
    emit({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 3 } });
    if (mode !== "eof") emit({ type: "message_stop" }); res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const stateDirectory = await mkdtemp(join(tmpdir(), "gateway-anthropic-wire-"));
  const gateway = await startGateway({ version: 1, port: 0, stateDirectory, providers: [{ id: "api", type: "anthropic-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, apiKeyEnv: key, models: { alias: "upstream" }, modelMetadata: { alias: { reasoningEfforts: ["low", "high", "max"] } } }] });
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const token = await gatewayToken(stateDirectory); const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const tools = [{ type: "custom", name: "patch" }];
  const request = (value: Record<string, unknown>, signal?: AbortSignal) => fetch(base + "/v1/responses", { method: "POST", headers, signal, body: JSON.stringify({ model: "alias", input: "hello", tools, ...value }) });
  try {
    const response = await request({ reasoning: { effort: "max", summary: "none" } }); const result = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200); assert.equal(result.status, "completed"); assert.equal(result.output_text, "answer-proof");
    assert.equal((result.output as Array<{ type: string }>).some(item => item.type === "reasoning"), false);
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 2, cache_creation_tokens: 3 } });
    assert.deepEqual(requests[0].output_config, { effort: "max" });

    mode = "tool"; stop = "tool_use";
    const called = await (await request({ tool_choice: { type: "custom", name: "patch" } })).json() as { output: Array<Record<string, unknown>>; status: string };
    assert.equal(called.status, "completed");
    const call = called.output.find(item => item.type === "custom_tool_call")!;
    assert.equal(call.name, "patch"); assert.equal(call.input, "patch\nproof"); assert.equal(call.call_id, "call1");

    mode = "text"; stop = "end_turn";
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
    const replay = await request({ input: [
      { role: "user", content: "inspect" }, { type: "custom_tool_call", name: "patch", call_id: "call1", input: "patch\nproof" },
      { type: "custom_tool_call_output", call_id: "call1", output: [{ type: "input_image", image_url: "data:image/png;base64," + png }] },
    ] }); assert.equal(replay.status, 200); await replay.arrayBuffer();
    const messages = requests.at(-1)!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.equal(messages[1].content[0].name, "tool_0");
    const toolResult = messages[2].content[0]; assert.equal(toolResult.tool_use_id, "call1");
    assert.deepEqual(toolResult.content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }]);

    for (const reason of ["max_tokens", "pause_turn", "model_context_window_exceeded", "refusal", "unknown"]) {
      stop = reason;
      const failed = await request({ stream: true }); const events = []; for await (const event of readEvents(failed.body!)) events.push(event);
      assert.equal(events.some(event => event.type === "response.completed"), false); assert.equal(events.at(-1)?.type, "response.failed");
    }
    stop = "end_turn";
    for (const invalid of ["duplicate", "bad-json", "foreign", "eof"]) { mode = invalid; const failed = await request({}); assert.ok(failed.status >= 400); }
    mode = "text"; const missing = await request({ tool_choice: "required" }); assert.equal(missing.status, 502);
    const unsupported = await request({ reasoning: { effort: "ultra" } }); assert.equal(unsupported.status, 400);

    mode = "hang"; const control = new AbortController(); const streaming = await request({ stream: true }, control.signal);
    try { for await (const event of readEvents(streaming.body!)) if (event.type === "response.output_text.delta") { control.abort(); break; } } catch (error) { assert.equal((error as Error).name, "AbortError"); }
    for (let attempt = 0; !disconnected && attempt < 100; attempt++) await delay(10);
    assert.equal(disconnected, true); mode = "text";
    assert.equal((await (await request({})).json() as { status: string }).status, "completed");
  } finally {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
});
