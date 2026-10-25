import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import type { Message } from "../app-server-connection.js";
import { trackExecutorTurns, type TurnPollConnection } from "../execution-host-turns.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

const options = { socketPath: "/unused", expected: () => ({inode: "1", device: "1"}), verify: async () => true, intervalMs: 3_600_000 };

test("changing active chats cannot consume every history slot ahead of pending failures", async () => {
  const directory = await mkdtemp("/tmp/hg-turn-fairness-");
  configureTelemetry(directory, "test");
  const since = Date.now() - 1000, at = Math.floor(Date.now() / 1000);
  const active = Array.from({length: 16}, (_, index) => `active-${index}`);
  const failed = Array.from({length: 24}, (_, index) => `failed-${index}`);
  let pass = 0;
  const connection = (): TurnPollConnection => ({
    ready: Promise.resolve(), send() {}, stop() {},
    async request(method, params) {
      const id = String(params.threadId), busy = active.includes(id);
      if (method === "thread/loaded/list") return {data: [...active, ...failed], nextCursor: null};
      if (method === "thread/read") return {thread: {id, updatedAt: at + pass, status: {type: busy ? "active" : "idle"}}};
      if (method === "thread/turns/list") return {data: busy ? [{id: id + "-running", status: "inProgress"}]
        : [{id: id + "-done", status: "failed", completedAt: at + 1, error: {message: "subscription usage limit"}}], nextCursor: null};
      return {};
    },
  });
  const tracker = trackExecutorTurns({...options, engine: "gateway", connection});
  try { for (pass = 0; pass < 6; pass++) await tracker.poll(); }
  finally { tracker.stop(); }
  await flushTelemetry();
  const recorded = (await readTelemetry(directory, since)).filter(event => event.event === "executor_turn_settled");
  assert.equal(new Set(recorded.map(event => event.turnId)).size, failed.length);
});

test("an unloaded settled watch retries its failed history read", async () => {
  const directory = await mkdtemp("/tmp/hg-turn-retry-"); configureTelemetry(directory, "test");
  const since = Date.now() - 1000, at = Math.floor(Date.now() / 1000);
  let pass = 0, firstTerminalRead = true;
  const connection = (): TurnPollConnection => ({
    ready: Promise.resolve(), send() {}, stop() {},
    async request(method) {
      if (method === "thread/loaded/list") return {data: pass === 0 ? ["one"] : [], nextCursor: null};
      if (method === "thread/read") return {thread: {id: "one", updatedAt: at + pass, status: {type: pass === 0 ? "active" : "idle"}}};
      if (method === "thread/turns/list") {
        if (pass === 0) return {data: [{id: "running", status: "inProgress"}], nextCursor: null};
        if (firstTerminalRead) {firstTerminalRead = false; throw new Error("temporary metadata failure");}
        return {data: [{id: "done", status: "failed", completedAt: at + 1}], nextCursor: null};
      }
      return {};
    },
  });
  const tracker = trackExecutorTurns({...options, engine: "native", connection});
  try { for (pass = 0; pass < 3; pass++) await tracker.poll(); }
  finally { tracker.stop(); }
  await flushTelemetry();
  assert.equal((await readTelemetry(directory, since)).filter(event => event.event === "executor_turn_settled" && event.turnId === "done").length, 1);
});

test("concurrent polls coalesce and a late timed-out request issues no further RPCs", async () => {
  let connections = 0, requests = 0, closed = 0;
  let resolveLate: ((result: Message) => void) | undefined;
  const connection = (): TurnPollConnection => {
    connections++;
    return {ready: Promise.resolve(), send() {}, stop() {closed++;}, request(method) {
      requests++;
      if (method === "initialize") return Promise.resolve({});
      return new Promise(resolve => {resolveLate = resolve;});
    }};
  };
  const tracker = trackExecutorTurns({...options, engine: "gateway", connection, timeoutMs: 10});
  // The tracker intentionally unrefs its deadline; this fixture keeps the process alive until that deadline.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await Promise.all([tracker.poll(), tracker.poll()]);
    assert.equal(connections, 1); assert.equal(closed, 1);
    const before = requests;
    resolveLate?.({data: ["one"], nextCursor: null});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, before);
  } finally {clearTimeout(keepAlive); tracker.stop();}
});

test("rotating loaded batches cannot lock the same chats out of history inspection", async () => {
  const ids = Array.from({length: 64}, (_, index) => `chat-${index}`), histories = new Set<string>();
  const at = Math.floor(Date.now() / 1000); let pass = 0;
  const connection = (): TurnPollConnection => ({ready: Promise.resolve(), send() {}, stop() {}, async request(method, params) {
    const id = String(params.threadId);
    if (method === "thread/loaded/list") return {data: ids, nextCursor: null};
    if (method === "thread/read") return {thread: {id, updatedAt: at + pass, status: {type: "active"}}};
    if (method === "thread/turns/list") {histories.add(id); return {data: [{id: id + "-running", status: "inProgress"}], nextCursor: null};}
    return {};
  }});
  const tracker = trackExecutorTurns({...options, engine: "gateway", connection});
  try { for (pass = 0; pass < 20; pass++) await tracker.poll(); }
  finally {tracker.stop();}
  assert.equal(histories.size, ids.length);
});
