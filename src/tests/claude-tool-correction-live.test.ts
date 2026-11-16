import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionRegistry } from "../providers/claude-session-registry.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { installClaudeFixture, type FixtureReply } from "./claude-cli-fixture.js";
import type { InferenceEvent, ResponsesInputItem, OpenAIToolCall } from "../protocol/types.js";
import { ProviderError } from "../providers/provider.js";

const unknown: FixtureReply = { calls: [{ tool: "not_registered", input: {} }], nativeToolError: true };
const call: FixtureReply = { calls: [{ tool: "read", input: { synthetic: true } }] };
const user: ResponsesInputItem = { role: "user", content: "Use the synthetic caller tool" };
const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];
async function turn(provider: ClaudeSubscription, input: ResponsesInputItem[], events: InferenceEvent[] = []) {
  const writer = new ResponsesWriter("fixture", () => {});
  for await (const event of provider.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "same-chat" })) {
    events.push(event); writer.accept(event);
  }
  return writer.result().output as ResponsesInputItem[];
}
const output = (items: ResponsesInputItem[]): ResponsesInputItem[] => items.flatMap(item => item.type === "function_call"
  ? [{ type: "function_call_output", call_id: item.call_id, output: "Caller executed once" }] : []);

for (const earlier of [false, true]) test(`native tool correction ${earlier ? "after earlier caller execution" : "before first caller execution"} keeps one CLI and never repeats an output`, async () => {
  const fixture = await installClaudeFixture({ replies: [...(earlier ? [call] : []), unknown, call, { text: "DONE" }] });
  const provider = new ClaudeSubscription({ id: "correction", type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { warmup: 0 } });
  try {
    const history: ResponsesInputItem[] = [user]; let pid: number | undefined;
    if (earlier) { const prior = await turn(provider, history); history.push(...prior, ...output(prior)); pid = [...sessionRegistry().sessions.values()][0].pid; }
    const events: InferenceEvent[] = [];
    const corrected = await turn(provider, history, events);
    const calls = events.filter((event): event is { type: "tool"; call: OpenAIToolCall } => event.type === "tool");
    assert.equal(calls.length, 1); assert.equal(calls[0].call.function.name, "read");
    const done = events.find(event => event.type === "done"); assert.equal(done?.usage?.input_tokens, 226);
    assert.equal([...sessionRegistry().sessions.values()][0].pid, pid ?? [...sessionRegistry().sessions.values()][0].pid);
    const final = await turn(provider, [...history, ...corrected, ...output(corrected)]);
    assert.ok(JSON.stringify(final).includes("DONE"));
    const capture = await fixture.capture();
    assert.equal(capture.filter(entry => entry.start).length, 1);
    assert.equal(capture.filter(entry => entry.user !== undefined).length, 1, "no new caller prompt was sent to correct the tool");
    assert.equal(capture.filter(entry => entry.toolResult !== undefined).length, earlier ? 2 : 1);
    assert.equal(sessionRegistry().replayUntil.size, 0);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});

test("native correction does not bypass an explicit forced tool selection", async () => {
  const fixture = await installClaudeFixture({ replies: [unknown, { calls: [{ tool: "other", input: {} }] }] });
  const provider = new ClaudeSubscription({ id: "forced-correction", type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { warmup: 0 } });
  const events: InferenceEvent[] = [];
  try {
    await assert.rejects(async () => {
      for await (const event of provider.infer({ model: "fixture", input: [user], tools: [...tools, { type: "function", name: "other" }],
        tool_choice: { type: "function", name: "read" } }, new AbortController().signal, { threadId: "forced" })) events.push(event);
    }, (error: unknown) => error instanceof ProviderError && error.upstream?.code === "forced_tool_mismatch");
    assert.equal(events.some(event => event.type === "tool"), false);
    assert.equal((await fixture.capture()).filter(entry => entry.toolResult !== undefined).length, 0);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});
