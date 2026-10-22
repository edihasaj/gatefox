import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { ChatCompletionsAPI, resolveChatTool } from "../providers/chat-completions-api.js";

const stream = (name: string, args = '{"cmd":"echo ok"}') => new Response([
  { model: "fixture", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: args } }] }, finish_reason: null }] },
  { model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

test("resolveChatTool keeps tool_N, accepts a unique original name, and refuses unknown or ambiguous names", () => {
  const tools = [
    { function: { name: "exec_command", responseTool: { name: "exec_command" } } },
    { function: { name: "apply_patch", responseTool: { name: "apply_patch" } } },
    { function: { name: "a__read", responseTool: { name: "read", namespace: "a" } } },
    { function: { name: "b__read", responseTool: { name: "read", namespace: "b" } } },
  ];
  assert.equal(resolveChatTool("tool_1", tools)?.name, "apply_patch");
  assert.equal(resolveChatTool("tool_9", tools), undefined);
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
  assert.equal((await run())[0]!.function.name, "exec_command", "the normal wire name still works");
  name = "delete_repo";
  await assert.rejects(run(), (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "invalid_tool_call"
    && /unknown tool "delete_repo"/.test(error.message));
});
