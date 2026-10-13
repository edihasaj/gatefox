import test from "node:test";
import assert from "node:assert/strict";
import { busyActivities, registerActivityProbe, registerShutdownHook, runShutdownHooks, runtimeBusy, shutdownDrainMs } from "../runtime-activity.js";

test("activity probes report busy work, a throwing probe counts as idle, and removal works", () => {
  assert.equal(runtimeBusy(), false);
  let busy = false;
  const removeBusy = registerActivityProbe("sessions", () => busy);
  const removeThrowing = registerActivityProbe("broken", () => { throw new Error("probe failed"); });
  try {
    assert.equal(runtimeBusy(), false);
    busy = true; assert.equal(runtimeBusy(), true); assert.deepEqual(busyActivities(), ["sessions"]);
    removeBusy(); assert.equal(runtimeBusy(), false);
  } finally { removeBusy(); removeThrowing(); }
});

test("shutdown hooks run together and the wait is bounded by the timeout", async () => {
  const ran: string[] = []; let finishSlow: () => void = () => {};
  const removers = [
    registerShutdownHook("fast", async () => { ran.push("fast"); }),
    registerShutdownHook("throws", () => { ran.push("throws"); throw new Error("hook failed"); }),
    registerShutdownHook("rejects", async () => { ran.push("rejects"); throw new Error("hook failed"); }),
    registerShutdownHook("slow", () => new Promise<void>(resolve => { ran.push("slow"); finishSlow = resolve; })),
  ];
  try {
    const started = Date.now(); await runShutdownHooks(80);
    const elapsed = Date.now() - started;
    assert.deepEqual(ran.sort(), ["fast", "rejects", "slow", "throws"]);
    assert.ok(elapsed >= 70 && elapsed < 2000, `bounded wait took ${elapsed} ms`);
    finishSlow(); ran.length = 0;
    removers[3]();
    const quick = Date.now(); await runShutdownHooks(5000);
    assert.ok(Date.now() - quick < 1000, "settled hooks do not wait for the timeout");
  } finally { finishSlow(); for (const remove of removers) remove(); }
  await runShutdownHooks(10);
});

test("a second module instance shares the same process-wide registry", async () => {
  const specifier = new URL("../runtime-activity.js?copy", import.meta.url).href;
  const copy = await import(specifier) as typeof import("../runtime-activity.js");
  assert.notEqual(copy.runtimeBusy, runtimeBusy, "the query loads a separate module instance");
  const remove = copy.registerActivityProbe("copy", () => true);
  let hooked = false; const removeHook = registerShutdownHook("original", async () => { hooked = true; });
  try {
    assert.equal(runtimeBusy(), true, "the original instance sees the copy's probe");
    await copy.runShutdownHooks(1000); assert.equal(hooked, true, "the copy runs the original instance's hook");
  } finally { remove(); removeHook(); }
  assert.equal(runtimeBusy(), false);
});

test("the shutdown drain defaults to 8 s and clamps the environment override", () => {
  const previous = process.env.GATEWAY_SHUTDOWN_DRAIN_MS;
  try {
    for (const [value, expected] of [[undefined, 8000], ["", 8000], ["soon", 8000], ["200", 200], ["-5", 0], ["0", 0], ["99999", 30000], ["1500.4", 1500]] as const) {
      if (value === undefined) delete process.env.GATEWAY_SHUTDOWN_DRAIN_MS; else process.env.GATEWAY_SHUTDOWN_DRAIN_MS = value;
      assert.equal(shutdownDrainMs(), expected, String(value));
    }
  } finally { if (previous === undefined) delete process.env.GATEWAY_SHUTDOWN_DRAIN_MS; else process.env.GATEWAY_SHUTDOWN_DRAIN_MS = previous; }
});
