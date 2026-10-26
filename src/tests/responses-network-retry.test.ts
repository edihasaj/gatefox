import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { configureNetworkRetryTiming, resetNetworkRetryTiming } from "../providers/network-retry.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { providerFailureDiagnostic } from "../provider-failure.js";
import { writePrivateJson, gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway } from "../server.js";
import { readEvents } from "../protocol/sse.js";
import type { WireEvent } from "../protocol/types.js";
import { setTimeout as nap } from "node:timers/promises";

const env = "GATEWAY_NETWORK_RETRY_FIXTURE_KEY";
const complete = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp\",\"status\":\"completed\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"total_tokens\":0}}}\n\n";
const delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n";
const reset = () => Object.assign(new Error("private socket detail"), { code: "ECONNRESET" });
const api = () => new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: "http://fixture.invalid", models: { fixture: "fixture" } });
async function drain(signal = new AbortController().signal) { for await (const _ of api().infer({ model: "fixture", input: "fixture" }, signal)) { /* drain */ } }
const sse = (body: ReadableStream<Uint8Array>) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const frames = (...written: string[]) => { const rest = [...written]; return new ReadableStream<Uint8Array>({ pull(c) { const next = rest.shift(); if (next !== undefined) c.enqueue(new TextEncoder().encode(next)); else c.close(); } }); };

/**
 * Fake time for the connection-retry budget: every wait advances the clock instead of
 * sleeping, so a 120 second outage costs no real seconds. `random` at 0.5 means no jitter.
 */
function fakeRetryClock(budgetMs = 120000) {
  const state = { now: 0, waits: [] as number[] };
  configureNetworkRetryTiming({
    now: () => state.now, random: () => 0.5, budgetMs,
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      state.waits.push(ms);
      if (signal.aborted) { reject(new Error("aborted")); return; }
      queueMicrotask(() => { state.now += ms; resolve(); });
    }),
  });
  return state;
}
async function withFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch; globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("a connect outage is absorbed inside the gateway and recorded as recovered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-network-retry-")); configureTelemetry(directory, "test");
  process.env[env] = "fixture"; const clock = fakeRetryClock(); const since = Date.now();
  try {
    let calls = 0;
    await withFetch(async () => { calls++; return calls <= 6 ? (() => { throw reset(); })() : new Response(complete, { headers: { "content-type": "text/event-stream" } }); },
      async () => await drain());
    assert.equal(calls, 7);
    // 1 s, 2 s, 4 s, then the 8 s ceiling, with nothing spent on real seconds.
    assert.deepEqual(clock.waits, [1000, 2000, 4000, 8000, 8000, 8000]);
    await flushTelemetry();
    const events = await readTelemetry(directory, since);
    const retries = events.filter(event => event.event === "provider_retry");
    assert.equal(retries.length, 6);
    assert.deepEqual(retries.map(event => event.attempt), [2, 3, 4, 5, 6, 7]);
    assert.deepEqual(retries.map(event => event.elapsedMs), [0, 1000, 3000, 7000, 15000, 23000]);
    assert.deepEqual(retries.map(event => event.upstreamStage), Array(6).fill("connect"));
    const recovered = events.filter(event => event.event === "provider_recovered");
    assert.equal(recovered.length, 1);
    assert.deepEqual({ ...recovered[0], at: undefined, host: undefined, component: undefined, pid: undefined },
      { at: undefined, host: undefined, component: undefined, pid: undefined, event: "provider_recovered", provider: "fixture", class: "network", attempts: 7, elapsedMs: 31000 });
  } finally {
    resetNetworkRetryTiming(); delete process.env[env]; await flushTelemetry(); await rm(directory, { recursive: true, force: true });
  }
});

test("a connection wait resumed beyond its budget returns the original failure without another request", async () => {
  process.env[env] = "fixture"; let now = 0; let calls = 0;
  configureNetworkRetryTiming({ now: () => now, random: () => 0.5, budgetMs: 120000, sleep: async () => { now = 121000; } });
  try {
    const failure = await withFetch(async () => { calls++; if (calls === 1) throw reset(); return new Response(complete, { headers: { "content-type": "text/event-stream" } }); },
      async () => drain().then(() => undefined, (error: unknown) => error));
    assert.ok(failure instanceof ProviderError); assert.equal(failure.code, "upstream_unavailable");
    assert.equal(failure.upstream?.code, "ECONNRESET"); assert.equal(calls, 1);
  } finally { resetNetworkRetryTiming(); delete process.env[env]; }
});

test("a connect outage longer than the budget spends it on waits and never starts a late attempt", async () => {
  process.env[env] = "fixture"; const clock = fakeRetryClock();
  // Each attempt reports a different transient code, so the survivor is identifiable.
  const codes = ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNABORTED", "ENETDOWN", "ENETUNREACH"] as const;
  const starts: number[] = []; const thrown: string[] = [];
  try {
    const failure = await withFetch(async () => {
      starts.push(clock.now);
      const code = codes[starts.length % codes.length]!; thrown.push(code);
      throw Object.assign(new Error("private socket detail"), { code });
    }, async () => {
      try { await drain(); } catch (error) { assert.ok(error instanceof ProviderError); return error; }
      throw new Error("inference unexpectedly succeeded");
    });
    assert.equal(failure.code, "upstream_unavailable"); assert.equal(failure.upstream?.event, "network");
    assert.ok(starts.length > 10, `expected the budget to hold out, saw ${starts.length} attempts`);
    assert.ok(thrown[0] !== thrown.at(-1));
    // The clipped wait was the defect: an attempt at or after the deadline re-runs a request the caller
    // has already waited out, so every start must stay inside the budget and the waits must never be cut.
    assert.ok(starts.every(at => at < 120000), `an attempt started at ${Math.max(...starts)}`);
    assert.deepEqual(clock.waits, [1000, 2000, 4000, ...Array(14).fill(8000)]);
    assert.equal(clock.now, 119000);
    assert.equal(failure.upstream?.code, thrown.at(-1), "the surfaced failure must be the last one, not the first");
  } finally { resetNetworkRetryTiming(); delete process.env[env]; }
});

// The outage budget belongs to the connection failures alone: a throttle that came first must not spend it.
test("a throttle earlier in the request cannot spend the outage budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-network-retry-mixed-")); configureTelemetry(directory, "test");
  process.env[env] = "fixture"; const clock = fakeRetryClock(); const since = Date.now();
  try {
    let calls = 0;
    await withFetch(async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { code: "server_error", message: "private" } }), { status: 503 });
      // Wall time passes before the route itself goes down; the outage starts 110 s in.
      if (calls === 2) clock.now = 110000;
      if (calls <= 6) throw reset();
      return new Response(complete, { headers: { "content-type": "text/event-stream" } });
    }, async () => await drain());
    assert.equal(calls, 7, "the outage was cut short by an unrelated throttle");
    assert.deepEqual(clock.waits, [1000, 2000, 4000, 8000, 8000]);
    await flushTelemetry();
    const events = await readTelemetry(directory, since);
    const retries = events.filter(event => event.event === "provider_retry");
    // Attempt 2 is the HTTP retry, timed from the HTTP failure; the rest from the first connection failure.
    assert.deepEqual(retries.map(event => event.attempt), [2, 3, 4, 5, 6, 7]);
    assert.deepEqual(retries.map(event => event.elapsedMs), [0, 0, 1000, 3000, 7000, 15000]);
    const recovered = events.filter(event => event.event === "provider_recovered");
    assert.equal(recovered.length, 1); assert.equal(recovered[0].elapsedMs, 23000); assert.equal(recovered[0].attempts, 7);
  } finally {
    resetNetworkRetryTiming(); delete process.env[env]; await flushTelemetry(); await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation during a connection backoff stops at once and sends nothing more", async () => {
  process.env[env] = "fixture"; const controller = new AbortController(); let calls = 0;
  const started = Date.now();
  try {
    await withFetch(async () => { calls++; throw reset(); }, async () => {
      const pending = drain(controller.signal); const timer = setTimeout(() => controller.abort(), 25);
      await assert.rejects(pending); clearTimeout(timer);
    });
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 2000, "the backoff outlived the cancellation");
  } finally { delete process.env[env]; }
});

test("a connection reset after published output is never replayed", async () => {
  process.env[env] = "fixture"; const clock = fakeRetryClock(); let calls = 0;
  // The body carries one text delta, then the socket dies: a second attempt would duplicate published text.
  const stream = () => { const written = [delta]; return new ReadableStream<Uint8Array>({
    pull(c) { const next = written.shift(); if (next !== undefined) c.enqueue(new TextEncoder().encode(next)); else c.error(reset()); } }); };
  try {
    await withFetch(async () => { calls++; return sse(stream()); },
      async () => await assert.rejects(drain(), (error: unknown) => error instanceof ProviderError && error.upstream?.event === "network" && error.upstream?.stage === "stream"));
    assert.equal(calls, 1); assert.deepEqual(clock.waits, []);
  } finally { resetNetworkRetryTiming(); delete process.env[env]; }
});

test("an HTTP 503 keeps its single retry, and the budget cannot widen it", async () => {
  process.env[env] = "fixture"; const clock = fakeRetryClock();
  try {
    let calls = 0;
    await withFetch(async () => { calls++; return new Response(JSON.stringify({ error: { code: "server_error", message: "private" } }), { status: 503 }); },
      async () => await assert.rejects(drain()));
    // The one-retry classes never enter the connection budget: no seam wait, one real second.
    assert.equal(calls, 2); assert.deepEqual(clock.waits, []); assert.equal(clock.now, 0);
  } finally { resetNetworkRetryTiming(); delete process.env[env]; }
});

test("a failed login refresh is never retried inside the gateway", async () => {
  const credentialFile = join(await mkdtemp(join(tmpdir(), "gateway-network-retry-oauth-")), "codex.json");
  await writePrivateJson(credentialFile, {
    client_id: "oaiapp_test", subject: "test-user", ext_agent_host_id: "urn:uuid:test", access_token: "old",
    refresh_token: "old-refresh", id_token: "id", scopes: ["openid", "resource.invoke", "chatgpt.tokens.use.direct"], expires_at: 0,
  });
  try {
    let calls = 0;
    await withFetch(async () => { calls++; return new Response("{}", { status: 503 }); }, async () =>
      await assert.rejects(drainOn(new ResponsesAPI({ id: "codex", type: "codex-subscription", credentialFile, models: { fixture: "fixture" } })),
        (error: unknown) => error instanceof ProviderError && error.upstream?.event === "oauth_refresh"));
    assert.equal(calls, 1);
  } finally { await rm(credentialFile, { force: true }); }
});
async function drainOn(provider: ResponsesAPI) { for await (const _ of provider.infer({ model: "fixture", input: "fixture" }, new AbortController().signal)) { /* drain */ } }

// The outage budget only works while the client stays patient: the server must keep
// heartbeating while the provider has produced nothing at all.
test("heartbeats cover the retry window, so the client never sees a stalled stream", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-network-retry-stream-"));
  process.env[env] = "fixture";
  // Real waits, but short ones: three retries span well over the fixture heartbeat.
  configureNetworkRetryTiming({ now: () => Date.now(), random: () => 0.5, budgetMs: 120000, sleep: () => nap(40) });
  let calls = 0;
  const route = api();
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, timeoutMs: 600000, maxConcurrent: 4,
    providers: [{ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: "http://fixture.invalid", models: { alias: "fixture" } }] };
  const server = await startGateway(config, () => route, undefined, { heartbeatMs: 20, onFailure: () => {} });
  try {
    // The client keeps the real fetch; only the provider's upstream call is mocked.
    const upstream = globalThis.fetch;
    globalThis.fetch = async () => { calls++; return calls <= 3 ? (() => { throw reset(); })() : sse(frames(delta, complete)); };
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const stream = await upstream(`${url}/v1/responses`, { method: "POST",
        headers: { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "alias", input: "fixture", stream: true }) });
      assert.equal(stream.status, 200);
      const events: WireEvent[] = []; for await (const event of readEvents(stream.body!)) events.push(event);
      const firstText = events.findIndex(event => event.type === "response.output_text.delta");
      assert.ok(firstText > 0);
      assert.equal(events[0].type, "response.created");
      assert.ok(events.slice(0, firstText).filter(event => event.type === "response.in_progress").length >= 2,
        "the retry window ran without a heartbeat");
      assert.equal(events.at(-1)!.type, "response.completed");
      assert.equal(calls, 4);
    } finally { globalThis.fetch = upstream; }
  } finally { resetNetworkRetryTiming(); delete process.env[env]; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

// A whole outage that ends in failure must still say which sockets were tried.
test("a request that exhausts the budget records its mixed codes on request_failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-network-retry-fail-")); configureTelemetry(directory, "server");
  process.env[env] = "fixture"; const clock = fakeRetryClock(1500); const since = Date.now();
  const mixed = () => new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("private"), { code: "ETIMEDOUT" }), Object.assign(new Error("private"), { code: "EHOSTUNREACH" })]) });
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, timeoutMs: 600000, maxConcurrent: 4,
    providers: [{ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: "http://fixture.invalid", models: { alias: "fixture" } }] };
  const server = await startGateway(config, () => api(), undefined, { heartbeatMs: 5000, onFailure: () => {} });
  try {
    const client = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; throw mixed(); };
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const stream = await client(`${url}/v1/responses`, { method: "POST",
        headers: { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "alias", input: "fixture", stream: true }) });
      for await (const _ of readEvents(stream.body!)) { /* drain the failed stream */ }
      await flushTelemetry();
      const failed = (await readTelemetry(directory, since)).filter(event => event.event === "request_failed");
      assert.equal(failed.length, 1);
      assert.equal(failed[0].upstreamEvent, "network"); assert.equal(failed[0].upstreamStage, "connect");
      assert.equal(failed[0].upstreamCode, undefined);
      assert.equal(failed[0].networkCodes, "EHOSTUNREACH,ETIMEDOUT");
      assert.equal(failed[0].code, "upstream_unavailable");
      assert.ok(calls > 1); assert.equal(clock.now, 1000); assert.ok(!JSON.stringify(failed).includes("private"));
    } finally { globalThis.fetch = client; }
  } finally {
    resetNetworkRetryTiming(); delete process.env[env];
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("happy-eyeballs codes that differ are named in the diagnostic and still retried", async () => {
  process.env[env] = "fixture"; const clock = fakeRetryClock(1500);
  const mixed = () => new TypeError("fetch failed", { cause: new AggregateError([Object.assign(new Error("private"), { code: "ETIMEDOUT" }), Object.assign(new Error("private"), { code: "EHOSTUNREACH" })]) });
  try {
    let calls = 0;
    const failure = await withFetch(async () => { calls++; throw mixed(); }, async () => {
      try { await drain(); } catch (error) { assert.ok(error instanceof ProviderError); return error; }
      throw new Error("inference unexpectedly succeeded");
    });
    assert.ok(calls > 1, "a mixed transient failure stays retryable");
    assert.equal(failure.upstream?.code, undefined);
    assert.deepEqual(failure.upstream?.networkCodes, ["EHOSTUNREACH", "ETIMEDOUT"]);
    const diagnostic = providerFailureDiagnostic({ requestId: "00000000-0000-0000-0000-000000000000", durationMs: clock.now, failure });
    assert.equal(diagnostic.networkCodes, "EHOSTUNREACH,ETIMEDOUT");
    assert.equal(diagnostic.upstreamStage, "connect");
    assert.ok(!JSON.stringify(diagnostic).includes("private"));
  } finally { resetNetworkRetryTiming(); delete process.env[env]; }
});
