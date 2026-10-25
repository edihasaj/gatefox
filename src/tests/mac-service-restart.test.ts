import test from "node:test";
import assert from "node:assert/strict";
import { restartUnifiedService, type UnifiedRestartTools } from "../mac-service.js";
import type { ServiceComponent, ServicePlan } from "../service-plan.js";

const component = (id: string, kind: ServiceComponent["kind"]): ServiceComponent => ({ id, kind, command: "/bin/true", args: [], log: "/tmp/x.log" });
const plain: ServicePlan = { version: 1, config: "/tmp/gateway.json", components: [component("inference", "inference"), component("native", "native")] };
const withClaude: ServicePlan = { ...plain, components: [...plain.components, component("claude-adapter", "claude-adapter")] };

/** A fake launchd on a fake clock: `next` is the pid reported after the service moves, or undefined when it never moves. */
function fakeTools(options: { next?: number; moveOn?: "signal" | "kickstart"; refuse?: string; statusMs?: number } = {}) {
  const calls: string[] = []; let pid = 100; let clock = 0; const statusTimeouts: number[] = [];
  const tools: UnifiedRestartTools = {
    // A slow launchctl takes `statusMs`, but never longer than the timeout it was given.
    status: async timeoutMs => { statusTimeouts.push(timeoutMs); clock += Math.min(options.statusMs ?? 0, timeoutMs); return { installed: true, pid }; },
    maintenance: async () => { calls.push("maintenance"); if (options.refuse) throw new Error(options.refuse); },
    signal: target => { calls.push(`signal:${target}`); if (options.moveOn === "signal" && options.next) pid = options.next; },
    kickstart: async () => { calls.push("kickstart"); if (options.moveOn === "kickstart" && options.next) pid = options.next; },
    finish: async () => ({ pid }),
    wait: async ms => { clock += ms; },
    now: () => clock,
  };
  return { tools, calls, statusTimeouts, elapsed: () => clock };
}

test("a plain restart asks the supervisor for its idle restart", async () => {
  const { tools, calls } = fakeTools({ next: 200, moveOn: "signal" });
  assert.deepEqual(await restartUnifiedService(plain, 100, false, tools), { pid: 200, restart: "idle" });
  assert.deepEqual(calls, ["maintenance", "signal:100"]);
});

test("Claude components refuse a plain restart with their reason, before any signal", async () => {
  const { tools, calls } = fakeTools({ next: 200, moveOn: "signal" });
  await assert.rejects(restartUnifiedService(withClaude, 100, false, tools), /Claude Desktop components are configured.*--force/);
  assert.deepEqual(calls, ["maintenance"]);
});

test("--force restarts through launchd even with Claude components", async () => {
  const { tools, calls } = fakeTools({ next: 300, moveOn: "kickstart" });
  assert.deepEqual(await restartUnifiedService(withClaude, 100, true, tools), { pid: 300, restart: "forced" });
  assert.deepEqual(calls, ["maintenance", "kickstart"]);
});

test("--force still requires the maintenance window", async () => {
  const { tools, calls } = fakeTools({ next: 300, moveOn: "kickstart", refuse: "quit ChatGPT" });
  await assert.rejects(restartUnifiedService(withClaude, 100, true, tools), /quit ChatGPT/);
  assert.deepEqual(calls, ["maintenance"]);
});

test("an idle restart held by running work says so and points at --force", async () => {
  const { tools } = fakeTools();
  await assert.rejects(restartUnifiedService(plain, 100, false, tools), /held the idle restart.*--force/);
});

test("a forced restart that never comes back is reported, not claimed", async () => {
  const { tools } = fakeTools();
  await assert.rejects(restartUnifiedService(plain, 100, true, tools), /has not started again yet/);
});

test("--force refuses when the config turned client-only while the running plan still serves inference", async () => {
  const { tools, calls } = fakeTools({ next: 300, moveOn: "kickstart" });
  await assert.rejects(restartUnifiedService(withClaude, 100, true, { ...tools, configuredClientOnly: true }), /client-only but the running service still serves inference/);
  assert.deepEqual(calls, []);
});

test("--force on a client-only plan without inference still restarts", async () => {
  const clientPlan: ServicePlan = { ...plain, components: [component("tunnel-studio", "tunnel")] };
  const { tools, calls } = fakeTools({ next: 300, moveOn: "kickstart" });
  assert.deepEqual(await restartUnifiedService(clientPlan, 100, true, { ...tools, configuredClientOnly: true }), { pid: 300, restart: "forced" });
  assert.deepEqual(calls, ["maintenance", "kickstart"]);
});

test("a slow launchctl cannot stretch the forced wait past its one-minute deadline", async () => {
  const { tools, statusTimeouts, elapsed } = fakeTools({ statusMs: 5000 });
  await assert.rejects(restartUnifiedService(plain, 100, true, tools), /has not started again yet/);
  assert.ok(elapsed() <= 60000, `waited ${elapsed()} ms`);
  assert.ok(statusTimeouts.every(timeout => timeout > 0 && timeout <= 5000));
});

test("a slow launchctl cannot stretch the idle wait past its deadline", async () => {
  const { tools, elapsed } = fakeTools({ statusMs: 5000 });
  await assert.rejects(restartUnifiedService(plain, 100, false, tools), /held the idle restart/);
  assert.ok(elapsed() <= 15000, `waited ${elapsed()} ms`);
});
