import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import type { Message } from "../app-server-connection.js";
import { shortFolder } from "./short-folder.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

type Received = { socket: WebSocket; number: number; message: Message };
async function fixture(onRequest: (value: Received) => void = ({ socket, number, message }) => {
  if (message.id !== undefined && typeof message.method === "string") socket.send(JSON.stringify({ id: message.id, result: { client: number, method: message.method } }));
}, filename = "rpc.sock") {
  const folder = await shortFolder("gw-ws-");
  const path = join(folder.directory, filename);
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
    await folder.remove();
  } };
}

async function until(check: () => boolean): Promise<void> {
  // A socket event that never comes fails here after ten seconds, or earlier by the test's own timeout; a loaded machine fails nothing.
  for (let i = 0; i < 2000; i++) { if (check()) return; await delay(5); }
  assert.fail("Expected socket activity did not arrive");
}

test("Unix RPC clients initialize independently and stopping one preserves the engine and other clients", { skip: process.platform === "win32", timeout: 30000 }, async () => {
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

test("Unix RPC preserves structured errors and routes server requests despite colliding client IDs", { skip: process.platform === "win32", timeout: 30000 }, async () => {
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

test("Unix RPC bounds pending requests and UTF-8 frame bytes without poisoning the connection", { skip: process.platform === "win32", timeout: 30000 }, async () => {
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

test("Unix RPC connection failures, remote closes and invalid frames settle readiness and pending work", { skip: process.platform === "win32", timeout: 30000 }, async t => {
  await t.test("missing socket", async () => {
    const client = new SocketAppServerConnection("/tmp/no-gateway-engine-" + process.pid + ".sock", async () => {});
    const pending = client.request("initialize", {});
    await assert.rejects(Promise.all([client.ready, pending]), /socket failed/);
    await client.exited; assert.equal(client.closed, true);
  });
  for (const action of ["close", "malformed", "oversized", "binary"] as const) await t.test(action, async () => {
    const f = await fixture(() => {});
    const client = new SocketAppServerConnection(f.path, async () => { throw new Error("secret callback detail"); });
    try {
      await client.ready;
      const pending = client.request("held", {});
      const rejection = assert.rejects(pending, /socket closed|invalid JSON|socket failed|invalid frame/);
      if (action === "close") f.sockets[0].close(1000);
      if (action === "malformed") f.sockets[0].send("not JSON: secret request content");
      if (action === "oversized") f.sockets[0].send("x".repeat(16 * 1024 * 1024 + 1));
      if (action === "binary") f.sockets[0].send(Buffer.from("{}"));
      await rejection; await client.exited; assert.equal(client.closed, true);
    } finally { client.stop(); await client.exited; await f.close(); }
  });
});

test("Unix RPC callback failures preserve pending requests, subsequent messages and sibling clients", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture(({ socket, number, message }) => {
    if (message.method === "model/list") socket.send(JSON.stringify({ id: message.id, result: { client: number } }));
  });
  const notices: string[] = [];
  const client = new SocketAppServerConnection(f.path, async message => {
    if (message.method === "broken/notice") throw new Error("private callback detail");
    notices.push(String(message.method));
  });
  const sibling = new SocketAppServerConnection(f.path, async () => {});
  try {
    await Promise.all([client.ready, sibling.ready]);
    const held = client.request("held", {});
    // Install a rejection listener immediately so a regression cannot leak an unhandled rejection.
    const outcome = held.then(value => ({ value }), error => ({ error }));
    await until(() => f.received.some(value => value.message.method === "held"));
    const socket = f.received.find(value => value.message.method === "held")!.socket;
    socket.send(JSON.stringify({ method: "broken/notice" }));
    socket.send(JSON.stringify({ method: "turn/completed" }));
    await until(() => notices.includes("turn/completed"));
    socket.send(JSON.stringify({ id: f.received.find(value => value.message.method === "held")!.message.id, result: { done: true } }));
    assert.deepEqual(await outcome, { value: { done: true } });
    assert.equal(client.closed, false); assert.equal(sibling.closed, false);
    assert.ok(await client.request("model/list", {}));
    assert.ok(await sibling.request("model/list", {}));
  } finally { client.stop(); sibling.stop(); await Promise.all([client.exited, sibling.exited]); await f.close(); }
});

test("Unix RPC failed callbacks return fixed server errors with original IDs and scrubbed telemetry", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture(); const state = await shortFolder("gw-ws-telemetry-");
  configureTelemetry(state.directory, "socket-test");
  const client = new SocketAppServerConnection(f.path, async () => { throw new Error("private callback detail"); });
  try {
    await client.ready;
    for (const [id, method] of [[7, "approval/request"], ["request-2", "private path /Users/person/secret"], [0, "a".repeat(65)]] as const) {
      f.sockets[0].send(JSON.stringify({ id, method, params: { secret: "private params" } }));
      await until(() => f.received.some(value => value.message.id === id && value.message.error !== undefined));
      assert.deepEqual(f.received.find(value => value.message.id === id && value.message.error !== undefined)!.message,
        { id, error: { code: -32603, message: "The adapter could not deliver this request" } });
    }
    assert.equal(client.closed, false);
    assert.equal((await client.request("model/list", {})).method, "model/list");
    await flushTelemetry();
    const events = (await readTelemetry(state.directory, 0)).filter(event => event.event === "engine_message_failed");
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(event => ({ transport: event.transport, method: event.method })),
      [{ transport: "socket", method: "approval/request" }, { transport: "socket", method: undefined }, { transport: "socket", method: undefined }]);
    assert.doesNotMatch(JSON.stringify(events), /private|secret|person/);
  } finally { client.stop(); await client.exited; await flushTelemetry(); await f.close(); await state.remove(); }
});

test("Unix RPC rejects a notification flood while a handler is blocked", { skip: process.platform === "win32", timeout: 30000 }, async () => {
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

test("Unix RPC preserves spaces and URL-special characters in the private socket path", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fixture(undefined, "private é #?.sock"); const client = new SocketAppServerConnection(f.path, async () => {});
  try { assert.deepEqual(await client.request("initialize", {}), { client: 1, method: "initialize" }); }
  finally { client.stop(); await client.exited; await f.close(); }
});

test("Unix RPC stop before open rejects readiness and requests and leaves the listener available", { skip: process.platform === "win32", timeout: 30000 }, async () => {
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
