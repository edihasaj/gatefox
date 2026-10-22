import test from "node:test";
import assert from "node:assert/strict";
import { replayCompletedDisplayItems } from "../executor-display-replay.js";
import type { Message } from "../app-server-connection.js";

test("display recovery replays only completed items from the captured turn", async () => {
  const emitted: Message[] = []; const completed = new Set<string>();
  await replayCompletedDisplayItems(async () => ({ data: [
    { turnId: "other-turn", item: { id: "foreign", type: "agentMessage", text: "wrong turn" }, completedAtMs: 1 },
    { turnId: "target-turn", item: { id: "active", type: "agentMessage", text: "saved answer" }, completedAtMs: 2 },
    { turnId: "target-turn", item: { id: "unfinished", type: "agentMessage", text: "still running" } },
    { turnId: "target-turn", item: { id: "tool", type: "commandExecution", status: "completed" }, completedAtMs: 3 },
  ], nextCursor: null }), message => { emitted.push(message); return Promise.resolve(); }, () => true,
  "chat", "target-turn", { has: id => completed.has(id), add: id => completed.add(id) });
  assert.deepEqual(emitted, [{ method: "item/completed", params: {
    threadId: "chat", turnId: "target-turn", item: { id: "active", type: "agentMessage", text: "saved answer" }, completedAtMs: 2,
  } }]);
});
