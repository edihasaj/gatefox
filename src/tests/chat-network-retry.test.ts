import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, Socket } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { ProviderError } from "../providers/provider.js";
import { configureNetworkRetryTiming, resetNetworkRetryTiming } from "../providers/network-retry.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway } from "../server.js";
import { readEvents } from "../protocol/sse.js";
import { setTimeout as nap } from "node:timers/promises";

const env = "GATEWAY_CHAT_NETWORK_FIXTURE_KEY";
const frame = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const complete = frame({ content: "ok" }, "stop") + "data: [DONE]\n\n";
const failure = (code: string) => Object.assign(new Error("private connection details"), { code });
const config = { id: "fixture", type: "chat-completions-api" as const, apiKeyEnv: env, baseUrl: "http://fixture.invalid/v1", models: { fixture: "fixture" } };
const api = () => new ChatCompletionsAPI(config);
async function drain(provider = api(), signal = new AbortController().signal, extra: Partial<ResponsesRequest> = {}) {
  const events: InferenceEvent[] = [];
  for await (const event of provider.infer({ model: "fixture", input: "fixture", ...extra }, signal)) events.push(event);
  return events;
}
function clock(budgetMs = 120000) {
  const state = { now: 0, waits: [] as number[] };
  configureNetworkRetryTiming({ now: () => state.now, random: () => 0.5, budgetMs,
    sleep: async (ms, signal) => { signal.throwIfAborted(); state.waits.push(ms); state.now += ms; } });
  return state;
}
async function withFetch(send: typeof fetch, run: () => Promise<void>) {
  const before = globalThis.fetch; globalThis.fetch = send; process.env[env] = "fixture";
  try { await run(); } finally { globalThis.fetch = before; delete process.env[env]; resetNetworkRetryTiming(); }
}

test("chat connection outages recover within the shared budget and keep the same request and routing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-connect-")); configureTelemetry(directory, "test");
  const state = clock(); let calls = 0; const bodies: unknown[] = []; const headers: unknown[] = [];
  await withFetch(async (_url, init) => {
    calls++; bodies.push(init?.body); headers.push(init?.headers);
    if (calls <= 6) throw failure("ETIMEDOUT");
    return new Response(complete);
  }, async () => {
    const events = await drain();
    assert.equal(events.filter(event => event.type === "text").length, 1); assert.equal(events.at(-1)?.type, "done");
    assert.equal(calls, 7); assert.deepEqual(state.waits, [1000, 2000, 4000, 8000, 8000, 8000]);
    assert.ok(bodies.every(value => value === bodies[0])); assert.ok(headers.every(value => value === headers[0]));
    await flushTelemetry(); const recorded = await readTelemetry(directory, 0);
    assert.deepEqual(recorded.filter(event => event.event === "provider_retry").map(event => event.attempt), [2, 3, 4, 5, 6, 7]);
    assert.equal(recorded.find(event => event.event === "provider_connection_recovered")?.attempts, 7);
    assert.ok(!JSON.stringify(recorded).includes("private connection details"));
  });
});

test("chat connection budget expires without a late request, including a wait delayed by sleep", async () => {
  for (const overshoot of [false, true]) {
    const state = clock(); const starts: number[] = [];
    if (overshoot) configureNetworkRetryTiming({ sleep: async () => { state.now = 121000; } });
    await withFetch(async () => { starts.push(state.now); throw failure("ECONNRESET"); }, async () => {
      await assert.rejects(drain(), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "ECONNRESET");
      assert.ok(starts.every(at => at < 120000));
      if (overshoot) assert.equal(starts.length, 1); else { assert.ok(starts.length > 10); assert.equal(state.now, 119000); }
    });
  }
});

test("cancelling a chat connection backoff sends no further request", async () => {
  const controller = new AbortController(); let calls = 0;
  configureNetworkRetryTiming({ sleep: async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); } });
  await withFetch(async () => { calls++; throw failure("ETIMEDOUT"); }, async () => {
    await assert.rejects(drain(api(), controller.signal)); assert.equal(calls, 1);
  });
});

test("permanent, unknown, abort, HTTP and typed protocol failures never gain a chat connection retry", async () => {
  const errors = [failure("ENOTFOUND"), failure("CERT_HAS_EXPIRED"), failure("ECONNREFUSED"), failure("ABORT_ERR"),
    new TypeError("fetch failed", { cause: failure("PRIVATE_CODE") }), new ProviderError("invalid_request", "private")];
  for (const error of errors) {
    clock(); let calls = 0;
    await withFetch(async () => { calls++; throw error; }, async () => { await assert.rejects(drain()); assert.equal(calls, 1); });
  }
  for (const status of [401, 429, 503]) {
    clock(); let calls = 0;
    await withFetch(async () => { calls++; return new Response("{}", { status }); }, async () => { await assert.rejects(drain()); assert.equal(calls, 1); });
  }
});

test("a chat body reset is never replayed, including buffered tool fragments and observed usage", async () => {
  const fragments = ["", frame({ content: "partial" }), frame({ reasoning_content: "partial" }),
    frame({ tool_calls: [{ index: 0, id: "call", function: { name: "tool_0", arguments: "{" } }] }),
    `data: ${JSON.stringify({ model: "fixture", choices: [], usage: { prompt_tokens: 200000, completion_tokens: 0, total_tokens: 200000 } })}\n\n`];
  for (const first of fragments) {
    const state = clock(); let calls = 0;
    await withFetch(async () => {
      calls++; let written = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (!written && first) { written = true; controller.enqueue(new TextEncoder().encode(first)); } else controller.error(failure("ECONNRESET"));
      } }));
    }, async () => {
      await assert.rejects(drain(api(), undefined, { tools: [{ type: "function", name: "tool", parameters: { type: "object" } }] }));
      assert.equal(calls, 1); assert.deepEqual(state.waits, []);
    });
  }
});

test("the real checked tailnet transport recovers a timed-out dial without sending to a different address", async () => {
  const state = clock(); let dials = 0; let requests = 0;
  const upstream = createServer((request, response) => { requests++; request.resume(); response.end(complete); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  process.env[env] = "fixture";
  try {
    const provider = new ChatCompletionsAPI({ ...config, tailnet: true }, { resolve: async () => ["100.64.0.1"], connectTimeoutMs: 5,
      connect: host => { assert.equal(host, "100.64.0.1"); dials++; return dials <= 3 ? new Socket() : connect({ host: "127.0.0.1", port }); } });
    const events = await drain(provider); assert.equal(events.at(-1)?.type, "done");
    assert.equal(dials, 4); assert.equal(requests, 1); assert.deepEqual(state.waits, [1000, 2000, 4000]);
  } finally { delete process.env[env]; resetNetworkRetryTiming(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});

test("tailnet DNS failures retry only a temporary resolver error and recheck the destination each time", async () => {
  for (const code of ["EAI_AGAIN", "ENOTFOUND", "PRIVATE_CODE"]) {
    clock(); let resolves = 0;
    process.env[env] = "fixture";
    try {
      const provider = new ChatCompletionsAPI({ ...config, tailnet: true }, { resolve: async () => {
        resolves++; if (resolves === 1 || code !== "EAI_AGAIN") throw failure(code);
        return ["203.0.113.5"];
      }, connect: () => { throw new Error("no public destination may be dialed"); } });
      await assert.rejects(drain(provider), { code: code === "EAI_AGAIN" ? "provider_unreachable" : "upstream_unavailable" });
      assert.equal(resolves, code === "EAI_AGAIN" ? 2 : 1);
    } finally { delete process.env[env]; resetNetworkRetryTiming(); }
  }
});

test("Responses clients keep receiving heartbeats until the chat connection recovers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chat-connect-stream-"));
  configureNetworkRetryTiming({ now: Date.now, sleep: async (_ms, signal) => { await nap(40, undefined, { signal }); } });
  const gatewayConfig: GatewayConfig = { version: 1, port: 0, stateDirectory: directory,
    providers: [{ ...config, models: { alias: "fixture" } }] };
  const gateway = await startGateway(gatewayConfig, undefined, undefined, { heartbeatMs: 20, onFailure: () => {} });
  const client = globalThis.fetch; let calls = 0;
  try {
    await withFetch(async () => { calls++; if (calls <= 3) throw failure("ETIMEDOUT"); return new Response(complete); }, async () => {
      const response = await client(`http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`, {
        method: "POST", headers: { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "alias", input: "fixture", stream: true }),
      });
      const events = []; for await (const event of readEvents(response.body!)) events.push(event);
      const firstText = events.findIndex(event => event.type === "response.output_text.delta");
      assert.ok(firstText > 0); assert.ok(events.slice(0, firstText).filter(event => event.type === "response.in_progress").length >= 2);
      assert.equal(events.at(-1)?.type, "response.completed"); assert.equal(calls, 4);
    });
  } finally { resetNetworkRetryTiming(); gateway.closeAllConnections(); await new Promise<void>(resolve => gateway.close(() => resolve())); }
});
