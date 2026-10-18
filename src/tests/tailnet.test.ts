import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTailnetAddress, tailnetFetch, type TailnetSeams } from "../tailnet.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { ProviderError } from "../providers/provider.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

const init = { method: "POST", headers: { Authorization: "Bearer tailnet-secret", "Content-Type": "application/json" }, body: "{}" };

/** A loopback upstream that records every request's bearer and answers 200 (or the given status). */
async function upstream(status = 200) {
  const seen: Array<string | undefined> = []; const connections: number[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => { seen.push(req.headers.authorization); req.resume(); res.writeHead(status, { "Content-Type": "text/plain" }); res.end("ok"); });
  server.on("connection", () => connections.push(1));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, seen, connections, port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } };
}
/** A port nothing listens on: connecting to it is refused at once. */
async function closedPort(): Promise<number> {
  const probe = createTcpServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = (probe.address() as { port: number }).port; probe.close(); await once(probe, "close"); return port;
}
async function telemetryEvents(): Promise<Array<Record<string, unknown>>> {
  await flushTelemetry(); return (await readTelemetry(state, since)).filter(event => event.event === "provider_address_refused");
}
let state = ""; let since = 0;
async function recordTelemetry(): Promise<void> { state = await mkdtemp(join(tmpdir(), "gateway-tailnet-")); configureTelemetry(state, "test"); since = Date.now() - 1000; }

test("only Tailscale addresses pass the address check", () => {
  for (const address of ["100.64.0.0", "100.108.115.57", "100.104.232.124", "100.127.255.255", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0:ab12::7"]) assert.equal(isTailnetAddress(address), true, address);
  for (const address of ["100.63.255.255", "100.128.0.0", "101.64.0.1", "10.0.0.1", "192.168.1.10", "203.0.113.5", "127.0.0.1", "::1", "fd7a:115c:a1e1::1", "fd7b:115c:a1e0::1", "::ffff:100.64.0.1",
    "100.64.0.1.5", "100.064.0.1", "dgx.example", "", "100.64.0.1/10"]) assert.equal(isTailnetAddress(address), false, address);
});

test("a public or private address is refused before any connection, so the bearer is never sent", async () => {
  await recordTelemetry(); const target = await upstream();
  try {
    for (const address of ["203.0.113.5", "192.168.1.10", "2001:db8::1", "fd7a:115c:a1e1::1"]) {
      // The dial seam would reach a live listener, so a wrongly allowed address would deliver the bearer.
      const send = tailnetFetch("qwen", { resolve: async () => [address], dial: () => ({ host: "127.0.0.1", port: target.port }) });
      await assert.rejects(send("http://dgx.example:4000/v1/chat/completions", init), (error: unknown) => error instanceof ProviderError && error.code === "provider_unreachable" && error.message === "Provider is unreachable" && !error.message.includes(address));
    }
    // An IP literal in the base URL is held to the same rule and needs no lookup.
    const literal = tailnetFetch("qwen", { resolve: async () => { throw new Error("must not resolve"); }, dial: () => ({ host: "127.0.0.1", port: target.port }) });
    await assert.rejects(literal("http://203.0.113.5:4000/v1/chat/completions", init), { code: "provider_unreachable" });
    assert.deepEqual(target.connections, [], "no connection was opened"); assert.deepEqual(target.seen, []);
    const events = await telemetryEvents();
    assert.equal(events.length, 5); assert.ok(events.every(event => event.provider === "qwen" && event.reason === "not_tailnet"));
    assert.ok(events.every(event => !JSON.stringify(event).match(/203\.0\.113|192\.168|2001|fd7a|dgx/)), "the event carries no address or host");
  } finally { target.close(); }
});

test("a mixed answer dials only the Tailscale addresses, and an IPv6 tailnet address is allowed", async () => {
  await recordTelemetry(); const target = await upstream(); const dialed: string[] = [];
  const seams: TailnetSeams = { dial: address => { dialed.push(address); return { host: "127.0.0.1", port: target.port }; } };
  try {
    const mixed = tailnetFetch("qwen", { ...seams, resolve: async () => ["203.0.113.5", "100.108.115.57", "192.168.1.10"] });
    const response = await mixed("http://dgx.example:4000/v1/chat/completions", init);
    assert.equal(response.status, 200); assert.equal(await response.text(), "ok");
    assert.deepEqual(dialed, ["100.108.115.57"]); assert.deepEqual(target.seen, ["Bearer tailnet-secret"]);
    assert.equal((await telemetryEvents()).length, 1, "the refused answers are recorded once");
    dialed.length = 0;
    const v6 = tailnetFetch("qwen", { ...seams, resolve: async () => ["fd7a:115c:a1e0::1"] });
    assert.equal((await v6("http://dgx.example:4000/x", init)).status, 200); assert.deepEqual(dialed, ["fd7a:115c:a1e0::1"]);
    const literal = tailnetFetch("qwen", seams);
    assert.equal((await literal("http://100.104.232.124:4000/x", init)).status, 200); assert.deepEqual(dialed.at(-1), "100.104.232.124");
  } finally { target.close(); }
});

test("connect attempts walk the resolved addresses in order and a request that reached a router is not replayed", async () => {
  await recordTelemetry(); const dead = await closedPort(); const live = await upstream(); const second = await upstream();
  const ports: Record<string, number> = { "100.108.115.57": dead, "100.104.232.124": live.port };
  try {
    const send = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57", "100.104.232.124"], dial: address => ({ host: "127.0.0.1", port: ports[address] }) });
    const response = await send("http://dgx.example:4000/v1/chat/completions", init);
    assert.equal(response.status, 200); await response.text(); assert.equal(live.seen.length, 1, "served once");
    // Neither address connects: the fixed error, nothing sent.
    const none = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57", "100.104.232.124"], dial: () => ({ host: "127.0.0.1", port: dead }) });
    await assert.rejects(none("http://dgx.example:4000/x", init), { code: "provider_unreachable", message: "Provider is unreachable" });
    // The first router answers with a server error: that answer is the result, the second router is never asked.
    const failing = await upstream(500); const ports2: Record<string, number> = { "100.108.115.57": failing.port, "100.104.232.124": second.port };
    const replay = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57", "100.104.232.124"], dial: address => ({ host: "127.0.0.1", port: ports2[address] }) });
    const answer = await replay("http://dgx.example:4000/x", init); assert.equal(answer.status, 500); await answer.text();
    assert.equal(failing.seen.length, 1); assert.equal(second.seen.length, 0, "no replay on the second address"); failing.close();
  } finally { live.close(); second.close(); }
});

test("a silent address times out and the next one answers; a redirect is not followed", async () => {
  await recordTelemetry(); const live = await upstream();
  const redirect = createServer((_req, res) => { res.writeHead(302, { Location: "http://203.0.113.5/" }); res.end(); }); redirect.listen(0, "127.0.0.1"); await once(redirect, "listening");
  try {
    const slow = tailnetFetch("qwen", { connectTimeoutMs: 50, resolve: async () => ["100.108.115.57", "100.104.232.124"], dial: address => address === "100.108.115.57" ? { host: "192.0.2.1", port: 9 } /* TEST-NET-1: never answers */ : { host: "127.0.0.1", port: live.port } });
    assert.equal((await slow("http://dgx.example:4000/x", init)).status, 200); assert.equal(live.seen.length, 1);
    const moved = tailnetFetch("qwen", { resolve: async () => ["100.108.115.57"], dial: () => ({ host: "127.0.0.1", port: (redirect.address() as { port: number }).port }) });
    await assert.rejects(moved("http://dgx.example:4000/x", init), /redirect refused/);
  } finally { live.close(); redirect.closeAllConnections(); redirect.close(); }
});

test("the chat provider sends its stream through the checked transport", async () => {
  await recordTelemetry(); process.env.TAILNET_TEST_KEY = "tailnet-secret";
  const seen: Array<string | undefined> = [];
  const router = createServer((req, res) => {
    seen.push(req.headers.authorization); req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ model: "qwen", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  router.listen(0, "127.0.0.1"); await once(router, "listening"); const port = (router.address() as { port: number }).port;
  const config = { id: "qwen", type: "chat-completions-api" as const, baseUrl: "http://dgx.example:4000/v1", tailnet: true, apiKeyEnv: "TAILNET_TEST_KEY", models: { "qwen/flash": "qwen" } };
  const run = async (provider: ChatCompletionsAPI) => { const events = []; for await (const event of provider.infer({ model: "qwen", input: "hi" } as never, new AbortController().signal)) events.push(event); return events; };
  try {
    const events = await run(new ChatCompletionsAPI(config, { resolve: async () => ["100.108.115.57"], dial: () => ({ host: "127.0.0.1", port }) }));
    assert.ok(events.some(event => event.type === "text" && event.text === "hello")); assert.deepEqual(seen, ["Bearer tailnet-secret"]);
    // Public answer: the provider fails before the router sees a byte.
    await assert.rejects(run(new ChatCompletionsAPI(config, { resolve: async () => ["203.0.113.5"], dial: () => ({ host: "127.0.0.1", port }) })), { code: "provider_unreachable" });
    assert.equal(seen.length, 1);
  } finally { router.closeAllConnections(); router.close(); }
});
