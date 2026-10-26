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
  for (const baseUrl of ["https://api.x.ai/v1", "https://openrouter.ai.attacker.invalid/api/v1", "http://openrouter.ai/api/v1",
    "https://user@openrouter.ai/api/v1", "https://openrouter.ai/api/v1?next=x", "https://openrouter.ai/api/v1#x", "https://openrouter.ai/other", "https://opencode.ai.attacker.invalid/inference/openai/v1",
    "http://opencode.ai/inference/openai/v1", "https://opencode.ai/other/v1", "https://opencode.ai/inference/openai/v1?next=x",
    "https://user@opencode.ai/inference/openai/v1"]) {
    assert.deepEqual(apiRoutingHeaders({ baseUrl }, { threadId: "thread_1" }), {});
  }
  assert.deepEqual(apiRoutingHeaders({ baseUrl: "https://opencode.ai/inference/openai/v1" }, { threadId: "line\nbreak", sessionId: " " }),
    { "User-Agent": "harness-gateway" });
});

test("OpenRouter uses the caller's cache identity for sticky routing from the first success", () => {
  const provider = { baseUrl: "https://openrouter.ai/api/v1" };
  const context = { threadId: "thread_1", sessionId: "window_1" };
  assert.deepEqual(apiRoutingHeaders(provider, context), { "x-session-id": "thread_1" });
  assert.deepEqual(apiRoutingHeaders(provider, { sessionId: "session_1" }), { "x-session-id": "session_1" });
  assert.deepEqual(apiRoutingHeaders(provider, context, { prompt_cache_key: "shared:fork-cache" }), { "x-session-id": "shared:fork-cache" });
  assert.deepEqual(apiRoutingHeaders(provider, context, { session_id: "explicit_session", prompt_cache_key: "other_cache" }), { "x-session-id": "explicit_session" });
  assert.deepEqual(apiRoutingHeaders(provider, {}), {});
  for (const value of ["", "line\nbreak", "unsafe\rvalue", "a".repeat(257), "unicode-\u2603", null, 7]) {
    assert.deepEqual(apiRoutingHeaders(provider, context, { prompt_cache_key: value }), {}, "invalid explicit keys are not silently replaced");
  }
  assert.deepEqual(apiRoutingHeaders(provider, { threadId: "line\nbreak" }), {});
});

test("an opted-in session-affinity provider receives the caller's thread ID as session-id, and nothing else does", () => {
  const provider = { baseUrl: "http://dgx.example:4000/v1", sessionAffinity: true };
  assert.deepEqual(apiRoutingHeaders(provider, { threadId: "thread_1", sessionId: "session_1" }), { "session-id": "thread_1" });
  assert.deepEqual(apiRoutingHeaders(provider, { sessionId: "session_1" }), { "session-id": "session_1" });
  assert.deepEqual(apiRoutingHeaders(provider, {}), {}, "no conversation ID is invented");
  assert.deepEqual(apiRoutingHeaders(provider, { threadId: "line\nbreak", sessionId: "a".repeat(129) }), {});
  for (const sessionAffinity of [false, undefined]) {
    assert.deepEqual(apiRoutingHeaders({ baseUrl: "http://dgx.example:4000/v1", sessionAffinity }, { threadId: "thread_1" }), {});
  }
});

test("the chat transport sends session-id to an opted-in provider and omits it otherwise", async t => {
  const key = "GATEWAY_AFFINITY_ROUTING_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const seen: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => { seen.push(new Headers(options.headers)); return chatStream(); });
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key,
    models: { "qwen/flash": "fixture" } };
  for (const sessionAffinity of [true, false]) {
    for await (const _ of new ChatCompletionsAPI({ ...config, sessionAffinity }).infer(
      { model: "fixture", input: "hello" }, new AbortController().signal, { threadId: "thread_1", sessionId: "session_1" })) {}
  }
  assert.equal(seen[0].get("session-id"), "thread_1");
  assert.equal(seen[0].get("x-opencode-session"), null);
  assert.equal(seen[1].get("session-id"), null);
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

test("OpenRouter transports send session affinity while Responses retains explicit cache controls", async t => {
  const key = "GATEWAY_OPENROUTER_ROUTING_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  let stream = responsesStream;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(options.headers), body: JSON.parse(String(options.body)) });
    return stream();
  });
  const config: ProviderConfig = { id: "openrouter", type: "responses-api", baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: key, models: { alias: "fixture" } };
  const request = { model: "fixture", input: "hello", prompt_cache_key: "caller_cache", prompt_cache_options: { mode: "implicit" } };
  for await (const _ of new ResponsesAPI(config).infer(request, new AbortController().signal, { threadId: "thread_1" })) {}
  assert.equal(seen[0].headers.get("x-session-id"), "caller_cache");
  assert.equal(seen[0].headers.get("x-opencode-session"), null);
  assert.equal(seen[0].body.prompt_cache_key, "caller_cache");
  assert.deepEqual(seen[0].body.prompt_cache_options, { mode: "implicit" });
  stream = chatStream;
  for await (const _ of new ChatCompletionsAPI({ ...config, type: "chat-completions-api" }).infer(request, new AbortController().signal, { threadId: "thread_1" })) {}
  assert.equal(seen[1].headers.get("x-session-id"), "caller_cache");
  for await (const _ of new ChatCompletionsAPI({ ...config, type: "chat-completions-api" }).infer({ ...request, session_id: "explicit_session" }, new AbortController().signal)) {}
  assert.equal(seen[2].headers.get("x-session-id"), "explicit_session");
  assert.equal(request.prompt_cache_key, "caller_cache");
});
