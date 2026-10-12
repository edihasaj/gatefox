import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ResponsesAPI } from "../providers/responses-api.js";
import { responsesEOFError } from "../providers/responses-errors.js";
import { ResponsesWriter } from "../protocol/responses.js";
import type { InferenceEvent, ResponsesRequest, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 1, output_tokens: 2, total_tokens: 3 };
const message = (text: string, status = "incomplete") => ({ type: "message", id: "msg_fixture", role: "assistant", phase: "commentary", status, content: [{ type: "output_text", text }] });
const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "inspect", arguments: "{}", status: "completed" };
const done = (item: unknown) => ({ type: "response.output_item.done", item });
const complete = (response: Record<string, unknown> = {}) => ({ type: "response.completed", response: { id: "resp_fixture", status: "completed", usage, ...response } });
const interrupted = (response: Record<string, unknown> = {}) => ({ type: "response.incomplete", response: { id: "resp_fixture", status: "incomplete", incomplete_details: { reason: "interrupted" }, usage, ...response } });
const delta = { type: "response.output_text.delta", item_id: "msg_fixture", content_index: 0, delta: "partial 🌲" };
const reasoning = { type: "response.output_item.added", item: { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-only" } };

async function fixture(frames: (attempt: number) => unknown[], options: { raw?: string; requestId?: string } = {}) {
  let attempts = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _ of request) { /* Discard the fixture request, never log its body. */ }
    response.writeHead(200, { "Content-Type": "text/event-stream", ...(options.requestId ? { "x-request-id": options.requestId } : {}) });
    const bytes = Buffer.from(frames(++attempts).map(frame => `data: ${JSON.stringify(frame)}\r\n\r\n`).join("") + (options.raw || ""));
    // Exercise genuine chunked HTTP and UTF-8 spanning transport chunks.
    for (let offset = 0; offset < bytes.length; offset += 7) response.write(bytes.subarray(offset, offset + 7));
    response.end();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const key = "GATEWAY_TERMINALS_FIXTURE_KEY"; assert.equal(Object.hasOwn(process.env, key), false); process.env[key] = "fixture-only";
  const provider = new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: key, baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, models: { fixture: "fixture" } });
  return { provider, attempts: () => attempts, close: async () => { delete process.env[key]; upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); } };
}
async function collect(provider: ResponsesAPI, options: Partial<ResponsesRequest> = {}, signal = new AbortController().signal) {
  const events: InferenceEvent[] = []; const wire: WireEvent[] = []; const writer = new ResponsesWriter("fixture", frame => wire.push(frame)); writer.begin();
  let error: unknown;
  try { for await (const event of provider.infer({ model: "fixture", input: "fixture", tools: [{ type: "function", name: "inspect" }], ...options }, signal)) { events.push(event); writer.accept(event); } }
  catch (failure) { error = failure; }
  return { events, wire, result: writer.result(), error: error as Error & { code?: string; upstream?: Record<string, unknown> } | undefined };
}

test("interrupted terminal retains actual incomplete message and response metadata", async () => {
  for (const earlierBoundary of [false, true]) {
    const actual = message("partial 🌲 suffix");
    const f = await fixture(() => [delta, ...(earlierBoundary ? [done(actual)] : []), interrupted({ output: [actual], end_turn: true })]);
    try {
      const result = await collect(f.provider); assert.equal(result.error, undefined); assert.equal(f.attempts(), 1);
      assert.equal(result.result.status, "incomplete"); assert.deepEqual(result.result.incomplete_details, { reason: "interrupted" });
      assert.equal(result.result.end_turn, false, "the SDK derives continuation from actual interruption, even if upstream end_turn conflicts");
      assert.equal(result.result.output_text, "partial 🌲 suffix");
      const output = result.result.output as Record<string, unknown>[]; assert.equal(output.length, 1); assert.equal(output[0].status, "incomplete");
      assert.equal(result.wire.filter(frame => frame.type === "response.completed").length, 0);
      assert.equal(result.wire.filter(frame => frame.type === "response.incomplete").length, 1);
      assert.equal(result.wire.filter(frame => frame.type === "response.output_item.done").length, 1);
    } finally { await f.close(); }
  }
});

test("only completed tool boundaries dispatch; interrupted partial calls never execute or replay", async () => {
  for (const partialStatus of [undefined, "incomplete", "in_progress"]) {
    const partial = { ...call, id: "fc_partial", call_id: "call_partial", status: partialStatus, arguments: '{"unfinished":' };
    const f = await fixture(() => [done(call), ...(partialStatus === undefined ? [] : [done(partial)]), interrupted({ output: [call, partial] })]);
    try {
      const result = await collect(f.provider); assert.equal(result.error, undefined); assert.equal(f.attempts(), 1);
      assert.equal(result.events.filter(event => event.type === "tool").length, 1);
      const output = result.result.output as Record<string, unknown>[]; assert.equal(output.length, 1); assert.equal(output[0].call_id, "call_fixture");
      assert.equal(result.result.status, "incomplete");
    } finally { await f.close(); }
  }
  const malformed = await fixture(() => [done({ ...call, arguments: '{"unfinished":' }), interrupted()]);
  try { const result = await collect(malformed.provider); assert.equal(result.error?.code, "invalid_tool_call"); assert.equal(result.events.filter(event => event.type === "tool").length, 0); assert.equal(malformed.attempts(), 1); }
  finally { await malformed.close(); }
});

test("minimal genuine completed event requires an identity while legacy explicit completed status remains compatible", async () => {
  for (const response of [{ id: "resp_minimal" }, { status: "completed" }]) {
    const f = await fixture(() => [{ type: "response.completed", response }]);
    try { const result = await collect(f.provider); assert.equal(result.error, undefined); assert.equal(result.result.status, "completed"); }
    finally { await f.close(); }
  }
  for (const response of [{}, { id: null }, { id: "" }, { id: "resp_bad", status: "in_progress" }, { id: "resp_bad", status: "failed" }]) {
    const f = await fixture(() => [{ type: "response.completed", response }]);
    try { const result = await collect(f.provider); assert.ok(result.error); assert.equal(result.events.filter(event => event.type === "done").length, 0); assert.equal(f.attempts(), 1); }
    finally { await f.close(); }
  }
});

test("completed terminals reject unfinished calls until the same call genuinely completes", async () => {
  const partial = { ...call, arguments: '{"value":', status: "incomplete" };
  for (const frames of [[complete({ output: [partial] })], [done(partial), complete()], [done(partial), complete({ output: [] })],
    [done({ ...partial, call_id: "" }), interrupted()], [done({ ...partial, call_id: undefined }), interrupted()]]) {
    const f = await fixture(() => frames);
    try { const result = await collect(f.provider); assert.equal(result.error?.code, "invalid_tool_call"); assert.equal(result.events.filter(event => event.type === "done").length, 0); assert.equal(result.events.filter(event => event.type === "tool").length, 0); assert.equal(f.attempts(), 1); }
    finally { await f.close(); }
  }
  const finished = { ...call, arguments: '{"value":1}' };
  for (const frames of [[done(partial), done(finished), complete({ output: [finished] })], [done(partial), complete({ output: [finished] })]]) {
    const f = await fixture(() => frames);
    try { const result = await collect(f.provider); assert.equal(result.error, undefined); assert.equal(result.result.status, "completed"); assert.equal(result.events.filter(event => event.type === "tool").length, 1); assert.equal(f.attempts(), 1); }
    finally { await f.close(); }
  }
  const changed = await fixture(() => [done(partial), complete({ output: [{ ...finished, arguments: '{"other":1}' }] })]);
  try { const result = await collect(changed.provider); assert.equal(result.error?.code, "invalid_tool_call"); assert.equal(result.events.filter(event => event.type === "tool").length, 0); }
  finally { await changed.close(); }
});

test("other incomplete reasons and declared errors cannot become successful continuation", async () => {
  for (const response of [
    { id: "resp", incomplete_details: { reason: "max_output_tokens" } },
    { id: "resp", incomplete_details: { reason: "content_filter" } },
    { id: "resp", incomplete_details: { reason: "unknown" } },
    { id: "resp", status: "failed", incomplete_details: { reason: "interrupted" } },
    { id: "resp", incomplete_details: { reason: "interrupted" }, error: { code: "insufficient_quota", message: "private fixture message" } },
  ]) {
    const f = await fixture(() => [done(message("partial")), { type: "response.incomplete", response }]);
    try { const result = await collect(f.provider); assert.ok(result.error); assert.equal(result.events.filter(event => event.type === "done").length, 0); assert.equal(f.attempts(), 1); assert.ok(!result.error.message.includes("private fixture message")); }
    finally { await f.close(); }
  }
});

test("bounded pre-output EOF retries once and recovers only through a real terminal", async () => {
  const f = await fixture(attempt => attempt === 1 ? [] : [complete()]);
  try { const result = await collect(f.provider); assert.equal(result.error, undefined); assert.equal(f.attempts(), 2); assert.equal(result.events.filter(event => event.type === "done").length, 1); }
  finally { await f.close(); }
});

test("persistent pre-output EOF exhausts one retry without a fake completion", async () => {
  const f = await fixture(() => []);
  try { const result = await collect(f.provider); assert.equal(f.attempts(), 2); assert.equal(result.error?.message, "Provider stream ended without completion"); assert.equal(result.events.filter(event => event.type === "done").length, 0); }
  finally { await f.close(); }
});

test("reasoning, text, completed tools, or message boundaries prevent EOF retries", async () => {
  for (const frames of [[reasoning], [delta], [done(call)], [done(message("", "completed"))]]) {
    const f = await fixture(() => frames, { requestId: "req_fixture" });
    try {
      const result = await collect(f.provider); assert.equal(f.attempts(), 1); assert.equal(result.error?.code, "incomplete");
      assert.equal(result.error?.message, "Provider stream ended without completion"); assert.equal(result.events.filter(event => event.type === "done").length, 0);
      assert.equal(result.error?.upstream?.event, "eof"); assert.equal(result.error?.upstream?.code, "missing_terminal"); assert.equal(result.error?.upstream?.requestId, "req_fixture");
    } finally { await f.close(); }
  }
});

test("cancellation during EOF recovery backoff prevents another provider request", async () => {
  const f = await fixture(() => []); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
  try { const result = await collect(f.provider, {}, controller.signal); assert.ok(result.error); assert.equal(f.attempts(), 1); }
  finally { clearTimeout(timer); await f.close(); }
});

test("malformed final SSE framing is not an eligible clean EOF", async () => {
  const f = await fixture(() => [], { raw: 'data: {"type":"response.completed"}' });
  try { const result = await collect(f.provider); assert.ok(result.error?.message.includes("incomplete frame")); assert.equal(f.attempts(), 1); }
  finally { await f.close(); }
});

test("EOF diagnostics keep only bounded counters, allowlisted event kinds, and validated request IDs", () => {
  const failure = responsesEOFError({ events: Infinity, lastEvent: "private prompt type", reasoningItems: -2, textDeltas: 1.5, toolCalls: 2000000 }, "private request value with spaces");
  assert.deepEqual(failure.upstream, { code: "missing_terminal", event: "eof", stream: { events: 0, lastEvent: "unknown", reasoningItems: 0, textDeltas: 1, toolCalls: 1000000 } });
  assert.ok(!JSON.stringify(failure).includes("private"));
});
