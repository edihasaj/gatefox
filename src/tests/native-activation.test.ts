import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nativeRelayHome } from "../native-control.js";
import { nativePendingPath, nativeRegistrationPath } from "../native-pause.js";
import { nativeExecutionEnvironment, nativeExecutionArgs } from "../native-execution-host-engine.js";
import { registerPlanRelay, type PlanRelayDeps } from "../native-plan-registration.js";
import { clearSlotHolders, slotHolders, type HolderDeps } from "../native-slot-holders.js";
import { ListenerActivity, listenerActivityPath, readListenerActivity } from "../ssh-listener-activity.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { ServicePlan } from "../service-plan.js";

/**
 * Activating the native relay without racing the machine's one remote-control slot. The registration is written as pending
 * before anything else, idle SSH listeners that may hold the slot are retired, busy ones refuse the activation, and a failed
 * connection leaves the previous registration exactly as it was. Every process here is a fixture: no ChatGPT, no relay, no
 * launchd and no real state folder.
 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-activate-")); const state = join(directory, "state"); await mkdir(state, { mode: 0o700 });
  const configPath = join(directory, "gateway.json"), nativeHome = join(directory, "native"), codex = join(directory, "codex");
  const relayHome = join(dirname(nativeRelayHome(configPath, nativeHome)), "relay-under-test");
  const args = ["--native-home", nativeHome, "--relay-home", relayHome, "--gateway", "/usr/bin/true", "--gateway-config", configPath, "--codex", codex, "--daemon"];
  const plan: ServicePlan = { version: 1, config: configPath, components: [
    { id: "inference", kind: "inference", command: "/usr/bin/true", args: [], log: join(directory, "inference.log") },
    { id: "native", kind: "native", command: "/usr/bin/true", args, log: join(directory, "native.log") }] };
  configureTelemetry(state, "test");
  const exists = (path: string) => access(path).then(() => true, () => false);
  const events = async (name: string) => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === name); };
  return { directory, state, configPath, nativeHome, codex, relayHome, plan, exists, events, clean: () => rm(directory, { recursive: true, force: true }) };
}
const calm = (overrides: Partial<PlanRelayDeps> = {}): PlanRelayDeps => ({
  appRunning: async () => false, check: async () => {}, enable: async () => {}, clearHolders: async () => 0, ...overrides });

test("the registration is pending while the relay connects, and final once it did", async () => {
  const f = await fixture();
  try {
    const seen: Record<string, unknown> = {};
    await registerPlanRelay(f.state, f.plan, calm({
      clearHolders: async pendingAtMs => { seen.pendingBeforeClear = await f.exists(nativePendingPath(f.state)); seen.pendingAt = pendingAtMs; return 0; },
      enable: async () => {
        seen.pendingDuringEnable = JSON.parse(await readFile(nativePendingPath(f.state), "utf8"));
        seen.finalDuringEnable = await f.exists(nativeRegistrationPath(f.state));
      } }));
    const receipt = { registered: true, home: f.relayHome, nativeHome: f.nativeHome, codex: f.codex };
    assert.equal(seen.pendingBeforeClear, true, "listeners are retired only after a restarting listener would already stand down");
    assert.deepEqual(seen.pendingDuringEnable, receipt, "an adapter or listener that starts during --enable already sees the relay as registered");
    assert.equal(seen.finalDuringEnable, false, "the final registration waits for the connection");
    assert.deepEqual(JSON.parse(await readFile(nativeRegistrationPath(f.state), "utf8")), receipt);
    assert.equal(await f.exists(nativePendingPath(f.state)), false, "pending is gone once the registration is final");
  } finally { await f.clean(); }
});

test("a relay that fails to connect leaves the previous registration byte for byte, and no pending record", async () => {
  const f = await fixture();
  try {
    // An older registration, formatted the way no writer would, to prove the file is never rewritten.
    const previous = `{"registered":true,   "home":"${f.relayHome}-old","nativeHome":"${f.nativeHome}","codex":"${f.codex}" , "extra":1}\n`;
    await writeFile(nativeRegistrationPath(f.state), previous, { mode: 0o600 });
    for (const [message, reason] of [["Native relay did not connect within 45 seconds", "timeout"], ["Native relay stopped before connecting; check the Codex build and host sign-in", "exit"]] as const) {
      await assert.rejects(registerPlanRelay(f.state, f.plan, calm({ enable: async () => { throw new Error(message); } })), (error: Error) => error.message.startsWith(message) && /previous registration was kept/.test(error.message));
      assert.equal(await readFile(nativeRegistrationPath(f.state), "utf8"), previous, `${reason}: the previous file is untouched`);
      assert.equal(await f.exists(nativePendingPath(f.state)), false, `${reason}: the pending record is rolled back`);
    }
    assert.deepEqual((await f.events("native_activation_failed")).map(event => event.reason), ["timeout", "exit"]);
  } finally { await f.clean(); }
});

test("a busy listener refuses the activation: nothing connects, nothing is registered, pending is rolled back", async () => {
  const f = await fixture();
  try {
    let enabled = false;
    await assert.rejects(registerPlanRelay(f.state, f.plan, calm({ enable: async () => { enabled = true; }, clearHolders: async () => { throw new Error("An SSH session from another Mac is using this Mac; retry when it is idle"); } })),
      /retry when it is idle/);
    assert.equal(enabled, false);
    assert.equal(await f.exists(nativeRegistrationPath(f.state)), false);
    assert.equal(await f.exists(nativePendingPath(f.state)), false);
  } finally { await f.clean(); }
});

test("an open ChatGPT app still refuses before anything is written", async () => {
  const f = await fixture();
  try {
    let cleared = false;
    await assert.rejects(registerPlanRelay(f.state, f.plan, calm({ appRunning: async () => true, clearHolders: async () => { cleared = true; return 0; } })), /Quit ChatGPT normally/);
    assert.equal(cleared, false);
    assert.equal(await f.exists(nativePendingPath(f.state)), false);
    assert.equal(await f.exists(nativeRegistrationPath(f.state)), false);
    assert.deepEqual((await f.events("native_activation_refused")).map(event => event.reason), ["app_running"]);
  } finally { await f.clean(); }
});

/** A process list as `ps -axo pid=,ppid=,lstart=,args=` prints it; `at` is a start time in ms. */
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lstart = (at: number) => { const d = new Date(at); const p = (n: number) => String(n).padStart(2, "0"); return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`; };
const row = (pid: number, parent: number, at: number, args: string) => `${String(pid).padStart(6)} ${String(parent).padStart(6)} ${lstart(at)} ${args}`;
const config = "/Users/x/gateway.json";
const pendingAt = Date.now(); const before = pendingAt - 3_600_000;
const listener = (pid: number, at = before, cfg = config) => row(pid, 1, at, `/usr/bin/node /g/cli.js codex-shim --config ${cfg} --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --ssh -- app-server --listen unix://`);
const engine = (pid: number, parent: number, at = before) => row(pid, parent, at, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex app-server --listen stdio://");

test("only stock engines under this gateway's listeners that started before the pending record can hold the slot", () => {
  const snapshot = [
    listener(100), engine(101, 100),
    row(102, 100, before, "/g/gateway-codex app-server -c model_catalog_json=/state/catalog.json"),
    row(110, 1, before, `/usr/bin/node /g/cli.js codex-shim --config ${config} --codex /c --ssh -- proxy`),
    listener(120, pendingAt + 5000), engine(121, 120, pendingAt + 5000),
    listener(130, before, "/Users/y/other.json"), engine(131, 130),
    row(140, 1, before, `/usr/bin/node /g/cli.js codex-shim --config ${config} --codex /c -- app-server`), engine(141, 140),
    engine(150, 1),
  ].join("\n");
  assert.deepEqual(slotHolders(snapshot, config, pendingAt), [{ pid: 101, owner: 100, kind: "ssh-listener" }, { pid: 141, owner: 140, kind: "adapter" }]);
});

function holderDeps(snapshot: string, state: Record<number, "idle" | "busy" | "unknown">, overrides: Partial<HolderDeps> = {}) {
  const gone = new Set<number>(); const terminated: number[] = [];
  const deps: HolderDeps = { snapshot: async () => snapshot, activity: async (_home, pid) => state[pid] ?? "unknown",
    terminate: pid => { terminated.push(pid); setTimeout(() => { gone.add(pid); gone.add(pid + 1); }, 20); }, alive: pid => !gone.has(pid), stopWaitMs: 2000, pollMs: 10, ...overrides };
  return { deps, terminated };
}
const run = (deps: HolderDeps) => clearSlotHolders({ configPath: config, sshHome: "/ssh", pendingAtMs: pendingAt }, deps);

test("an idle listener is retired gracefully and waited for before the relay connects", async () => {
  const f = await fixture();
  try {
    const { deps, terminated } = holderDeps([listener(100), engine(101, 100)].join("\n"), { 100: "idle" });
    assert.equal(await run(deps), 1);
    assert.deepEqual(terminated, [100], "the listener got a TERM; its engine was never signalled");
    assert.deepEqual((await f.events("native_listener_retired")).map(event => event.count), [1]);
  } finally { await f.clean(); }
});

test("a busy listener, one that cannot say, or another adapter refuses and nothing is signalled", async () => {
  const f = await fixture();
  try {
    const snapshot = [listener(100), engine(101, 100), listener(200), engine(201, 200)].join("\n");
    for (const [state, reason] of [[{ 100: "idle", 200: "busy" }, "listener_busy"], [{ 100: "idle", 200: "unknown" }, "listener_unknown"]] as const) {
      const { deps, terminated } = holderDeps(snapshot, state);
      await assert.rejects(run(deps), /SSH session from another Mac is using this Mac; retry when it is idle/);
      assert.deepEqual(terminated, [], `${reason}: the idle listener is spared too, so the refusal changes nothing`);
    }
    const adapter = holderDeps([row(140, 1, before, `/usr/bin/node /g/cli.js codex-shim --config ${config} --codex /c -- app-server`), engine(141, 140)].join("\n"), {});
    await assert.rejects(run(adapter.deps), /Codex session on this Mac/);
    assert.deepEqual(adapter.terminated, []);
    assert.deepEqual((await f.events("native_activation_refused")).map(event => event.reason), ["listener_busy", "listener_unknown", "adapter_running"]);
  } finally { await f.clean(); }
});

test("a listener that became busy after the first answer keeps its sessions, and one that will not stop fails the activation", async () => {
  const snapshot = [listener(100), engine(101, 100)].join("\n");
  let asked = 0;
  const flip = holderDeps(snapshot, {}, { activity: async () => ++asked === 1 ? "idle" : "busy" });
  await assert.rejects(run(flip.deps), /retry when it is idle/);
  assert.deepEqual(flip.terminated, []);
  const stuck = holderDeps(snapshot, { 100: "idle" }, { alive: () => true, stopWaitMs: 50 });
  await assert.rejects(run(stuck.deps), /did not stop/);
});

test("a machine with no holder retires nothing", async () => {
  const none = holderDeps(listener(100), { 100: "idle" });
  assert.equal(await run(none.deps), 0);
  assert.deepEqual(none.terminated, []);
});

test("an SSH listener records whether any of its sessions runs a turn, and no record reads as unknown", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gw-listener-")); const pid = process.pid;
  try {
    assert.equal(await readListenerActivity(folder, pid), "unknown", "a listener from a release without records");
    const activity = new ListenerActivity(folder, pid); const sent: unknown[] = [];
    activity.publish();
    await new Promise(done => setTimeout(done, 30));
    assert.equal(await readListenerActivity(folder, pid), "idle", "a listener with no session is idle");
    const session = activity.open(async message => { sent.push(message); });
    await session.emit({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1", status: "inProgress" } } });
    await new Promise(done => setTimeout(done, 30));
    assert.equal(await readListenerActivity(folder, pid), "busy", "a running turn keeps the listener");
    assert.equal(sent.length, 1, "the client still receives every message");
    await session.emit({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed" } } });
    await new Promise(done => setTimeout(done, 30));
    assert.equal(await readListenerActivity(folder, pid), "idle");
    await session.emit({ method: "turn/started", params: { threadId: "t2", turn: { id: "u2", status: "inProgress" } } });
    session.close();
    await new Promise(done => setTimeout(done, 30));
    assert.equal(await readListenerActivity(folder, pid), "idle", "a session that ended runs nothing");
    await activity.stop();
    assert.equal(await readListenerActivity(folder, pid), "unknown");
    await writeFile(listenerActivityPath(folder, 999999), JSON.stringify({ pid: 1, busy: false }));
    assert.equal(await readListenerActivity(folder, 999999), "unknown", "a record for another pid says nothing");
    assert.ok((await stat(folder)).isDirectory());
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("the shared host's native engine stands down whenever the relay is registered, live or not", () => {
  assert.equal(nativeExecutionEnvironment("/native", true).CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1");
  assert.equal(nativeExecutionEnvironment("/native", false).CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, undefined, "an unregistered Mac keeps today's behaviour");
  assert.throws(() => nativeExecutionArgs(["app-server", "--remote-control"], "/s", true), /conflicts with managed relay ownership/);
});
