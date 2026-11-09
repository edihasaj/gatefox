import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { AppServerBackends } from "../app-server-backends.js";
import { object, type Message } from "../app-server-connection.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { writePrivateJson, type GatewayConfig } from "../config.js";
import { executionHostHome, executionHostMarker, sdkIdentity, socketIdentity } from "../execution-host-storage.js";
import { setHostWaitForTests, type ExecutionHostClient } from "../execution-host-client.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

import { fixture, until, revision, instanceId, send } from "./shared-native-fixture.js";
isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

test("two native adapters retain original account and shared session after either client closes", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const second = await f.create();
    const started = await first.adapter.request("thread/start", { cwd: f.directory }); const id = String(object(started.thread).id);
    await first.adapter.request("turn/start", { threadId: id }); await first.adapter.stop();
    const resumed = await second.adapter.request("thread/resume", { threadId: id });
    assert.equal(resumed.executorPid, started.executorPid); assert.equal(object(resumed.thread).id, id);
    assert.equal(first.events.some(message => message.method === "error" || object(object(message.params).turn).status === "failed"), false);
    assert.deepEqual(await second.adapter.request("account/read", {}), { account: { type: "chatgpt", email: "fixture-primary@example.test" } });
    await second.adapter.request("turn/interrupt", { threadId: id, turnId: "native-turn" });
    await until(() => second.events.some(message => object(object(message.params).turn).status === "interrupted"));
    assert.equal(f.initializations.length, 2); assert.equal(object(f.initializations[0].clientInfo).name, "Codex Desktop");
    assert.equal(object(f.calls.find(message => message.method === "native/acquire")?.params).cwd, f.directory);
    assert.equal(f.calls.some(message => String(message.method).startsWith("execution/")), false);
    await f.noSpawn();
  } finally { await f.clean(); }
});

test("native-only adapter intent does not inherit gateway sharing from an older both-capability host", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await writePrivateJson(join(f.home, "owner.json"), { ...f.owner, capabilities: ["native", "gateway"] });
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedExecutors: false });
    f.snapshot.models.push({ slug: "claude/fixture", display_name: "Claude fixture" });
    const first = await f.create(); assert.equal(first.adapter.native.shared, true);
    // The fixture CLI exits after recording its private gateway home. A shared
    // route would instead call the host's forbidden execution/acquire method.
    await assert.rejects(first.adapter.request("thread/start", { model: "claude/fixture", modelProvider: "subscription_gateway" }, { engine: "gateway" }), /exited/);
    const spawned = JSON.parse(await readFile(f.spawnMarker, "utf8"));
    assert.notEqual(spawned.home, f.nativeHome); assert.ok(spawned.home.startsWith(join(f.config.stateDirectory, "desktop-generations") + "/"));
    assert.equal(spawned.authPresent, false); assert.equal(f.calls.some(message => String(message.method).startsWith("execution/")), false);
    assert.deepEqual(await first.adapter.request("account/read", {}), { account: { type: "chatgpt", email: "fixture-primary@example.test" } });
    assert.equal(first.adapter.native.closed, false);
  } finally { await f.clean(); }
});

test("turning off native sharing refuses a second original-native SDK while the old host owns it", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create();
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedNativeExecutor: false });
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /still owns/.test(error.message));
    assert.equal(f.calls.filter(message => message.method === "native/acquire").length, 1); await f.noSpawn();
    assert.equal(first.adapter.native.closed, false); await first.adapter.request("account/read", {});
  } finally { await f.clean(); }
});

test("a global live or unconfirmed native-home lease blocks legacy native spawn without a local host receipt", { timeout: 10000 }, async () => {
  const f = await fixture(); const globalPath = nativeHomeOwnerPath(f.nativeHome);
  try {
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedNativeExecutor: false });
    await rm(join(f.home, "owner.json"));
    for (const state of [{ hostPid: process.pid, pid: 0, sdkState: "idle" }, { hostPid: 0, pid: 0, sdkState: "starting" }]) {
      await writePrivateJson(globalPath, { version: 1, managed: "subscription-gateway-native-execution-owner", configPath: join(f.directory, "other.json"),
        nativeHome: f.nativeHome, codex: f.owner.codex, sdkSha256: f.owner.sdkSha256, socketPath: join(f.home, "native.sock"), state: "running", ...state });
      await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001);
      await f.noSpawn();
    }
    assert.equal(f.calls.length, 0);
  } finally { await rm(dirname(globalPath), { recursive: true, force: true }); await f.clean(); }
});

test("native adapter shutdown rejects a stalled host control operation before waiting for creation", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); f.hooks.stallRelease = true;
    // A generation retirement awaits this real control RPC in the creation queue.
    const state = first.adapter as unknown as { nativeHost: { client: ExecutionHostClient }; creating: Promise<unknown> };
    const release = state.nativeHost.client.release("b".repeat(64));
    state.creating = release.catch(() => {});
    await until(() => f.calls.some(message => message.method === "execution/release"));
    await Promise.race([first.adapter.stop(), delay(1000).then(() => { throw new Error("Shutdown waited for the host RPC timeout"); })]);
    await assert.rejects(release, /closed/); assert.equal(f.threads.size, 0); await f.noSpawn();
  } finally { f.disconnectControl(); await f.clean(); }
});

test("shared native default workspace applies only to new chats", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create();
    const started = await first.adapter.request("thread/start", { cwd: null });
    assert.equal(object(started.thread).cwd, process.cwd());
    await first.adapter.request("thread/resume", { threadId: object(started.thread).id });
    await first.adapter.request("thread/fork", { threadId: object(started.thread).id });
    await first.adapter.native.request("config/read", {}); await first.adapter.native.request("config/read", { cwd: null });
    await first.adapter.native.request("configRequirements/read", {}); await first.adapter.native.request("externalAgentConfig/detect", { cwds: [f.directory] });
    for (const method of ["thread/resume", "thread/fork", "configRequirements/read", "externalAgentConfig/detect"]) {
      assert.equal(Object.hasOwn(object(f.nativeCalls.find(message => message.method === method)?.params), "cwd"), false);
    }
    const reads = f.nativeCalls.filter(message => message.method === "config/read");
    assert.deepEqual(reads.map(message => object(message.params)), [{}, { cwd: null }]);
    await f.noSpawn();
  } finally { await f.clean(); }
});

test("shared-native transport loss closes frontend without reporting native SDK death", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const started = await first.adapter.request("thread/start", { cwd: f.directory }); const id = String(object(started.thread).id);
    await first.adapter.request("turn/start", { threadId: id });
    await first.adapter.request("fixture/drop", {}).catch(() => {}); await until(() => first.exits() === 1);
    assert.equal(first.events.some(message => message.method === "error" || message.method === "turn/completed"), false);
    const second = await f.create(); assert.equal(object((await second.adapter.request("thread/resume", { threadId: id })).thread).id, id);
    assert.equal(f.threads.has(id), true); await f.noSpawn();
  } finally { await f.clean(); }
});

const controlLostEvents = async (f: Awaited<ReturnType<typeof fixture>>, since: number) => { await flushTelemetry(); return (await readTelemetry(f.config.stateDirectory, since)).filter(event => event.event === "execution_host_control_lost"); };

// The host may drop the control connection while its own process and engine keep running. That connection is what the host
// keys this session's native ownership to, so the session must end and the app must reconnect; the running turn is not failed.
test("losing the executor host control connection ends the session and the next one acquires the host again", { timeout: 10000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
    await first.adapter.request("turn/start", { threadId: id });
    await until(() => first.events.some(message => message.method === "turn/started")); // The turn is live when the host drops control.
    f.disconnectControl();
    await until(() => first.exits() === 1);
    assert.equal(first.adapter.native.closed, true);
    assert.equal(first.events.some(message => message.method === "error" || object(object(message.params).turn).status === "failed"), false);
    const events = await controlLostEvents(f, since);
    assert.equal(events.length, 1); assert.equal(events[0].sharedGateway, false);
    assert.deepEqual(Object.keys(events[0]).sort(), ["at", "component", "event", "host", "pid", "sharedGateway"]);
    await Promise.race([first.adapter.stop(), delay(1000, undefined, { ref: false }).then(() => { throw new Error("Shutdown after a lost host control connection never finished"); })]);
    const second = await f.create();
    assert.equal(object((await second.adapter.request("thread/resume", { threadId: id })).thread).id, id);
    assert.equal(f.calls.filter(message => message.method === "native/acquire").length, 2); await f.noSpawn();
  } finally { await f.clean(); }
});

// The exit path the fix reuses ends only after the engine's last frames are forwarded. A desktop app that stopped reading parks
// one of them there forever, so the lost-host teardown must bound that wait instead of inheriting it.
test("a lost host control connection ends the session while blocked frontend output holds a notification", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
    await first.adapter.request("turn/start", { threadId: id });
    f.hooks.emit = async message => { if (message.method === "turn/started") await held; };
    f.nativeMessages([{ method: "turn/started", params: { threadId: id, turn: { id: "wedged-turn", status: "inProgress" } } }]);
    await until(() => first.events.length === 2); // The turn is tracked and live; only its delivery is parked on the blocked write.
    f.disconnectControl();
    await until(() => first.exits() === 1, 1500);
    assert.equal(first.adapter.native.closed, true);
    assert.equal(first.events.some(message => message.method === "error" || object(object(message.params).turn).status === "failed"), false);
    release(); await first.adapter.native.drained;
    await Promise.race([first.adapter.stop(), delay(1000, undefined, { ref: false }).then(() => { throw new Error("Shutdown stayed wedged behind the released notification"); })]);
  } finally { release(); await f.clean(); }
});

test("a deliberate stop closes the control connection without recording a host loss", { timeout: 10000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    const first = await f.create();
    await first.adapter.request("thread/start", { cwd: f.directory });
    await first.adapter.stop();
    assert.equal(first.exits(), 1);
    assert.equal((await controlLostEvents(f, since)).length, 0); await f.noSpawn();
  } finally { await f.clean(); }
});

const stopCleanly = (adapter: AppServerBackends) => Promise.race([adapter.stop(), delay(1000, undefined, { ref: false }).then(() => { throw new Error("Shutdown stayed wedged behind output the app had not read"); })]);

// A confirmed engine death is reported through an `error` and a failed `turn/completed`, and either one can park on an app that
// stopped reading. Here the engine socket dies first, so the host control loss arrives with `native.closed` already true: the
// bound must arm itself without closing anything, and the loop must stop rather than park on the next frame.
async function deathReportBlockedOn(f: Awaited<ReturnType<typeof fixture>>, frame: "error" | "turn/completed", held: Promise<void>) {
  const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
  await first.adapter.request("turn/start", { threadId: id });
  f.hooks.emit = async message => { if (message.method === frame) await held; };
  f.nativeDeath();
  await until(() => first.events.some(message => message.method === "error")); // the host confirmed this exact launch died
  assert.equal(first.adapter.native.closed, true);
  f.disconnectControl();
  await until(() => first.exits() === 1, 2000);
  return first;
}

test("a lost host control connection bounds a death report the app has not read", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await deathReportBlockedOn(f, "error", held);
    assert.equal(first.events.some(message => message.method === "turn/completed"), false);
    release(); await stopCleanly(first.adapter); assert.equal(first.exits(), 1);
  } finally { release(); await f.clean(); }
});

test("a lost host control connection bounds the failed completion of a death report", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await deathReportBlockedOn(f, "turn/completed", held);
    const completed = first.events.filter(message => message.method === "turn/completed");
    assert.equal(completed.length, 1); assert.equal(object(object(completed[0].params).turn).status, "failed");
    release(); await stopCleanly(first.adapter); assert.equal(first.exits(), 1);
  } finally { release(); await f.clean(); }
});

test("confirmed native SDK death reports the actual active turn from a warm resume snapshot", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id }); await first.adapter.stop();
    const second = await f.create(); await second.adapter.request("thread/resume", { threadId: id });
    assert.equal(second.events.some(message => message.method === "turn/started"), false);
    f.nativeDeath(); await until(() => second.exits() === 1);
    const failed = second.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.equal(failed.length, 1); assert.equal(object(failed[0].params).threadId, id); assert.equal(object(object(failed[0].params).turn).id, "native-turn");
    assert.equal(second.events.filter(message => message.method === "error").length, 1);
    assert.doesNotMatch(JSON.stringify(second.events), /original-primary-secret/); await f.noSpawn();
  } finally { await f.clean(); }
});

test("native socket EOF before the host close observer waits only for the exact launch death", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id }); f.nativeDeath(100);
    await until(() => first.adapter.native.closed); assert.equal(first.exits(), 0);
    await until(() => first.exits() === 1);
    const lookups = f.calls.filter(message => message.method === "native/death"); assert.ok(lookups.length >= 2);
    for (const lookup of lookups) assert.deepEqual(lookup.params, { revision, pid: process.pid, instanceId });
    const failed = first.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.equal(failed.length, 1); assert.equal(object(object(failed[0].params).turn).id, "native-turn");
  } finally { await f.clean(); }
});

test("native unsubscribe and warm resume replace a stale active turn with the real current turn", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id }); await first.adapter.request("thread/unsubscribe", { threadId: id });
    const second = await f.create(); await second.adapter.request("turn/interrupt", { threadId: id, turnId: "native-turn" });
    await second.adapter.request("turn/start", { threadId: id, fixtureTurnId: "native-next-turn" });
    await first.adapter.request("thread/resume", { threadId: id }); f.nativeDeath(); await until(() => first.exits() === 1);
    const failed = first.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.deepEqual(failed.map(message => object(object(message.params).turn).id), ["native-next-turn"]);
  } finally { await f.clean(); }
});

test("a delayed native resume snapshot cannot replace a newer actual turn notification", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", {})).thread).id);
    await first.adapter.request("turn/start", { threadId: id });
    const resume = first.adapter.request("thread/resume", { threadId: id, delayMs: 75 });
    await until(() => f.nativeCalls.some(message => message.method === "thread/resume"));
    const turn = { id: "native-newer-turn", status: "inProgress" }; f.threads.get(id)!.turns = [turn];
    f.nativeMessages([{ method: "turn/started", params: { threadId: id, turn } }]);
    await resume; f.nativeDeath(); await until(() => first.exits() === 1);
    const failed = first.events.filter(message => object(object(message.params).turn).status === "failed");
    assert.deepEqual(failed.map(message => object(object(message.params).turn).id), ["native-newer-turn"]);
  } finally { await f.clean(); }
});

test("buffered native completion drains before confirmed SDK death is assessed", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await f.create();
    f.hooks.emit = async message => { if (message.method === "turn/started") await held; };
    f.nativeMessages([{ method: "turn/started", params: { threadId: "buffered-chat", turn: { id: "buffered-turn", status: "inProgress" } } },
      { method: "turn/completed", params: { threadId: "buffered-chat", turn: { id: "buffered-turn", status: "completed" } } }]);
    await until(() => first.events.length === 1); await delay(5); f.nativeDeath();
    await until(() => first.adapter.native.closed); assert.equal(first.exits(), 0);
    release(); await until(() => first.exits() === 1);
    assert.deepEqual(first.events.map(message => message.method), ["turn/started", "turn/completed"]);
    assert.equal(object(object(first.events[1].params).turn).status, "completed"); await f.noSpawn();
  } finally { release(); await f.clean(); }
});

test("deliberate shared-native stop discards queued notifications without awaiting blocked output", { timeout: 10000 }, async () => {
  const f = await fixture(); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = await f.create();
    f.hooks.emit = async message => { if (message.method === "turn/started") await held; };
    f.nativeMessages([{ method: "turn/started", params: { threadId: "held-chat", turn: { id: "held-turn", status: "inProgress" } } },
      { method: "turn/completed", params: { threadId: "held-chat", turn: { id: "held-turn", status: "completed" } } }]);
    await until(() => first.events.length === 1);
    await Promise.race([first.adapter.stop(), delay(1000, undefined, { ref: false }).then(() => { throw new Error("Client stop waited for blocked output"); })]);
    release(); await first.adapter.native.drained;
    assert.deepEqual(first.events.map(message => message.method), ["turn/started"]); assert.equal(first.exits(), 1);
    await f.noSpawn();
  } finally { release(); await f.clean(); }
});

test("warm native resume reuses pending approval ID and rejects inconsistent replay", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
    await first.adapter.request("fixture/approval", { threadId: id }); await first.adapter.request("thread/resume", { threadId: id });
    await until(() => first.events.filter(message => message.method === "item/commandExecution/requestApproval").length === 2);
    const approvals = first.events.filter(message => message.method === "item/commandExecution/requestApproval"); assert.equal(approvals[0].id, approvals[1].id);
    assert.equal(first.adapter.reply({ id: approvals[0].id, result: { decision: "accept" } }), true);
    await until(() => f.replies.length === 1); assert.equal(f.replies[0].id, 77);
    await first.adapter.request("thread/resume", { threadId: id }); await delay(10);
    assert.equal(first.exits(), 0); assert.equal(first.events.filter(message => message.method === "item/commandExecution/requestApproval").length, 2);
    assert.equal(f.replies.length, 1);
    const second = await f.create(); await second.adapter.request("fixture/approval", { threadId: id });
    await second.adapter.request("fixture/inconsistent", { threadId: id }); await until(() => f.replies.length === 2);
    assert.deepEqual(f.replies[1], { id: 77, error: { code: -32603, message: "The adapter could not deliver this request" } });
    assert.equal(second.exits(), 0);
    const displayed = second.events.filter(message => message.method === "item/commandExecution/requestApproval");
    assert.equal(displayed.length, 1); assert.equal(object(displayed[0].params).command, "fixture-only");
    assert.equal(object((await second.adapter.request("account/read", {})).account).type, "chatgpt");
    f.nativeMessages([{ method: "serverRequest/resolved", params: { requestId: 77 } }]);
    await until(() => second.events.some(message => message.method === "serverRequest/resolved"));
    assert.equal(object(second.events.find(message => message.method === "serverRequest/resolved")!.params).requestId, displayed[0].id);
    assert.equal(second.adapter.reply({ id: displayed[0].id, result: { decision: "accept" } }), false);
    assert.equal(f.replies.length, 2, "a late UI answer cannot execute the resolved callback");
    assert.equal(second.events.some(message => message.method === "turn/completed"), false); await f.noSpawn();
  } finally { await f.clean(); }
});

test("configured native sharing fails closed for missing host, wrong scope, or absent capability", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (const owner of [undefined, { ...f.owner, nativeHome: join(f.directory, "wrong") }, { ...f.owner, capabilities: ["gateway"] }]) {
      if (owner) await writePrivateJson(join(f.home, "owner.json"), owner); else await rm(join(f.home, "owner.json"));
      await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001);
      await f.noSpawn();
    }
    assert.equal(f.calls.length, 0);
    await writePrivateJson(join(f.home, "owner.json"), f.owner);
    const planPath = join(f.config.stateDirectory, "service-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")); await writePrivateJson(planPath, { ...plan, sharedExecutors: true });
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /gateway/.test(error.message));
    await f.noSpawn(); assert.equal(f.calls.length, 0);
  } finally { await f.clean(); }
});

async function sharedPlan(f: Awaited<ReturnType<typeof fixture>>, capabilities: string[], plan: Message = { sharedExecutors: true }) {
  await writePrivateJson(join(f.home, "owner.json"), { ...f.owner, capabilities });
  const planPath = join(f.config.stateDirectory, "service-plan.json");
  await writePrivateJson(planPath, { ...JSON.parse(await readFile(planPath, "utf8")), ...plan });
}
const fallbackEvents = async (f: Awaited<ReturnType<typeof fixture>>, since: number) => { await flushTelemetry(); return (await readTelemetry(f.config.stateDirectory, since)).filter(event => event.event === "native_sharing_fallback"); };

test("a gateway-only host makes the adapter fall back to a private native engine under the native-home lease and keep sharing gateway chats", { timeout: 30000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    // A host without native sharing runs no native engine, so nothing answers at its native socket.
    await sharedPlan(f, ["gateway"]); await f.closeNative();
    // Like the real engine, this one runs until its adapter closes its pipe; it records whether the lease was there first. The
    // record is renamed into place, so the test never reads it half written.
    const engine = join(f.directory, "engine"); const receipt = nativeHomeOwnerPath(f.nativeHome); const partial = `${f.spawnMarker}.partial`;
    await writeFile(engine, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(partial)},JSON.stringify({lease:fs.existsSync(${JSON.stringify(receipt)})}));fs.renameSync(${JSON.stringify(partial)},${JSON.stringify(f.spawnMarker)});process.stdin.on('end',()=>process.exit(0));process.stdin.resume();\n`, { mode: 0o700 });
    const adapter = await AppServerBackends.create(engine, ["app-server", "--listen", "stdio://"], f.config, {}, {}, { current: () => f.snapshot, refresh: async () => f.snapshot, combined: (value: typeof f.snapshot) => ({ models: value.models }) } as unknown as DesktopCatalog,
      async () => {}, () => {}, f.configPath);
    try {
      assert.notEqual(adapter.native.shared, true); assert.equal((adapter as unknown as { sharedGateway?: boolean }).sharedGateway, true);
      assert.equal(f.calls.some(message => message.method === "native/acquire"), false);
      await until(() => existsSync(f.spawnMarker)); assert.deepEqual(JSON.parse(await readFile(f.spawnMarker, "utf8")), { lease: true });
      const events = await fallbackEvents(f, since); assert.equal(events.length, 1); assert.equal(events[0].reason, "other"); assert.equal(events[0].holders, 1);
      assert.deepEqual(Object.keys(events[0]).sort(), ["at", "component", "event", "holders", "host", "pid", "reason"]);
      // Like a host that is down, a host without native sharing leaves the native home to this adapter's lease alone.
      const lease = JSON.parse(await readFile(receipt, "utf8"));
      assert.equal(lease.hostPid, process.pid); assert.equal(lease.pid, (adapter.native as unknown as { pid?: number }).pid); assert.equal(typeof lease.privateOwner?.instanceId, "string");
    } finally { await adapter.stop(); }
    assert.equal(existsSync(receipt), false);
  } finally { await f.clean(); }
});

test("a full host keeps the shared native path and emits no fallback", { timeout: 10000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    await sharedPlan(f, ["native", "gateway"]);
    const first = await f.create(); assert.equal(first.adapter.native.shared, true);
    assert.equal(f.calls.filter(message => message.method === "native/acquire").length, 1); await f.noSpawn();
    assert.equal((await fallbackEvents(f, since)).length, 0);
  } finally { await f.clean(); }
});

// A host that is down may leave native chats to a private engine (see native-fallback.test.ts), but never while its native engine still answers.
test("an unavailable host whose native engine still answers fails closed", { timeout: 10000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    await sharedPlan(f, ["native", "gateway"]); await rm(join(f.home, "owner.json"));
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /host is unavailable/.test(error.message));
    await sharedPlan(f, ["native", "gateway"]); await writePrivateJson(join(f.home, "owner.json"), { ...f.owner, capabilities: ["native", "gateway"], pid: 0 });
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /host is unavailable/.test(error.message));
    assert.equal((await fallbackEvents(f, since)).length, 0); await f.noSpawn();
  } finally { await f.clean(); }
});

// A host that refuses native ownership because private engines hold the home lets the adapter join them, and only join them.
// While no private engines hold it (a host still exiting after a restart), the adapter asks the host again until the wait ends.
test("a host refusal with no private engine left to join is asked again, and the adapter shares the host's engine", { timeout: 30000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    f.hooks.refuseNative = 1;
    const first = await f.create(); assert.equal(first.adapter.native.shared, true);
    assert.equal(f.calls.filter(message => message.method === "native/acquire").length, 2); await f.noSpawn();
    assert.equal(existsSync(nativeHomeOwnerPath(f.nativeHome)), false); assert.equal((await fallbackEvents(f, since)).length, 0);
  } finally { await f.clean(); }
});

test("a host still refusing after its first claim is asked again until it takes the home, with no private engine started", { timeout: 30000 }, async () => {
  // After a restart the new host's claim can lose to the old host that is still exiting; the adapter waits for it to claim.
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    f.hooks.refuseNative = 3;
    const first = await f.create(); assert.equal(first.adapter.native.shared, true);
    assert.equal(f.calls.filter(message => message.method === "native/acquire").length, 4); await f.noSpawn();
    assert.equal(existsSync(nativeHomeOwnerPath(f.nativeHome)), false); assert.equal((await fallbackEvents(f, since)).length, 0);
  } finally { await f.clean(); }
});

test("a host that refuses through the whole wait fails the adapter, with no private engine started", { timeout: 30000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  setHostWaitForTests(600);
  try {
    f.hooks.refuseNative = 1_000_000;
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /ownership is held by a live owner/.test(error.message));
    await f.noSpawn();
    assert.equal(existsSync(nativeHomeOwnerPath(f.nativeHome)), false); assert.equal((await fallbackEvents(f, since)).length, 0);
  } finally { setHostWaitForTests(); await f.clean(); }
});

