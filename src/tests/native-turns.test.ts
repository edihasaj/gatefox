// Unit coverage for the native-turn tracker: caps evict, engine-side closes release,
// and no well-formed notification can throw into the reader loop.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeTurnTracker } from "../native-turns.js";
import { configureTelemetry, flushTelemetry, readTelemetry, telemetry } from "../telemetry.js";
import type { Message } from "../app-server-connection.js";

const EVICT_WINDOW = 60_000; // Keep in step with the tracker's report window.

const started = (threadId: string, id: string): Message => ({ method: "turn/started", params: { threadId,
  turn: { id, rootTurnId: null, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: 123, completedAt: null, durationMs: null } } });
const status = (threadId: string, value: unknown): Message => ({ method: "thread/status/changed", params: { threadId, status: value } });

test("300 sub-agent threads closed by the engine leave nothing tracked", () => {
  const tracker = new NativeTurnTracker();
  for (let index = 0; index < 300; index++) {
    tracker.observe(started(`sub-${index}`, `turn-${index}`));
    tracker.observe({ method: "thread/closed", params: { threadId: `sub-${index}` } });
  }
  assert.equal(tracker.active.size, 0);
  tracker.observe(started("later", "turn")); // The next thread now fits without any eviction pressure.
  assert.equal(tracker.active.size, 1);
});

test("an inactive status releases the thread and unknown shapes change nothing", () => {
  const tracker = new NativeTurnTracker();
  tracker.observe(started("idle-chat", "turn-1"));
  tracker.observe(status("idle-chat", { type: "idle", activeFlags: [] }));
  assert.equal(tracker.active.size, 0);
  tracker.observe(started("busy-chat", "turn-2"));
  tracker.observe(status("busy-chat", { type: "active", activeFlags: [] }));
  assert.equal(tracker.active.size, 1);
  // The SDK reports `systemError` while the turn is still running, so it must not release anything.
  tracker.observe(status("busy-chat", { type: "systemError", activeFlags: [] }));
  assert.equal(tracker.active.size, 1, "systemError accompanies a turn that is still running");
  for (const value of ["notLoaded", {}, null, { type: null }]) {
    tracker.observe(started("odd-chat", "turn-3"));
    tracker.observe(status("odd-chat", value));
    assert.equal(tracker.active.size, 2, `status shape ${JSON.stringify(value)} must do nothing`);
    tracker.observe({ method: "thread/status/changed", params: { status: { type: "idle" } } }); // No thread id: nothing.
    assert.equal(tracker.active.size, 2);
    tracker.observe(started("notLoaded-chat", "turn-4"));
    tracker.observe(status("notLoaded-chat", { type: "notLoaded" }));
    tracker.delete("notLoaded-chat");
  }
});

test("the cap evicts the oldest entries and reports evictions at most once per minute", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-turns-"));
  try {
    configureTelemetry(directory, "test");
    const tracker = new NativeTurnTracker();
    for (let index = 0; index < 256; index++) tracker.observe(started(`chat-${index}`, `turn-${index}`));
    for (let index = 0; index < 3; index++) tracker.observe(started(`over-${index}`, `turn-${index}`));
    assert.equal(tracker.active.size, 256); // The engine was never asked to stop.
    assert.equal(tracker.active.has("chat-0"), false);
    assert.equal(tracker.active.has("chat-1"), false);
    assert.equal(tracker.active.has("chat-2"), false);
    assert.equal(tracker.active.has("over-2"), true);
    await flushTelemetry();
    const evictions = (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === "native_turns_evicted");
    assert.equal(evictions.length, 1); assert.equal(evictions[0].count, 1); // The rest waits for its own window.
    tracker.close(); // Closing the engine releases the pending window timer.
    await flushTelemetry();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("re-observing a known thread never evicts and terminal events free their slot", () => {
  const tracker = new NativeTurnTracker();
  for (let index = 0; index < 256; index++) tracker.observe(started(`chat-${index}`, `turn-${index}`));
  tracker.observe(started("chat-100", "replacement")); // Same thread: replaced in place, the cap is untouched.
  assert.equal(tracker.active.size, 256); assert.equal(tracker.active.get("chat-100")?.id, "replacement");
  tracker.observe({ method: "turn/completed", params: { threadId: "chat-100", turn: { id: "replacement", status: "completed" } } });
  assert.equal(tracker.active.size, 255);
  tracker.observe(started("chat-100", "replacement")); // The completed key blocks a duplicate revival.
  assert.equal(tracker.active.size, 255);
  for (let index = 0; index < 300; index++) tracker.rememberCompleted(JSON.stringify(["bulk", `turn-${index}`]));
  assert.equal(tracker.completed.size <= 512, true);
});

test("malformed and unrelated messages are observed without throwing", () => {
  const tracker = new NativeTurnTracker();
  const messages: Message[] = [{}, { method: "turn/started" }, { method: "turn/started", params: null },
    { method: "turn/started", params: { threadId: 5, turn: { id: 7, status: "inProgress" } } },
    { method: "turn/completed", params: { threadId: "a", turn: { id: "b", status: 42 } } },
    { method: "thread/closed" }, { id: 1, method: "turn/started", params: { threadId: "a", turn: { id: "b", status: "inProgress" } } },
    { method: "item/started", params: { threadId: "a" } }, { method: "turn/started", params: { threadId: "a\u0000b", turn: { id: "x", status: "inProgress" } } }];
  for (const message of messages) tracker.observe(message);
  assert.equal(tracker.active.size, 0);
  assert.equal(tracker.completed.size, 0); // No malformed notification recorded anything.
  tracker.clear();
  assert.equal(tracker.active.size, 0); assert.equal(tracker.completed.size, 0);
});

test("a release invalidates an in-flight read, and unrelated notifications do not", () => {
  const tracker = new NativeTurnTracker();
  const before = tracker.revision;
  tracker.observe(started("a", "1"));
  assert.equal(tracker.revision, before + 1);
  // thread/read raced with these, so its answer must not be trusted and must not re-add the thread.
  tracker.observe({ method: "thread/closed", params: { threadId: "a" } });
  assert.equal(tracker.revision, before + 2);
  tracker.observe(started("b", "2"));
  tracker.observe(status("b", { type: "idle" }));
  assert.equal(tracker.revision, before + 4);
  tracker.observe({ method: "item/started", params: { threadId: "a" } });
  tracker.observe(status("c", { type: "systemError" })); // Nothing was released.
  assert.equal(tracker.revision, before + 4);
  tracker.observe({ method: "thread/closed", params: {} }); // No thread id: nothing to release.
  assert.equal(tracker.revision, before + 4);
  tracker.observe({ method: "turn/completed", params: { threadId: "a", turn: { id: "1", status: "failed" } } });
  assert.equal(tracker.revision, before + 5);
});

test("evictions counted inside the quiet minute are reported when it closes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-window-"));
  try {
    configureTelemetry(directory, "test");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] }); // The minute is a wall-clock window; freeze it to reach its edge.
    const tracker = new NativeTurnTracker();
    const since = Date.now(); // Mocked time starts at the epoch, so the window filter has to be fixed up front.
    const reported = async () => { await flushTelemetry(); return (await readTelemetry(directory, since)).filter(event => event.event === "native_turns_evicted"); };
    for (let index = 0; index < 258; index++) tracker.observe(started(`chat-${index}`, `turn-${index}`));
    assert.deepEqual((await reported()).map(event => event.count), [1]); // The first is immediate; the second waits for the window.
    t.mock.timers.tick(EVICT_WINDOW - 1);
    assert.deepEqual((await reported()).map(event => event.count), [1]);
    t.mock.timers.tick(1);
    assert.deepEqual((await reported()).map(event => event.count), [1, 1]);
    tracker.observe(started("overflow", "turn")); // Inside the fresh window again.
    assert.deepEqual((await reported()).map(event => event.count), [1, 1]);
    tracker.close(); // An engine that exits must not take the pending count with it.
    assert.deepEqual((await reported()).map(event => event.count), [1, 1, 1]);
  } finally { t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
});

// Regression: a stalled engine loop can pass the window edge before the overdue timer runs. The
// eviction that flushes at that edge opens the next window, so the old timer must not survive it:
// it used to report the new window's count at the same instant and leave that window unscheduled.
test("an eviction at a passed window edge reports once and reschedules the next window", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gw-native-overdue-"));
  try {
    configureTelemetry(directory, "test");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
    const tracker = new NativeTurnTracker();
    const since = Date.now();
    const reported = async () => { await flushTelemetry(); return (await readTelemetry(directory, since)).filter(event => event.event === "native_turns_evicted"); };
    const counts = async () => (await reported()).map(event => event.count);
    const evict = (name: string) => tracker.observe(started(name, `turn-${name}`));
    for (let index = 0; index < 258; index++) evict(`chat-${index}`); // One immediate report, one count waiting for the edge.
    assert.deepEqual(await counts(), [1]);
    t.mock.timers.setTime(EVICT_WINDOW + 1); // The clock passes the edge while the timer is still queued.
    evict("edge");
    assert.deepEqual(await counts(), [1, 2]); // The waiting count is reported at once, together with this one.
    evict("fresh"); // Inside the window the report just opened, so it has to wait for that window.
    t.mock.timers.tick(1);
    assert.deepEqual(await counts(), [1, 2]); // A stale timer must not report a second time at the same instant.
    t.mock.timers.tick(EVICT_WINDOW);
    assert.deepEqual(await counts(), [1, 2, 1]); // It is reported when the next window closes.
    tracker.close();
  } finally { t.mock.timers.reset(); await rm(directory, { recursive: true, force: true }); }
});
