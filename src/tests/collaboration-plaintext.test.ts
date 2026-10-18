import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ResponsesWriter, responseToolFrames, responseToolItems } from "../protocol/responses.js";
import type { InferenceEvent, OpenAIToolCall, ResponsesRequest, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const collaboration = (name: string, encryptedFunctionArgs?: string[]): OpenAIToolCall => ({
  type: "function", id: `call_${name}`, responseTool: { type: "function", namespace: "collaboration", name },
  ...(encryptedFunctionArgs === undefined ? {} : { encryptedFunctionArgs }),
  function: { name, arguments: '{"task":"exact\\nplaintext"}' },
});

function marker(item: Record<string, unknown>): unknown { return item.encrypted_function_args; }
function writerOutput(call: OpenAIToolCall): { output: Record<string, unknown>[]; frames: WireEvent[] } {
  const frames: WireEvent[] = []; const writer = new ResponsesWriter("fixture", frame => frames.push(frame));
  writer.begin(); writer.accept({ type: "tool", call }); writer.accept({ type: "done", usage });
  return { output: writer.result().output as Record<string, unknown>[], frames };
}

test("only plaintext collaboration calls carry the explicit empty encryption marker in JSON and SSE", () => {
  for (const name of ["spawn_agent", "send_message", "followup_task"]) {
    const call = collaboration(name); const expected = call.function.arguments;
    assert.deepEqual(marker(responseToolItems([call])[0]), []);
    const rawFrames = responseToolFrames([call], 0).map(frame => JSON.parse(frame) as Record<string, unknown>);
    assert.deepEqual(marker(rawFrames[0].item as Record<string, unknown>), []);
    assert.deepEqual(marker(rawFrames[1]), []);
    assert.deepEqual(marker(rawFrames[2].item as Record<string, unknown>), []);
    const { output, frames } = writerOutput(call);
    assert.equal(output[0].arguments, expected, "plaintext arguments stay byte-for-byte intact");
    assert.deepEqual(marker(output[0]), []);
    assert.deepEqual(marker(frames.find(frame => frame.type === "response.function_call_arguments.done") as Record<string, unknown>), []);
    for (const frame of frames.filter(frame => frame.type === "response.output_item.added" || frame.type === "response.output_item.done")) {
      const item = frame.item as Record<string, unknown>;
      if (item.type === "function_call") assert.deepEqual(marker(item), []);
    }
  }
});

test("custom, unrelated, and lookalike tool identities never receive the plaintext marker", () => {
  const calls: OpenAIToolCall[] = [
    { type: "function", id: "custom", responseTool: { type: "custom", namespace: "collaboration", name: "spawn_agent" }, function: { name: "spawn_agent", arguments: '{"input":"x"}' } },
    { type: "function", id: "namespace", responseTool: { type: "function", namespace: "collaboration_extra", name: "spawn_agent" }, function: { name: "spawn_agent", arguments: "{}" } },
    { type: "function", id: "name", responseTool: { type: "function", namespace: "collaboration", name: "spawn_agent_now" }, function: { name: "spawn_agent_now", arguments: "{}" } },
    { type: "function", id: "plain", function: { name: "collaboration.spawn_agent", arguments: "{}" } },
  ];
  for (const call of calls) {
    const item = responseToolItems([call])[0]; assert.equal(Object.hasOwn(item, "encrypted_function_args"), false);
    const { output } = writerOutput(call); assert.equal(Object.hasOwn(output[0], "encrypted_function_args"), false);
  }
});

const upstreamCall = (encrypted: unknown = undefined) => ({
  type: "function_call", id: "fc_upstream", call_id: "call_upstream", namespace: "collaboration", name: "spawn_agent",
  arguments: '{"task":"exact\\nplaintext"}', status: "completed",
  ...(encrypted === undefined ? {} : { encrypted_function_args: encrypted }),
});
const complete = (output: unknown[]) => ({ type: "response.completed", response: { status: "completed", usage, output } });

async function infer(t: TestContext, frames: unknown[], options: Partial<ResponsesRequest> = {}) {
  t.mock.method(globalThis, "fetch", async () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")));
  const apiKeyEnv = "GATEWAY_COLLABORATION_FIXTURE_KEY";
  if (!Object.hasOwn(process.env, apiKeyEnv)) { process.env[apiKeyEnv] = "fixture-only"; t.after(() => { delete process.env[apiKeyEnv]; }); }
  const api = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv, baseUrl: "http://127.0.0.1:1", models: { fixture: "fixture" } });
  const events: InferenceEvent[] = []; const wire: WireEvent[] = []; const writer = new ResponsesWriter("fixture", frame => wire.push(frame)); writer.begin();
  for await (const event of api.infer({ model: "fixture", input: "fixture", tools: [{ type: "namespace", name: "collaboration", tools: [{ type: "function", name: "spawn_agent" }] }], ...options }, new AbortController().signal)) {
    events.push(event); writer.accept(event);
  }
  return { events, wire, output: writer.result().output as Record<string, unknown>[] };
}

test("Responses upstream metadata is retained opaquely through events, SSE, and the final snapshot", async t => {
  for (const encrypted of [[], ["opaque-a", "opaque-b"]]) {
    const call = upstreamCall(encrypted); const result = await infer(t, [{ type: "response.output_item.done", item: call }, complete([call])]);
    const event = result.events.find(event => event.type === "tool"); assert.ok(event && event.type === "tool");
    assert.deepEqual(event.call.encryptedFunctionArgs, encrypted);
    assert.equal(event.call.function.arguments, call.arguments);
    assert.deepEqual(marker(result.output[0]), encrypted);
    const sseItems = result.wire.filter(frame => frame.type === "response.output_item.added" || frame.type === "response.output_item.done")
      .map(frame => frame.item as Record<string, unknown>).filter(item => item.type === "function_call");
    assert.ok(sseItems.length >= 2); sseItems.forEach(item => assert.deepEqual(marker(item), encrypted));
  }
});

test("malformed or changed upstream encryption metadata fails closed", async t => {
  for (const malformed of [null, "opaque", ["opaque", 1], {}]) {
    await assert.rejects(infer(t, [complete([upstreamCall(malformed)])]), /invalid or duplicate tool call/);
  }
  const first = upstreamCall(["opaque-a"]); const changed = upstreamCall(["opaque-b"]);
  await assert.rejects(infer(t, [{ type: "response.output_item.done", item: first }, complete([changed])]), /invalid or duplicate tool call/);
  await assert.rejects(infer(t, [{ type: "response.output_item.done", item: first }, complete([upstreamCall()])]), /invalid or duplicate tool call/);
});

test("added encryption metadata is validated and remains stable through completion", async t => {
  const added = (encrypted: unknown) => ({ type: "response.output_item.added", item: upstreamCall(encrypted) });
  for (const encrypted of [[], ["opaque-a"]]) {
    const call = upstreamCall(encrypted);
    const result = await infer(t, [added(encrypted), { type: "response.output_item.done", item: call }, complete([call])]);
    const event = result.events.find(event => event.type === "tool"); assert.ok(event && event.type === "tool");
    assert.deepEqual(event.call.encryptedFunctionArgs, encrypted);
  }
  await assert.rejects(infer(t, [added(null), complete([])]), /tool call/);
  await assert.rejects(infer(t, [added(["opaque-a"]), { type: "response.output_item.done", item: upstreamCall([]) }]), /tool call/);
  await assert.rejects(infer(t, [added(["opaque-a"]), complete([{ ...upstreamCall(["opaque-b"]) }])]), /tool call/);
  await assert.rejects(infer(t, [added(["opaque-a"]), complete([upstreamCall()])]), /tool call/);
});

test("a later completed encryption marker remains valid when absent from an early added call", async t => {
  const early = { ...upstreamCall() }; const completed = upstreamCall(["opaque-a"]);
  const result = await infer(t, [{ type: "response.output_item.added", item: early }, { type: "response.output_item.done", item: completed }, complete([completed])]);
  const event = result.events.find(event => event.type === "tool"); assert.ok(event && event.type === "tool");
  assert.deepEqual(event.call.encryptedFunctionArgs, ["opaque-a"]);
});
