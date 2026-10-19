import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { apiRoutingHeaders } from "../providers/api-routing.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";
import { inferenceContext } from "../providers/provider.js";

test("OpenCode routing preserves caller conversation identity across model API formats", () => {
  for (const prefix of ["inference", "inference/go"]) {
    for (const format of ["openai", "anthropic"]) {
      const provider = { baseUrl: `https://opencode.ai/${prefix}/${format}/v1` };
      assert.deepEqual(apiRoutingHeaders(provider, { threadId: "thread_1", sessionId: "window_1" }),
        { "User-Agent": "harness-gateway", "x-opencode-session": "thread_1" });
      assert.equal(apiRoutingHeaders(provider, { sessionId: "session_1" })["x-opencode-session"], "session_1");
      assert.deepEqual(apiRoutingHeaders(provider, {}), { "User-Agent": "harness-gateway" });
    }
  }
  assert.deepEqual(inferenceContext({ "x-opencode-session": "ses_1" }), { sessionId: "ses_1" });
  assert.deepEqual(inferenceContext({ "x-opencode-session": "line\nbreak" }), {});
});

test("provider-specific conversation headers never reach a different origin or API", () => {
  for (const baseUrl of ["https://api.x.ai/v1", "https://openrouter.ai/api/v1", "https://opencode.ai.attacker.invalid/inference/openai/v1",
    "http://opencode.ai/inference/openai/v1", "https://opencode.ai/other/v1", "https://opencode.ai/inference/openai/v1?next=x",
    "https://user@opencode.ai/inference/openai/v1"]) {
    assert.deepEqual(apiRoutingHeaders({ baseUrl }, { threadId: "thread_1" }), {});
  }
  assert.deepEqual(apiRoutingHeaders({ baseUrl: "https://opencode.ai/inference/openai/v1" }, { threadId: "line\nbreak", sessionId: " " }),
    { "User-Agent": "harness-gateway" });
});

const responsesStream = () => new Response(`data: ${JSON.stringify({
  type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
})}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const chatStream = () => new Response(`data: ${JSON.stringify({
  choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 },
})}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const anthropicStream = () => new Response([
  { type: "message_start", message: { usage: { input_tokens: 1 } } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer" } },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

test("all three OpenCode API transports send the correct endpoint, credentials and stable session header", async t => {
  const key = "GATEWAY_OPENCODE_ROUTING_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let stream = responsesStream;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(String(options.body)) });
    return stream();
  });
  for (const plan of ["inference", "inference/go"]) {
    const config: ProviderConfig = { id: "opencode", type: "responses-api", baseUrl: `https://opencode.ai/${plan}/openai/v1`,
      apiKeyEnv: key, models: { alias: "fixture" } };
    stream = responsesStream;
    for await (const _ of new ResponsesAPI(config).infer({ model: "fixture", input: "hello" }, new AbortController().signal, { threadId: "thread_1" })) {}
    assert.equal(seen.at(-1)?.url, `${config.baseUrl}/responses`);
    assert.equal(seen.at(-1)?.headers.get("authorization"), "Bearer fixture-only");
    stream = chatStream;
    for await (const _ of new ChatCompletionsAPI({ ...config, type: "chat-completions-api" }).infer(
      { model: "fixture", input: "hello" }, new AbortController().signal, { threadId: "thread_1" })) {}
    assert.equal(seen.at(-1)?.url, `${config.baseUrl}/chat/completions`);
    stream = anthropicStream;
    for await (const _ of new AnthropicAPI({ ...config, type: "anthropic-api", baseUrl: `https://opencode.ai/${plan}/anthropic/v1` }).infer(
      { model: "fixture", input: "hello" }, new AbortController().signal, { threadId: "thread_1" })) {}
    assert.equal(seen.at(-1)?.url, `https://opencode.ai/${plan}/anthropic/v1/messages`);
    assert.equal(seen.at(-1)?.headers.get("x-api-key"), "fixture-only");
  }
  for (const request of seen) {
    assert.equal(request.headers.get("x-opencode-session"), "thread_1");
    assert.equal(request.headers.get("user-agent"), "harness-gateway");
    assert.equal(request.body.model, "fixture");
  }
});

test("Grok Responses uses the existing API transport and preserves caller tools and instructions", async t => {
  const key = "GATEWAY_XAI_ROUTING_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let sent: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, "https://api.x.ai/v1/responses");
    assert.equal(new Headers(options.headers).get("x-opencode-session"), null);
    sent = JSON.parse(String(options.body)); return responsesStream();
  });
  const provider = new ResponsesAPI({ id: "grok", type: "responses-api", baseUrl: "https://api.x.ai/v1", apiKeyEnv: key,
    models: { "grok/main": "grok-4.7" } });
  const tools = [{ type: "function" as const, name: "read_file", parameters: { type: "object", properties: {} } }];
  for await (const _ of provider.infer({ model: "grok-4.7", input: "hello", instructions: "Caller instructions.", tools, store: false,
    reasoning: { effort: "high" } }, new AbortController().signal)) {}
  assert.equal(sent?.instructions, "Caller instructions.");
  assert.equal(sent?.store, false);
  const translated = sent?.tools as { type: string; name: string; parameters: unknown }[];
  assert.equal(translated.length, 1); assert.equal(translated[0].type, "function");
  assert.match(translated[0].name, /^[A-Za-z0-9_-]{1,64}$/);
  assert.deepEqual(translated[0].parameters, tools[0].parameters);
  assert.deepEqual(sent?.reasoning, { effort: "high" });
});
