import test from "node:test";
import assert from "node:assert/strict";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";
import type { ProviderConfig } from "../config.js";
import { normalizeResponsesTools } from "../protocol/request.js";
import { nativeCatalog, nativeTools } from "../providers/copilot-render.js";
import { ResponsesAPI } from "../providers/responses-api.js";

const schema = { type: "object", properties: { z: { enum: ["z", "a"] }, a: { type: "string" } } };
const reordered = { properties: { a: { type: "string" }, z: { enum: ["z", "a"] } }, type: "object" };
const tools = ["write", "read"].map(name => ({ type: "function" as const, name, parameters: schema }));
const changed = [...tools].reverse().map(tool => ({ ...tool, parameters: reordered }));
const input = [
  { type: "message" as const, role: "user" as const, content: "Start" },
  { type: "function_call" as const, name: "read", call_id: "call_1", arguments: "{}" },
  { type: "function_call_output" as const, call_id: "call_1", output: "Exact result" },
];

for (const type of ["chat-completions-api", "anthropic-api"] as const) test(`${type} equivalent catalogs retain native tool names, schemas and replay bytes`, async t => {
  const key = "GATEWAY_PREFIX_REUSE_FIXTURE", before = process.env[key]; process.env[key] = "synthetic-only";
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); bodies.push(body);
    const named = type === "anthropic-api" ? body.messages[1].content.find((part: { type: string }) => part.type === "tool_use").name : body.messages[1].tool_calls[0].function.name;
    const frames = type === "anthropic-api" ? [
      { type: "message_start", message: { usage: { input_tokens: 1, cache_read_input_tokens: 1024, cache_creation_input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", name: named, id: "next", input: {} } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } }, { type: "message_stop" },
    ] : [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "next", type: "function", function: { name: named, arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1025, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 1024 } } }];
    return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + (type === "chat-completions-api" ? "data: [DONE]\n\n" : ""), { headers: { "Content-Type": "text/event-stream" } });
  });
  const config: ProviderConfig = { id: "fixture", type, baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: key, models: { alias: "fixture" } };
  const provider = type === "anthropic-api" ? new AnthropicAPI(config) : new ChatCompletionsAPI(config);
  const original = JSON.stringify(tools);
  for (const catalog of [tools, changed]) {
    const events = [];
    for await (const event of provider.infer({ model: "fixture", input, tools: catalog, tool_choice: { type: "function", name: "read" } }, new AbortController().signal)) events.push(event);
    assert.equal(events.find(event => event.type === "tool")?.call.function.name, "read", "response calls resolve against the stable native mapping");
  }
  assert.equal(JSON.stringify(bodies[0]), JSON.stringify(bodies[1]));
  assert.equal(JSON.stringify(tools), original, "caller data is not mutated");
});

test("Copilot schema object reordering preserves native catalog bytes and meaningful arrays", () => {
  const one = nativeTools(nativeCatalog(normalizeResponsesTools(tools)));
  const two = nativeTools(nativeCatalog(normalizeResponsesTools(changed)));
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.ok(JSON.stringify(two).includes('["z","a"]'));
});

test("OpenRouter Responses stabilizes equivalent tool catalogs without changing history or cache identity", async t => {
  const key = "GATEWAY_RESPONSES_PREFIX_FIXTURE"; const before = process.env[key]; process.env[key] = "fixture";
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  const sent: { body: Record<string, unknown>; headers: Headers }[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sent.push({ body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
    return new Response('data: {"type":"response.completed","response":{"id":"fixture","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
  });
  const provider = new ResponsesAPI({ id: "fixture", type: "responses-api", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: key, models: { alias: "fixture" } });
  const original = JSON.stringify({ input, tools });
  for (const catalog of [tools, changed]) {
    for await (const _ of provider.infer({ model: "fixture", input, tools: catalog, prompt_cache_key: "caller", tool_choice: { type: "function", name: "read" } }, new AbortController().signal, { threadId: "thread" })) {}
  }
  assert.equal(JSON.stringify(sent[0].body), JSON.stringify(sent[1].body));
  assert.deepEqual(sent[0].body.input, input); assert.equal(sent[0].headers.get("x-session-id"), "caller");
  assert.equal(JSON.stringify({ input, tools }), original);
  assert.ok(JSON.stringify(sent[0].body.tools).includes('["z","a"]'));
});
