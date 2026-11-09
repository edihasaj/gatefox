import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { ProviderError } from "../providers/provider.js";
import { classifyProviderFailure, streamFailureCode } from "../provider-failure.js";
import { ResponsesTranslationError } from "../protocol/request.js";
import type { ResponsesRequest } from "../protocol/types.js";

const key = "GATEWAY_OPENROUTER_TOOLS_FIXTURE";
const config = { id: "openrouter", type: "responses-api" as const, baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: key, models: { flash: "deepseek/deepseek-v4-flash" } };
const custom = { type: "namespace" as const, name: "files", tools: [{ type: "custom" as const, name: "patch", format: { type: "grammar" as const, syntax: "regex" as const, definition: ".+" } }] };
const request = (): ResponsesRequest => ({ model: config.models.flash, input: "go", tools: [custom], tool_choice: { type: "custom", name: "patch", namespace: "files" } });
const stream = (...frames: unknown[]) => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(""));
const complete = (output: unknown[] = []) => ({ type: "response.completed", response: { id: "r", status: "completed", output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
function fixture(t: TestContext): void {
  const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

test("OpenRouter DeepSeek custom calls survive schema, forced choice, writer and follow-up replay exactly once", async t => {
  fixture(t);
  const bodies: ResponsesRequest[] = [];
  const raw = "*** Begin Patch\n*** End Patch\n";
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as ResponsesRequest; bodies.push(body);
    const definition = body.tools![0] as Record<string, unknown>;
    assert.equal(definition.type, "function");
    assert.deepEqual(definition.parameters, { type: "object", required: ["input"], properties: { input: { type: "string" } }, additionalProperties: false });
    assert.match(String(definition.description), /files.patch/);
    assert.match(String(definition.description), /Required regex grammar/);
    assert.deepEqual(body.tool_choice, { type: "function", name: definition.name });
    if (bodies.length > 1) return stream(complete());
    const call = { type: "function_call", id: "fc", call_id: "call", name: definition.name, arguments: JSON.stringify({ input: raw }), status: "completed" };
    return stream({ type: "response.output_item.done", item: call }, complete([call]));
  });
  const original = request(), before = structuredClone(original);
  const writer = new ResponsesWriter("flash", () => {}); writer.begin();
  for await (const event of new ResponsesAPI(config).infer(original, new AbortController().signal)) writer.accept(event);
  const output = writer.result().output as Record<string, unknown>[];
  assert.equal(output.length, 1);
  assert.deepEqual({ type: output[0].type, namespace: output[0].namespace, name: output[0].name, input: output[0].input, call_id: output[0].call_id },
    { type: "custom_tool_call", namespace: "files", name: "patch", input: raw, call_id: "call" });
  assert.deepEqual(original, before, "the caller's request is immutable");
  const followup = { ...original, input: [output[0], { type: "custom_tool_call_output", call_id: "call", namespace: "files", name: "patch", output: "ok" }] } as ResponsesRequest;
  for await (const _event of new ResponsesAPI(config).infer(followup, new AbortController().signal)) { /* drain */ }
  const history = bodies[1].input as Record<string, unknown>[];
  assert.equal(history[0].type, "function_call");
  assert.equal(history[0].arguments, JSON.stringify({ input: raw }));
  assert.equal(history[0].name, (bodies[0].tools![0] as { name: string }).name);
  assert.deepEqual(history[1], { type: "function_call_output", call_id: "call", output: "ok" });
});

test("OpenRouter DeepSeek returning the readable alias still resolves one declared custom tool and dispatches it once", async t => {
  fixture(t);
  const raw = "*** Begin Patch\n*** End Patch\n";
  for (const returned of ["files.patch", "functions.files.patch"]) {
    t.mock.method(globalThis, "fetch", async () => {
      const call = { type: "function_call", id: "fc", call_id: "call", name: returned, arguments: JSON.stringify({ input: raw }), status: "completed" };
      return stream({ type: "response.output_item.added", item: { ...call, arguments: "", status: "in_progress" } }, { type: "response.output_item.done", item: call }, complete([call]));
    });
    const writer = new ResponsesWriter("flash", () => {}); writer.begin();
    for await (const event of new ResponsesAPI(config).infer(request(), new AbortController().signal)) writer.accept(event);
    const output = writer.result().output as Record<string, unknown>[];
    assert.equal(output.length, 1);
    assert.deepEqual({ type: output[0].type, namespace: output[0].namespace, name: output[0].name, input: output[0].input, call_id: output[0].call_id },
      { type: "custom_tool_call", namespace: "files", name: "patch", input: raw, call_id: "call" });
  }
});

test("OpenRouter still refuses a returned alias that is not declared, with no retry and no dispatch", async t => {
  fixture(t);
  let requests = 0, dispatched = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return stream(complete([{ type: "function_call", id: "fc", call_id: "call", name: "files.delete", arguments: JSON.stringify({ input: "x" }), status: "completed" }])); });
  await assert.rejects(async () => {
    for await (const event of new ResponsesAPI(config).infer(request(), new AbortController().signal)) if (event.type === "tool") dispatched++;
  }, error => error instanceof ProviderError && error.code === "tool_identity_failure" && error.upstream?.code === "unknown_wire_tool" && !error.message.includes("files.delete"));
  assert.equal(requests, 1); assert.equal(dispatched, 0);
});

test("malformed custom function envelopes fail before dispatch on OpenRouter and generic Responses without retry", async t => {
  fixture(t);
  for (const baseUrl of [config.baseUrl, "https://example.invalid/v1"]) {
    for (const arguments_ of ["{}", "null", "[]", '{"input":4}', '{"input":"ok","discarded":true}']) {
      let requests = 0, dispatched = 0;
      t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
        requests++;
        const body = JSON.parse(String(options.body));
        const bridged = baseUrl === config.baseUrl;
        return stream(complete([{ type: "function_call", id: "fc", call_id: "call", name: bridged ? body.tools[0].name : "patch", ...(bridged ? {} : { namespace: "files" }), arguments: arguments_, status: "completed" }]));
      });
      await assert.rejects(async () => {
        for await (const event of new ResponsesAPI({ ...config, baseUrl }).infer(request(), new AbortController().signal)) if (event.type === "tool") dispatched++;
      }, error => error instanceof ProviderError && error.code === "invalid_tool_call");
      assert.equal(requests, 1); assert.equal(dispatched, 0);
    }
  }
});

test("writer-level invalid custom output is a provider failure, while invalid requests retain their classification", () => {
  const failure = classifyProviderFailure(new ResponsesTranslationError("private output", "invalid_provider_output"), undefined);
  assert.equal(failure.code, "invalid_tool_call"); assert.equal(failure.status, 502);
  assert.equal(streamFailureCode(failure), "invalid_prompt", "no repeated paid inference");
  assert.equal(failure.message, "Provider returned invalid custom tool arguments");
  assert.equal(classifyProviderFailure(new ResponsesTranslationError("private request", "invalid_shape"), undefined).code, "invalid_request");
});
