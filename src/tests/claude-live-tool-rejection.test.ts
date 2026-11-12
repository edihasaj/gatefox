import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionRegistry } from "../providers/claude-session-registry.js";
import { ProviderError } from "../providers/provider.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { InferenceEvent, ResponsesInputItem } from "../protocol/types.js";
import { rejectedClaudeTool } from "../providers/claude-calls.js";

const user = (text: string): ResponsesInputItem => ({ role: "user", content: text });
const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];
const provider = () => new ClaudeSubscription({ id: `tool-rejection-${process.pid}`, type: "claude-subscription",
  models: { fixture: "fixture" }, claudeSessions: { warmup: 0 } });

test("older error classes normalize fixed tool-name failures without trusting prose or getters", () => {
  const legacy = Object.assign(new Error("private old error text"), { code: "invalid_tool_call", status: 502,
    upstream: { code: "unknown_tool", event: "claude.tool_use" } });
  const normalized = rejectedClaudeTool(legacy);
  assert.ok(normalized instanceof ProviderError);
  assert.equal(normalized.upstream?.code, "unknown_tool");
  assert.equal(normalized.message.includes("private"), false);
  assert.equal(rejectedClaudeTool(Object.assign(new Error("crash"), { code: "cli_failed" })), undefined);
  assert.equal(rejectedClaudeTool(Object.assign(new Error("other"), { code: "invalid_tool_call", upstream: { code: "unknown_tool", event: "other" } })), undefined);
  let reads = 0;
  const getter = Object.defineProperty(new Error("private"), "upstream", { get() { reads++; throw Error("must not read"); } });
  assert.equal(rejectedClaudeTool(getter), undefined);
  assert.equal(reads, 0);
});

async function turn(subscription: ClaudeSubscription, input: ResponsesInputItem[], events: InferenceEvent[] = []) {
  const writer = new ResponsesWriter("fixture", () => {});
  for await (const event of subscription.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "same-chat" })) {
    events.push(event); writer.accept(event);
  }
  return writer.result().output as ResponsesInputItem[];
}

for (const [foreign, reason] of [["unregistered-private-tool", "unknown_tool"], ["mcp__gateway__missing", "unavailable_gateway_tool"], ["Bash", "native_builtin_tool"]]) {
  test(`a controlled ${reason} stop permits only a later caller request`, { timeout: 30000 }, async () => {
    const fixture = await installClaudeFixture({ replies: [{ foreign }, { text: "RECOVERED" }] });
    try {
      const subscription = provider(), events: InferenceEvent[] = [];
      await assert.rejects(turn(subscription, [user("first")], events),
        (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call" && error.upstream?.code === reason);
      assert.equal(events.some(event => event.type === "tool"), false);
      assert.equal((await fixture.capture()).filter(entry => entry.start).length, 1, "the failed request never replays itself");
      assert.equal(sessionRegistry().sessions.size, 0);
      assert.equal(sessionRegistry().replayUntil.size, 0, "a deliberate confinement stop is not a CLI crash");
      const recovered = await turn(subscription, [user("first"), user("try again")]);
      assert.ok(JSON.stringify(recovered).includes("RECOVERED"));
      assert.equal((await fixture.capture()).filter(entry => entry.start).length, 2);
    } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
  });
}

test("recovery after a rejected tool does not repeat an earlier caller tool result", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] },
    { foreign: "unregistered-private-tool" }, { text: "RECOVERED" }] });
  try {
    const subscription = provider(), first = [user("read")];
    const output = await turn(subscription, first);
    const results: ResponsesInputItem[] = output.flatMap(item => item.type === "function_call"
      ? [{ type: "function_call_output", call_id: item.call_id, output: "caller already executed this once" }] : []);
    const history = [...first, ...output, ...results], events: InferenceEvent[] = [];
    await assert.rejects(turn(subscription, history, events), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "unknown_tool");
    assert.equal(events.some(event => event.type === "tool"), false);
    await turn(subscription, [...history, user("continue")]);
    const capture = await fixture.capture();
    assert.equal(capture.filter(entry => entry.toolResult !== undefined).length, 1);
    assert.equal(capture.filter(entry => entry.start).length, 2);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});

test("an unsolicited tool between requests remains a protocol crash with a hold", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "FIRST" }, { text: "MUST NOT RUN" }] });
  try {
    const subscription = provider(); await turn(subscription, [user("first")]);
    const session = [...sessionRegistry().sessions.values()][0];
    const reader = session as unknown as { line(line: string): void };
    reader.line(JSON.stringify({ type: "stream_event", event: { type: "content_block_start",
      content_block: { type: "tool_use", id: "unsolicited", name: "unregistered-private-tool", input: {} } } }));
    assert.equal(sessionRegistry().replayUntil.size, 1);
    await assert.rejects(turn(subscription, [user("first"), user("continue")]),
      (error: unknown) => error instanceof ProviderError && error.upstream?.code === "session_continuity_unavailable");
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 1);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});
