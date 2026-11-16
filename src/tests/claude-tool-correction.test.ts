import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChatRequest } from "../protocol/request.js";
import { ClaudeMessageStream, type ClaudeStreamStep } from "../providers/claude-stream.js";
import { ProviderError } from "../providers/provider.js";
import { toolCorrectionLimits } from "../providers/claude-tool-correction.js";
import { shortFolder } from "./short-folder.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

const tools = responsesToChatRequest({ model: "fixture", input: "fixture", tools: [{ type: "function", name: "read" }] }).tools!;
const stream = () => new ClaudeMessageStream({ tools, summaryVisible: true, nativeMcpOnly: true, allowToolCorrection: true });
const usage = { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 2, output_tokens: 5 };
const frame = (event: Record<string, unknown>) => ({ type: "stream_event", event });
function message(parser: ClaudeMessageStream, names: string[], id = "call"): ClaudeStreamStep {
  parser.accept(frame({ type: "message_start", message: { id: "msg_" + id, usage } }));
  for (const [index, name] of names.entries()) {
    const call = { type: "tool_use", id: id + index, name, input: {} };
    parser.accept(frame({ type: "content_block_start", index, content_block: call }));
    parser.accept({ type: "assistant", message: { id: "msg_" + id, content: [call] } });
  }
  const step = parser.accept(frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage }));
  parser.accept(frame({ type: "message_stop" }));
  return step;
}
const errorResult = (id = "call0", extra = {}) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, ...extra }] } });
const unavailable = (error: unknown) => error instanceof ProviderError && error.upstream?.code === "unavailable_gateway_tool";

test("native rejection permits a corrected tool in the same stream, accounting for both model calls", () => {
  const parser = stream();
  const bad = message(parser, ["mcp__gateway__missing"]);
  assert.equal(bad.end, undefined); assert.deepEqual(bad.events, []);
  assert.deepEqual(parser.observedTokens, { input: 3, cacheRead: 10, cacheWrite: 2, output: 5 });
  parser.accept(errorResult());
  const good = message(parser, ["mcp__gateway__read"], "fixed");
  assert.equal(good.end?.kind, "tool_use");
  if (good.end?.kind !== "tool_use") assert.fail();
  assert.equal(good.end.calls.length, 1); assert.equal(good.end.calls[0].function.name, "read");
  assert.deepEqual(good.end.tokens, { input: 6, cacheRead: 20, cacheWrite: 4, output: 10 });
  assert.equal(good.end.usage.input_tokens, 30);
});

test("missing, mismatched or successful tool feedback never authorizes correction", () => {
  for (const feedback of [undefined, errorResult("wrong"), errorResult("call0", { is_error: false })]) {
    const parser = stream(); message(parser, ["mcp__gateway__missing"]);
    assert.throws(() => { if (feedback) parser.accept(feedback); message(parser, ["mcp__gateway__read"], "fixed"); }, unavailable);
  }
  const parser = stream();
  parser.accept(frame({ type: "message_start", message: { id: "m", usage } }));
  parser.accept(frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call0", name: "mcp__gateway__missing" } }));
  parser.accept(errorResult());
  assert.throws(() => parser.accept(frame({ type: "message_start", message: { id: "too_early", usage } })), unavailable);
});

test("two corrections are bounded and cannot reuse a rejected call ID", () => {
  const parser = stream();
  for (let i = 0; i < toolCorrectionLimits.attempts; i++) { message(parser, ["mcp__gateway__missing"], "bad" + i); parser.accept(errorResult("bad" + i + "0")); }
  assert.throws(() => message(parser, ["mcp__gateway__missing"], "too_many"), unavailable);
  const reused = stream(); message(reused, ["mcp__gateway__missing"]); reused.accept(errorResult());
  assert.throws(() => message(reused, ["mcp__gateway__read"]), unavailable);
});

test("mixed calls, native tools, aliases and malformed identities stay final", () => {
  for (const names of [["mcp__gateway__missing", "mcp__gateway__read"], ["mcp__gateway__read", "mcp__gateway__missing"],
    ["mcp__gateway__missing", "mcp__gateway__other"]]) assert.throws(() => message(stream(), names), unavailable);
  for (const name of ["Bash", "Read", "ToolSearch", "read", "functions.read", "mcp__foreign__read", "mcp__gateway__bad.name"])
    assert.throws(() => message(stream(), [name]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call");
  const parser = stream(); parser.accept(frame({ type: "message_start", message: { id: "m", usage } }));
  assert.throws(() => parser.accept(frame({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "mcp__gateway__missing" } })), unavailable);
});

test("native refusals and cancellation still win during correction; waiting is bounded", async () => {
  const parser = stream(); message(parser, ["mcp__gateway__missing"]);
  assert.throws(() => parser.accept({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Not logged in" }] } }),
    (error: unknown) => error instanceof ProviderError && error.code === "authentication");
  const saved = toolCorrectionLimits.rejectionMs; toolCorrectionLimits.rejectionMs = 5;
  try {
    const waiting = stream(); message(waiting, ["mcp__gateway__missing"]);
    await assert.rejects(waiting.waitForNativeFrame(new Promise(() => {})), unavailable);
    const cancelled = stream(); message(cancelled, ["mcp__gateway__missing"]);
    const error = new ProviderError("cancelled", "cancelled", 499);
    await assert.rejects(cancelled.waitForNativeFrame(Promise.reject(error)), value => value === error);
  } finally { toolCorrectionLimits.rejectionMs = saved; }
});

test("duplicate assistant snapshots do not double count a rejected model call", () => {
  const parser = stream(); message(parser, ["mcp__gateway__missing"]);
  parser.accept({ type: "assistant", message: { content: [{ type: "tool_use", id: "call0", name: "mcp__gateway__missing", input: {} }] } });
  parser.accept(errorResult());
  const result = message(parser, ["mcp__gateway__read"], "fixed");
  assert.equal(result.end?.tokens.output, 10);
});

test("the CLI may print the rejection before the rejected message's final usage", () => {
  const parser = stream();
  parser.accept(frame({ type: "message_start", message: { id: "bad", usage } }));
  const use = { type: "tool_use", id: "call0", name: "mcp__gateway__missing", input: {} };
  parser.accept(frame({ type: "content_block_start", index: 0, content_block: use }));
  parser.accept(errorResult());
  parser.accept({ type: "assistant", message: { id: "bad", content: [use] } });
  assert.equal(parser.accept(frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage })).end, undefined);
  const result = message(parser, ["mcp__gateway__read"], "corrected");
  assert.equal(result.end?.tokens.output, 10);
});

test("unknown tools can be corrected into text without duplicating earlier visible output", () => {
  const parser = stream();
  parser.accept(frame({ type: "message_start", message: { id: "bad", usage } }));
  const first = parser.accept(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking." } }));
  const use = { type: "tool_use", id: "call0", name: "mcp__gateway__missing", input: {} };
  parser.accept(frame({ type: "content_block_start", index: 1, content_block: use }));
  parser.accept({ type: "assistant", message: { id: "bad", content: [use] } });
  parser.accept(frame({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage }));
  parser.accept(errorResult());
  parser.accept(frame({ type: "message_start", message: { id: "fixed", usage } }));
  const last = parser.accept(frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }));
  parser.accept(frame({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage }));
  assert.throws(() => parser.accept({ type: "result", subtype: "success", result: "different text", usage }), /differs from streamed text/);
  const result = parser.accept({ type: "result", subtype: "success", result: "Done.", usage });
  assert.equal(result.end?.kind, "result"); assert.equal(result.end?.tokens.output, 10);
  assert.equal([...first.events, ...last.events].filter(event => event.type === "text").map(event => event.text).join(""), "Checking.\n\nDone.");
});

test("correction telemetry retains fixed outcomes and counts, never names, call IDs, arguments or native diagnostic prose", async () => {
  const f = await shortFolder("gwtc-"); configureTelemetry(f.directory, "test");
  try {
    const parser = stream(); message(parser, ["mcp__gateway__private_name"], "private_id");
    parser.accept({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "private_id0", is_error: true,
      content: "private provider diagnostic prose" }] } });
    message(parser, ["mcp__gateway__read"], "fixed");
    await flushTelemetry();
    const events = (await readTelemetry(f.directory, 0)).filter(event => event.event === "claude_tool_correction");
    assert.ok(events.some(event => event.outcome === "recovered"));
    for (const secret of ["private_name", "private_id", "diagnostic prose"]) assert.ok(!JSON.stringify(events).includes(secret));
  } finally { await flushTelemetry(); await f.remove(); }
});
