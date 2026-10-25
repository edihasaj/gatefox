import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import type { Message } from "../app-server-connection.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { trackExecutorTurns, type TurnPollConnection } from "../execution-host-turns.js";
import { summarizeTelemetry } from "../diagnostics.js";

type Turn = { id: string; status: string; startedAt?: number; completedAt?: number; error?: { message: string } };
type Engine = { loaded: string[]; status: Record<string, string>; updatedAt: Record<string, number>; turns: Record<string, Turn | Turn[]> };
type Fake = TurnPollConnection & { requests: string[]; calls: { method: string; params: Message }[]; sent: Message[]; stopped: boolean };

function fixture(engine: Engine, options: { stopThrows?: boolean; pageSize?: number; failReads?: Set<string>; failTurns?: Set<string> } = {}) {
  const connections: Fake[] = [];
  const connection = (): TurnPollConnection => {
    const fake: Fake = {
      ready: Promise.resolve(), requests: [], calls: [], sent: [], stopped: false,
      async request(method, params) {
        fake.requests.push(method); fake.calls.push({ method, params });
        const id = String(params.threadId);
        if (method === "thread/loaded/list") return { data: engine.loaded, nextCursor: null };
        if (method === "thread/read") { if (options.failReads?.delete(id)) throw new Error("transient read"); return { thread: { id, status: { type: engine.status[id] ?? "notLoaded" }, updatedAt: engine.updatedAt[id] } }; }
        if (method === "thread/turns/list") {
          if (options.failTurns?.delete(id)) throw new Error("transient turns");
          const turns = engine.turns[id] ? (Array.isArray(engine.turns[id]) ? engine.turns[id] : [engine.turns[id]]) : [];
          const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
          const size = options.pageSize ?? 50, next = start + size < turns.length ? String(start + size) : null;
          return { data: turns.slice(start, start + size), nextCursor: next };
        }
        return {};
      },
      send(message) { fake.sent.push(message); },
      stop() { fake.stopped = true; if (options.stopThrows) throw new Error("Codex app-server is closed"); },
    };
    connections.push(fake); return fake;
  };
  return { connections, connection };
}
const now = () => Date.now() / 1000;
async function settledEvents(dir: string, since: number) {
  await flushTelemetry();
  return (await readTelemetry(dir, since)).filter(event => event.event === "executor_turn_settled");
}
const base = { socketPath: "/unused", expected: () => ({ inode: "1", device: "1" }), verify: async () => true, intervalMs: 3_600_000 };

test("records a usage-limit turn that ends while no window is connected, once, without its text", async () => {
  const dir = await mkdtemp("/tmp/hg-exec-turns-"); const since = Date.now() - 1000; configureTelemetry(dir, "test");
  const engine: Engine = { loaded: ["thread-1"], status: { "thread-1": "active" }, updatedAt: { "thread-1": 1 }, turns: {} };
  const f = fixture(engine);
  const tracker = trackExecutorTurns({ ...base, engine: "gateway", connection: f.connection });
  await tracker.poll();
  const message = "Claude subscription five-hour usage limit reached. Provider-reported reset: soon";
  engine.status["thread-1"] = "idle"; engine.updatedAt["thread-1"] = 2;
  engine.turns["thread-1"] = { id: "turn-1", status: "completed", startedAt: now() - 30, completedAt: now() + 1, error: { message } };
  await tracker.poll(); await tracker.poll();
  tracker.stop();
  const recorded = await settledEvents(dir, since);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].engine, "gateway"); assert.equal(recorded[0].turnId, "turn-1");
  assert.equal(recorded[0].status, "completed"); assert.equal(recorded[0].errorClass, "usage_limit");
  assert.ok(Number(recorded[0].durationMs) >= 30000);
  assert.ok(!JSON.stringify(recorded[0]).includes("five-hour"));
  const summary = summarizeTelemetry(recorded, new Date(since)) as { executorTurns: Record<string, number>; recentProblems: unknown[] };
  assert.deepEqual(summary.executorTurns, { "gateway completed:usage_limit": 1 });
  assert.equal(summary.recentProblems.length, 1);
  // Every inspection is transient: it only initializes, reads and closes. It never answers a server request.
  assert.equal(f.connections.length, 3);
  for (const connection of f.connections) {
    assert.equal(connection.stopped, true);
    assert.deepEqual(connection.sent, [{ method: "initialized", params: {} }]);
  }
});

test("a chat seen running is still read after it unloads, and a turn that ended before the tracker started is ignored", async () => {
  const dir = await mkdtemp("/tmp/hg-exec-turns-"); const since = Date.now() - 1000; configureTelemetry(dir, "test");
  const engine: Engine = { loaded: ["running", "old"], status: { running: "active", old: "idle" }, updatedAt: { running: 1, old: 1 },
    turns: { old: { id: "turn-old", status: "failed", completedAt: now() - 3600, error: { message: "stream disconnected" } } } };
  const f = fixture(engine);
  const tracker = trackExecutorTurns({ ...base, engine: "native", connection: f.connection });
  await tracker.poll();
  engine.loaded = ["old"]; engine.status.running = "notLoaded"; engine.updatedAt.running = 2;
  engine.turns.running = { id: "turn-2", status: "failed", completedAt: now() + 1 };
  await tracker.poll();
  tracker.stop();
  const recorded = await settledEvents(dir, since);
  assert.deepEqual(recorded.map(event => [event.engine, event.turnId, event.status]), [["native", "turn-2", "failed"]]);
});

test("a changed socket is never asked, and stop ends polling even when closing throws", async () => {
  const engine: Engine = { loaded: ["x"], status: { x: "active" }, updatedAt: {}, turns: {} };
  const refused = fixture(engine);
  const tracker = trackExecutorTurns({ ...base, engine: "gateway", connection: refused.connection, verify: async () => false });
  await tracker.poll(); tracker.stop();
  assert.equal(refused.connections.length, 0);
  const throwing = fixture(engine, { stopThrows: true });
  const polling = trackExecutorTurns({ ...base, engine: "gateway", connection: throwing.connection, intervalMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.doesNotThrow(() => polling.stop());
  const count = throwing.connections.length; assert.ok(count >= 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(throwing.connections.length, count, "no inspection after stop");
});

test("unloaded active watches survive transient read and turns-list failures until a terminal turn is conclusive", async () => {
  const dir = await mkdtemp("/tmp/hg-exec-turns-"); const since = Date.now() - 1_000; configureTelemetry(dir, "test");
  const engine: Engine = { loaded: ["x"], status: { x: "active" }, updatedAt: { x: now() }, turns: {} };
  const failedReads = new Set<string>(); const f = fixture(engine, { failTurns: new Set(["x"]), failReads: failedReads });
  const tracker = trackExecutorTurns({ ...base, engine: "gateway", connection: f.connection });
  await tracker.poll();
  engine.loaded = []; engine.status.x = "notLoaded"; engine.turns.x = { id: "late", status: "failed", completedAt: now() + 2 };
  await tracker.poll();
  assert.equal((await settledEvents(dir, since)).length, 1, "the failed first turns page was retried after unload");
  engine.loaded = ["y"]; engine.status.y = "active"; engine.updatedAt.y = now();
  await tracker.poll();
  failedReads.add("y"); await tracker.poll();
  engine.loaded = []; engine.status.y = "notLoaded"; engine.turns.y = { id: "read-late", status: "completed", completedAt: now() + 2 };
  await tracker.poll(); tracker.stop();
  assert.ok((await settledEvents(dir, since)).some(event => event.turnId === "read-late"));
});

test("paginates terminal turns behind a newer active turn and keeps only outcomes after this tracker started", async () => {
  const dir = await mkdtemp("/tmp/hg-exec-turns-"); const since = Date.now() - 1_000; configureTelemetry(dir, "test");
  const engine: Engine = { loaded: ["x", "old"], status: { x: "active", old: "idle" }, updatedAt: { x: now(), old: now() }, turns: {} };
  const tracker = trackExecutorTurns({ ...base, engine: "native", connection: fixture(engine, { pageSize: 1 }).connection });
  const at = Math.floor(Date.now() / 1000);
  engine.turns.x = [{ id: "new-active", status: "inProgress" }, { id: "one", status: "completed", completedAt: at + 2 }, { id: "two", status: "failed", completedAt: at + 1 }];
  engine.turns.old = { id: "before-host", status: "completed", completedAt: at - 30 };
  await tracker.poll(); tracker.stop();
  assert.deepEqual((await settledEvents(dir, since)).map(event => event.turnId).sort(), ["one", "two"]);
});

test("same-second completions count, while an old idle rollout and 256 old idle chats need no history requests", async () => {
  const dir = await mkdtemp("/tmp/hg-exec-turns-"); const since = Date.now() - 1_000; configureTelemetry(dir, "test");
  const ids = Array.from({ length: 256 }, (_, index) => `old-${index}`);
  const engine: Engine = { loaded: ["same", "before", ...ids], status: {}, updatedAt: {}, turns: {} };
  const at = Math.floor(Date.now() / 1000);
  engine.status.same = "idle"; engine.status.before = "idle"; engine.updatedAt.same = at; engine.updatedAt.before = at;
  engine.turns.same = { id: "same", status: "completed", completedAt: at };
  engine.turns.before = { id: "before", status: "completed", completedAt: at - 30 };
  for (const id of ids) { engine.status[id] = "idle"; engine.updatedAt[id] = at - 7_200; }
  const f = fixture(engine); const tracker = trackExecutorTurns({ ...base, engine: "gateway", connection: f.connection });
  await tracker.poll(); tracker.stop();
  assert.deepEqual((await settledEvents(dir, since)).map(event => event.turnId), ["same"]);
  assert.equal(f.connections[0]!.requests.filter(method => method === "thread/turns/list").length, 2);
});

test("rotates more than 256 loaded chats without starving the final batch", async () => {
  const ids = Array.from({ length: 512 }, (_, index) => `thread-${index}`);
  const engine: Engine = { loaded: ids, status: {}, updatedAt: {}, turns: {} };
  for (const id of ids) { engine.status[id] = "active"; engine.updatedAt[id] = now(); }
  const f = fixture(engine); const tracker = trackExecutorTurns({ ...base, engine: "gateway", connection: f.connection });
  for (let index = 0; index < 16; index++) await tracker.poll();
  tracker.stop();
  const read = new Set(f.connections.flatMap(connection => connection.calls.filter(call => call.method === "thread/read").map(call => String(call.params.threadId))));
  assert.equal(read.size, ids.length);
});

test("continuously changing active batches do not phase-lock the same history half", async () => {
  const ids = Array.from({ length: 64 }, (_, index) => `active-${index}`);
  const engine: Engine = { loaded: ids, status: {}, updatedAt: {}, turns: {} };
  const epoch = Math.floor(Date.now() / 1000);
  for (const id of ids) engine.status[id] = "active";
  const f = fixture(engine); const tracker = trackExecutorTurns({ ...base, engine: "native", connection: f.connection });
  for (let poll = 0; poll < 20; poll++) {
    for (const id of ids) engine.updatedAt[id] = epoch + poll;
    await tracker.poll();
  }
  tracker.stop();
  const histories = new Set(f.connections.flatMap(connection => connection.calls.filter(call => call.method === "thread/turns/list").map(call => String(call.params.threadId))));
  assert.equal(histories.size, ids.length);
});

test("a timed-out or stopped inspection closes its socket and cannot write telemetry after its late response", async () => {
  const dir = await mkdtemp("/tmp/hg-exec-turns-"); const since = Date.now() - 1_000; configureTelemetry(dir, "test");
  let resolveList: ((value: Message) => void) | undefined, stopped = false;
  const connection = (): TurnPollConnection => ({ ready: Promise.resolve(),
    request(method) { if (method === "initialize") return Promise.resolve({}); return new Promise(resolve => { resolveList = resolve; }); },
    send() {}, stop() { stopped = true; },
  });
  const tracker = trackExecutorTurns({ ...base, engine: "native", connection, timeoutMs: 5 });
  await tracker.poll(); assert.equal(stopped, true);
  resolveList?.({ data: ["x"] }); await new Promise(resolve => setImmediate(resolve)); tracker.stop();
  assert.equal((await settledEvents(dir, since)).length, 0);
});
