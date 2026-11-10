import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import { contextCacheBudget } from "../context-cache-budget.js";
import { claudeReplayBudget } from "../providers/claude-replay-budget.js";
import type { Provider } from "../providers/provider.js";

const minute = 60_000;
const cold = { input: 200000, read: 0, uncached: 200000 };

test("an idle-expired Copilot seed does not block its first warm continuation", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  let calls = 0;
  const provider: Provider = { async *infer() {
    calls++;
    yield { type: "done", usage: { input_tokens: 82110, output_tokens: 1, total_tokens: 82111,
      input_tokens_details: { cached_tokens: calls === 3 ? 82000 : 0 } } };
  } };
  const turn = async () => {
    for await (const _ of cacheGuardedInference(provider, { model: "sonnet", input: "unchanged large history" },
      new AbortController().signal, { threadId: "copilot-idle" }, "idle-expired-copilot")) {}
  };
  await turn();
  now += 58 * minute;
  await turn();
  await turn();
  assert.equal(calls, 3, "the new live session can demonstrate cache reuse after its cold seed");
});

test("active work still stops after three cold requests even when inference itself takes twenty minutes", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = contextCacheBudget("slow-active", "thread", "model", 1000);
  budget.beforeRequest("provider"); budget.record(cold);
  now += minute;
  budget.beforeRequest("provider");
  now += 20 * minute;
  budget.record(cold);
  budget.beforeRequest("provider"); budget.record(cold);
  assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
});

test("overlapping long inference cannot expire a conversation's measured cold history", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  let release!: () => void; let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  const provider: Provider = { async *infer(request) {
    calls++;
    if (request.input === "slow") { started(); await held; }
    yield { type: "done", usage: { input_tokens: 200000, output_tokens: 1, total_tokens: 200001,
      input_tokens_details: { cached_tokens: 0 } } };
  } };
  const turn = async (input: string) => {
    for await (const _ of cacheGuardedInference(provider, { model: "model", input },
      new AbortController().signal, { threadId: "overlap" }, "overlapping-active")) {}
  };
  await turn("seed"); now += minute;
  const slow = turn("slow"); await entered;
  try {
    now += 6 * minute;
    await turn("parallel");
    await turn("probe");
    await assert.rejects(turn("blocked"), { code: "invalid_request" });
    assert.equal(calls, 4, "the fifth request must not reach the provider while the slow request is active");
  } finally { release(); await slow; }
});

test("failed inference always releases its activity so a later idle restart is allowed", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  let fail = false;
  const provider: Provider = { async *infer() {
    if (fail) throw Error("fixture failure");
    yield { type: "done", usage: { input_tokens: 200000, output_tokens: 1, total_tokens: 200001,
      input_tokens_details: { cached_tokens: 0 } } };
  } };
  const turn = async () => {
    for await (const _ of cacheGuardedInference(provider, { model: "model", input: "history" },
      new AbortController().signal, { threadId: "failed-activity" }, "failed-activity")) {}
  };
  await turn(); fail = true;
  await assert.rejects(turn(), /fixture failure/);
  now += 58 * minute; fail = false;
  await turn(); await turn(); await turn();
  await assert.rejects(turn(), { code: "invalid_request" });
});

test("native Claude activity is shared across budget instances and completion is idempotent", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = () => claudeReplayBudget("native-overlap", "thread", "sonnet", 1000);
  const tokens = { input: 4, cacheRead: 0, cacheWrite: 82000, output: 1 };
  budget().record(tokens);
  const finish = budget().track();
  now += 6 * minute;
  budget().beforeRequest("continued"); budget().record(tokens);
  const probe = budget(); probe.beforeRequest("continued"); probe.record(tokens);
  assert.throws(() => budget().beforeRequest("continued"), { code: "invalid_request" });
  finish(); finish();
  now += 5 * minute;
  assert.doesNotThrow(() => budget().beforeRequest("seed"));
});

test("blocked retries cannot extend the fixed cooldown, and expiry permits one probe", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = contextCacheBudget("retry-activity", "thread", "model", 1000);
  budget.record(cold); budget.record(cold); budget.record(cold);
  now += 4 * minute;
  assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
  now += minute;
  assert.doesNotThrow(() => budget.beforeRequest("provider"), "the original deadline still admits one probe");
  budget.record(cold);
  assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
});

test("missing cache usage remains protected within active work and restarts after an idle interval", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = contextCacheBudget("idle-unknown", "thread", "model", 1000);
  budget.beforeRequest("provider"); budget.record({ input: 200000 });
  now += 58 * minute;
  budget.beforeRequest("provider"); budget.record({ input: 200000 });
  assert.doesNotThrow(() => budget.beforeRequest("provider")); budget.record({ input: 200000 });
  assert.throws(() => budget.beforeRequest("provider"), /did not report cache reuse/);
});

test("a long failed request without measurements cannot erase an earlier active miss", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = contextCacheBudget("idle-partial", "thread", "model", 1000);
  budget.beforeRequest("provider"); budget.record(cold);
  now += minute; budget.beforeRequest("provider");
  now += 20 * minute; budget.record();
  budget.beforeRequest("provider"); budget.record(cold);
  budget.beforeRequest("provider"); budget.record(cold);
  assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
});

test("a backwards clock adjustment does not clear the active block", t => {
  let now = Date.now(); const start = now; t.mock.method(Date, "now", () => now);
  const budget = contextCacheBudget("idle-clock", "thread", "model", 1000);
  budget.record(cold); budget.record(cold); budget.record(cold);
  now -= 60 * minute;
  assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
  now = start + minute;
  assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
});

test("a late legacy write after policy adoption waits for observed idle time", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const key = createHash("sha256").update(JSON.stringify(["legacy-idle", "thread", "model"])).digest("hex");
  const state = globalThis as unknown as Record<symbol, Map<string, unknown>>;
  state[Symbol.for("harness-gateway/context-cache-budget/v1")].set(key,
    { count: 3, bytes: 1000, cacheTokens: 200000, unknown: false });
  const budget = contextCacheBudget("legacy-idle", "thread", "model", 1000);
  assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
  now += 5 * minute;
  assert.doesNotThrow(() => budget.beforeRequest("provider"));
});

test("the native Claude budget applies the same idle-aware protection", t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const budget = claudeReplayBudget("idle-native-claude", "thread", "sonnet", 1000);
  const tokens = { input: 4, cacheRead: 0, cacheWrite: 82000, output: 1 };
  budget.beforeRequest("seed"); budget.record(tokens);
  now += 58 * minute;
  budget.beforeRequest("seed"); budget.record(tokens);
  assert.doesNotThrow(() => budget.beforeRequest("continued"));
  budget.record({ input: 4, cacheRead: 82000, cacheWrite: 100, output: 1 });
  assert.doesNotThrow(() => budget.beforeRequest("continued"));
});
