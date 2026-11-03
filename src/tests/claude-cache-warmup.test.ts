import test from "node:test";
import assert from "node:assert/strict";
import { claudeLiveWarmup, largeClaudeHistoryBytes } from "../providers/claude-cache-warmup.js";
import type { ClaudeConversation } from "../providers/claude-render.js";

test("default warmup uses an exact serialized byte boundary and honors explicit choices", () => {
  const history: ClaudeConversation = [{ role: "user", content: "" }];
  const overhead = Buffer.byteLength(JSON.stringify(history));
  history[0].content = "x".repeat(largeClaudeHistoryBytes - overhead - 1);
  assert.equal(claudeLiveWarmup(undefined, history, 1), 1);
  history[0].content += "x";
  assert.equal(claudeLiveWarmup(undefined, history, 1), 0);
  for (const warmup of [0, 1, 5]) assert.equal(claudeLiveWarmup({ claudeSessions: { warmup } }, history, 1), warmup);
});
