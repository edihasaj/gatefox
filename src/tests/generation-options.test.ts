import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AnthropicAPI } from "../providers/anthropic-api.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { ProviderError } from "../providers/provider.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";

async function drain(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("API adapters validate and forward Messages generation options", async () => {
  const anthropicBodies: Array<Record<string, unknown>> = [];
  const chatBodies: Array<Record<string, unknown>> = [];
  let anthropicStop = "end_turn";
  let chatFinish = "stop";
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (request.url === "/messages") {
      anthropicBodies.push(body);
      emit({ type: "message_start", message: { usage: { input_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } });
      emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } });
      emit({ type: "message_delta", delta: { stop_reason: anthropicStop, ...(anthropicStop === "stop_sequence" ? { stop_sequence: "END" } : {}) }, usage: { output_tokens: 3 } });
      emit({ type: "message_stop" }); response.end(); return;
    }
    chatBodies.push(body);
    emit({ model: "chat-model", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: null }] });
    emit({ model: "chat-model", choices: [{ index: 0, delta: {}, finish_reason: chatFinish }] });
    emit({ choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const key = "GATEWAY_GENERATION_OPTIONS_KEY"; const before = process.env[key]; process.env[key] = "fixture";
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const anthropic = new AnthropicAPI({ id: "anthropic", type: "anthropic-api", baseUrl, apiKeyEnv: key, models: { alias: "anthropic-model" } });
  const chat = new ChatCompletionsAPI({ id: "chat", type: "chat-completions-api", baseUrl: `${baseUrl}/v1`, apiKeyEnv: key, models: { alias: "chat-model" }, modelMetadata: { alias: { reasoningEfforts: ["high"] } } });
  const anthropicRequest: ResponsesRequest = { model: "anthropic-model", input: "hello", max_output_tokens: 9, stop: ["END"], temperature: 0.5, top_p: 0.4, parallel_tool_calls: false, reasoning: { effort: "high" } };
  const chatRequest: ResponsesRequest = { ...anthropicRequest, model: "chat-model" };
  try {
    await drain(anthropic.infer(anthropicRequest, new AbortController().signal, { clientProtocol: "messages", adaptiveThinking: true }));
    assert.equal(anthropicBodies[0]!.max_tokens, 9);
    assert.deepEqual(anthropicBodies[0]!.stop_sequences, ["END"]);
    assert.equal(anthropicBodies[0]!.temperature, 0.5); assert.equal(anthropicBodies[0]!.top_p, 0.4);
    assert.deepEqual(anthropicBodies[0]!.tool_choice, { type: "auto", disable_parallel_tool_use: true });
    assert.deepEqual(anthropicBodies[0]!.thinking, { type: "adaptive" });

    await drain(chat.infer(chatRequest, new AbortController().signal, { clientProtocol: "messages" }));
    assert.equal(chatBodies[0]!.max_tokens, 9); assert.deepEqual(chatBodies[0]!.stop, ["END"]);
    assert.equal(chatBodies[0]!.temperature, 0.5); assert.equal(chatBodies[0]!.top_p, 0.4); assert.equal(chatBodies[0]!.parallel_tool_calls, false);
    assert.equal(chatBodies[0]!.reasoning_effort, "high");

    await drain(anthropic.infer({ model: "anthropic-model", input: [
      { role: "system", content: "You are Claude Code, the gateway client." },
      { role: "system", content: "Follow the caller's actual instruction." },
      { role: "user", content: "Continue" },
    ] }, new AbortController().signal, { clientProtocol: "messages" }));
    assert.deepEqual(anthropicBodies.at(-1)!.system, [
      { type: "text", text: "You are Claude Code, the gateway client." },
      { type: "text", text: "Follow the caller's actual instruction.", cache_control: { type: "ephemeral" } },
    ]);
    assert.deepEqual((anthropicBodies.at(-1)!.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content[0], { type: "text", text: "Continue", cache_control: { type: "ephemeral" } });
    const beforeMidSystem = anthropicBodies.length;
    await assert.rejects(drain(anthropic.infer({ model: "anthropic-model", input: [
      { role: "user", content: "First" }, { role: "system", content: "Late instruction" },
    ] }, new AbortController().signal, { clientProtocol: "messages" })), error => error instanceof ProviderError && error.status === 400);
    assert.equal(anthropicBodies.length, beforeMidSystem);

    await drain(chat.infer({ model: "chat-model", input: [
      { role: "user", content: "First" }, { role: "system", content: "Late instruction" }, { role: "user", content: "Second" },
    ] }, new AbortController().signal, { clientProtocol: "messages" }));
    assert.deepEqual((chatBodies.at(-1)!.messages as Array<Record<string, unknown>>).map(message => [message.role, message.content]), [
      ["system", "Late instruction"], ["user", "First"], ["user", "Second"],
    ]);

    await drain(chat.infer({ model: "chat-model", input: [
      { role: "system", content: "Client attribution" }, { role: "system", content: "Caller instructions" },
      { role: "user", content: "First" }, { role: "system", content: "Later instruction" },
      { role: "assistant", content: "Checking" },
      { type: "function_call", call_id: "check", name: "read", arguments: '{"path":"proof.txt"}' },
      { type: "function_call_output", call_id: "check", output: "proof" },
      { role: "system", content: "Final instruction\nKeep this line." }, { role: "user", content: "Second" },
    ], tools: [{ type: "function", name: "read" }] }, new AbortController().signal, { clientProtocol: "messages" }));
    assert.deepEqual(chatBodies.at(-1)!.messages, [
      { role: "system", content: "Client attribution\n\nCaller instructions\n\nLater instruction\n\nFinal instruction\nKeep this line." },
      { role: "user", content: "First" },
      { role: "assistant", content: "Checking", tool_calls: [{ id: "check", type: "function", function: { name: "read", arguments: '{"path":"proof.txt"}' } }] },
      { role: "tool", tool_call_id: "check", content: "proof" },
      { role: "user", content: "Second" },
    ]);

    const beforeInvalid = anthropicBodies.length + chatBodies.length;
    for (const invalid of [{ stop: "END" }, { temperature: 1.1 }, { top_p: 2 }, { parallel_tool_calls: "false" }]) {
      await assert.rejects(drain(anthropic.infer({ model: "anthropic-model", input: "hello", ...invalid }, new AbortController().signal)), error => error instanceof ProviderError && error.status === 400);
    }
    await assert.rejects(drain(chat.infer({ model: "chat-model", input: "hello", temperature: 2.1 }, new AbortController().signal)), error => error instanceof ProviderError && error.status === 400);
    assert.equal(anthropicBodies.length + chatBodies.length, beforeInvalid);

    anthropicStop = "max_tokens";
    const capped = await drain(anthropic.infer({ model: "anthropic-model", input: "hello" }, new AbortController().signal, { clientProtocol: "messages" }));
    assert.equal(capped.at(-1)?.type, "done"); assert.equal((capped.at(-1) as Extract<InferenceEvent, { type: "done" }>).stopReason, "max_tokens");
    await assert.rejects(drain(anthropic.infer({ model: "anthropic-model", input: "hello" }, new AbortController().signal)), ProviderError);

    anthropicStop = "stop_sequence";
    const stopped = await drain(anthropic.infer({ model: "anthropic-model", input: "hello" }, new AbortController().signal, { clientProtocol: "messages" }));
    assert.deepEqual(stopped.at(-1), { type: "done", usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 2, cache_creation_tokens: 3 } }, accounting: { cacheWriteTokens: 3 }, stopReason: "stop_sequence", stopSequence: "END" });

    chatFinish = "length";
    const chatCapped = await drain(chat.infer({ model: "chat-model", input: "hello" }, new AbortController().signal, { clientProtocol: "messages" }));
    assert.equal((chatCapped.at(-1) as Extract<InferenceEvent, { type: "done" }>).stopReason, "max_tokens");
    await assert.rejects(drain(chat.infer({ model: "chat-model", input: "hello" }, new AbortController().signal)), ProviderError);

    chatFinish = "stop";
    await drain(chat.infer({ model: "chat-model", input: [
      { type: "function_call", call_id: "one", name: "first", arguments: "{}" },
      { type: "function_call", call_id: "two", name: "second", arguments: "{}" },
      { type: "function_call_output", call_id: "one", output: "first result" },
      { type: "function_call_output", call_id: "two", output: "second result" },
    ], tools: [{ type: "function", name: "first" }, { type: "function", name: "second" }] }, new AbortController().signal));
    const replay = chatBodies.at(-1)!.messages as Array<Record<string, unknown>>;
    assert.equal(replay.length, 3); assert.equal(replay[0]!.role, "assistant"); assert.equal((replay[0]!.tool_calls as unknown[]).length, 2);
    assert.equal(replay[1]!.role, "tool"); assert.equal(replay[2]!.role, "tool");
  } finally {
    if (before === undefined) delete process.env[key]; else process.env[key] = before;
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
