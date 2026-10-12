import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { Message } from "../app-server-connection.js";

type Received = { socket: WebSocket; number: number; message: Message };
async function fixture(onRequest: (value: Received) => void = ({ socket, number, message }) => {
  if (message.id !== undefined && typeof message.method === "string") socket.send(JSON.stringify({ id: message.id, result: { client: number, method: message.method } }));
}, filename = "rpc.sock") {
  const directory = await mkdtemp("/tmp/gw-ws-");
  const path = join(directory, filename);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  const received: Received[] = [];
  wss.on("connection", socket => {
    const number = sockets.push(socket);
    socket.on("message", data => {
      const value = { socket, number, message: JSON.parse(data.toString()) as Message };
      received.push(value); onRequest(value);
    });
  });
  server.listen(path); await once(server, "listening"); await chmod(path, 0o600);
  return { path, sockets, received, async close() {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.fail("Expected socket activity did not arrive");
}

test("Unix RPC clients initialize independently and stopping one preserves the engine and other clients", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const f = await fixture(); const exits: SocketAppServerConnection[] = [];
  const a = new SocketAppServerConnection(f.path, async () => {}, value => exits.push(value));
  const b = new SocketAppServerConnection(f.path, async () => {});
  try {
    // Both requests are legal while each independent socket is connecting.
    assert.deepEqual(await Promise.all([a.request("initialize", {}), b.request("initialize", {})]), [{ client: 1, method: "initialize" }, { client: 2, method: "initialize" }]);
    await Promise.all([a.ready, b.ready]);
    assert.deepEqual(f.received.map(value => value.message.id), [1, 1]);
    a.send({ method: "initialized" }); b.send({ method: "initialized" });
    a.stop(); assert.deepEqual(await a.exited, { code: 0, signal: null });
    assert.equal(a.closed, true); assert.deepEqual(exits, [a]);
    assert.equal(b.closed, false);
    assert.deepEqual(await b.request("model/list", {}), { client: 2, method: "model/list" });
    const c = new SocketAppServerConnection(f.path, async () => {});
    assert.deepEqual(await c.request("initialize", {}), { client: 3, method: "initialize" });
    c.stop(); await c.exited;
    await assert.rejects(a.request("model/list", {}), /closed/);
  } finally { a.stop(); b.stop(); await Promise.all([a.exited, b.exited]); await f.close(); }
});

test("Unix RPC preserves structured errors and routes server requests despite colliding client IDs", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const f = await fixture(({ socket, message }) => {
    if (message.method === "failure") socket.send(JSON.stringify({ id: message.id, error: { code: -32007, message: "Approval required", data: { reason: "permission", retryable: true } } }));
    if (message.method === "nested") socket.send(JSON.stringify({ id: message.id, result: { nested: true } }));
  });
  const messages: Message[] = []; let nested: Message | undefined;
  const client = new SocketAppServerConnection(f.path, async message => {
    messages.push(message);
    if (message.method === "approval") {
      nested = await client.request("nested", {});
      client.send({ id: message.id, result: { decision: "accept" } });
    }
  });
  try {
    await client.ready;
    const held = client.request("held", {}); let settled = false;
    void held.then(() => { settled = true; }, () => { settled = true; });
    await until(() => f.received.length === 1);
    f.sockets[0].send(JSON.stringify({ id: 1, method: "approval", params: { tool: "read" } }));
    f.sockets[0].send(JSON.stringify({ method: "turn/completed", params: { turn: "t1" } }));
    await until(() => f.received.some(value => value.message.result !== undefined));
    assert.deepEqual(nested, { nested: true }); assert.equal(settled, false);
    await until(() => messages.length === 2);
    assert.deepEqual(messages.map(value => value.method), ["approval", "turn/completed"]);
    f.sockets[0].send(JSON.stringify({ id: 1, result: { completed: true } }));
    assert.deepEqual(await held, { completed: true });
    await assert.rejects(client.request("failure", {}), error => {
      assert.equal((error as Error).message, "Approval required");
      assert.equal((error as Error & { code: number }).code, -32007);
      assert.deepEqual((error as Error & { data: unknown }).data, { reason: "permission", retryable: true }); return true;
    });
  } finally { client.stop(); await client.exited; await f.close(); }
});

test("Unix RPC bounds pending requests and UTF-8 frame bytes without poisoning the connection", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const f = await fixture(() => {}); const client = new SocketAppServerConnection(f.path, async () => {});
  try {
    await client.ready;
    const tooLarge = "é".repeat(8 * 1024 * 1024);
    assert.throws(() => client.send({ method: "oversized", params: { text: tooLarge } }), /exceeds 16 MiB/);
    await assert.rejects(client.request("oversized", { text: tooLarge }), /exceeds 16 MiB/);
    const requests = Array.from({ length: 256 }, () => client.request("pending", {}));
    const outcomes = Promise.allSettled(requests);
    await assert.rejects(client.request("overflow", {}), /Too many pending/);
    await until(() => f.received.length === 256);
    assert.equal(client.closed, false);
    client.stop(); await client.exited;
    const results = await outcomes;
    assert.equal(results.filter(result => result.status === "rejected").length, 256);
    assert.equal(f.received.some(value => value.message.method === "oversized" || value.message.method === "overflow"), false);
  } finally { client.stop(); await client.exited; await f.close(); }
});

test("Unix RPC connection failures, remote closes and invalid frames settle readiness and pending work", { skip: process.platform === "win32", timeout: 10000 }, async t => {
  await t.test("missing socket", async () => {
    const client = new SocketAppServerConnection("/tmp/no-gateway-engine-" + process.pid + ".sock", async () => {});
    const pending = client.request("initialize", {});
    await assert.rejects(Promise.all([client.ready, pending]), /socket failed/);
    await client.exited; assert.equal(client.closed, true);
  });
  for (const action of ["close", "malformed", "oversized", "binary", "handler"] as const) await t.test(action, async () => {
    const f = await fixture(() => {});
    const client = new SocketAppServerConnection(f.path, async () => { throw new Error("secret callback detail"); });
    try {
      await client.ready;
      const pending = client.request("held", {});
      const rejection = assert.rejects(pending, /socket closed|invalid JSON|socket failed|invalid frame|handler failed/);
      if (action === "close") f.sockets[0].close(1000);
      if (action === "malformed") f.sockets[0].send("not JSON: secret request content");
      if (action === "oversized") f.sockets[0].send("x".repeat(16 * 1024 * 1024 + 1));
      if (action === "binary") f.sockets[0].send(Buffer.from("{}"));
      if (action === "handler") f.sockets[0].send(JSON.stringify({ method: "handler" }));
      await rejection; await client.exited; assert.equal(client.closed, true);
    } finally { client.stop(); await client.exited; await f.close(); }
  });
});

test("Unix RPC rejects a notification flood while a handler is blocked", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const f = await fixture(() => {}); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const client = new SocketAppServerConnection(f.path, async () => blocked);
  try {
    await client.ready;
    const pending = client.request("held", {}); const rejection = assert.rejects(pending, /message queue is full/);
    for (let i = 0; i < 257; i++) f.sockets[0].send(JSON.stringify({ method: "notification", params: { i } }));
    await rejection; await client.exited; assert.equal(client.closed, true);
  } finally { release(); client.stop(); await client.exited; await f.close(); }
});

test("Unix RPC preserves spaces and URL-special characters in the private socket path", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const f = await fixture(undefined, "private é #?.sock"); const client = new SocketAppServerConnection(f.path, async () => {});
  try { assert.deepEqual(await client.request("initialize", {}), { client: 1, method: "initialize" }); }
  finally { client.stop(); await client.exited; await f.close(); }
});

test("Unix RPC stop before open rejects readiness and requests and leaves the listener available", { skip: process.platform === "win32", timeout: 5000 }, async () => {
  const f = await fixture(); const client = new SocketAppServerConnection(f.path, async () => {});
  try {
    const pending = client.request("initialize", {});
    client.stop(); client.stop();
    await assert.rejects(Promise.all([client.ready, pending]), /closed/);
    await client.exited; assert.equal(client.closed, true);
    const replacement = new SocketAppServerConnection(f.path, async () => {});
    await replacement.request("initialize", {}); replacement.stop(); await replacement.exited;
  } finally { client.stop(); await client.exited; await f.close(); }
});
