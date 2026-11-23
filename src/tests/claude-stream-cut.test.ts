import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeMessageStream } from "../providers/claude-stream.js";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeNativeToolName } from "../providers/claude-tool-names.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionRegistry } from "../providers/claude-session-registry.js";
import { ProviderError } from "../providers/provider.js";
import { providerFailureDiagnostic, streamFailureCode } from "../provider-failure.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { installClaudeFixture, type FixtureReply } from "./claude-cli-fixture.js";
import type { InferenceEvent, OpenAITool, ResponsesInputItem } from "../protocol/types.js";

const tools: OpenAITool[] = ["alpha", "beta"].map(name => ({ type: "function", function: { name, parameters: { type: "object", properties: {} }, responseTool: { type: "function", name } } }));
const [alpha, beta] = tools.map(claudeNativeToolName);
const event = (value: Record<string, unknown>) => ({ type: "stream_event", event: value });
const start = (id: string) => event({ type: "message_start", message: { id, usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } });
const text = (index: number, value: string) => event({ type: "content_block_delta", index, delta: { type: "text_delta", text: value } });
const use = (index: number, id: string, name: string, json = "") => [event({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } }),
  ...(json ? [event({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json } })] : [])];
const done = (id: string, name: string, input: unknown) => ({ type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id, name, input }] } });
// Captured from Claude Code 2.1.299 and 2.1.326: the marker is a sibling of `event`, in snake case.
const stopped = (from: unknown) => ({ ...event({ type: "message_stop" }), abandoned_blocks: { api_message_id: "msg_1", from_block_index: from } });
const notice = { type: "assistant", error: "server_error", is_api_error_message: true, api_error: "connection_failed",
  message: { id: "synthetic", model: "<synthetic>", content: [{ type: "text", text: "API Error: Connection lost mid-response." }] } };
const resumed = [start("msg_2"), text(0, "AFTER"), event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }), event({ type: "message_stop" }),
  { type: "result", subtype: "success", is_error: false, result: "AFTER" }];
const interrupted = (error: unknown) => error instanceof ProviderError && error.code === "upstream_unavailable" && error.status === 503 && error.upstream?.code === "stream_interrupted";
const live = () => { const stream = new ClaudeMessageStream({ tools, summaryVisible: true, nativeMcpOnly: true, allowToolCorrection: true }); stream.forwardFinishedCalls(); return stream; };

for (const [label, json] of [["partial arguments", "{\"path\":\"a"], ["no arguments yet", ""], ["arguments that happen to parse", "{\"path\":\"a\"}"]]) {
  test(`a cut call with ${label} is never forwarded and the CLI's own resumed reply completes`, () => {
    const stream = live();
    const steps = [start("msg_1"), text(0, "Now:"), ...use(1, "toolu_cut", alpha, json), stopped(1), ...resumed].map(message => stream.accept(message));
    assert.deepEqual(steps.flatMap(step => step.end ? [step.end.kind] : []), ["result"]);
    assert.deepEqual(steps.flatMap(step => step.events), [{ type: "text", text: "Now:" }, { type: "text", text: "\n\nAFTER" }]);
    assert.equal(steps.at(-1)!.end!.tokens.output, 3);
  });
}

test("a resumed reply may call the tool again, and only that call is forwarded", () => {
  const stream = live();
  const steps = [start("msg_1"), ...use(0, "toolu_cut", alpha, "{"), stopped(0), start("msg_2"), ...use(0, "toolu_new", alpha), done("toolu_new", alpha, { path: "a" }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } })].map(message => stream.accept(message));
  const end = steps.at(-1)!.end; assert.equal(end?.kind, "tool_use");
  assert.deepEqual(end.kind === "tool_use" && end.calls.map(call => [call.id, call.function.arguments]), [["toolu_new", "{\"path\":\"a\"}"]]);
  assert.equal(end.kind === "tool_use" && end.cut, undefined);
});

test("a finished call beside an unfinished one is forwarded alone", () => {
  const frames = [start("msg_1"), ...use(1, "toolu_done", alpha, "{\"path\":\"a\"}"), done("toolu_done", alpha, { path: "a" }), ...use(2, "toolu_cut", beta, "{\"path\":\"b")];
  const stream = live(); for (const frame of frames) assert.equal(stream.accept(frame).end, undefined);
  const end = stream.accept(stopped(2)).end;
  assert.deepEqual(end?.kind === "tool_use" && [end.cut, end.calls.map(call => [call.id, call.function.name, call.function.arguments])], [true, [["toolu_done", "alpha", "{\"path\":\"a\"}"]]]);
  // A session adopted from an older release would crash on the CLI's notice, so its request stays retryable instead.
  const older = new ClaudeMessageStream({ tools, summaryVisible: true, nativeMcpOnly: true, allowToolCorrection: true });
  for (const frame of frames) older.accept(frame);
  assert.throws(() => older.accept(stopped(2)), interrupted);
});

test("an unreadable marker trusts nothing in the cut message", () => {
  for (const from of [undefined, -1, "1", 1.5]) {
    const stream = live();
    for (const frame of [start("msg_1"), ...use(0, "toolu_done", alpha), done("toolu_done", alpha, {})]) stream.accept(frame);
    assert.equal(stream.accept(stopped(from)).end, undefined);
  }
});

test("an unavailable private name in a cut message leaves no rejection to wait for", () => {
  const stream = live();
  for (const frame of [start("msg_1"), ...use(0, "toolu_cut", "mcp__gateway__missing"), stopped(0)]) stream.accept(frame);
  assert.deepEqual(resumed.map(message => stream.accept(message).end?.kind).at(-1), "result");
});

test("only a failure to resume becomes retryable; other native failures keep their meaning", () => {
  const cut = () => { const stream = live(); for (const frame of [start("msg_1"), ...use(0, "toolu_cut", alpha, "{"), stopped(0)]) stream.accept(frame); return stream; };
  assert.throws(() => cut().accept(notice), interrupted);
  assert.throws(() => cut().accept({ type: "assistant", error: "authentication_failed", message: { content: [] } }), (error: unknown) => error instanceof ProviderError && error.code === "authentication");
  assert.throws(() => cut().accept({ type: "assistant", error: "billing_error", message: { content: [] } }), (error: unknown) => error instanceof ProviderError && error.code === "insufficient_quota");
  const later = cut(); later.accept(start("msg_2"));
  assert.throws(() => later.accept(notice), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "server_error", "a resumed message that fails without another cut is an ordinary outage");
  const uncut = live(); uncut.accept(start("msg_1")); for (const frame of use(0, "toolu_bad", alpha, "{")) uncut.accept(frame);
  assert.throws(() => uncut.accept(event({ type: "message_stop" })), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "malformed_tool_call", "a malformed call without the marker stays final");
});

test("Codex may retry the failure and diagnostics name it", () => {
  let failure: ProviderError | undefined;
  const stream = live(); for (const frame of [start("msg_1"), ...use(0, "toolu_cut", alpha, "{"), stopped(0)]) stream.accept(frame);
  try { stream.accept(notice); } catch (error) { failure = error as ProviderError; }
  assert.equal(streamFailureCode(failure!), "upstream_unavailable");
  const record = providerFailureDiagnostic({ requestId: "x", durationMs: 1, failure: failure! });
  assert.deepEqual([record.code, record.status, record.upstreamCode, record.upstreamEvent], ["upstream_unavailable", 503, "stream_interrupted", "claude.stream"]);
});

const user = (value: string): ResponsesInputItem => ({ role: "user", content: value });
const provider = (warmup: number, mode: "live" | "replay" = "live") => new ClaudeSubscription({ id: `stream-cut-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { warmup, mode } });
async function turn(subscription: ClaudeSubscription, input: ResponsesInputItem[], events: InferenceEvent[] = []) {
  const writer = new ResponsesWriter("fixture", () => {});
  for await (const item of subscription.infer({ model: "fixture", input, tools: ["read", "write"].map(name => ({ type: "function" as const, name, parameters: { type: "object", properties: {} } })) },
    new AbortController().signal, { threadId: "cut-chat" })) { events.push(item); writer.accept(item); }
  return writer.result().output as ResponsesInputItem[];
}
async function withFixture(replies: FixtureReply[], run: (fixture: Awaited<ReturnType<typeof installClaudeFixture>>) => Promise<void>) {
  const fixture = await installClaudeFixture({ replies });
  try { await run(fixture); } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
}
const names = (events: InferenceEvent[]) => events.flatMap(item => item.type === "tool" ? [item.call.function.name] : []);
const answered = (output: ResponsesInputItem[]): ResponsesInputItem[] => output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "caller result" }] : []);

test("a live chat cut while writing a call continues on the same CLI", { timeout: 30000 }, () => withFixture(
  [{ text: "The run finished.", cut: { tool: "read", json: "{\"path\":\"a" } }, { text: "RESUMED" }, { text: "NEXT" }], async fixture => {
    const subscription = provider(0), events: InferenceEvent[] = [], first = [user("first")];
    const output = await turn(subscription, first, events);
    assert.deepEqual(names(events), []); assert.ok(JSON.stringify(output).includes("RESUMED"));
    assert.ok(JSON.stringify(await turn(subscription, [...first, ...output, user("again")])).includes("NEXT"));
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 1, "no reseed, so the warm cache is kept");
  }));

test("a live chat forwards the finished call of a cut reply and survives the CLI's notice", { timeout: 30000 }, () => withFixture(
  [{ calls: [{ tool: "read", input: { path: "a" } }], cut: { tool: "write", json: "" } }, { text: "AFTER TOOL" }], async fixture => {
    const subscription = provider(0), events: InferenceEvent[] = [], first = [user("first")];
    const output = await turn(subscription, first, events);
    assert.deepEqual(names(events), ["read"]);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(sessionRegistry().replayUntil.size, 0);
    assert.ok(JSON.stringify(await turn(subscription, [...first, ...output, ...answered(output)])).includes("AFTER TOOL"));
    const capture = await fixture.capture();
    assert.equal(capture.filter(entry => entry.start).length, 1);
    assert.equal(capture.filter(entry => entry.toolResult !== undefined).length, 1);
  }));

test("a reply the CLI cannot resume fails retryable, without a hold, and the retry succeeds", { timeout: 30000 }, () => withFixture(
  [{ text: "Partial.", cut: { tool: "read", json: "{" }, cutGivesUp: true }, { text: "RETRIED" }], async fixture => {
    const subscription = provider(0), events: InferenceEvent[] = [];
    await assert.rejects(turn(subscription, [user("first")], events), interrupted);
    assert.deepEqual(names(events), []);
    assert.equal(sessionRegistry().replayUntil.size, 0); assert.equal(sessionRegistry().sessions.size, 0);
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 1, "the gateway itself never replays");
    assert.ok(JSON.stringify(await turn(subscription, [user("first")])).includes("RETRIED"));
  }));

test("a queued steering update is still never retried after a cut", { timeout: 30000 }, () => withFixture(
  [{ calls: [{ tool: "read", input: {} }] }, { cut: { tool: "write", json: "{" }, cutGivesUp: true }], async () => {
    const subscription = provider(0), first = [user("first")], output = await turn(subscription, first);
    await assert.rejects(turn(subscription, [...first, ...output, ...answered(output), user("steer")]),
      (error: unknown) => error instanceof ProviderError && error.code === "invalid_request" && error.upstream?.code === "steering_barrier_failed");
  }));

test("a one-shot request resumes, forwards finished calls and fails retryable the same way", { timeout: 30000 }, () => withFixture(
  [{ cut: { tool: "read", json: "" } }, { text: "RESUMED" }, { calls: [{ tool: "read", input: {} }], cut: { tool: "write", json: "{" } }, { cut: { tool: "read", json: "{" }, cutGivesUp: true }], async () => {
    const subscription = provider(0, "replay"), forwarded: InferenceEvent[] = [];
    assert.ok(JSON.stringify(await turn(subscription, [user("one")])).includes("RESUMED"));
    await turn(subscription, [user("two")], forwarded); assert.deepEqual(names(forwarded), ["read"]);
    await assert.rejects(turn(subscription, [user("three")]), interrupted);
  }));
