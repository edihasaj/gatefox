import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChatRequest } from "../protocol/request.js";
import { ClaudeMessageStream, type ClaudeStreamStep } from "../providers/claude-stream.js";
import { ProviderError } from "../providers/provider.js";

const tools = responsesToChatRequest({ model: "fixture", input: "fixture", tools: [{ type: "function", name: "read" }] }).tools!;
const usage = { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 5 };
const frame = (event: Record<string, unknown>) => ({ type: "stream_event", event });
/** A request on a live session, which always passes the calls it still expects the CLI to reject. */
function live(awaiting: string[] = []): ClaudeMessageStream {
  const parser = new ClaudeMessageStream({ tools, summaryVisible: true, nativeMcpOnly: true, allowToolCorrection: true });
  parser.expectRejections(awaiting);
  return parser;
}
const result = (id: string, error: boolean) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, ...(error ? { is_error: true } : {}) }] } });
/** One native message; `rejectAfter` prints the CLI's error for that call right after its block, as the CLI does when it leads. */
function message(parser: ClaudeMessageStream, names: string[], id = "call", rejectAfter?: number): ClaudeStreamStep {
  parser.accept(frame({ type: "message_start", message: { id: "msg_" + id, usage } }));
  for (const [index, name] of names.entries()) parser.accept(frame({ type: "content_block_start", index, content_block: { type: "tool_use", id: id + index, name, input: {} } }));
  let step = parser.accept(frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage }));
  for (const [index, name] of names.entries()) {
    const next = parser.accept({ type: "assistant", message: { id: "msg_" + id, content: [{ type: "tool_use", id: id + index, name, input: {} }] } });
    if (next.end) step = next;
    if (rejectAfter === index) parser.accept(result(id + index, true));
  }
  return step;
}
const unavailable = (error: unknown) => error instanceof ProviderError && error.upstream?.code === "unavailable_gateway_tool";
const forwarded = (step: ClaudeStreamStep) => step.end?.kind === "tool_use" ? step.end.calls.map(call => call.id) : [];

test("a live mixed batch forwards only its declared calls and withholds the unavailable one", () => {
  const parser = live();
  const step = message(parser, ["mcp__gateway__read", "mcp__gateway__Grep"]);
  assert.deepEqual(forwarded(step), ["call0"]);
  if (step.end?.kind !== "tool_use") assert.fail();
  assert.equal(step.end.calls[0].function.name, "read");
  assert.deepEqual(step.end.tokens, { input: 3, cacheRead: 10, cacheWrite: 2, output: 5 });
  assert.deepEqual(parser.withheldCalls, ["call1"]);
});

test("the next request requires the CLI's own error for the withheld call before another model message", () => {
  const confirmed = live(["call1"]);
  confirmed.accept(result("call0", false)); confirmed.accept(result("call1", true));
  assert.deepEqual(forwarded(message(confirmed, ["mcp__gateway__read"], "next")), ["next0"]);

  const missing = live(["call1"]); missing.accept(result("call0", false));
  assert.throws(() => message(missing, ["mcp__gateway__read"], "next"), unavailable);
  const succeeded = live(["call1"]);
  assert.throws(() => succeeded.accept(result("call1", false)), unavailable);
  const ended = live(["call1"]);
  assert.throws(() => ended.accept({ type: "result", subtype: "success", result: "", usage }), unavailable);
});

test("a rejection printed inside the same request leaves nothing to confirm later", () => {
  const parser = live();
  assert.deepEqual(forwarded(message(parser, ["mcp__gateway__Grep", "mcp__gateway__read"], "call", 0)), ["call1"]);
  assert.deepEqual(parser.withheldCalls, []);
});

test("several unavailable calls in one batch are withheld or corrected together", () => {
  const mixed = live();
  assert.deepEqual(forwarded(message(mixed, ["mcp__gateway__Grep", "mcp__gateway__read", "mcp__gateway__Glob"])), ["call1"]);
  assert.deepEqual(mixed.withheldCalls, ["call0", "call2"]);

  const corrected = live();
  assert.equal(message(corrected, ["mcp__gateway__Grep", "mcp__gateway__Glob"]).end, undefined);
  corrected.accept(result("call0", true)); corrected.accept(result("call1", true));
  assert.deepEqual(forwarded(message(corrected, ["mcp__gateway__read"], "fixed")), ["fixed0"]);
  const partial = live();
  message(partial, ["mcp__gateway__Grep", "mcp__gateway__Glob"]); partial.accept(result("call0", true));
  assert.throws(() => message(partial, ["mcp__gateway__read"], "fixed"), unavailable);
});

test("a withheld ID cannot be reused and foreign native tools still end the request", () => {
  assert.throws(() => message(live(["call0"]), ["mcp__gateway__read"]), unavailable);
  assert.throws(() => message(live(), ["mcp__gateway__read", "Bash"]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call");
});
