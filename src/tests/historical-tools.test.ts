import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";
import type { ResponsesRequest } from "../protocol/types.js";

const key = "GATEWAY_HISTORICAL_TOOL_FIXTURE";
const tools = [{ type: "function" as const, name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];
/** A chat that used exec_command and an MCP tool, replayed with only exec_command declared, as compaction or a deferred tool leaves it. */
const input = [
  { type: "message", role: "user", content: "check the server" },
  { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: '{"cmd":"uptime"}' },
  { type: "function_call_output", call_id: "call_exec", output: "up 3 days" },
  { type: "function_call", call_id: "call_mcp", name: "mcp__recall__report_correction", arguments: '{"text":"use uv"}' },
  { type: "function_call_output", call_id: "call_mcp", output: "saved" },
  { type: "message", role: "user", content: "summarize" },
] as unknown as ResponsesRequest["input"];

async function outbound(t: test.TestContext, provider: { infer: ChatCompletionsAPI["infer"] }, request: ResponsesRequest): Promise<Record<string, unknown>> {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => { body = JSON.parse(init.body); return new Response("fixture stop", { status: 500 }); });
  await assert.rejects(async () => { for await (const _ of provider.infer(request, new AbortController().signal)) { /* the fixture stops at the upstream */ } },
    (error: unknown) => !(error instanceof Error && /Historical tool is absent/.test(error.message)));
  assert.ok(body, "the request reached the upstream instead of being refused");
  return body!;
}

test("Qwen keeps a call to an undeclared tool and its result as text instead of refusing the whole chat", async t => {
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const body = await outbound(t, new ChatCompletionsAPI(config), { model: "fixture", input, tools });
  const messages = body.messages as Array<{ role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string } }>; tool_call_id?: string }>;
  const structured = messages.flatMap(message => message.tool_calls || []);
  assert.deepEqual(structured.map(call => [call.id, call.function.name]), [["call_exec", "exec_command"]], "a declared tool keeps its structured call");
  assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["call_exec"], "no result is orphaned");
  const text = messages.map(message => message.content || "").join("\n");
  assert.match(text, /\[Earlier tool call mcp__recall__report_correction: \{"text":"use uv"\}\]/);
  assert.match(text, /\[Result of earlier tool call mcp__recall__report_correction\]\nsaved/);
  assert.ok(!messages.some(message => message.content === null && !message.tool_calls), "every message keeps content or a call");
});

test("Qwen with no declared tools, as during compaction, sends the whole history as text", async t => {
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const body = await outbound(t, new ChatCompletionsAPI(config), { model: "fixture", input });
  const messages = body.messages as Array<{ role: string; tool_calls?: unknown[] }>;
  assert.equal(body.tools, undefined);
  assert.ok(messages.every(message => !message.tool_calls && message.role !== "tool"));
});

test("a current tool_choice naming an undeclared tool is still refused", async t => {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const request = { model: "fixture", input: "go", tools, tool_choice: { type: "function", name: "delete_repo" } } as unknown as ResponsesRequest;
  await assert.rejects(async () => { for await (const _ of new ChatCompletionsAPI(config).infer(request, new AbortController().signal)) { /* refused first */ } }, /not in the catalog|absent from the current catalog/);
});

test("the Anthropic API keeps a call to an undeclared tool and its result as text", async t => {
  const config: ProviderConfig = { id: "anthropic", type: "anthropic-api", baseUrl: "http://127.0.0.1:4001/v1", apiKeyEnv: key, models: { "anthropic/sonnet": "fixture" } };
  const body = await outbound(t, new AnthropicAPI(config), { model: "fixture", input, tools });
  const blocks = (body.messages as Array<{ role: string; content: Array<{ type: string; id?: string; tool_use_id?: string; text?: string }> }>).flatMap(message => message.content.map(block => ({ role: message.role, ...block })));
  assert.deepEqual(blocks.filter(block => block.type === "tool_use").map(block => block.id), ["call_exec"]);
  assert.deepEqual(blocks.filter(block => block.type === "tool_result").map(block => block.tool_use_id), ["call_exec"]);
  assert.ok(blocks.some(block => block.role === "assistant" && /\[Earlier tool call mcp__recall__report_correction/.test(block.text || "")));
  assert.ok(blocks.some(block => block.role === "user" && /\[Result of earlier tool call mcp__recall__report_correction\]\nsaved/.test(block.text || "")));
});

test("a request with no tools drops auto or none tool_choice, as compaction sends it, and refuses required", async t => {
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  for (const tool_choice of ["auto", "none"]) {
    const body = await outbound(t, new ChatCompletionsAPI(config), { model: "fixture", input, tool_choice, parallel_tool_calls: true } as unknown as ResponsesRequest);
    assert.equal(body.tool_choice, undefined, `${tool_choice} is not sent without tools`);
    assert.equal(body.tools, undefined);
  }
  const withTools = await outbound(t, new ChatCompletionsAPI(config), { model: "fixture", input, tools, tool_choice: "auto" } as unknown as ResponsesRequest);
  assert.equal(withTools.tool_choice, "auto", "a request with tools keeps its selection");
  await assert.rejects(async () => { for await (const _ of new ChatCompletionsAPI(config).infer({ model: "fixture", input, tool_choice: "required" } as unknown as ResponsesRequest, new AbortController().signal)) { /* refused */ } },
    /needs at least one declared tool|Required tool is not in the catalog/);
});
