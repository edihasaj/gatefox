import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startGateway } from "../server.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";
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
    // Cache writes count in input_tokens but stay out of the Responses usage detail; a Messages client gets them as cache_creation_input_tokens.
    assert.deepEqual(result.usage, { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 2 } });
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
    mode = "text"; const missing = await request({ tool_choice: "required" }); assert.equal(missing.status, 400);
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

async function anthropicOutbound(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const key = "GATEWAY_TEST_ANTHROPIC_CACHE_KEY"; const before = process.env[key]; process.env[key] = "fixture-only";
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ type: "message_start", message: { usage: { input_tokens: 1 } } });
    emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
    emit({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
    emit({ type: "message_stop" }); res.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const provider = new AnthropicAPI({ id: "cache", type: "anthropic-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, apiKeyEnv: key, models: { alias: "upstream" } });
  let captured: Record<string, unknown> | undefined;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return realFetch(input as string | URL, init);
  }) as typeof fetch;
  try { for await (const _event of provider.infer({ model: "upstream", ...request } as never, new AbortController().signal)); }
  finally { globalThis.fetch = realFetch; if (before === undefined) delete process.env[key]; else process.env[key] = before; upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  assert.ok(captured);
  return captured;
}

const ephemeral = (block: Record<string, unknown> | undefined) => block?.cache_control as { type: string } | undefined;

test("Anthropic API marks at most four ephemeral breakpoints without reordering or nesting", async () => {
  // Last tool, last system block, last message tail, penultimate message tail, any role.
  const basic = await anthropicOutbound({
    input: [{ role: "system", content: "s1" }, { role: "system", content: "s2" }, { role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }],
    tools: [{ type: "function", name: "read" }, { type: "function", name: "write" }],
  });
  const basicMessages = basic.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual((basic.tools as Array<Record<string, unknown>>).map(tool => tool.name), ["tool_0", "tool_1"]);
  assert.deepEqual(ephemeral((basic.tools as Array<Record<string, unknown>>).at(-1)!), { type: "ephemeral" });
  assert.equal(ephemeral((basic.tools as Array<Record<string, unknown>>)[0]!), undefined);
  assert.deepEqual(ephemeral((basic.system as Array<Record<string, unknown>>).at(-1)!), { type: "ephemeral" });
  assert.equal(ephemeral((basic.system as Array<Record<string, unknown>>)[0]!), undefined);
  assert.deepEqual(ephemeral(basicMessages.at(-2)!.content.at(-1)!), { type: "ephemeral" });
  assert.deepEqual(ephemeral(basicMessages.at(-1)!.content.at(-1)!), { type: "ephemeral" });

  // Penultimate tail is by position, not by a user-role filter: assistant keeps its slot.
  const assistantPenultimate = await anthropicOutbound({
    input: [{ role: "system", content: "s1" }, { role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }, { role: "assistant", content: "a2" }, { role: "user", content: "q3" }],
  });
  const apMessages = assistantPenultimate.messages as Array<{ content: Array<Record<string, unknown>> }>;
  assert.deepEqual(ephemeral(apMessages.at(-2)!.content.at(-1)!), { type: "ephemeral" });
  assert.equal(ephemeral(apMessages[0]!.content[0]!), undefined);

  // A tool result is a user-role message whose tail is a tool_result block: its nested content stays unmarked.
  const nested = await anthropicOutbound({
    input: [{ role: "user", content: "run" }, { type: "function_call", call_id: "c1", name: "read", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "proof" }] }],
    tools: [{ type: "function", name: "read" }],
  });
  const nestedMessages = nested.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(nestedMessages.map(message => message.role), ["user", "assistant", "user"]);
  const toolResult = nestedMessages.at(-1)!.content.at(-1)!;
  assert.equal(toolResult.type, "tool_result");
  assert.deepEqual(ephemeral(toolResult), { type: "ephemeral" });
  // Text-only results serialize content as a plain string leaf: the marker stays on the outer tool_result.
  assert.equal(toolResult.content, "proof");

  // Array results (for example an image) keep their nested blocks unmarked.
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const nestedArray = await anthropicOutbound({
    input: [{ role: "user", content: "run" }, { type: "function_call", call_id: "c1", name: "read", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: [{ type: "input_image", image_url: "data:image/png;base64," + png }] }],
    tools: [{ type: "function", name: "read" }],
  });
  const arrayToolResult = (nestedArray.messages as Array<{ content: Array<Record<string, unknown>> }>).at(-1)!.content.at(-1)!;
  assert.equal(arrayToolResult.type, "tool_result");
  assert.deepEqual(ephemeral(arrayToolResult), { type: "ephemeral" });
  assert.ok(Array.isArray(arrayToolResult.content));
  assert.deepEqual((arrayToolResult.content as Array<Record<string, unknown>>).map(block => block.cache_control), [undefined]);

  // Long conversations keep exactly four markers: last tool, last system, last two tails.
  const longInput: Array<Record<string, unknown>> = [{ role: "system", content: "s1" }, { role: "system", content: "s2" }];
  for (let turn = 0; turn < 12; turn++) { longInput.push({ role: "user", content: `u${turn}` }, { role: "assistant", content: `a${turn}` }); }
  const long = await anthropicOutbound({ input: longInput, tools: [{ type: "function", name: "read" }] });
  const longMessages = long.messages as Array<{ content: Array<Record<string, unknown>> }>;
  const markers = [
    ...((long.tools as Array<Record<string, unknown>>).flatMap(tool => tool.cache_control ? [tool] : [])),
    ...((long.system as Array<Record<string, unknown>>).flatMap(block => block.cache_control ? [block] : [])),
    ...longMessages.flatMap(message => message.content.filter(block => block.cache_control)),
  ];
  assert.equal(markers.length, 4);
  assert.deepEqual(ephemeral(longMessages.at(-2)!.content.at(-1)!), { type: "ephemeral" });
  assert.deepEqual(ephemeral(longMessages.at(-1)!.content.at(-1)!), { type: "ephemeral" });

  // Order stays as the caller sent it: markers never move or merge blocks.
  const order = await anthropicOutbound({
    input: [{ role: "system", content: "system before" }, { role: "user", content: "first" }, { role: "assistant", content: "second" }, { role: "user", content: "third" }],
  });
  assert.deepEqual((order.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>).map(message => [message.role, (message.content[0] as { text?: string }).text]), [["user", "first"], ["assistant", "second"], ["user", "third"]]);
});
