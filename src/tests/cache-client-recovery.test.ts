import test from "node:test";
import assert from "node:assert/strict";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import type { InferenceContext, Provider } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";
import { ContextCacheBlocked } from "../context-cache-budget.js";
import { createHash } from "node:crypto";
import { inferenceContext } from "../providers/provider.js";

test("the legacy SDK capability header remains parseable without changing cache policy", () => {
  assert.equal(inferenceContext({ "x-harness-cache-recovery": "1" }).cacheRecovery, true);
  for (const value of [undefined, "true", "2", ["1", "1"]]) assert.equal(inferenceContext({ "x-harness-cache-recovery": value }).cacheRecovery, undefined);
  assert.equal(inferenceContext({}, { client_metadata: { cacheRecovery: true } }).cacheRecovery, undefined);
});

test("a blocked SDK turn remains a cache refusal and never impersonates context exhaustion", async () => {
  let calls = 0;
  const provider: Provider = { async *infer() { calls++; yield { type: "done", usage: {
    input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 0 } } }; } };
  const context: InferenceContext = { threadId: "recover-once", turnId: "turn", requestKind: "turn", cacheRecovery: true };
  const run = async (input = "a".repeat(1000), extra: Partial<InferenceContext> = {}) => {
    for await (const _ of cacheGuardedInference(provider, { model: "same", input }, new AbortController().signal,
      { ...context, ...extra }, "sdk-cache-recovery")) {}
  };
  await run(); await run();
  await assert.rejects(run(), error => error instanceof ContextCacheBlocked && streamFailureCode(error) === "invalid_prompt" && !/compact|context window/i.test(error.message));
  assert.equal(calls, 2, "the cache stop never spends a third full-context request");
  await assert.rejects(run(undefined, { turnId: "retry-turn" }), { code: "invalid_request" });
  await run(undefined, { requestKind: "compaction" }); await run(undefined, { requestKind: "compaction" });
  await assert.rejects(run(undefined, { requestKind: "compaction" }), { code: "invalid_request" });
  assert.equal(calls, 4, "cold compaction has its own bound and never enters SDK trim/retry recovery");
  await run("short summary"); assert.equal(calls, 5);
});

test("anonymous, unclassified, and native Messages clients retain the final refusal", async () => {
  const provider: Provider = { async *infer() { yield { type: "done", usage: {
    input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 0 } } }; } };
  for (const context of [{}, { threadId: "plain" }, { threadId: "old-sdk", turnId: "t", requestKind: "turn" },
    { threadId: "messages", turnId: "t", requestKind: "turn", clientProtocol: "messages", cacheRecovery: true }] as InferenceContext[]) {
    const run = async () => { for await (const _ of cacheGuardedInference(provider, { model: "m", input: "large" },
      new AbortController().signal, context, "no-sdk-cache-recovery")) {} };
    await run(); await run(); await assert.rejects(run(), { code: "invalid_request" });
  }
});

test("legacy SDK capability and late writers cannot turn a cache stop into a context-limit signal", async () => {
  const { contextCacheBudget } = await import("../context-cache-budget.js");
  const scope = "legacy-recovery", identity = "thread", model = "m";
  const budget = contextCacheBudget(scope, identity, model, 1000);
  const cold = { input: 200000, read: 0, uncached: 200000 };
  budget.record(cold); budget.record(cold);
  const legacyBeforeRequest: (mode: "provider", legacyFlag: boolean) => void = budget.beforeRequest;
  assert.throws(() => legacyBeforeRequest("provider", true), { code: "invalid_request" });
  const key = createHash("sha256").update(JSON.stringify([scope, identity, model])).digest("hex");
  const histories = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("harness-gateway/context-cache-budget/v1")];
  // The old record() replaces the object without knowing any new recovery fields.
  histories.set(key, { count: 3, bytes: 1000, cacheTokens: 200000, unknown: false, lastActivityAt: Date.now() });
  const fresh = await import(new URL("../context-cache-budget.js?recovery-adoption", import.meta.url).href);
  assert.throws(() => fresh.contextCacheBudget(scope, identity, model, 1000).beforeRequest("provider"), { code: "invalid_request" });
});
