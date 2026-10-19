import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { grokToolBridge, isGrokResponsesRoute } from "../providers/grok-tools.js";
import { ProviderError } from "../providers/provider.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";

const key = "GATEWAY_GROK_TOOLS_FIXTURE";
const config: ProviderConfig = { id: "grok", type: "responses-api", baseUrl: "https://api.x.ai/v1", apiKeyEnv: key, models: { grok: "grok-4.7" } };
const custom = (name = "patch", namespace = "files") => ({ type: "namespace" as const, name: namespace, tools: [{ type: "custom" as const, name, description: "Apply a raw patch", format: { type: "grammar" as const, syntax: "regex" as const, definition: ".+" } }] });
const fn = (name = "read", namespace = "files", strict?: boolean) => ({ type: "namespace" as const, name: namespace, tools: [{ type: "function" as const, name, description: "Read a file",
  parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" } }, required: ["path"] }, ...(strict === undefined ? {} : { strict }) }] });
const complete = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "r", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
const stream = (...frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
const request = (tools: unknown[], input: unknown = "go"): ResponsesRequest => ({ model: "grok-4.7", input: input as ResponsesRequest["input"], tools: tools as never[] });

function bridge(value: ResponsesRequest) {
  const result = grokToolBridge(config, value, structuredClone(value));
  assert.ok(result); return result;
}

test("Grok wire names are stable across catalog order, namespace-safe, and preserve function strict schemas", () => {
  const first = request([custom("patch", "files"), custom("patch", "workspace"), fn("read", "files", true)]);
  const second = request([fn("read", "files", true), custom("patch", "workspace"), custom("patch", "files")]);
  const left = bridge(first).body.tools as Array<Record<string, unknown>>;
  const right = bridge(second).body.tools as Array<Record<string, unknown>>;
  const byDescription = (tools: Array<Record<string, unknown>>) => new Map(tools.map(tool => [String(tool.description), tool]));
  for (const [description, tool] of byDescription(left)) {
    const match = byDescription(right).get(description)!;
    assert.equal(tool.name, match.name);
    assert.match(String(tool.name), /^grok_[A-Za-z0-9_-]{43}$/);
    assert.ok(String(tool.name).length <= 64);
  }
  assert.equal(new Set(left.map(tool => tool.name)).size, 3);
  const functionTool = left.find(tool => String(tool.description).includes("Caller tool identity: files.read"))!;
  assert.deepEqual(functionTool.parameters, fn("read", "files", true).tools[0].parameters);
  assert.equal(functionTool.strict, true);
  const customTool = left.find(tool => String(tool.description).includes("Caller tool identity: files.patch"))!;
  assert.deepEqual(customTool.parameters, { type: "object", required: ["input"], properties: { input: { type: "string" } }, additionalProperties: false });
  assert.match(String(customTool.description), /Required regex grammar:\n\.\+/);
});

test("Grok lifts lite tools, remaps forced choice and replay, and leaves opaque ciphertext unchanged", () => {
  const value = request([fn("current")], [
    { type: "additional_tools", tools: [custom()] },
    { type: "custom_tool_call", call_id: "custom-call", namespace: "files", name: "patch", input: "raw patch", encrypted_function_args: ["opaque-call"] },
    { type: "custom_tool_call_output", call_id: "custom-call", namespace: "files", name: "patch", output: "ok" },
    { type: "reasoning", encrypted_content: "opaque-reasoning" },
  ]);
  value.tool_choice = { type: "function", namespace: "files", name: "current" };
  const result = bridge(value).body;
  assert.equal((result.input as Array<Record<string, unknown>>).some(item => item.type === "additional_tools"), false);
  const call = (result.input as Array<Record<string, unknown>>).find(item => item.call_id === "custom-call" && item.type === "function_call")!;
  assert.equal(call.namespace, undefined); assert.match(String(call.name), /^grok_/);
  assert.equal(call.arguments, JSON.stringify({ input: "raw patch" })); assert.deepEqual(call.encrypted_function_args, ["opaque-call"]);
  const output = (result.input as Array<Record<string, unknown>>).find(item => item.type === "function_call_output")!;
  assert.equal(output.name, undefined); assert.equal(output.namespace, undefined);
  assert.equal((result.input as Array<Record<string, unknown>>).find(item => item.type === "reasoning")?.encrypted_content, "opaque-reasoning");
  assert.deepEqual(result.tool_choice, { type: "function", name: (result.tools as Array<Record<string, unknown>>).find(tool => String(tool.description).includes("files.current"))?.name });
});

test("Grok replays a removed custom tool under its original stable identity and restores caller custom calls", async t => {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>; bodies.push(body);
    if (bodies.length === 1) {
      const wireName = (body.tools as Array<Record<string, unknown>>)[0].name;
      const call = { type: "function_call", id: "fc", call_id: "call", name: wireName, arguments: JSON.stringify({ input: "*** patch" }), status: "completed" };
      return stream({ type: "response.output_item.done", item: call }, complete([call]));
    }
    return stream(complete());
  });
  const api = new ResponsesAPI(config);
  const first: InferenceEvent[] = [];
  for await (const event of api.infer(request([custom()]), new AbortController().signal)) first.push(event);
  const emitted = first.find(event => event.type === "tool");
  assert.deepEqual(emitted, { type: "tool", call: { id: "call", type: "function", responseTool: { type: "custom", namespace: "files", name: "patch" },
    function: { name: "patch", arguments: JSON.stringify({ input: "*** patch" }) } } });
  const history = [
    { type: "custom_tool_call", call_id: "call", namespace: "files", name: "patch", input: "*** patch" },
    { type: "custom_tool_call_output", call_id: "call", namespace: "files", name: "patch", output: "done" },
    { type: "message", role: "user", content: "continue" },
  ];
  for await (const _event of api.infer(request([fn("new_tool")], history), new AbortController().signal)) { /* drain */ }
  const replay = bodies[1].input as Array<Record<string, unknown>>;
  const call = replay.find(item => item.type === "function_call")!;
  assert.equal(call.arguments, JSON.stringify({ input: "*** patch" }));
  assert.match(String(call.name), /^grok_/);
  assert.equal(replay.find(item => item.type === "function_call_output")?.name, undefined);
  assert.equal(replay.find(item => item.type === "function_call_output")?.namespace, undefined);
});

test("Grok rejects foreign wire calls and malformed completed custom envelopes without parsing partial arguments", async t => {
  const own = bridge(request([custom()]));
  assert.throws(() => own.restoreItem({ type: "function_call", name: "foreign", call_id: "call", arguments: "{}" }), ProviderError);
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    const name = (body.tools as Array<Record<string, unknown>>)[0].name;
    const partial = { type: "function_call", id: "fc", call_id: "call", name, arguments: "{\"input\"", status: "in_progress", encrypted_function_args: ["opaque"] };
    const malformed = { ...partial, arguments: "{}", status: "completed" };
    return stream({ type: "response.output_item.added", item: partial }, { type: "response.output_item.done", item: malformed });
  });
  await assert.rejects(async () => { for await (const _event of new ResponsesAPI(config).infer(request([custom()]), new AbortController().signal)) { /* drain */ } },
    error => error instanceof ProviderError && error.code === "invalid_tool_call");
});

test("only official Grok Responses routes enable the bridge", () => {
  assert.equal(isGrokResponsesRoute(config, "grok-4.7"), true);
  assert.equal(isGrokResponsesRoute({ ...config, baseUrl: "https://opencode.ai/inference/go/openai/v1" }, "grok-4.7"), true);
  for (const provider of [
    { ...config, baseUrl: "https://example.invalid/v1" },
    { ...config, baseUrl: "https://api.x.ai/v1", type: "codex-subscription" as const },
    { ...config, baseUrl: "https://opencode.ai/inference/anthropic/v1" },
  ]) assert.equal(isGrokResponsesRoute(provider, "grok-4.7"), false);
  assert.equal(isGrokResponsesRoute(config, "gpt-6.1"), false);
});
