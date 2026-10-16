import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { connect } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, gatewayToken } from "../config.js";
import { createGatewayHandler, startGateway } from "../server.js";
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
