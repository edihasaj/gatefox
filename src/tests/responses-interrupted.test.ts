import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesWriter } from "../protocol/responses.js";
import type { WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
test("interrupted inference preserves its actual terminal and keeps the user turn open", () => {
  const events: WireEvent[] = []; const writer = new ResponsesWriter("fixture", event => events.push(event));
  writer.begin(); writer.accept({ type: "text", messageId: "first", phase: "commentary", text: "Actual text" });
  writer.accept({ type: "message-done", messageId: "first", status: "completed" });
  writer.accept({ type: "tool", call: { type: "function", id: "call", function: { name: "fixture", arguments: "{}" } } });
  writer.accept({ type: "text", messageId: "partial", phase: "partial_answer", text: "Partial" });
  writer.accept({ type: "done", usage, interrupted: true, endTurn: false });
  const result = writer.result(); const output = result.output as Array<Record<string, unknown>>;
  assert.equal(writer.completed, true); assert.equal(result.status, "incomplete");
  assert.deepEqual(result.incomplete_details, { reason: "interrupted" }); assert.equal(result.end_turn, false);
  assert.deepEqual(output.map(item => item.status), ["completed", "completed", "incomplete"]);
  assert.deepEqual(output.map(item => item.type), ["message", "function_call", "message"]);
  assert.equal(result.output_text, "Actual textPartial"); assert.deepEqual(result.usage, usage);
  assert.equal(events.filter(event => event.type === "response.incomplete").length, 1);
  assert.equal(events.filter(event => event.type === "response.completed" || event.type === "response.failed").length, 0);
  writer.fail("late", "late error"); writer.progress();
  assert.equal(events.filter(event => event.type === "response.incomplete").length, 1);
  assert.throws(() => writer.accept({ type: "text", text: "late" }));
});

test("actual unfinished message status survives a message boundary", () => {
  const writer = new ResponsesWriter("fixture", () => {});
  writer.accept({ type: "text", messageId: "partial", text: "Actual partial" });
  writer.accept({ type: "message-done", messageId: "partial", status: "incomplete" });
  writer.accept({ type: "done", usage, interrupted: true, endTurn: false });
  assert.equal((writer.result().output as Array<Record<string, unknown>>)[0].status, "incomplete");
});

test("an interrupted inference cannot assert the user turn finished", () => {
  const events: WireEvent[] = []; const writer = new ResponsesWriter("fixture", event => events.push(event)); writer.begin();
  for (const endTurn of [true, undefined]) {
    assert.throws(() => writer.accept({ type: "done", usage, interrupted: true, endTurn }), /cannot finish/);
    assert.equal(writer.completed, false); assert.equal(events.length, 1);
  }
});
