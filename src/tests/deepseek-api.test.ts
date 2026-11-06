import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { discoverModels, loadDiscoveredModels, modelCatalog } from "../catalog.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import type { ProviderError } from "../providers/provider.js";
import { isDeepSeekApi, ReasoningReplay } from "../providers/deepseek-reasoning.js";
import { responsesHttpError } from "../providers/responses-errors.js";

const key = "GATEWAY_DEEPSEEK_FIXTURE";
const config = (baseUrl = "https://api.deepseek.com"): ProviderConfig => ({ id: "deepseek", type: "chat-completions-api", baseUrl, apiKeyEnv: key,
  models: { "deepseek/deepseek-flash": "deepseek-flash" }, modelMetadata: { "deepseek/deepseek-flash": { reasoningEfforts: ["low", "high", "max"] } } });
const sse = (values: unknown[]) => new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
const callReply = () => sse([
  { choices: [{ index: 0, delta: { reasoning_content: "private thought" }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  { choices: [], usage },
]);
const textReply = () => sse([{ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] }, { choices: [], usage }]);
const tools = [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }];
const first = { model: "deepseek-flash", tools, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] }] };
const second = { ...first, input: [...first.input, { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }, { type: "function_call_output", call_id: "call_1", output: "ok" }] };
const run = async (provider: ChatCompletionsAPI, request: unknown, context: { sessionId?: string } = { sessionId: "s1" }) => {
  for await (const _ of provider.infer(request as never, new AbortController().signal, context)) { /* drain */ }
};

function fixture(t: test.TestContext) {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>; bodies.push(body);
    return bodies.length === 1 ? callReply() : textReply();
  });
  return bodies;
}
const assistant = (body: Record<string, unknown>) => (body.messages as Array<Record<string, unknown>>).find(message => message.role === "assistant");

test("DeepSeek gets its reasoning back on the next request with tools, as its API requires", async t => {
  const bodies = fixture(t); const provider = new ChatCompletionsAPI(config());
  await run(provider, first); await run(provider, second);
  assert.equal(assistant(bodies[1])?.reasoning_content, "private thought");
  assert.equal(bodies[1].thinking, undefined);
});

test("reasoning stays within its conversation, and lost reasoning turns thinking off instead of failing", async t => {
  const bodies = fixture(t); const provider = new ChatCompletionsAPI(config());
  await run(provider, first); await run(provider, { ...second, reasoning: { effort: "high" } }, { sessionId: "another-chat" });
  assert.equal(assistant(bodies[1])?.reasoning_content, undefined);
  assert.deepEqual(bodies[1].thinking, { type: "disabled" });
  assert.equal(bodies[1].reasoning_effort, undefined, "an effort has no meaning with thinking off");
  await run(new ChatCompletionsAPI(config()), second);
  assert.deepEqual(bodies[2].thinking, { type: "disabled" }, "a restart empties the private store");
});

test("every other chat origin keeps its exact request", async t => {
  const bodies = fixture(t); const provider = new ChatCompletionsAPI(config("https://openrouter.ai/api/v1"));
  await run(provider, first); await run(provider, second);
  assert.equal(assistant(bodies[1])?.reasoning_content, undefined);
  assert.equal(bodies[1].thinking, undefined);
  for (const value of ["https://api.deepseek.com.example.com", "http://api.deepseek.com", "https://api.deepseek.com/anthropic", "https://user@api.deepseek.com", undefined]) assert.equal(isDeepSeekApi(value), false, String(value));
  for (const value of ["https://api.deepseek.com", "https://api.deepseek.com/", "https://api.deepseek.com/v1"]) assert.equal(isDeepSeekApi(value), true, value);
});

test("the private reasoning store stays bounded", () => {
  const replay = new ReasoningReplay();
  for (let index = 0; index < 5000; index++) replay.remember("chat", [], { tool_calls: [{ id: `call_${index}` }] }, "thought");
  assert.equal(replay.restore("chat", [{ role: "assistant", tool_calls: [{ id: "call_0" }] }]), undefined, "the oldest entries go first");
  assert.ok(replay.restore("chat", [{ role: "assistant", tool_calls: [{ id: "call_4999" }] }]));
  replay.remember("chat", [], { content: "plain" }, "");
  assert.deepEqual(replay.restore("chat", [{ role: "assistant", content: "plain" }]), [{ role: "assistant", content: "plain" }], "a turn without reasoning is known, with nothing to add");
});

test("two identical answers in one chat keep their own reasoning", () => {
  const replay = new ReasoningReplay();
  replay.remember("chat", [], { content: "done" }, "first thought");
  replay.remember("chat", [{ content: "done" }], { content: "done" }, "second thought");
  const restored = replay.restore("chat", [{ role: "assistant", content: "done" }, { role: "user", content: "again" }, { role: "assistant", content: "done" }]);
  assert.deepEqual(restored?.filter(message => message.role === "assistant").map(message => message.reasoning_content), ["first thought", "second thought"]);
});

test("a request without a conversation identity never stores or receives reasoning", async t => {
  const replay = new ReasoningReplay();
  replay.remember(undefined, [], { content: "done" }, "private");
  assert.equal(replay.restore(undefined, [{ role: "assistant", content: "done" }]), undefined);
  assert.deepEqual(replay.restore(undefined, [{ role: "user", content: "hi" }]), [{ role: "user", content: "hi" }], "a first turn still keeps thinking on");
  const bodies = fixture(t); const provider = new ChatCompletionsAPI(config());
  await run(provider, first, {}); await run(provider, second, {});
  assert.deepEqual(bodies[1].thinking, { type: "disabled" });
  assert.equal(assistant(bodies[1])?.reasoning_content, undefined);
});

test("a Codex reasoning summary does not change the turn it belongs to", async t => {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    return sse([{ choices: [{ index: 0, delta: { reasoning_content: "real thought" }, finish_reason: null }] }, { choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] }, { choices: [], usage }]);
  });
  const provider = new ChatCompletionsAPI(config()); const user = first.input[0];
  await run(provider, { ...first, input: [user] });
  await run(provider, { ...first, input: [user, { type: "reasoning", summary: [{ type: "summary_text", text: "public summary" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }, user] });
  assert.equal(assistant(bodies[1])?.content, "answer");
  assert.equal(assistant(bodies[1])?.reasoning_content, "real thought");
  assert.equal(bodies[1].thinking, undefined);
});

test("DeepSeek's published efforts, window and default reach the catalog", async t => {
  process.env[key] = "fixture-only"; t.after(() => { delete process.env[key]; });
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", context_window: 1048576, input_modalities: ["text", "image"], effort: { supported_levels: ["low", "high", "max"], default_level: "high" } }] }));
  const provider = { ...config(), models: {}, modelMetadata: {} };
  const [model] = await discoverModels(provider);
  assert.deepEqual(model.metadata.reasoningEfforts, ["low", "high", "max"]);
  assert.equal(model.metadata.defaultReasoningEffort, "high");
  assert.equal(model.metadata.contextWindow, 1048576);
  loadDiscoveredModels(provider, [model]);
  const row = modelCatalog({ version: 1, stateDirectory: "/tmp/unused", port: 0, providers: [provider] } as never).models[0];
  assert.equal(row.default_reasoning_level, "high");
});

test("DeepSeek's cache hits are read, so cache safety sees a warm prefix", async t => {
  process.env[key] = "fixture-only"; t.after(() => { delete process.env[key]; });
  t.mock.method(globalThis, "fetch", async () => sse([{ choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] }, { choices: [], usage: { ...usage, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 2 } }]));
  let done: { input_tokens_details?: { cached_tokens?: number } } | undefined;
  for await (const event of new ChatCompletionsAPI(config()).infer({ model: "deepseek-flash", input: "hello" }, new AbortController().signal)) if (event.type === "done") done = event.usage;
  assert.equal(done?.input_tokens_details?.cached_tokens, 8);
});

test("an empty account is a final, readable failure on the real chat path", async t => {
  process.env[key] = "fixture-only"; t.after(() => { delete process.env[key]; });
  const body = { error: { message: "Insufficient Balance (request_id: secret)", type: "insufficient_balance_error", code: "invalid_request_error" } };
  const direct = await responsesHttpError(Response.json(body, { status: 402 }));
  assert.equal(direct.code, "insufficient_quota");
  t.mock.method(globalThis, "fetch", async () => Response.json(body, { status: 402 }));
  await assert.rejects(run(new ChatCompletionsAPI(config()), first), (error: ProviderError) => {
    assert.equal(error.code, "insufficient_quota"); assert.equal(error.status, 402);
    assert.match(error.message, /no usable balance/); assert.equal(error.message.includes("secret"), false);
    return true;
  });
});
