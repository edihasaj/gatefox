import test from "node:test";
import assert from "node:assert/strict";
import { healthIntervalMs, startHealthSchedule } from "../health-schedule.js";

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

/** A timer bank the test drives itself: nothing fires until the tick is pulled. */
function fakeTimers() {
  const armed: Array<{ tick: () => void; ms: number; cancelled: boolean }> = [];
  return {
    set(tick: () => void, ms: number) { const entry = { tick, ms, cancelled: false }; armed.push(entry); return () => { entry.cancelled = true; }; },
    fire(index = 0) { armed[index]!.tick(); },
    get count() { return armed.length; },
    get ms() { return armed[0]!.ms; },
  };
}

/** One schedule with a counting run and a switch for the URL's presence. */
function harness(extra: { exists?: (path: string) => Promise<boolean>; timers?: ReturnType<typeof fakeTimers> } = {}) {
  const calls: Array<{ resolve: () => void; done: Promise<void> }> = [];
  const seen: string[] = [];
  const stop = startHealthSchedule({
    stateDirectory: "/state",
    timers: extra.timers ?? fakeTimers(),
    exists: extra.exists ?? (async path => { seen.push(path); return true; }),
    run: () => new Promise<void>(resolve => calls.push({ resolve: () => resolve(), done: settle() })),
  });
  return { calls, seen, stop };
}

test("the first tick waits a full interval, and nothing starts at once", async () => {
  const timers = fakeTimers();
  const { calls } = harness({ timers });
  assert.equal(timers.count, 1);
  assert.equal(timers.ms, healthIntervalMs);
  assert.equal(healthIntervalMs, 10 * 60_000);
  assert.equal(calls.length, 0);
  timers.fire();
  await settle();
  assert.equal(calls.length, 1);
});

test("an unfinished tick is skipped, and the next one goes after", async () => {
  const timers = fakeTimers();
  const { calls } = harness({ timers });
  timers.fire();
  await settle();
  timers.fire();
  timers.fire();
  assert.equal(calls.length, 1, "overlap started anyway");
  calls[0]!.resolve();
  await calls[0]!.done;
  timers.fire();
  await settle();
  assert.equal(calls.length, 2);
});

test("no monitor URL means no health run, but the timer keeps checking", async () => {
  const timers = fakeTimers();
  const paths: string[] = [];
  const { calls } = harness({ timers, exists: async path => { paths.push(path); return false; } });
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
  assert.deepEqual(paths, ["/state/alert-push-url"]);
});

test("a refusing URL check never stops the heartbeat", async () => {
  const timers = fakeTimers();
  const { calls } = harness({ timers, exists: async () => { throw new Error("EIO"); } });
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
});

test("a rejected run is swallowed and the next tick still works", async () => {
  const timers = fakeTimers();
  let first = true;
  const calls: number[] = [];
  const stop = startHealthSchedule({ stateDirectory: "/state", timers, exists: async () => true, run: async () => {
    calls.push(calls.length);
    if (first) { first = false; throw new Error("probe exploded"); }
  } });
  timers.fire();
  await settle();
  timers.fire();
  await settle();
  assert.deepEqual(calls, [0, 1]);
  stop();
});

test("stopping cancels the timer and refuses late ticks", async () => {
  const timers = fakeTimers();
  const { calls, stop } = harness({ timers });
  stop();
  timers.fire();
  await settle();
  assert.equal(calls.length, 0);
  assert.equal(timers.count, 1);
});

test("the real timer never holds the process open", async () => {
  let unrefed = 0;
  let ms = 0;
  let cleared = false;
  const original = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  try {
    globalThis.setInterval = ((tick: () => void, interval: number) => { ms = interval; void tick; return { unref() { unrefed++; }, ref() {} } as unknown as NodeJS.Timeout; }) as typeof setInterval;
    globalThis.clearInterval = (() => { cleared = true; }) as typeof clearInterval;
    const stop = startHealthSchedule({ stateDirectory: "/state", exists: async () => false, run: async () => {} });
    assert.equal(unrefed, 1);
    assert.equal(ms, healthIntervalMs);
    stop();
    assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = original;
    globalThis.clearInterval = originalClear;
  }
});
