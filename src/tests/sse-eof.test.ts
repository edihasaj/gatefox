import test from "node:test";
import assert from "node:assert/strict";
import { readEvents } from "../protocol/sse.js";
import { ProviderError } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";

async function consume(parts: Uint8Array[]): Promise<void> {
  async function* bytes() { yield* parts; }
  for await (const _ of readEvents(bytes())) { /* Consume only complete frames. */ }
}
test("EOF in a UTF-8 character is retryable truncation without exposing its partial payload", async () => {
  const privatePrefix = Buffer.from('data: {"type":"response.output_text.delta","delta":"private-fixture');
  await assert.rejects(consume([privatePrefix, Buffer.from([0xf0, 0x9f])]), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, "incomplete"); assert.equal(error.upstream?.code, "truncated_frame");
    assert.equal(streamFailureCode(error), "incomplete"); assert.equal(error.message.includes("private-fixture"), false);
    return true;
  });
});
test("invalid UTF-8 inside a received stream remains a permanent protocol error", async () => {
  await assert.rejects(consume([Buffer.from([0xff])]), (error: unknown) => {
    assert.ok(error instanceof ProviderError); assert.equal(error.code, "invalid_stream");
    assert.equal(streamFailureCode(error), "invalid_prompt"); return true;
  });
});
