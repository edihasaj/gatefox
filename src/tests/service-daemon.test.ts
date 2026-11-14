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

test("the daemon presets the login environment before it activates, runs or waits for anything", async () => {
  const f = await configured();
  try {
    const order: string[] = [];
    const preset = async (state: string) => { order.push("preset"); assert.equal(state, f.directory); };
    await runServiceDaemon(f.config, { preset, activate: async () => { order.push("activate"); return { plan: f.plan, restored: false }; }, run: async () => { order.push("run"); } });
    assert.deepEqual(order, ["preset", "activate", "run"]);
    order.length = 0;
    await runServiceDaemon(f.config, { preset, activate: async () => { order.push("activate"); return { restored: true }; }, standby: async () => { order.push("standby"); }, notice: () => {} });
    assert.deepEqual(order, ["preset", "activate", "standby"], "the idle path presets too");
    order.length = 0;
    await assert.rejects(runServiceDaemon(f.config, { preset, activate: async () => { order.push("activate"); return { restored: false }; } }), /plan is missing/);
    assert.deepEqual(order, ["preset", "activate"], "and a refusal comes after it");
  } finally { await f.remove(); }
});

test("the login-race recovery sees the preset's result and finishes before activation", async () => {
  const f = await configured();
  try {
    const order: string[] = [];
    await runServiceDaemon(f.config, {
      preset: async () => { order.push("preset"); return "set"; },
      recover: async (state, preset) => { assert.equal(state, f.directory); order.push(`recover:${String(preset)}`); },
      activate: async () => { order.push("activate"); return { plan: f.plan, restored: false }; }, run: async () => { order.push("run"); },
    });
    assert.deepEqual(order, ["preset", "recover:set", "activate", "run"]);
  } finally { await f.remove(); }
});

test("the daemon attempts staged native adoption after login activation and before starting its supervisor", async () => {
  const f = await configured();
  try {
    const order: string[] = [];
    await runServiceDaemon(f.config, {
      preset: async () => { order.push("preset"); },
      activate: async () => { order.push("login"); return { plan: f.plan, restored: false }; },
      activateNative: async (_path, plan) => { order.push("native"); return plan; },
      activateClaude: async (_path, plan) => { order.push("claude"); return plan; },
      run: async () => { order.push("supervisor"); },
    });
    assert.deepEqual(order, ["preset", "login", "native", "claude", "supervisor"]);
  } finally { await f.remove(); }
});

test("the daemon passes an adopted Claude plan to the supervisor without changing its config", async () => {
  const f = await configured();
  const adopted: ServicePlan = { ...f.plan, components: [{ id: "claude-adapter", kind: "claude-adapter", command: "/signed/node", args: [], log: join(f.directory, "adapter.log") }] };
  try {
    await runServiceDaemon(f.config, { preset: async () => {}, activate: async () => ({ plan: f.plan, restored: false }),
      activateNative: async (_path, plan) => plan, activateClaude: async () => adopted,
      run: async plan => { assert.deepEqual(plan, adopted); } });
    await assert.rejects(runServiceDaemon(f.config, { preset: async () => {}, activate: async () => ({ plan: f.plan, restored: false }),
      activateNative: async (_path, plan) => plan, activateClaude: async () => ({ ...adopted, config: join(f.directory, "other.json") }),
      run: async () => assert.fail("foreign plan must not run") }), /another configuration/);
  } finally { await f.remove(); }
});
