import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { messagesToResponses } from "../protocol/messages-request.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { ResponsesInputItem } from "../protocol/types.js";

/** One tool step the way Claude Code 2.1.299 replays it: the result, then a system-role message. */
async function toolStep(systemText: string) {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "Bash", input: { command: "echo one" } }] }, { text: "Continued" }] });
  const provider = new ClaudeSubscription({ id: `budget-note-${process.pid}`, type: "claude-subscription",
    models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const sessionId = "019a1234-5678-7890-abcd-0123456789ae";
  const turn = async (messages: unknown[]) => {
    const request = messagesToResponses({ model: "fixture", max_tokens: 100, messages,
      metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: sessionId }) },
      tools: [{ name: "Bash", input_schema: { type: "object", properties: {} } }] });
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer(request, new AbortController().signal, { clientProtocol: "messages", sessionId })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    const first = [{ role: "user", content: "start" }];
    const call = (await turn(first)).find(item => item.type === "function_call") as { call_id: string; arguments: string };
    const output = await turn([...first, { role: "assistant", content: [{ type: "tool_use", id: call.call_id, name: "Bash", input: JSON.parse(call.arguments) }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.call_id, content: "one" }] },
      { role: "system", content: [{ type: "text", text: systemText }] }]);
    assert.ok(JSON.stringify(output).includes("Continued"));
    const capture = await fixture.capture();
    assert.equal(capture.filter(row => row.start).length, 1, "the same CLI continued without a reseed");
    assert.equal(capture.filter(row => row.toolResult !== undefined).length, 1);
    return capture.filter(row => row.user !== undefined).map(row => row.heads ?? []);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
}

test("Claude Code's token budget note never becomes an empty user turn for a waiting CLI", { timeout: 30000 }, async () => {
  const turns = await toolStep("<total_tokens>14948670 tokens left</total_tokens>");
  assert.equal(turns.length, 1, "only the opening prompt was written; the CLI got the tool result alone");
});

test("any other system message beside tool results still reaches the CLI", { timeout: 30000 }, async () => {
  const turns = await toolStep("Use British spelling from now on.");
  assert.equal(turns.length, 2);
  assert.ok(turns[1].some(head => head.includes("system")));
});
