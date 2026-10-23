import test from "node:test";
import assert from "node:assert/strict";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { imageConversation } from "../protocol/images.js";
import { renderConversation } from "../providers/claude-render.js";
import { ledgerEntries } from "../providers/claude-ledger.js";
import type { ResponsesRequest } from "../protocol/types.js";

test("Claude preserves a multi-part summary whose exact joined text is a newline", () => {
  const request: ResponsesRequest = { model: "fixture", input: [
    { type: "message", role: "user", content: "Task" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "" }, { type: "summary_text", text: "" }] },
    { type: "message", role: "assistant", content: "Answer" },
  ] };
  const before = JSON.stringify(request);
  const restored = restoreReasoning(request, "fixture", { preserveSummaries: true });
  const messages = responsesToChatRequest(restored, { reasoningSummaryMetadata: true }).messages;
  assert.equal(messages.length, 3);
  assert.equal(messages[1].content, "\n"); assert.equal(messages[1].reasoningSummary, true);
  const blocks = renderConversation(imageConversation(messages).conversation, [], "text");
  assert.equal(blocks[2].text, "<<item 2 reasoning_summary>>\n\n\n<</item>>");
  const ledger = ledgerEntries(restored, []);
  assert.equal(ledger.messages, messages.length);
  assert.deepEqual(ledger.entries.map(entry => entry.first), [0, 2]);
  assert.equal(JSON.stringify(request), before);
});
