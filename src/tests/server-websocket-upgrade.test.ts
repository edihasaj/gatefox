import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { Writable, type Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, gatewayToken } from "../config.js";
import { createGatewayHandler, startGateway } from "../server.js";
import { handleUpgrade, upgradeRefusalGraceMs } from "../server-upgrade.js";
import { flushRecords } from "../usage-ledger.js";
import type { InferenceEvent } from "../protocol/types.js";

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ws-"));
  let providerCalls = 0;
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory,
    providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] });
  const server = await startGateway(config, () => ({ async *infer(): AsyncGenerator<InferenceEvent> {
    providerCalls++; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } }));
  const port = (server.address() as { port: number }).port;
  const token = await gatewayToken(directory);
  const bearer = { Authorization: `Bearer ${token}` };
  const counts = async () => { const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as { active: number; running: number; queued: number };
    return [health.active, health.running, health.queued]; };
  return { server, port, bearer, providerCalls: () => providerCalls, counts,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** Sends a raw upgrade handshake and returns every byte the server answered with, until it closed. */
async function handshake(port: number, path: string, headers: Record<string, string>): Promise<string> {
  const lines = [`GET ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: Upgrade", "Upgrade: websocket",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), "", ""];
  const socket = connect({ port, host: "127.0.0.1" });
  socket.on("error", () => { /* a reset after the refusal is the client's choice */ });
  const closed = once(socket, "close");
  const chunks: Buffer[] = []; socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
  await once(socket, "connect");
  socket.write(lines.join("\r\n"));
  await closed;
  return Buffer.concat(chunks).toString();
}
const head = (bytes: string) => bytes.slice(0, bytes.indexOf("\r\n\r\n"));

test("GET /v1/responses with a bearer and an upgrade gets 426, no body, and never a provider", async () => {
  const gateway = await setup();
  try {
    const before = await gateway.counts();
    const answer = await handshake(gateway.port, "/v1/responses", gateway.bearer);
    assert.match(head(answer), /^HTTP\/1\.1 426 Upgrade Required/);
    assert.match(head(answer), /\r\nConnection: close/i);
    assert.equal(answer.slice(answer.indexOf("\r\n\r\n") + 4), "", "the refusal carries no body");
    assert.equal(gateway.providerCalls(), 0, "an upgrade never invokes a provider");
    assert.deepEqual(await gateway.counts(), before, "admission counters are unchanged");
  } finally { await gateway.close(); }
});

test("an upgrade without a valid bearer is 401 before any path answer", async () => {
  const gateway = await setup();
  try {
    assert.match(head(await handshake(gateway.port, "/v1/responses", {})), /^HTTP\/1\.1 401 Unauthorized/);
    assert.match(head(await handshake(gateway.port, "/v1/responses", { Authorization: "Bearer wrong-token" })), /^HTTP\/1\.1 401/);
    assert.match(head(await handshake(gateway.port, "/elsewhere", {})), /^HTTP\/1\.1 401/, "authentication still precedes the 404");
    assert.equal(gateway.providerCalls(), 0);
  } finally { await gateway.close(); }
});

test("an upgrade on any other path is 404 once authenticated", async () => {
  const gateway = await setup();
  try {
    const answer = await handshake(gateway.port, "/v1/other", gateway.bearer);
    assert.match(head(answer), /^HTTP\/1\.1 404 Not Found/);
    assert.match(head(answer), /\r\nConnection: close/i);
    assert.equal(gateway.providerCalls(), 0);
    const before = await gateway.counts();
    await handshake(gateway.port, "/v1/responses", gateway.bearer);
    assert.deepEqual(await gateway.counts(), before, "admission counters are unchanged");
  } finally { await gateway.close(); }
});

// Node versions that route an upgrade to the request handler instead of the "upgrade" event must refuse it identically.
class FakeResponse extends EventEmitter {
  status = 0; headersSent = false; writableEnded = false; headers: Record<string, string> = {}; private body = "";
  setHeader(): void {} writeHead(status: number, responseHeaders?: Record<string, string>): this { this.status = status; Object.assign(this.headers, responseHeaders); this.headersSent = true; return this; }
  write(chunk: string): boolean { this.body += chunk; return true; }
  end(value?: string): void { this.body += value ?? ""; this.writableEnded = true; this.emit("finish"); }
  text(): string { return this.body; }
}

test("the request handler answers an upgrade pass-through with the same 426", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ws-passthrough-"));
  let providerCalls = 0;
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory,
    providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] });
  const handler = await createGatewayHandler(config, () => ({ async *infer(): AsyncGenerator<InferenceEvent> { providerCalls++; yield { type: "done", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }; } }));
  const token = await gatewayToken(directory);
  const get = (headers: Record<string, string>) => {
    const res = new FakeResponse();
    const finished = new Promise<void>(resolve => res.once("finish", () => resolve()));
    handler.handle({ method: "GET", url: "/v1/responses", headers, [Symbol.asyncIterator]: async function* () {} } as unknown as IncomingMessage, res as unknown as ServerResponse);
    return finished.then(() => res);
  };
  const authorized = await get({ authorization: `Bearer ${token}`, upgrade: "websocket", connection: "Upgrade" });
  assert.equal(authorized.status, 426);
  assert.equal(authorized.headers["Connection"], "close");
  assert.equal(authorized.text(), "", "no body on the refusal");
  const unauthorized = await get({ authorization: "Bearer wrong", upgrade: "websocket" });
  assert.equal(unauthorized.status, 401);
  assert.equal(providerCalls, 0);
  assert.equal(handler.isIdle(), true, "an upgrade never occupies admission or a provider slot");
});

/** Sends raw request bytes and returns what the server answered with until it closed (or a second passed). */
async function rawExchange(port: number, text: string): Promise<string> {
  const socket = connect({ port, host: "127.0.0.1" });
  socket.on("error", () => { /* a reset after the answer is the client's choice */ });
  const chunks: Buffer[] = []; socket.on("data", chunk => chunks.push(Buffer.from(chunk)));
  await once(socket, "connect"); socket.write(text);
  await Promise.race([once(socket, "close"), delay(1000)]);
  socket.destroy();
  return Buffer.concat(chunks).toString();
}

test("an upgrade that carries an Origin is 403, before the token is even read", async () => {
  const gateway = await setup();
  try {
    const withBearer = await handshake(gateway.port, "/v1/responses", { ...gateway.bearer, Origin: "http://evil.example" });
    assert.match(head(withBearer), /^HTTP\/1\.1 403 Forbidden/);
    assert.match(withBearer, /"code":"cross_origin"/);
    assert.match(head(await handshake(gateway.port, "/v1/responses", { Origin: "http://evil.example" })), /^HTTP\/1\.1 403/, "Origin is checked before authentication");
    assert.equal(gateway.providerCalls(), 0);
  } finally { await gateway.close(); }
});

test("clients that keep their half of a refused upgrade open do not hold the server's close", async () => {
  const gateway = await setup();
  const clients = [] as Array<ReturnType<typeof connect>>;
  try {
    const answered: Array<Promise<void>> = [];
    const paths = [["/v1/responses", true], ["/v1/responses", false], ["/v1/other", true], ["/v1/other", false]] as const;
    for (let round = 0; round < 3; round++) for (const [path, authorized] of paths) {
      const socket = connect({ port: gateway.port, host: "127.0.0.1", allowHalfOpen: true });
      socket.on("error", () => {}); clients.push(socket);
      let received = ""; socket.on("data", chunk => { received += chunk; });
      // The client never ends its side. The server must still let go once it has said no.
      answered.push(once(socket, "end").then(() => { assert.match(received, /^HTTP\/1\.1 (426|401|404)/); }));
      await once(socket, "connect");
      socket.write(["GET " + path + " HTTP/1.1", "Host: 127.0.0.1", "Connection: Upgrade", "Upgrade: websocket", ...(authorized ? [`Authorization: ${gateway.bearer.Authorization}`] : []), "", ""].join("\r\n"));
    }
    assert.equal(await Promise.race([Promise.all(answered).then(() => "ended"), delay(5000).then(() => "held")]), "ended", "the server closes its side after the refusal");
    const closed = new Promise<string>(resolve => gateway.server.close(() => resolve("closed")));
    assert.equal(await Promise.race([closed, delay(5000).then(() => "hung")]), "closed", "server.close() returns with half-open clients attached");
  } finally { for (const socket of clients) socket.destroy(); await gateway.close(); }
});

test("a refused upgrade socket is destroyed after a grace even if the client never reads the refusal", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let destroyed = false;
  // A socket whose write never completes: `end()` never reports it is done, as for a client that stops reading.
  const stuck = Object.assign(new Writable({ write() { /* never calls back */ }, destroy(error, callback) { destroyed = true; callback(error); } }), {}) as unknown as Duplex;
  handleUpgrade({ url: "/v1/responses", headers: { origin: "http://evil.example" } } as never, stuck, "token");
  assert.equal(destroyed, false, "the socket is not dropped before the grace passes");
  t.mock.timers.tick(upgradeRefusalGraceMs - 1); assert.equal(destroyed, false);
  t.mock.timers.tick(1); assert.equal(destroyed, true, "the fallback timer destroys the socket");
});

test("an unreadable request target is answered 400 on both the upgrade and the request path, and the server keeps serving", async () => {
  const gateway = await setup();
  try {
    const upgrade = await rawExchange(gateway.port, "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    assert.match(head(upgrade), /^HTTP\/1\.1 400 Bad Request/);
    const plain = await rawExchange(gateway.port, "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert.match(head(plain), /^HTTP\/1\.1 400 Bad Request/);
    assert.match(plain, /"code":"invalid_request"/);
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/health`)).status, 200, "the daemon survived both");
    assert.equal(gateway.providerCalls(), 0);
  } finally { await gateway.close(); }
});

async function handlerSetup() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-ws-handler-"));
  let providerCalls = 0;
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] });
  const handler = await createGatewayHandler(config, () => ({ async *infer(): AsyncGenerator<InferenceEvent> { providerCalls++; yield { type: "text", text: "OK" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; } }));
  const token = await gatewayToken(directory);
  const call = (request: { method: string; url: string; headers: Record<string, string>; body?: unknown }, response = new FakeResponse()) => {
    const finished = new Promise<void>(resolve => response.once("finish", () => resolve()));
    handler.handle({ method: request.method, url: request.url, headers: request.headers,
      [Symbol.asyncIterator]: async function* () { if (request.body !== undefined) yield Buffer.from(JSON.stringify(request.body)); } } as unknown as IncomingMessage, response as unknown as ServerResponse);
    return finished.then(() => response);
  };
  return { handler, token, call, providerCalls: () => providerCalls, close: async () => { await flushRecords(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

test("an Upgrade header without an upgrade token in Connection is an ordinary request", async () => {
  const run = await handlerSetup();
  try {
    const auth = { authorization: `Bearer ${run.token}`, "content-type": "application/json" };
    const post = await run.call({ method: "POST", url: "/v1/responses", headers: { ...auth, upgrade: "h2c" }, body: { model: "alias", input: "hello" } });
    assert.equal(post.status, 200, "a POST with Upgrade: h2c is served, not answered 426");
    assert.equal(run.providerCalls(), 1);
    const keepAlive = await run.call({ method: "POST", url: "/v1/responses", headers: { ...auth, upgrade: "h2c", connection: "keep-alive" }, body: { model: "alias", input: "hello" } });
    assert.equal(keepAlive.status, 200);
    const real = await run.call({ method: "GET", url: "/v1/responses", headers: { authorization: `Bearer ${run.token}`, upgrade: "websocket", connection: "keep-alive, Upgrade" } });
    assert.equal(real.status, 426, "the upgrade token among others still counts, in any case");
    const noToken = await run.call({ method: "GET", url: "/v1/responses", headers: { authorization: `Bearer ${run.token}`, upgrade: "websocket" } });
    assert.equal(noToken.status, 404, "a GET with only an Upgrade header is just an unknown endpoint");
  } finally { await run.close(); }
});

test("an unreadable request target through the request handler answers 400 and never rejects", async t => {
  const rejections: unknown[] = []; const note = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", note); t.after(() => { process.off("unhandledRejection", note); });
  const run = await handlerSetup();
  try {
    const response = await run.call({ method: "GET", url: "http://[", headers: {} });
    assert.equal(response.status, 400);
    assert.equal(run.handler.isIdle(), true);
    await delay(20); assert.deepEqual(rejections, []);
  } finally { await run.close(); }
});

test("a handler that fails unexpectedly answers 500 while the head is unsent, and never leaves a rejection", async t => {
  const rejections: unknown[] = []; const note = (reason: unknown) => { rejections.push(reason); };
  process.on("unhandledRejection", note); t.after(() => { process.off("unhandledRejection", note); });
  const run = await handlerSetup();
  try {
    // setHeader is the first thing the handler does to the response; making it throw stands in for any unforeseen failure.
    class Exploding extends FakeResponse { override setHeader(): void { throw new Error("boom"); } }
    const early = await run.call({ method: "GET", url: "/health", headers: {} }, new Exploding());
    assert.equal(early.status, 500);
    assert.equal(JSON.parse(early.text()).error.code, "internal_error");
    assert.ok(!early.text().includes("boom"), "the answer never carries the exception text");
    // With the head already sent, the connection is cut instead of a second head being written.
    class Sent extends Exploding { override headersSent = true; destroyed = false; destroy(): this { this.destroyed = true; this.emit("finish"); return this; } }
    const late = await run.call({ method: "GET", url: "/health", headers: {} }, new Sent());
    assert.equal((late as Sent).destroyed, true); assert.equal(late.status, 0);
    await delay(20); assert.deepEqual(rejections, []);
  } finally { await run.close(); }
});
