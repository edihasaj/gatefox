import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { providerFailureStatus, streamFailureCode } from "../provider-failure.js";
import { ChatCompletionsAPI, chatWireToolNames, resolveChatTool } from "../providers/chat-completions-api.js";
import type { ProviderError } from "../providers/provider.js";

const stream = (name: string, args = '{"cmd":"echo ok"}') => new Response([
  { model: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] }, finish_reason: null }] },
  { model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

test("a tool keeps its real name on the wire unless the grammar or uniqueness forbids it", () => {
  const named = (...names: string[]) => names.map(name => ({ function: { name, responseTool: { name } } }));
  const long = "x".repeat(65);
  assert.deepEqual(chatWireToolNames(named("exec_command", "mcp__recall__query", "a-b")), ["exec_command", "mcp__recall__query", "a-b"]);
  assert.deepEqual(chatWireToolNames(named("needs.dot", long, "ok")), ["tool_0", "tool_1", "ok"], "an invalid name falls back to its position");
  assert.deepEqual(chatWireToolNames(named("same", "same")), ["tool_0", "tool_1"], "a duplicate never collapses onto one tool");
  assert.deepEqual(chatWireToolNames(named("tool_1", "first")), ["tool_0", "first"], "a real name cannot impersonate a position");
  const fallback = named("needs.dot", "ok");
  assert.equal(resolveChatTool("tool_0", fallback)?.name, "needs.dot", "a position works where it is the wire name");
  assert.equal(resolveChatTool("tool_1", fallback), undefined);
});

test("the request and a chat already in progress both use real names, so nothing asks the model to recall a position", async t => {
  const key = "GATEWAY_TOOL_WIRE_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let body: { tools: Array<{ function: { name: string } }>; messages: Array<{ tool_calls?: Array<{ function: { name: string } }> }> } | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => { body = JSON.parse(init.body); return stream("exec_command"); });
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const tools = [{ type: "function" as const, name: "exec_command", parameters: { type: "object" } }, { type: "custom" as const, name: "apply_patch", format: { type: "text" } }];
  const input = [{ type: "function_call", call_id: "one", name: "exec_command", arguments: "{}" }, { type: "function_call_output", call_id: "one", output: "ok" },
    { type: "custom_tool_call", call_id: "two", name: "apply_patch", input: "patch" }, { type: "custom_tool_call_output", call_id: "two", output: "ok" }];
  for await (const _ of new ChatCompletionsAPI(config).infer({ model: "fixture", input, tools } as never, new AbortController().signal)) { /* drain */ }
  assert.deepEqual(body!.tools.map(tool => tool.function.name).sort(), ["apply_patch", "exec_command"]);
  assert.deepEqual(body!.messages.flatMap(message => message.tool_calls || []).map(call => call.function.name), ["exec_command", "apply_patch"]);
  assert.doesNotMatch(JSON.stringify(body), /tool_\d/);
});

test("resolveChatTool takes the wire name, accepts a unique original name, and refuses a position, unknown or ambiguous names", () => {
  const tools = [
    { function: { name: "exec_command", responseTool: { name: "exec_command" } } },
    { function: { name: "apply_patch", responseTool: { name: "apply_patch" } } },
    { function: { name: "a__read", responseTool: { name: "read", namespace: "a" } } },
    { function: { name: "b__read", responseTool: { name: "read", namespace: "b" } } },
  ];
  assert.equal(resolveChatTool("tool_1", tools), undefined, "a position is a guess when the tool has a real wire name");
  assert.equal(resolveChatTool("tool_9", tools), undefined);
  assert.equal(resolveChatTool("exec_command", tools)?.name, "exec_command");
  assert.equal(resolveChatTool("apply_patch", tools)?.name, "apply_patch");
  assert.equal(resolveChatTool("b.read", tools)?.name, "b__read", "a namespaced name resolves exactly");
  assert.equal(resolveChatTool("read", tools), undefined, "an ambiguous local name never guesses");
  assert.equal(resolveChatTool("rm_everything", tools), undefined);
  assert.equal(resolveChatTool("", tools), undefined);
});

test("the chat transport runs a call Qwen named by its original tool name and names the tool it refuses", async t => {
  const key = "GATEWAY_TOOL_NAME_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let name = "exec_command";
  t.mock.method(globalThis, "fetch", async () => stream(name));
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const tools = [{ type: "function" as const, name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];
  const run = async () => {
    const calls: Array<{ function: { name: string; arguments: string } }> = [];
    for await (const event of new ChatCompletionsAPI(config).infer({ model: "fixture", input: "run it", tools }, new AbortController().signal)) {
      if ((event as { type: string }).type === "tool") calls.push((event as unknown as { call: { function: { name: string; arguments: string } } }).call);
    }
    return calls;
  };
  const recovered = await run();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.function.name, "exec_command");
  assert.equal(recovered[0]!.function.arguments, '{"cmd":"echo ok"}');
  name = "tool_0";
  await assert.rejects(run(), { code: "malformed_tool_call" }, "a remembered position never runs a tool");
  name = "delete_repo";
  await assert.rejects(run(), (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "malformed_tool_call"
    && /unknown tool "delete_repo"/.test(error.message));
});

const garbledStream = (calls: Array<{ name: string; arguments: string }>) => new Response([
  { model: "fixture", choices: [{ index: 0, delta: { tool_calls: calls.map((call, index) => ({ index, id: `call_${index}`, function: call })) }, finish_reason: null }] },
  { model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

test("a garbled Qwen call is retryable, never a final turn failure, and carries a fixed reason", async t => {
  const key = "GATEWAY_TOOL_GARBLE_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const tools = [{ type: "function" as const, name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];
  // Names observed on real failed worker turns.
  for (const [name, args, reason] of [["tool=\n", "{}", "unknown_tool"], ["tool=tool_14", "{}", "unknown_tool"], ["tool_1=\n<parameter=input", "{}", "unknown_tool"], ["exec_command", "{not json", "invalid_tool_arguments"]] as const) {
    t.mock.method(globalThis, "fetch", async () => garbledStream([{ name, arguments: args }]));
    await assert.rejects(async () => { for await (const _ of new ChatCompletionsAPI(config).infer({ model: "fixture", input: "run it", tools }, new AbortController().signal)) { /* drain */ } },
      (error: unknown) => {
        const failure = error as ProviderError;
        assert.equal(failure.code, "malformed_tool_call"); assert.equal(failure.upstream?.code, reason);
        assert.notEqual(streamFailureCode(failure), "invalid_prompt", "Codex must be free to retry a sampled failure");
        assert.equal(streamFailureCode(failure), "malformed_tool_call");
        assert.equal(providerFailureStatus(failure), 502);
        return true;
      });
  }
});

test("a valid call is not released when a sibling in the batch is garbled, so a retry cannot repeat it", async t => {
  const key = "GATEWAY_TOOL_BATCH_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  t.mock.method(globalThis, "fetch", async () => garbledStream([{ name: "exec_command", arguments: '{"cmd":"rm build.lock"}' }, { name: "tool=", arguments: "{}" }]));
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const tools = [{ type: "function" as const, name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];
  const seen: string[] = [];
  await assert.rejects(async () => { for await (const event of new ChatCompletionsAPI(config).infer({ model: "fixture", input: "run it", tools }, new AbortController().signal)) seen.push((event as { type: string }).type); }, { code: "malformed_tool_call" });
  assert.equal(seen.includes("tool"), false);
});
