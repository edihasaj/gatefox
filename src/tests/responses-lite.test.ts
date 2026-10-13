import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { declaredResponsesTools, responsesToChatRequest } from "../protocol/request.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { modelCatalog } from "../catalog.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import type { ProviderConfig } from "../config.js";

const lite = (extra: Record<string, unknown>[] = []): ResponsesRequest => ({ model: "upstream", reasoning: { effort: "high", context: "all_turns" }, tools: [],
  input: [
    { type: "additional_tools", id: "at_1", role: "developer", tools: [{ type: "namespace", name: "functions", description: "Codex tools", tools: [{ type: "function", name: "exec_command", description: "Run", parameters: { type: "object", properties: { cmd: { type: "string" } } } }] }] },
    { type: "message", role: "user", content: "list files" }, ...extra,
  ] } as unknown as ResponsesRequest);

test("Responses lite tools are declared from additional_tools input items, not replayed as messages", () => {
  assert.deepEqual(declaredResponsesTools(lite()).map(tool => (tool as { name: string }).name), ["functions"]);
  const chat = responsesToChatRequest(lite());
  assert.deepEqual(chat.tools?.map(tool => tool.function.name), ["functions.exec_command"]);
  assert.deepEqual(chat.messages.map(message => message.role), ["user"]);
});

test("the subscription endpoint receives lite requests unchanged and their namespaced calls map back to the caller", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-lite-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const bodies: Array<Record<string, unknown>> = [];
  const call = { type: "function_call", id: "fc_1", call_id: "call_2", name: "exec_command", namespace: "functions", arguments: "{\"cmd\":\"ls\"}", status: "completed" };
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)));
    const event = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`;
    return new Response(event({ type: "response.output_item.done", output_index: 0, item: call }) + event({ type: "response.completed", response: { id: "r", status: "completed", output: [call], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const provider = new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { "codex/upstream": "upstream" } } as ProviderConfig);
    const history = [{ type: "function_call", call_id: "call_1", name: "exec_command", namespace: "functions", arguments: "{\"cmd\":\"pwd\"}" }, { type: "function_call_output", call_id: "call_1", output: "/tmp" }];
    const events: InferenceEvent[] = []; for await (const event of provider.infer(lite(history), new AbortController().signal)) events.push(event);
    const sent = bodies[0] as { input: Array<Record<string, unknown>>; tools: unknown[]; reasoning: Record<string, unknown> };
    assert.equal(sent.input[0].type, "additional_tools", "lite tool declarations reach the upstream untouched");
    assert.deepEqual(sent.tools, []); assert.equal(sent.reasoning.context, "all_turns");
    assert.equal(sent.input.find(item => item.call_id === "call_1")?.namespace, "functions", "a namespaced call is not moved into the gateway namespace");
    const tool = events.find(event => event.type === "tool") as Extract<InferenceEvent, { type: "tool" }>;
    assert.deepEqual(tool.call.responseTool, { type: "function", name: "exec_command", namespace: "functions" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("discovered lite flags reach the Codex catalog row", () => {
  const row = modelCatalog({ version: 1, port: 3457, stateDirectory: "/unused", providers: [{ id: "codex", type: "codex-subscription", credentialFile: "unused", models: { "codex/sol": "sol" },
    modelMetadata: { "codex/sol": { reasoningEfforts: ["high"], useResponsesLite: true, supportsReasoningEffortUpdates: true } } }] }).models[0];
  assert.equal(row.use_responses_lite, true); assert.equal(row.supports_reasoning_effort_updates, true);
});
