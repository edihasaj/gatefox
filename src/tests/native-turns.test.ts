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
    assert.equal(evictions.length, 1); assert.equal(evictions[0].count, 1); // The next minute's window carries the rest.
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

test("notifications bump the revision only on turn lifecycle", () => {
  const tracker = new NativeTurnTracker();
  const before = tracker.revision;
  tracker.observe(started("a", "1"));
  assert.equal(tracker.revision, before + 1);
  tracker.observe({ method: "thread/closed", params: { threadId: "a" } });
  tracker.observe(status("b", { type: "idle" }));
  tracker.observe({ method: "item/started", params: { threadId: "a" } });
  assert.equal(tracker.revision, before + 1);
  tracker.observe({ method: "turn/completed", params: { threadId: "a", turn: { id: "1", status: "failed" } } });
  assert.equal(tracker.revision, before + 2);
});
