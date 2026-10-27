import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readActivity, type ActivityConnection, type ActivityOptions, type ActivitySource } from "../activity.js";
import { recordedActivity, type ActivityRow } from "../activity-history.js";
import type { Message } from "../app-server-connection.js";

const source: ActivitySource = { socketPath: "/fixture/native.sock", native: true };
function fixture(status = "completed", runtime = "notLoaded") {
  const calls: string[] = [];
  let stopped = 0, reads = 0;
  const state = { runtime, flags: [] as string[], flip: false, mismatch: false, failHistory: false };
  const connection: ActivityConnection = {
    async request(method, params) {
      calls.push(method);
      if (method === "initialize") return {};
      if (method === "thread/loaded/list") return { data: runtime === "notLoaded" ? [] : ["one"], nextCursor: null };
      if (method === "thread/list") return { data: [{ id: "one" }], nextCursor: null };
      if (method === "thread/read") {
        assert.equal(params.includeTurns, false);
        reads++;
        return { thread: { id: state.mismatch ? "unrelated" : "one", model: "fixture/model", name: "Fixture\nname", updatedAt: 100,
          status: { type: state.flip && reads > 1 ? "active" : state.runtime, activeFlags: state.flags } } };
      }
      assert.equal(method, "thread/turns/list");
      assert.equal(params.itemsView, "notLoaded");
      if (state.failHistory) throw Error("private error text");
      return { data: status ? [{ id: "turn-one", status, completedAt: 1793059115,
        ...(status === "failed" ? { error: { message: "Private account quota exceeded, secret-value" } } : {}) }] : [], nextCursor: null };
    },
    send(message) { assert.equal(message.method, "initialized"); },
    stop() { stopped++; },
  };
  const options: ActivityOptions = { sources: async () => [source], verify: async () => true, connection: () => connection,
    history: async () => ({ rows: [], partial: false }) };
  return { calls, state, options, stopped: () => stopped, read: () => readActivity("/fixture/config", "/fixture/state", options) };
}

test("saved offline completions and failures are visible without resuming any thread", async () => {
  for (const status of ["completed", "failed", "interrupted"]) {
    const f = fixture(status), report = await f.read();
    assert.equal(report.coverage, "available");
    assert.equal(report.rows[0]!.state, status);
    assert.equal(report.rows[0]!.source, "sdk");
    assert.equal(report.rows[0]!.name, "Fixture name");
    assert.equal(report.rows[0]!.turn?.status, status);
    assert.equal(report.rows[0]!.turn?.errorClass, status === "failed" ? "usage_limit" : undefined);
    assert.equal(JSON.stringify(report).includes("secret-value"), false);
    assert.ok(f.calls.every(method => ["initialize", "thread/list", "thread/read", "thread/loaded/list", "thread/turns/list"].includes(method)));
    assert.equal(f.stopped(), 1);
  }
});

test("a currently active executor or a newer turn hides an older terminal status", async () => {
  for (const flip of [false, true]) {
    const f = fixture("failed", flip ? "idle" : "active"); f.state.flip = flip;
    const report = await f.read();
    assert.equal(report.rows[0]!.state, "running");
    assert.equal(report.rows[0]!.turn?.status, "failed", "past outcome is retained but never presented as the current state");
  }
});

test("notLoaded, missing history, and mismatched thread IDs never mean completed", async () => {
  for (const mode of ["empty", "failed", "mismatch"]) {
    const f = fixture(mode === "empty" ? "" : "completed");
    f.state.failHistory = mode === "failed"; f.state.mismatch = mode === "mismatch";
    const report = await f.read();
    assert.equal(report.rows[0]!.state, "unknown");
    assert.equal(report.rows[0]!.turn, undefined);
    if (mode !== "empty") assert.equal(report.coverage, "partial");
  }
});

test("pending approval and user input are waiting, not unattended progress", async () => {
  for (const [flag, waitingFor] of [["waitingOnApproval", "approval"], ["waitingOnUserInput", "input"]]) {
    const f = fixture("inProgress", "active"); f.state.flags = [flag!];
    const report = await f.read();
    assert.equal(report.rows[0]!.state, "waiting"); assert.equal(report.rows[0]!.waitingFor, waitingFor);
  }
});

test("orphaned inProgress history is unknown, not proof of a running executor", async () => {
  const f = fixture("inProgress", "notLoaded"), report = await f.read();
  assert.equal(report.rows[0]!.state, "unknown");
  assert.equal(report.rows[0]!.turn?.status, "inProgress");
});

test("recorded outcomes survive an unavailable host without manufacturing liveness", async () => {
  const row: ActivityRow = { threadId: "one", state: "unknown", source: "recorded", observedAt: new Date().toISOString(), turn: { id: "old", status: "failed", errorClass: "usage_limit" } };
  const report = await readActivity("/fixture/config", "/fixture/state", { sources: async () => [], history: async () => ({ rows: [row], partial: false }) });
  assert.equal(report.coverage, "unavailable"); assert.deepEqual(report.rows, [row]);
});

test("socket replacement and ambiguous writers fail closed", async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture(); let checks = 0;
    f.options.sources = async () => ambiguous ? [source, { ...source, socketPath: "/fixture/second.sock" }] : [source];
    // Both sources must report the thread loaded to establish the ambiguous case.
    const make = f.options.connection!;
    f.options.connection = value => {
      const c = make(value), request = c.request.bind(c);
      return { ...c, request: (method, params) => method === "thread/loaded/list" ? Promise.resolve({ data: ["one"] }) : request(method, params) };
    };
    if (!ambiguous) f.options.verify = async () => ++checks < 4;
    const report = await f.read();
    assert.equal(report.coverage, "partial"); assert.equal(report.rows[0]!.state, "unknown");
    assert.equal(report.rows[0]!.turn, undefined);
  }
});

test("deadline and cancellation close borrowed sockets and cannot mutate a returned snapshot", async () => {
  for (const cancel of [false, true]) {
    const f = fixture(), abort = new AbortController(); let release!: (value: Message) => void;
    const make = f.options.connection!;
    f.options.connection = value => {
      const c = make(value), request = c.request.bind(c);
      return { ...c, request: (method, params) => method === "thread/list" ? new Promise(done => { release = done; }) : request(method, params) };
    };
    f.options.timeoutMs = 30; f.options.signal = abort.signal;
    const pending = f.read();
    if (cancel) setTimeout(() => abort.abort(), 10);
    const report = await pending, before = JSON.stringify(report);
    assert.equal(report.coverage, "partial"); assert.equal(f.stopped(), 1);
    release({ data: [{ id: "one" }], nextCursor: "later" }); await new Promise(done => setTimeout(done, 10));
    assert.equal(JSON.stringify(report), before);
  }
});

test("late list rejection cannot change pagination flags after the report returns", async () => {
  const f = fixture(); let reject!: (error: Error) => void;
  const make = f.options.connection!;
  f.options.connection = value => {
    const c = make(value), request = c.request.bind(c);
    return { ...c, request: (method, params) => method === "thread/list" ? new Promise((_done, fail) => { reject = fail; })
      : method === "thread/loaded/list" ? Promise.resolve({ data: Array.from({ length: 65 }, (_, index) => "loaded-" + index) }) : request(method, params) };
  };
  f.options.timeoutMs = 20;
  const report = await f.read(), before = JSON.stringify(report);
  reject(Error("late private error")); await new Promise(done => setTimeout(done, 10));
  assert.equal(JSON.stringify(report), before);
});

test("content-free historical fallback is bounded, private, and read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "activity-history-")); await mkdir(join(root, "telemetry"), { mode: 0o700 });
  const now = Date.now(), at = new Date(now).toISOString(), path = join(root, "telemetry", `events-${at.slice(0, 10)}.jsonl`);
  const text = [
    { event: "executor_turn_settled", at, threadId: "one", turnId: "turn", status: "completed", message: "secret-value", errorClass: "secret-value" },
    { event: "turn_started", at, threadId: "two", turnId: "running" },
    { event: "turn_completed", at, threadId: "../invalid", turnId: "other", status: "failed" },
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(path, text, { mode: 0o600 });
  const result = await recordedActivity(root, now + 1);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0]!.state, "unknown");
  assert.equal(result.rows[0]!.turn?.status, "completed");
  assert.equal(JSON.stringify(result).includes("secret-value"), false);
  assert.equal(await readFile(path, "utf8"), text);
});
