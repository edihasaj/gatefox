import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { SharedNativeConnection } from "../shared-native-connection.js";
import type { Message } from "../app-server-connection.js";

type Received = { socket: WebSocket; client: number; message: Message };
async function fixture(onRequest: (value: Received) => void) {
  const directory = await mkdtemp("/tmp/gw-native-client-");
  const path = join(directory, "native.sock");
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  const received: Received[] = [];
  wss.on("connection", socket => {
    const client = sockets.push(socket);
    socket.on("message", data => {
      const value = { socket, client, message: JSON.parse(data.toString()) as Message };
      received.push(value); onRequest(value);
    });
  });
  server.listen(path); await once(server, "listening"); await chmod(path, 0o600);
  return { path, server, sockets, received, async close() {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.fail("Expected native socket activity did not arrive");
}
const options = { skip: process.platform === "win32", timeout: 5000 };

test("shared native clients retain independent RPC sessions while using the same engine threads", options, async () => {
  const threads = new Map<string, Message>();
  const f = await fixture(({ socket, client, message }) => {
    if (message.id === undefined || typeof message.method !== "string") return;
    let result: Message = { engine: "original-native", client };
    if (message.method === "thread/start") {
      result = { thread: { id: "native-thread", cwd: "/workspace" } };
      threads.set("native-thread", result);
    }
    if (["thread/read", "thread/resume"].includes(message.method)) result = threads.get("native-thread")!;
    socket.send(JSON.stringify({ id: message.id, result }));
  });
  let exitsA = 0; let exitsB = 0;
  const a = new SharedNativeConnection(f.path, async () => {}, () => { exitsA++; });
  const b = new SharedNativeConnection(f.path, async () => {}, () => { exitsB++; });
  try {
    assert.equal(a.shared, true); assert.equal(b.shared, true);
    const initialized = await Promise.all([a.request("initialize", {}), b.request("initialize", {})]);
    await Promise.all([a.ready, b.ready]);
    assert.deepEqual(initialized.map(value => value.engine), ["original-native", "original-native"]);
    assert.deepEqual(initialized.map(value => value.client).sort(), [1, 2]);
    assert.deepEqual(f.received.slice(0, 2).map(value => value.message.id), [1, 1]);
    a.send({ method: "initialized" }); b.send({ method: "initialized" });
    const started = await a.request("thread/start", { cwd: "/workspace" });
    assert.deepEqual(await b.request("thread/resume", { threadId: "native-thread" }), started);
    a.stop(); a.stop();
    assert.deepEqual(await a.exited, { code: 0, signal: null }); await a.drained;
    assert.equal(a.closed, true); assert.equal(exitsA, 1); assert.equal(exitsB, 0);
    assert.equal(b.closed, false); assert.equal(f.server.listening, true);
    assert.deepEqual(await b.request("thread/read", { threadId: "native-thread" }), started);
    await assert.rejects(a.request("thread/read", { threadId: "native-thread" }), /closed/);
    const replacement = new SharedNativeConnection(f.path, async () => {}, () => {});
    try {
      await replacement.ready;
      assert.deepEqual(await replacement.request("thread/read", { threadId: "native-thread" }), started);
    } finally { replacement.stop(); await replacement.drained; }
  } finally { a.stop(); b.stop(); await Promise.all([a.drained, b.drained]); await f.close(); }
});

test("shared native approvals and notifications route to their client despite colliding request IDs", options, async () => {
  const f = await fixture(({ socket, client, message }) => {
    if (message.method === "nested/read") socket.send(JSON.stringify({ id: message.id, result: { client, read: true } }));
  });
  const messagesA: Message[] = []; const messagesB: Message[] = [];
  let nested: Message | undefined;
  const a = new SharedNativeConnection(f.path, async message => {
    messagesA.push(message);
    if (message.method === "item/commandExecution/requestApproval") {
      nested = await a.request("nested/read", {});
      a.send({ id: message.id, result: { decision: "accept" } });
    }
  }, () => {});
  const b = new SharedNativeConnection(f.path, async message => {
    messagesB.push(message);
    if (message.method === "item/commandExecution/requestApproval") b.send({ id: message.id, result: { decision: "decline" } });
  }, () => {});
  try {
    await Promise.all([a.ready, b.ready]);
    const heldA = a.request("held", { owner: "a" }); const heldB = b.request("held", { owner: "b" });
    let settledA = false; let settledB = false;
    void heldA.then(() => { settledA = true; }, () => { settledA = true; });
    void heldB.then(() => { settledB = true; }, () => { settledB = true; });
    await until(() => f.received.filter(value => value.message.method === "held").length === 2);
    const receivedA = f.received.find(value => (value.message.params as Message)?.owner === "a")!;
    const receivedB = f.received.find(value => (value.message.params as Message)?.owner === "b")!;
    const approvalA = { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-a" } };
    const approvalB = { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-b" } };
    const completedA = { method: "turn/completed", params: { threadId: "thread-a", turnId: "turn-a" } };
    const completedB = { method: "turn/completed", params: { threadId: "thread-b", turnId: "turn-b" } };
    receivedA.socket.send(JSON.stringify(approvalA)); receivedA.socket.send(JSON.stringify(completedA));
    receivedB.socket.send(JSON.stringify(approvalB)); receivedB.socket.send(JSON.stringify(completedB));
    await until(() => messagesA.length === 2 && messagesB.length === 2 && f.received.filter(value => value.message.result).length === 2);
    assert.deepEqual(messagesA, [approvalA, completedA]); assert.deepEqual(messagesB, [approvalB, completedB]);
    assert.deepEqual(nested, { client: receivedA.client, read: true });
    assert.equal(settledA, false); assert.equal(settledB, false);
    assert.deepEqual(f.received.filter(value => value.message.result).map(value => ({ client: value.client, id: value.message.id, result: value.message.result })).sort((left, right) => left.client - right.client), [
      { client: receivedA.client, id: 1, result: { decision: "accept" } },
      { client: receivedB.client, id: 1, result: { decision: "decline" } },
    ].sort((left, right) => left.client - right.client));
    receivedA.socket.send(JSON.stringify({ id: 1, result: { owner: "a" } }));
    receivedB.socket.send(JSON.stringify({ id: 1, result: { owner: "b" } }));
    assert.deepEqual(await Promise.all([heldA, heldB]), [{ owner: "a" }, { owner: "b" }]);
  } finally { a.stop(); b.stop(); await Promise.all([a.drained, b.drained]); await f.close(); }
});

test("unexpected shared native termination rejects pending RPC and waits for the handler to drain", options, async () => {
  const f = await fixture(() => {});
  let release!: () => void; let entered = false; let finished = false; let exits = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const client = new SharedNativeConnection(f.path, async () => {
    entered = true; await blocked; finished = true;
  }, () => { exits++; });
  try {
    await client.ready;
    const pending = client.request("held", {});
    const rejected = assert.rejects(pending, /socket closed/);
    f.sockets[0].send(JSON.stringify({ method: "turn/started", params: { threadId: "native-thread" } }));
    await until(() => entered && f.received.length === 1);
    let drained = false;
    const waitForDrain = client.drained.then(() => { drained = true; });
    f.sockets[0].terminate();
    await rejected;
    assert.deepEqual(await client.exited, { code: 1, signal: null });
    await delay(5);
    assert.equal(client.closed, true); assert.equal(exits, 1);
    assert.equal(finished, false); assert.equal(drained, false);
    release(); await waitForDrain;
    assert.equal(finished, true); assert.equal(drained, true);
    client.stop(); assert.equal(exits, 1); assert.equal(f.server.listening, true);
  } finally { release(); client.stop(); await client.drained; await f.close(); }
});
