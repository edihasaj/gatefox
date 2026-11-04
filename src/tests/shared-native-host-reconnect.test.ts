import test from "node:test";
import assert from "node:assert/strict";
import { object, type Message } from "../app-server-connection.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { ReconnectingNativeConnection } from "../reconnecting-native-connection.js";
import type { NativeRpcConnection } from "../shared-native-connection.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";
import { fixture, until } from "./shared-native-fixture.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

const events = async (f: Awaited<ReturnType<typeof fixture>>, since: number, name: string) => {
  await flushTelemetry(); return (await readTelemetry(f.config.stateDirectory, since)).filter(event => event.event === name);
};

// A host restart while no native turn runs must not end the desktop session: ChatGPT shows "hit a snag" when it does.
test("an idle session survives a host restart: it rejoins the restarted engine and resumes its loaded chats", { timeout: 20000 }, async () => {
  const f = await fixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    const first = await f.create();
    const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
    await first.adapter.request("thread/start", { cwd: f.directory, ephemeral: true });
    const initializations = f.initializations.length;
    f.restartHost();
    await until(() => f.calls.filter(message => message.method === "native/acquire").length === 2 && f.nativeCalls.some(message => message.method === "thread/resume"));
    // The app's next request reaches the restarted engine through the same session.
    const read = await first.adapter.request("thread/read", { threadId: id });
    assert.equal(object(read.thread).id, id);
    assert.equal(first.exits(), 0); assert.equal(first.adapter.native.closed, false);
    assert.equal(f.initializations.length, initializations + 1, "the app's initialize is replayed once");
    assert.deepEqual(f.initializations.at(-1), f.initializations[0]);
    const resumes = f.nativeCalls.filter(message => message.method === "thread/resume").map(message => object(message.params));
    assert.deepEqual(resumes, [{ threadId: id, excludeTurns: true }], "only the durable loaded chat is resumed");
    assert.equal((await events(f, since, "execution_host_reconnected")).length, 1);
    assert.equal((await events(f, since, "execution_host_control_lost")).length, 0);
    // A second restart is survived the same way: the new control connection is the one that is watched.
    f.restartHost();
    await until(() => f.calls.filter(message => message.method === "native/acquire").length === 3);
    assert.equal(object((await first.adapter.request("thread/read", { threadId: id })).thread).id, id);
    assert.equal(first.exits(), 0);
    await f.noSpawn();
  } finally { await f.clean(); }
});

test("a host restart during a native turn still ends the session without failing the turn", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
    await first.adapter.request("turn/start", { threadId: id });
    await until(() => first.events.some(message => message.method === "turn/started"));
    f.restartHost();
    await until(() => first.exits() === 1);
    assert.equal(first.adapter.native.closed, true);
    assert.equal(f.calls.filter(message => message.method === "native/acquire").length, 1, "no reconnect was attempted");
    assert.equal(first.events.some(message => message.method === "error" || object(object(message.params).turn).status === "failed"), false);
  } finally { await f.clean(); }
});

test("a deliberate stop during a host restart ends the session promptly", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); await first.adapter.request("thread/start", { cwd: f.directory });
    f.hooks.refuseNative = 1000; // The restarted host never hands the engine back, so the repair keeps trying.
    f.restartHost();
    await until(() => (first.adapter.native as ReconnectingNativeConnection).repairing);
    const held = first.adapter.native.request("thread/read", { threadId: "held" });
    const started = Date.now(); await first.adapter.stop();
    assert.ok(Date.now() - started < 3000, "stop does not wait out the repair");
    await assert.rejects(held, /closed/, "a request held by the repair is released by the stop");
    assert.equal(first.exits(), 1);
  } finally { f.hooks.refuseNative = 0; await f.clean(); }
});

test("a durable chat resumed with the throwaway flag is still resumed after a host restart", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.create(); const id = String(object((await first.adapter.request("thread/start", { cwd: f.directory })).thread).id);
    await first.adapter.request("thread/unsubscribe", { threadId: id });
    await first.adapter.request("thread/resume", { threadId: id, ephemeral: true });
    const before = f.nativeCalls.filter(message => message.method === "thread/resume").length;
    f.restartHost();
    await until(() => f.nativeCalls.filter(message => message.method === "thread/resume").length === before + 1);
    assert.deepEqual(object(f.nativeCalls.filter(message => message.method === "thread/resume").at(-1)!.params), { threadId: id, excludeTurns: true });
    assert.equal(first.exits(), 0);
  } finally { await f.clean(); }
});

function fakeSocket() {
  let exit!: () => void; let resolveExit!: (value: { code: null; signal: null }) => void;
  const sent: Message[] = [];
  const socket = {
    shared: true as const, closed: false, ready: Promise.resolve(),
    exited: new Promise<{ code: null; signal: null }>(resolve => { resolveExit = resolve; }),
    drained: Promise.resolve(),
    async request(method: string) { return { method }; },
    send(message: Message) { sent.push(message); },
    stop() { if (socket.closed) return; socket.closed = true; resolveExit({ code: null, signal: null }); exit(); },
  };
  return { socket: socket as NativeRpcConnection & typeof socket, sent, wire(onExit: () => void) { exit = onExit; } };
}

test("the reconnecting connection holds requests during a repair and exits once when the repair gives up", async () => {
  const sockets: ReturnType<typeof fakeSocket>[] = []; let exits = 0;
  const connection = new ReconnectingNativeConnection(onExit => { const next = fakeSocket(); next.wire(onExit); sockets.push(next); return next.socket; }, () => { exits++; });
  let finish!: (value: NativeRpcConnection | undefined) => void;
  connection.reconnect = replacement => new Promise(resolve => { finish = value => resolve(value ?? undefined); void replacement; });
  connection.drop();
  assert.equal(connection.repairing, true);
  const held = connection.request("thread/read", {}); connection.send({ method: "held" });
  finish(undefined);
  await assert.rejects(held, /closed/);
  assert.equal(exits, 1); assert.equal(connection.closed, true); assert.equal(sockets[0].sent.length, 0);
  await connection.exited; await connection.drained;
});

test("the reconnecting connection adopts a replacement and sends held messages to it", async () => {
  const sockets: ReturnType<typeof fakeSocket>[] = []; let exits = 0;
  const connection = new ReconnectingNativeConnection(onExit => { const next = fakeSocket(); next.wire(onExit); sockets.push(next); return next.socket; }, () => { exits++; });
  connection.reconnect = async replacement => replacement();
  connection.drop(); connection.send({ method: "held" });
  assert.deepEqual(await connection.request("thread/read", {}), { method: "thread/read" });
  assert.equal(sockets.length, 2); assert.deepEqual(sockets[1].sent, [{ method: "held" }]);
  assert.equal(exits, 0); assert.equal(connection.generation, 1);
  // The adopted socket's own loss is watched exactly once.
  connection.reconnect = undefined; sockets[1].socket.stop();
  await connection.exited; assert.equal(exits, 1);
});
