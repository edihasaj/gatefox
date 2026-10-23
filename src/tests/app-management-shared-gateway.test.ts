import assert from "node:assert/strict";
import { createServer, type RequestListener, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GatewayConfig } from "../config.js";
import { gatewayToken } from "../config.js";
import { maximumGatewayInfoBytes } from "../gateway-info.js";
import { startGateway } from "../server.js";
import { sharedGatewayCatalog } from "../app-management/shared-gateway.js";

const catalog = { version: 1, hostname: "shared host", providers: [{ id: "one", label: "First provider", type: "claude-subscription", models: [{ id: "one/model", label: "A model" }] }] };

async function listener(handler: RequestListener): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer(handler); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  return { server, port, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

async function client(port: number): Promise<GatewayConfig> {
  const root = await mkdtemp(join(tmpdir(), "gateway-shared-client-")); const stateDirectory = join(root, "state"); await mkdir(stateDirectory, { mode: 0o700 });
  await writeFile(join(stateDirectory, "client-token"), "x".repeat(32) + "\n", { mode: 0o600 });
  return { version: 1, port, stateDirectory, providers: [], clientOnly: true };
}

test("the authenticated shared catalog exposes only selected public routes and never invokes inference", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gateway-shared-host-")); let inferred = 0;
  const gateway = await startGateway({ version: 1, port: 0, stateDirectory, providers: [{
    id: "claude", label: "Claude Account", type: "claude-subscription", credentialFile: "/private/never-disclosed", models: { "claude/fast": "claude-fast" },
    modelMetadata: { "claude/fast": { displayName: "Claude Fast", contextWindow: 4096 } },
  }, {
    id: "grok", label: "Grok Subscription", type: "grok-subscription", grokHome: "/private/grok-home", models: { "grok/build": "grok-build" },
  }] }, () => ({ async *infer() { inferred++; } }));
  try {
    const port = (gateway.address() as { port: number }).port; const token = await gatewayToken(stateDirectory);
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/v1/gateway-info`); assert.equal(unauthenticated.status, 401);
    const response = await fetch(`http://127.0.0.1:${port}/v1/gateway-info`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); const wire = await response.text();
    assert.doesNotMatch(wire, /credentialFile|stateDirectory|grokHome|private/);
    const peer = await client(port); await writeFile(join(peer.stateDirectory, "client-token"), `${token}\n`, { mode: 0o600 });
    assert.deepEqual(await sharedGatewayCatalog(peer), { status: "available", hostname: JSON.parse(wire).hostname, providers: [
      { id: "claude", label: "Claude Account", type: "claude-subscription", models: [{ id: "claude/fast", label: "Claude Fast" }] },
      { id: "grok", label: "Grok Subscription", type: "grok-subscription", models: [{ id: "grok/build", label: "grok-build" }] },
    ] });
    assert.equal(inferred, 0);
  } finally { gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); }
});

test("shared inspection clears its view for unavailable, redirected, oversized, malformed, and duplicate catalogs", async () => {
  const cases: Array<{ name: string; status?: number; body?: string; headers?: Record<string, string> }> = [
    { name: "wrong auth", status: 401, body: "denied", headers: { "content-type": "application/json" } },
    { name: "not found", status: 404, body: "missing", headers: { "content-type": "application/json" } },
    { name: "non-json", status: 200, body: "not json", headers: { "content-type": "text/plain" } },
    { name: "malformed json", status: 200, body: "{", headers: { "content-type": "application/json" } },
    { name: "duplicate provider", status: 200, body: JSON.stringify({ ...catalog, providers: [catalog.providers[0], catalog.providers[0]] }), headers: { "content-type": "application/json" } },
    { name: "duplicate alias", status: 200, body: JSON.stringify({ ...catalog, providers: [catalog.providers[0], { ...catalog.providers[0], id: "two", models: catalog.providers[0].models }] }), headers: { "content-type": "application/json" } },
    { name: "oversized", status: 200, body: " ".repeat(maximumGatewayInfoBytes + 1), headers: { "content-type": "application/json" } },
  ];
  for (const item of cases) {
    const fixture = await listener((_request, response) => { response.writeHead(item.status!, item.headers); response.end(item.body); });
    try { assert.deepEqual(await sharedGatewayCatalog(await client(fixture.port)), { status: "unavailable", providers: [] }, item.name); }
    finally { await fixture.close(); }
  }
  const redirect = await listener((_request, response) => { response.writeHead(302, { location: "http://127.0.0.1:1/v1/gateway-info" }); response.end(); });
  try { assert.deepEqual(await sharedGatewayCatalog(await client(redirect.port)), { status: "unavailable", providers: [] }); }
  finally { await redirect.close(); }
  const offline = await listener(() => undefined); const port = offline.port; await offline.close();
  assert.deepEqual(await sharedGatewayCatalog(await client(port), undefined, 50), { status: "unavailable", providers: [] });
});

test("shared inspection honors its deadline and the caller cancellation", async () => {
  let began: () => void = () => {}; const requestBegan = new Promise<void>(resolve => { began = resolve; });
  const fixture = await listener((_request, response) => { began(); response.writeHead(200, { "content-type": "application/json" }); response.write("{"); });
  try {
    assert.deepEqual(await sharedGatewayCatalog(await client(fixture.port), undefined, 20), { status: "unavailable", providers: [] });
    const controller = new AbortController(); const pending = sharedGatewayCatalog(await client(fixture.port), controller.signal, 5000); await requestBegan; controller.abort();
    assert.deepEqual(await pending, { status: "unavailable", providers: [] });
  } finally { await fixture.close(); }
});

test("streaming authentication and non-JSON failures release their peer response", async () => {
  for (const [status, contentType] of [[401, "application/json"], [200, "text/plain"]] as const) {
    let closed: () => void = () => {}; const peerClosed = new Promise<void>(resolve => { closed = resolve; });
    const fixture = await listener((request, response) => {
      response.once("close", closed); response.writeHead(status, { "content-type": contentType }); response.write("still streaming");
    });
    try {
      assert.deepEqual(await sharedGatewayCatalog(await client(fixture.port)), { status: "unavailable", providers: [] });
      await Promise.race([peerClosed, new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error("peer response was not cancelled")), 500))]);
    } finally { await fixture.close(); }
  }
});
