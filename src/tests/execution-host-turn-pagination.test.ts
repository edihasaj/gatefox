import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { trackExecutorTurns, type TurnPollConnection } from "../execution-host-turns.js";

const options = { socketPath: "/unused", expected: () => ({inode: "1", device: "1"}), verify: async () => true, intervalMs: 3_600_000 };

test("a new terminal head arriving during a bounded history walk is collected after that walk", async () => {
  const directory = await mkdtemp("/tmp/hg-turn-pagination-"); configureTelemetry(directory, "test");
  const since = Date.now() - 1000, at = Math.floor(Date.now() / 1000);
  const turns = Array.from({length: 17}, (_, index) => ({id: `old-${index}`, status: "completed", completedAt: at + 1}));
  let updatedAt = at;
  const connection = (): TurnPollConnection => ({ready: Promise.resolve(), send() {}, stop() {}, async request(method, params) {
    if (method === "thread/loaded/list") return {data: ["chat"], nextCursor: null};
    if (method === "thread/read") return {thread: {id: "chat", updatedAt, status: {type: "idle"}}};
    if (method === "thread/turns/list") {
      const index = params.cursor ? turns.findIndex(turn => turn.id === params.cursor) + 1 : 0;
      return {data: turns.slice(index, index + 1), nextCursor: index + 1 < turns.length ? turns[index]!.id : null};
    }
    return {};
  }});
  const tracker = trackExecutorTurns({...options, engine: "gateway", connection});
  try {
    await tracker.poll();
    turns.unshift({id: "new-during-pagination", status: "failed", completedAt: at + 2}); updatedAt = at + 2;
    for (let pass = 0; pass < 6; pass++) await tracker.poll();
  } finally {tracker.stop();}
  await flushTelemetry();
  const records = (await readTelemetry(directory, since)).filter(event => event.event === "executor_turn_settled");
  assert.equal(records.filter(event => event.turnId === "new-during-pagination").length, 1);
  assert.equal(new Set(records.map(event => event.turnId)).size, turns.length);
});

test("one deep history cannot indefinitely starve the other loaded histories", async () => {
  const ids = Array.from({length: 64}, (_, index) => `chat-${index}`), visited = new Set<string>();
  const at = Math.floor(Date.now() / 1000); let pass = 0;
  const connection = (): TurnPollConnection => ({ready: Promise.resolve(), send() {}, stop() {}, async request(method, params) {
    const id = String(params.threadId);
    if (method === "thread/loaded/list") return {data: ids, nextCursor: null};
    if (method === "thread/read") return {thread: {id, updatedAt: at + pass, status: {type: "active"}}};
    if (method === "thread/turns/list") {
      visited.add(id);
      return {data: [{id: id + "-running", status: "inProgress"}], nextCursor: String(Number(params.cursor ?? 0) + 1)};
    }
    return {};
  }});
  const tracker = trackExecutorTurns({...options, engine: "native", connection});
  try {for (pass = 0; pass < 128; pass++) await tracker.poll();}
  finally {tracker.stop();}
  assert.equal(visited.size, ids.length);
});
