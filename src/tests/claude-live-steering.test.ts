import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { ResponsesInputItem } from "../protocol/types.js";

const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: text });
const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];

test("tool results followed by user and developer updates reseed once and resume live tool continuation", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [
    { calls: [{ tool: "read", input: {} }] },
    { text: "Updated", calls: [{ tool: "read", input: {} }] },
    { text: "Finished" },
  ] });
  configureTelemetry(fixture.directory, "test");
  const since = Date.now();
  const provider = new ClaudeSubscription({ id: `steering-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[]) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "steered" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  const results = (output: ResponsesInputItem[]) => output.flatMap(item => item.type === "function_call"
    ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "tool result" }] : []);
  try {
    const first = [user("Start")]; const a = await turn(first);
    const second: ResponsesInputItem[] = [...first, ...a, ...results(a), user("New context"),
      { type: "message", role: "developer", content: "Preserve these additional instructions" }, user("Continue with the update")];
    const b = await turn(second);
    const c = await turn([...second, ...b, ...results(b)]);
    assert.ok(c.some(item => item.type === "message"));
    const capture = await fixture.capture();
    assert.deepEqual(capture.flatMap(entry => entry.start ? [entry.start] : []), ["live", "live"], "one safe reseed, then reuse; no one-shot replay");
    const seeded = capture.filter(entry => entry.user !== undefined)[1];
    assert.ok(seeded.heads?.some(head => /^<<item \d+ developer>>$/.test(head)), "the reseed retains the developer role");
    assert.equal(seeded.heads?.filter(head => /^<<item \d+ user>>$/.test(head)).length, 3, "all three caller messages stay in the complete history");
    assert.ok(capture.some(entry => entry.toolResult === "tool result"), "the third request relays its tool result");
    await flushTelemetry();
    const events = (await readTelemetry(fixture.directory, since)).filter(event => event.event === "claude_session");
    assert.ok(events.some(event => event.outcome === "reseeded" && event.missReason === "messages_after_tools"));
    assert.equal(events.some(event => event.outcome === "fallback"), false);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await flushTelemetry(); await fixture.restore();
  }
});
