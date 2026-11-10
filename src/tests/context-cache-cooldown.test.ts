import assert from "node:assert/strict";
import test from "node:test";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import { contextCacheBudget, ContextCacheBlocked } from "../context-cache-budget.js";
import type { Provider } from "../providers/provider.js";

const cold = { input: 104562, read: 0, uncached: 104562 };
const partial = { input: 106877, read: 28672, uncached: 78205 };
const warm = { input: 107000, read: 106000, uncached: 1000 };
const minute = 60_000;

test("the Terra incident can demonstrate warm reuse on its third request", async () => {
  let calls = 0;
  const provider: Provider = { async *infer() {
    const value = [cold, partial, warm][Math.min(calls++, 2)];
    yield { type: "done", usage: { input_tokens: value.input, input_tokens_details: { cached_tokens: value.read }, output_tokens: 1, total_tokens: value.input + 1 } };
  } };
  const send = async () => { for await (const _ of cacheGuardedInference(provider, { model: "terra", input: "history" }, new AbortController().signal, { threadId: "incident" }, "cooldown-incident")) {} };
  await send(); await send(); await send(); await send();
  assert.equal(calls, 4);
});

test("three cold calls start a fixed cooldown; expiry buys only one probe", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = () => contextCacheBudget("fixed-cooldown", "thread", "model", 1000);
  for (let i = 0; i < 3; i++) { const request = budget(); request.beforeRequest("provider"); request.record(cold); }
  const start = now;
  for (let i = 1; i <= 4; i++) {
    now = start + i * minute;
    assert.throws(() => budget().beforeRequest("provider"), error => error instanceof ContextCacheBlocked && error.message.includes(`${(5 - i) * 60} seconds`));
  }
  now = start + 5 * minute;
  const probe = budget(); probe.beforeRequest("provider");
  assert.throws(() => budget().beforeRequest("provider"), ContextCacheBlocked, "only one probe can claim admission");
  probe.record(cold);
  assert.throws(() => budget().beforeRequest("provider"), ContextCacheBlocked, "a cold probe immediately starts another cooldown");
  now += 5 * minute;
  const recovered = budget(); recovered.beforeRequest("provider"); recovered.record(warm);
  assert.doesNotThrow(() => budget().beforeRequest("provider"));
});

test("a third attempt is reserved across budget instances and a usage-less failure consumes it", () => {
  const budget = () => contextCacheBudget("probe-reservation", "thread", "model", 1000);
  budget().record(cold); budget().record(cold);
  const probe = budget(); probe.beforeRequest("provider");
  assert.doesNotThrow(() => probe.beforeRequest("seed"), "native preparation may recheck the same admission");
  const finish = probe.track();
  assert.throws(() => budget().beforeRequest("provider"), /current request/);
  probe.record(); finish();
  assert.throws(() => budget().beforeRequest("provider"), ContextCacheBlocked);
});

test("unknown usage and refusals retain the two-request limit, including mixed streaks", () => {
  for (const kind of ["unknown", "refused"] as const) {
    const budget = contextCacheBudget("strict-cooldown", kind, "model", 300000);
    budget.record(kind === "unknown" ? { input: cold.input } : cold, { refused: kind === "refused" });
    // An ordinary measured miss cannot erase the strict nature of the streak.
    budget.record(cold, { refused: kind === "refused" });
    assert.throws(() => budget.beforeRequest("provider"), ContextCacheBlocked);
  }
});

test("a long in-flight request cannot reopen a cooled-down conversation in parallel", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = () => contextCacheBudget("cooldown-inflight", "thread", "model", 1000);
  const slow = budget(); const finish = slow.track();
  for (let i = 0; i < 3; i++) budget().record(cold);
  now += 6 * minute;
  assert.throws(() => budget().beforeRequest("provider"), /current request/);
  finish();
  const probe = budget(); probe.beforeRequest("provider"); probe.record(cold);
  assert.throws(() => budget().beforeRequest("provider"), ContextCacheBlocked);
});

test("native track-before-admission permits recovery, and failed admission work cannot leak its reservation", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = () => contextCacheBudget("native-cooldown-order", "thread", "model", 1000);
  for (let i = 0; i < 3; i++) {
    const request = budget(); const finish = request.track();
    try { request.beforeRequest("seed"); request.record(cold); } finally { finish(); }
  }
  now += 5 * minute;
  const failed = budget(); const finishFailed = failed.track();
  failed.beforeRequest("seed"); finishFailed(); // The transport failed before reporting any usage.
  assert.throws(() => budget().beforeRequest("seed"), ContextCacheBlocked);
  now += 5 * minute;
  const recovered = budget(); const finishRecovered = recovered.track();
  try { recovered.beforeRequest("seed"); recovered.record(warm); } finally { finishRecovered(); }
  assert.doesNotThrow(() => budget().beforeRequest("continued"));
});

test("a cooldown probe stays bounded even when a caller change or cancellation excuses its miss", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  for (const outcome of [{ clientChange: true }, { cancelled: true }]) {
    const budget = () => contextCacheBudget("excused-cooldown-probe", JSON.stringify(outcome), "model", 1000);
    for (let i = 0; i < 3; i++) budget().record(cold);
    now += 5 * minute;
    const probe = budget(); probe.beforeRequest("provider"); probe.record(cold, outcome);
    assert.throws(() => budget().beforeRequest("provider"), ContextCacheBlocked);
  }
});

test("stale completion and cleanup cannot release a newer compacted chat's recovery reservation", () => {
  for (const finishOnly of [false, true]) {
    const budget = (bytes = 1000) => contextCacheBudget("probe-generation", String(finishOnly), "model", bytes);
    budget().record(cold); budget().record(cold);
    const stale = budget(); stale.beforeRequest("provider"); const finishStale = stale.track();
    const compacted = budget(500); compacted.beforeRequest("provider"); compacted.record(cold);
    budget(500).record(cold);
    const current = budget(500); current.beforeRequest("provider"); const finishCurrent = current.track();
    if (!finishOnly) stale.record(cold, { clientChange: true });
    finishStale();
    assert.throws(() => budget(500).beforeRequest("provider"), /current request/);
    current.record(warm); finishCurrent();
    assert.doesNotThrow(() => budget(500).beforeRequest("provider"));
  }
});
