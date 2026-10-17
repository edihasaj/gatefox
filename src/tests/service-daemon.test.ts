import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { runServiceDaemon, untilStopped } from "../service-daemon.js";
import type { ServicePlan } from "../service-plan.js";
import { shortFolder } from "./short-folder.js";

async function configured() {
  const made = await shortFolder("gwd-"); const config = join(made.directory, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3459, clientOnly: true, stateDirectory: made.directory, providers: [] });
  const plan: ServicePlan = { version: 1, config, components: [] };
  return { ...made, config, plan };
}

test("the daemon runs the plan it is given, and refuses when there is none and nothing was rolled back", async () => {
  const f = await configured();
  try {
    const ran: string[] = [];
    await runServiceDaemon(f.config, { activate: async () => ({ plan: f.plan, restored: false }), run: async (plan, state) => { ran.push(plan.config, state); }, standby: async () => assert.fail("no standby") });
    assert.deepEqual(ran, [f.config, f.directory]);
    await assert.rejects(runServiceDaemon(f.config, { activate: async () => ({ restored: false }), run: async () => assert.fail("no plan to run") }), /Unified service plan is missing/);
    await assert.rejects(runServiceDaemon(f.config, { activate: async () => ({ plan: { ...f.plan, config: join(f.directory, "other.json") }, restored: false }) }), /another configuration/);
  } finally { await f.remove(); }
});

test("after rolling an interrupted consolidation back the daemon stays idle instead of failing every launchd restart", async () => {
  const f = await configured();
  try {
    const notices: string[] = []; let waited = false;
    await runServiceDaemon(f.config, { activate: async () => ({ restored: true }), run: async () => assert.fail("nothing to run"),
      standby: async () => { waited = true; }, notice: line => { notices.push(line); } });
    assert.equal(waited, true);
    assert.equal(notices.length, 1); assert.ok(!notices[0].includes(f.directory), "the notice names no path");
  } finally { await f.remove(); }
});

test("standing by ends on the stop signals only, holds an idle restart's SIGUSR2, and leaves no listener behind", async () => {
  // An emitter of the test's own: emitting real signal events in the test process would reach the runner's handlers.
  const stops = ["SIGTERM", "SIGINT"]; const held = process.platform === "win32" ? [] : ["SIGUSR2"]; const names = [...stops, ...held];
  for (const name of stops) {
    const signals = new EventEmitter(); let ended = false;
    const waiting = untilStopped(signals).then(() => { ended = true; });
    assert.deepEqual(names.map(other => signals.listenerCount(other)), names.map(() => 1), "a listener for each, so SIGUSR2's default action cannot end the process");
    for (const other of held) signals.emit(other);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ended, false, "an idle restart's signal does not end standby: a relaunch would only stand by again");
    signals.emit(name); await waiting;
    assert.deepEqual(names.map(other => signals.listenerCount(other)), names.map(() => 0));
  }
});
