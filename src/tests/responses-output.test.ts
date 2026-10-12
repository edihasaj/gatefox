import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ResponsesWriter } from "../protocol/responses.js";
import type { InferenceEvent, ResponsesRequest, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 1, output_tokens: 2, total_tokens: 3 };
const message = (id: string, text: string, phase?: string) => ({
  id, type: "message", role: "assistant", status: "completed", ...(phase === undefined ? {} : { phase }),
  content: [{ type: "output_text", text }],
});
const delta = (id: string, text: string, index = 0) => ({ type: "response.output_text.delta", item_id: id, content_index: index, delta: text });
const itemDone = (item: unknown) => ({ type: "response.output_item.done", item });
const complete = (fields: Record<string, unknown> = {}) => ({ type: "response.completed", response: { status: "completed", usage, ...fields } });
async function infer(t: TestContext, frames: unknown[], options: Partial<ResponsesRequest> = {}) {
  t.mock.method(globalThis, "fetch", async () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("")));
  const apiKeyEnv = "GATEWAY_OUTPUT_FIXTURE_KEY";
  if (!Object.hasOwn(process.env, apiKeyEnv)) { process.env[apiKeyEnv] = "fixture-only"; t.after(() => { delete process.env[apiKeyEnv]; }); }
  const provider = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv, baseUrl: "http://127.0.0.1:1", models: { fixture: "fixture" } });
  const events: InferenceEvent[] = []; const wire: WireEvent[] = [];
  const writer = new ResponsesWriter("fixture", frame => wire.push(frame)); writer.begin();
  for await (const event of provider.infer({ model: "fixture", input: "fixture", ...options }, new AbortController().signal)) {
    events.push(event); writer.accept(event);
  }
  return { events, wire, result: writer.result() };
}
const text = (events: InferenceEvent[]) => events.filter(event => event.type === "text").map(event => event.text).join("");
const messages = (result: Record<string, unknown>) => (result.output as Record<string, unknown>[]).filter(item => item.type === "message");

test("completed Responses preserve only an actual boolean end_turn, including tool-only continued responses", async t => {
  for (const actual of [undefined, false, true]) {
    const response = await infer(t, [complete(actual === undefined ? {} : { end_turn: actual })]);
    const done = response.events.at(-1)!;
    assert.equal(done.type, "done");
    assert.equal(Object.hasOwn(done, "endTurn"), actual !== undefined);
    assert.equal(Object.hasOwn(response.result, "end_turn"), actual !== undefined);
    assert.equal(response.result.end_turn, actual);
    assert.deepEqual(response.result.output, [], "no assistant content may be invented");
    assert.ok(response.wire.filter(frame => frame.type === "response.created").every(frame => !Object.hasOwn(frame.response as object, "end_turn")));
  }
  const call = { type: "function_call", id: "fc_upstream", call_id: "call", name: "inspect", arguments: "{}", status: "completed" };
  const response = await infer(t, [complete({ output: [call], end_turn: false })], { tools: [{ type: "function", name: "inspect" }] });
  assert.equal(response.result.end_turn, false);
  assert.deepEqual((response.result.output as Record<string, unknown>[]).map(item => item.type), ["function_call"]);
});

test("actual nested message text survives item.done and completed.output without any text delta", async t => {
  for (const frames of [
    [itemDone(message("actual", "provider answer", "final_answer")), complete({ output: [message("actual", "provider answer", "final_answer")] })],
    [complete({ output: [message("actual", "provider answer", "final_answer")] })],
  ]) {
    const response = await infer(t, frames);
    assert.equal(text(response.events), "provider answer");
    assert.equal(response.result.output_text, "provider answer");
    assert.equal(messages(response.result).length, 1);
    assert.equal(messages(response.result)[0].phase, "final_answer");
    assert.equal(response.wire.filter(frame => frame.type === "response.output_item.done").length, 1);
  }
});

test("partial streamed text appends only the confirmed missing suffix and retains separate assistant phases", async t => {
  const preamble = message("preamble", "Inspecting now", "commentary");
  const answer = message("answer", "All done", "final_answer");
  const call = { type: "function_call", call_id: "call", name: "inspect", arguments: "{}" };
  const response = await infer(t, [
    { type: "response.output_item.added", item: { ...preamble, status: "in_progress", content: [] } },
    delta("preamble", "Inspect"), itemDone(preamble), itemDone(call), delta("answer", "All "),
    complete({ output: [preamble, call, answer], end_turn: true }),
  ], { tools: [{ type: "function", name: "inspect" }] });
  assert.deepEqual(response.events.filter(event => event.type === "text").map(event => event.text), ["Inspect", "ing now", "All ", "done"]);
  const output = response.result.output as Record<string, unknown>[];
  assert.deepEqual(output.map(item => item.type), ["message", "function_call", "message"]);
  assert.deepEqual(messages(response.result).map(item => item.phase), ["commentary", "final_answer"]);
  assert.equal(response.events.filter(event => event.type === "tool").length, 1, "a final snapshot must not dispatch a call twice");
  assert.equal(response.result.output_text, "Inspecting nowAll done");
});

test("phase supplied only by the completed snapshot reaches the real message boundary", async t => {
  const response = await infer(t, [
    delta("actual", "partial "), itemDone(message("actual", "partial answer")),
    complete({ output: [message("actual", "partial answer", "partial_answer")] }),
  ]);
  assert.equal(response.result.output_text, "partial answer");
  assert.equal(messages(response.result)[0].phase, "partial_answer");
  const completed = response.wire.filter(frame => frame.type === "response.output_item.done");
  assert.equal(completed.length, 1);
  assert.equal((completed[0].item as Record<string, unknown>).phase, "partial_answer");
});

test("interleaved message IDs retain their own text and completion boundary", async t => {
  const response = await infer(t, [
    delta("first", "first"), delta("second", "second"),
    itemDone(message("first", "first", "commentary")), itemDone(message("second", "second", "final_answer")),
    complete({ output: [message("first", "first", "commentary"), message("second", "second", "final_answer")] }),
  ]);
  assert.deepEqual(messages(response.result).map(item => (item.content as { text: string }[])[0].text), ["first", "second"]);
  assert.deepEqual(messages(response.result).map(item => item.phase), ["commentary", "final_answer"]);
  assert.equal(new Set(messages(response.result).map(item => item.id)).size, 2);
});

test("final-output custom tools retain exact caller namespace and execute once", async t => {
  const call = { type: "custom_tool_call", id: "upstream-call", call_id: "call", namespace: "files", name: "patch", input: "actual patch", status: "completed" };
  const response = await infer(t, [itemDone(call), complete({ output: [call], end_turn: false })], {
    tools: [{ type: "namespace", name: "files", tools: [{ type: "custom", name: "patch" }] }],
  });
  const calls = response.result.output as Record<string, unknown>[];
  assert.equal(calls.length, 1); assert.equal(calls[0].namespace, "files"); assert.equal(calls[0].input, "actual patch");
});

test("malformed or inconsistent final output fails instead of inventing completion or replaying tools", async t => {
  const actual = message("actual", "answer", "final_answer");
  const call = { type: "function_call", call_id: "call", name: "inspect", arguments: "{}" };
  for (const frames of [
    [delta("actual", "streamed"), complete({ output: [actual] })],
    [itemDone(actual), complete({ output: [{ ...actual, content: [{ type: "output_text", text: "changed" }] }] })],
    [complete({ output: [message("actual", "answer", "private unsupported phase")] })],
    [complete({ output: [{ ...actual, status: "in_progress" }] })],
    [complete({ output: [{ ...actual, status: ["completed"] }] })],
    [complete({ output: [{ ...actual, role: "user" }] })],
    [complete({ output: [{ ...actual, id: "" }] })],
    [itemDone(actual), itemDone(actual), complete()],
    [itemDone(message("actual", "answer")), itemDone(message("actual", "answer")), complete()],
    [delta("actual", "answer", 0.5), complete()],
    [complete({ end_turn: "false" })],
    [complete({ end_turn: null })],
    [itemDone(call), complete({ output: [{ ...call, arguments: "changed" }] })],
    [complete({ output: [actual, actual] })],
    [complete({ output: [call, call] })],
    [delta("actual", "later", 1), complete({ output: [actual] })],
    [delta("actual", "ear", 0), delta("actual", "later", 1), complete({ output: [{ ...actual, content: [{ type: "output_text", text: "earlier" }, { type: "output_text", text: "later" }] }] })],
  ]) {
    await assert.rejects(infer(t, frames, { tools: [{ type: "function", name: "inspect" }] }), error => {
      assert.ok(error instanceof Error); assert.ok(!error.message.includes("private unsupported phase")); return true;
    });
  }
});

test("ordered multiple content parts preserve text without duplication", async t => {
  const actual = { ...message("actual", "first", "final_answer"), content: [{ type: "output_text", text: "first" }, { type: "output_text", text: "second" }] };
  const response = await infer(t, [delta("actual", "first", 0), delta("actual", "sec", 1), complete({ output: [actual] })]);
  assert.equal(response.result.output_text, "firstsecond");
});

test("legacy ID-less deltas and top-level fallback remain compatible without duplicating text", async t => {
  for (const frames of [
    [{ type: "response.output_text.delta", delta: "legacy" }, complete({ output_text: "legacy" })],
    [complete({ output_text: "legacy" })],
    [{ type: "response.output_text.delta", delta: "lega" }, complete({ output: [message("actual", "legacy", "final_answer")] })],
    [{ type: "response.output_item.added", item: { ...message("actual", "", "final_answer"), status: "in_progress", content: [] } },
      { type: "response.output_text.delta", delta: "lega" }, complete({ output: [message("actual", "legacy", "final_answer")] })],
  ]) {
    const response = await infer(t, frames);
    assert.equal(response.result.output_text, "legacy"); assert.equal(messages(response.result).length, 1);
  }
});

test("ID-less text cannot be attributed when multiple assistant messages are open", async t => {
  await assert.rejects(infer(t, [
    ...["first", "second"].map(id => ({ type: "response.output_item.added", item: { ...message(id, ""), status: "in_progress", content: [] } })),
    { type: "response.output_text.delta", delta: "ambiguous" }, complete(),
  ]), { code: "inconsistent_stream" });
});

test("ID-less text around a caller tool retains message/tool/message order and later actual phases", async t => {
  const call = { type: "function_call", call_id: "call", name: "inspect", arguments: "{}" };
  for (const snapshot of [undefined, [message("before", "before", "commentary"), call, message("after", "after", "final_answer")]]) {
    const response = await infer(t, [
      { type: "response.output_text.delta", delta: "before" }, itemDone(call),
      { type: "response.output_text.delta", delta: "after" }, complete(snapshot ? { output: snapshot } : {}),
    ], { tools: [{ type: "function", name: "inspect" }] });
    assert.deepEqual((response.result.output as Record<string, unknown>[]).map(item => item.type), ["message", "function_call", "message"]);
    assert.deepEqual(messages(response.result).map(item => (item.content as { text: string }[])[0].text), ["before", "after"]);
    if (snapshot) assert.deepEqual(messages(response.result).map(item => item.phase), ["commentary", "final_answer"]);
  }
});

test("a completed legacy message does not capture the next ID-less assistant message", async t => {
  const call = { type: "function_call", call_id: "call", name: "inspect", arguments: "{}" };
  for (const withTool of [false, true]) {
    const response = await infer(t, [
      { type: "response.output_text.delta", delta: "before" }, itemDone(message("before", "before", "commentary")),
      ...(withTool ? [itemDone(call)] : []), { type: "response.output_text.delta", delta: "after" },
      complete({ output: [message("before", "before", "commentary"), ...(withTool ? [call] : []), message("after", "after", "final_answer")] }),
    ], { tools: [{ type: "function", name: "inspect" }] });
    assert.deepEqual(messages(response.result).map(item => (item.content as { text: string }[])[0].text), ["before", "after"]);
    assert.deepEqual(messages(response.result).map(item => item.phase), ["commentary", "final_answer"]);
  }
});

test("failed partial streams do not invent end_turn metadata", () => {
  const wire: WireEvent[] = []; const writer = new ResponsesWriter("fixture", frame => wire.push(frame)); writer.begin();
  writer.accept({ type: "text", text: "partial", messageId: "actual", phase: "commentary" });
  writer.fail("upstream_error", "Provider failed");
  assert.equal(Object.hasOwn(writer.result(), "end_turn"), false);
  assert.equal(Object.hasOwn(wire.at(-1)!.response as object, "end_turn"), false);
});
