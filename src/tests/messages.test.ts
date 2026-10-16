import test from "node:test";
import assert from "node:assert/strict";
import { anthropicError, MessagesWriter } from "../protocol/messages.js";
import type { WireEvent } from "../protocol/types.js";

test("Messages writer emits native text and tool stream with cached usage accounting", () => {
  const events: WireEvent[] = []; const writer = new MessagesWriter("alias", event => events.push(event));
  writer.begin(); writer.accept({ type: "text", text: "Checking" });
  writer.accept({ type: "tool", call: { type: "function", id: "call_1", function: { name: "lookup", arguments: '{"value":7}' } } });
  writer.accept({ type: "done", usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 2, cache_creation_tokens: 3 } } });
  assert.deepEqual(events.map(event => event.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal((events.at(-2)!.delta as any).stop_reason, "tool_use");
  assert.deepEqual(events.at(-2)!.usage, { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 });
  assert.deepEqual(writer.result().usage, { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 });
  assert.deepEqual((writer.result().content as any[])[1], { type: "tool_use", id: "call_1", name: "lookup", input: { value: 7 } });
});

test("Messages writer cannot turn incomplete output into a successful completion", () => {
  const events: WireEvent[] = []; const writer = new MessagesWriter("alias", event => events.push(event)); writer.begin();
  assert.throws(() => writer.accept({ type: "done", endTurn: false, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }));
  writer.fail("usage_limit", "Limit reached"); assert.equal(events.at(-1)!.type, "error"); assert.equal((events.at(-1)!.error as any).type, "rate_limit_error");
  assert.equal(events.some(event => event.type === "message_stop"), false);
  assert.equal(anthropicError("request_too_large", "Too large", 413).error.type, "request_too_large");
  assert.equal(anthropicError("cross_origin", "Blocked", 403).error.type, "permission_error");
  assert.equal(anthropicError("timeout", "Timed out", 504).error.type, "timeout_error");
  assert.equal(anthropicError("invalid_tool_call", "Upstream call", 502).error.type, "api_error");
});
