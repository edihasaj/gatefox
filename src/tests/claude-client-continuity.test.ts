import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { claudeMcpCatalog } from "../providers/claude-control.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { messagesToResponses } from "../protocol/messages-request.js";
import { inferenceContext } from "../providers/provider.js";
import { configureTelemetry, flushTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import { ProviderError } from "../providers/provider.js";
import type { ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

const user = (content: string): ResponsesInputItem => ({ type: "message", role: "user", content });
const tools = ["read", "write"].map(name => ({ type: "function" as const, name, parameters: { type: "object", properties: {} } }));

test("session-only clients keep one CLI through warmup, reordered tools, tool results and follow-up", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: [{ text: "Warmup" }, { calls: [{ tool: "read", input: {} }] }, { text: "Done" }, { text: "Follow-up" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `session-only-${process.pid}`, type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live", warmup: 1 } });
  const turn = async (input: ResponsesInputItem[], reversed = false) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools: reversed ? [...tools].reverse() : tools }, new AbortController().signal, { sessionId: "client-session" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    const first = [user("Start")], a = await turn(first);
    const second = [...first, ...a, user("Read")], b = await turn(second, true);
    const complete = [...second, ...b, ...b.flatMap(item => item.type === "function_call"
      ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "exact result" }] : [])];
    const c = await turn(complete);
    await turn([...complete, ...c, user("Follow-up")], true);
    const capture = await fixture.capture();
    assert.deepEqual(capture.filter(row => row.start).map(row => row.start), ["oneshot", "live"]);
    assert.deepEqual(capture.filter(row => row.toolResult !== undefined).map(row => row.toolResult), ["exact result"]);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});

test("native Messages caller-owned compaction replaces history without synthetic request-kind or window headers", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "First" }, { text: "Second" }, { text: "Summary" }, { text: "After compaction" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `native-metadata-${process.pid}`, type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const metadata = { user_id: JSON.stringify({ device_id: "device", account_uuid: "", session_id: "019a1234-5678-7890-abcd-0123456789ab" }) };
  const turn = async (request: ResponsesRequest) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer(request, new AbortController().signal, { ...inferenceContext({}, request), clientProtocol: "messages" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    const first = messagesToResponses({ model: "fixture", max_tokens: 32, metadata, messages: [{ role: "user", content: "Start" }] });
    await turn(first);
    const second = messagesToResponses({ model: "fixture", max_tokens: 32, metadata, messages: [
      { role: "user", content: "Start" }, { role: "assistant", content: "First" }, { role: "user", content: "Next" }] });
    await turn(second);
    // Observed native /compact: edit the prior user and omit the latest assistant;
    // the wire request supplies no explicit compaction kind or window identifier.
    await turn(messagesToResponses({ model: "fixture", max_tokens: 32, metadata, messages: [
      { role: "user", content: "Start" }, { role: "assistant", content: "First" },
      { role: "user", content: [{ type: "text", text: "Next\n" }, { type: "text", text: "Summarize the conversation" }] }] }));
    await turn(messagesToResponses({ model: "fixture", max_tokens: 32, metadata, messages: [{ role: "user", content: "Compacted history" }] }));
    assert.deepEqual((await fixture.capture()).filter(row => row.start).map(row => row.start), ["live", "live", "live"]);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});

for (const mode of ["pending-tools", "cache-budget"] as const) test(`native history replacement preserves ${mode} safety`, { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: mode === "pending-tools"
    ? [{ calls: [{ tool: "read", input: {} }] }, { text: "Must not run" }]
    : [{ text: "First" }, { text: "Second" }, { text: "Must not run" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `native-safety-${mode}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const metadata = { user_id: JSON.stringify({ device_id: "device", account_uuid: "", session_id: "019a1234-5678-7890-abcd-0123456789ab" }) };
  const turn = async (text: string) => {
    const request = messagesToResponses({ model: "fixture", max_tokens: 32, metadata,
      tools: mode === "pending-tools" ? [{ name: "read", input_schema: { type: "object", properties: {} } }] : [], messages: [{ role: "user", content: text }] });
    for await (const _ of provider.infer(request, new AbortController().signal, { ...inferenceContext({}, request), clientProtocol: "messages" })) {}
  };
  try {
    await turn(mode === "cache-budget" ? "a".repeat(300000) : "Read");
    if (mode === "cache-budget") await turn("b".repeat(300000));
    await assert.rejects(turn(mode === "cache-budget" ? "c".repeat(300000) : "Replace pending history"),
      (error: unknown) => error instanceof ProviderError && error.status === 400);
    assert.equal((await fixture.capture()).filter(row => row.start).length, mode === "cache-budget" ? 2 : 1);
    assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions().length, 1, "a rejected replacement retains the existing session");
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});

test("equivalent catalogs have stable native bytes while schema meaning and array order remain exact", () => {
  const one = [{ function: { name: "tool", parameters: { type: "object", properties: { b: { enum: ["b", "a"] }, a: { type: "string" } } } }, type: "function" as const }];
  const two = [{ function: { name: "tool", parameters: { properties: { a: { type: "string" }, b: { enum: ["b", "a"] } }, type: "object" } }, type: "function" as const }];
  const original = JSON.stringify(one);
  assert.equal(JSON.stringify(claudeMcpCatalog(one)), JSON.stringify(claudeMcpCatalog(two)));
  assert.equal(JSON.stringify(one), original);
  assert.notEqual(JSON.stringify(claudeMcpCatalog(two)), JSON.stringify(claudeMcpCatalog([{ ...two[0], function: { ...two[0].function, parameters: { type: "object", properties: { b: { enum: ["a", "b"] } } } } }])));
});

test("an equal raw session and thread ID never share a Claude provider process", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "Session" }, { text: "Thread" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `identity-isolation-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  try {
    for (const context of [{ sessionId: "same" }, { threadId: "same" }]) for await (const _ of provider.infer({ model: "fixture", input: "Hello" }, new AbortController().signal, context)) {}
    assert.equal((await fixture.capture()).filter(row => row.start === "live").length, 2);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});
