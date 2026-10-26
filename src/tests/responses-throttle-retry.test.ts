import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ResponsesAPI } from "../providers/responses-api.js";
import { ProviderError } from "../providers/provider.js";
import { configureThrottleRetryTiming, resetThrottleRetryTiming } from "../providers/throttle-retry.js";
import { configureNetworkRetryTiming, resetNetworkRetryTiming } from "../providers/network-retry.js";
import { throttleMessage } from "../providers/responses-errors.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

const env = "GATEWAY_THROTTLE_RETRY_FIXTURE_KEY";
const complete = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp\",\"status\":\"completed\",\"usage\":{\"input_tokens\":0,\"output_tokens\":0,\"total_tokens\":0}}}\n\n";
const delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n";
const api = () => new ResponsesAPI({ id: "fixture", type: "responses-api", apiKeyEnv: env, baseUrl: "http://fixture.invalid", models: { fixture: "fixture" } });
async function drain(signal = new AbortController().signal) { for await (const _ of api().infer({ model: "fixture", input: "fixture" }, signal)) { /* drain */ } }
const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const http429 = (error: Record<string, unknown>, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { ...error, message: "private caller data" } }), { status: 429, headers: { "content-type": "application/json", ...headers } });
const streamError = (code: string) => sse(`data: ${JSON.stringify({ type: "error", error: { code, message: "private caller data" } })}\n\n`);
const reset = () => Object.assign(new Error("private socket detail"), { code: "ECONNRESET" });

/** Fake time: waits advance the clock instantly. `random` 0.5 means no jitter. */
function fakeClock(budgetMs = 120000) {
  const state = { now: 0, waits: [] as number[] };
  const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    state.waits.push(ms);
    if (signal.aborted) { reject(new Error("aborted")); return; }
    queueMicrotask(() => { state.now += ms; resolve(); });
  });
  configureThrottleRetryTiming({ now: () => state.now, random: () => 0.5, budgetMs, sleep });
  configureNetworkRetryTiming({ now: () => state.now, random: () => 0.5, sleep });
  return state;
}
async function withFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch; globalThis.fetch = fake;
  try { return await run(); } finally { globalThis.fetch = original; }
}
function cleanup() { resetThrottleRetryTiming(); resetNetworkRetryTiming(); delete process.env[env]; }

test("a 429 throttle without Retry-After backs off on the gateway schedule and records recovery", async () => {
  const directory = await mkdtemp(join("/tmp", "gateway-throttle-retry-")); configureTelemetry(directory, "test");
  process.env[env] = "fixture"; const clock = fakeClock(); const since = Date.now();
  try {
    let calls = 0;
    await withFetch(async () => ++calls <= 3 ? http429({ code: "rate_limit_exceeded" }) : sse(complete), async () => await drain());
    assert.equal(calls, 4);
    assert.deepEqual(clock.waits, [1000, 2000, 4000]);
    await flushTelemetry();
    const events = await readTelemetry(directory, since);
    const retries = events.filter(event => event.event === "provider_retry");
    assert.deepEqual(retries.map(event => event.code), Array(3).fill("rate_limit_exceeded"));
    assert.deepEqual(retries.map(event => event.elapsedMs), [0, 1000, 3000]);
    const recovered = events.filter(event => event.event === "provider_recovered");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.class, "throttle"); assert.equal(recovered[0]!.attempts, 4); assert.equal(recovered[0]!.elapsedMs, 7000);
  } finally { cleanup(); await flushTelemetry(); await rm(directory, { recursive: true, force: true }); }
});

test("a throttle longer than the budget fails as a retryable throttle with an honest message", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    let calls = 0;
    const failure = await withFetch(async () => { calls++; return http429({ code: "rate_limit_exceeded" }); },
      async () => drain().then(() => undefined, (error: unknown) => error));
    assert.ok(failure instanceof ProviderError);
    assert.equal(failure.code, "rate_limit_exceeded"); assert.equal(failure.status, 429); assert.equal(failure.message, throttleMessage);
    // 1 + 2 + 4 + (14 × 8) = 119 s; the next 8 s wait would cross 120 s, so it is never started.
    assert.deepEqual(clock.waits, [1000, 2000, 4000, ...Array(14).fill(8000)]); assert.equal(calls, 18);
    assert.equal(clock.now, 119000, "the returned failure occurred before the deadline, without a shortened final wait");
  } finally { cleanup(); }
});

test("Retry-After replaces the step, and a stream throttle retries on the same schedule", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    let calls = 0;
    await withFetch(async () => { calls++; return calls === 1 ? http429({ code: "rate_limit_exceeded" }, { "retry-after": "7" }) : calls === 2 ? streamError("rate_limit_exceeded") : sse(complete); },
      async () => await drain());
    assert.equal(calls, 3); assert.deepEqual(clock.waits, [7000, 2000]);
  } finally { cleanup(); }
});

test("quota and usage-limit 429s are final and never retried", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    for (const error of [{ code: "insufficient_quota" }, { type: "usage_limit_reached" }]) {
      let calls = 0;
      const failure = await withFetch(async () => { calls++; return http429(error, { "retry-after": "2" }); }, async () => drain().then(() => undefined, (e: unknown) => e));
      assert.ok(failure instanceof ProviderError); assert.notEqual(failure.code, "rate_limit_exceeded"); assert.equal(calls, 1);
    }
    assert.deepEqual(clock.waits, []);
  } finally { cleanup(); }
});

test("a wait resumed after sleep cannot start a request beyond the throttle budget", async () => {
  process.env[env] = "fixture"; let now = 0; let calls = 0;
  configureThrottleRetryTiming({ now: () => now, random: () => 0.5, budgetMs: 120000,
    sleep: async () => { now = 121000; } });
  try {
    const failure = await withFetch(async () => { calls++; return calls === 1 ? http429({ code: "rate_limit_exceeded" }) : sse(complete); },
      async () => drain().then(() => undefined, (error: unknown) => error));
    assert.ok(failure instanceof ProviderError); assert.equal(failure.code, "rate_limit_exceeded");
    assert.equal(calls, 1);
  } finally { cleanup(); }
});

test("a throttle after published output is never replayed", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    let calls = 0;
    const body = delta + `data: ${JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded" } })}\n\n`;
    const failure = await withFetch(async () => { calls++; return sse(body); }, async () => drain().then(() => undefined, (e: unknown) => e));
    assert.ok(failure instanceof ProviderError); assert.equal(failure.code, "rate_limit_exceeded"); assert.equal(calls, 1); assert.deepEqual(clock.waits, []);
  } finally { cleanup(); }
});

test("cancellation during a throttle wait stops at once", async () => {
  process.env[env] = "fixture"; const controller = new AbortController();
  configureThrottleRetryTiming({ now: () => 0, random: () => 0.5, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); queueMicrotask(() => controller.abort());
  }) });
  try {
    let calls = 0;
    await assert.rejects(withFetch(async () => { calls++; return http429({ code: "rate_limit_exceeded" }); }, async () => await drain(controller.signal)));
    assert.equal(calls, 1);
  } finally { cleanup(); }
});

test("throttles spend neither the connection budget nor the single retry of other classes", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    let calls = 0;
    const plan: Array<() => Response> = [
      () => http429({ code: "rate_limit_exceeded" }),
      () => { throw reset(); },
      () => http429({ code: "rate_limit_exceeded" }),
      () => new Response("{}", { status: 503 }),
      () => http429({ code: "rate_limit_exceeded" }),
      () => sse(complete),
    ];
    await withFetch(async () => plan[calls++]!(), async () => await drain());
    assert.equal(calls, 6);
    // throttle 1 s, network 1 s, throttle 2 s, throttle 4 s. The single 503 retry waits 1 s of
    // real time on its own timer, so it is absent here; calls === 6 proves it still happened.
    assert.deepEqual(clock.waits, [1000, 1000, 2000, 4000]);
  } finally { cleanup(); }
});

test("a network failure and a later throttle start independent 120-second budgets", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    let calls = 0;
    const plan: Array<() => Response> = [
      () => { throw reset(); },
      () => http429({ code: "rate_limit_exceeded" }),
      () => { throw reset(); },
      () => http429({ code: "rate_limit_exceeded" }),
      () => sse(complete),
    ];
    await withFetch(async () => plan[calls++]!(), async () => await drain());
    assert.equal(calls, 5);
    assert.deepEqual(clock.waits, [1000, 1000, 2000, 2000]);
  } finally { cleanup(); }
});

test("a named Retry-After can use the throttle budget past the unnamed 60-second compatibility limit", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    let calls = 0;
    await withFetch(async () => ++calls === 1
      ? http429({ code: "rate_limit_exceeded" }, { "retry-after": "45" }) : sse(complete), async () => await drain());
    assert.equal(calls, 2); assert.deepEqual(clock.waits, [45000]);
    calls = 0; clock.now = 0; clock.waits.length = 0;
    await withFetch(async () => ++calls === 1
      ? http429({ code: "rate_limit_exceeded" }, { "retry-after": "75" }) : sse(complete), async () => await drain());
    assert.equal(calls, 2); assert.deepEqual(clock.waits, [75000]);
    calls = 0; clock.now = 0; clock.waits.length = 0;
    const failure = await withFetch(async () => { calls++; return http429({ code: "rate_limit_exceeded" }, { "retry-after": "121" }); },
      async () => drain().then(() => undefined, (error: unknown) => error));
    assert.ok(failure instanceof ProviderError); assert.equal(failure.code, "rate_limit_exceeded");
    assert.equal(calls, 1); assert.deepEqual(clock.waits, []);
  } finally { cleanup(); }
});

test("repeated throttles return the last failure without a shortened final wait", async () => {
  process.env[env] = "fixture"; const clock = fakeClock();
  try {
    let calls = 0;
    const failure = await withFetch(async () => {
      calls++;
      return http429({ code: "rate_limit_exceeded" }, { "retry-after": calls < 3 ? "1" : "119" });
    }, async () => drain().then(() => undefined, (error: unknown) => error));
    assert.ok(failure instanceof ProviderError); assert.equal(failure.code, "rate_limit_exceeded");
    assert.equal(failure.upstream?.retryAfterMs, 119000, "the third, triggering failure is returned unchanged");
    assert.equal(calls, 3); assert.deepEqual(clock.waits, [1000, 1000]); assert.equal(clock.now, 2000);
  } finally { cleanup(); }
});
