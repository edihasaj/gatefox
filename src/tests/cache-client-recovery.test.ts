import test from "node:test";
import assert from "node:assert/strict";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import type { InferenceContext, Provider } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";
import { ContextCacheRecoveryRequired } from "../context-cache-budget.js";
import { createHash } from "node:crypto";

test("a blocked SDK turn offers compaction once without another provider call; a compacted history recovers", async () => {
  let calls = 0;
  const provider: Provider = { async *infer() { calls++; yield { type: "done", usage: {
    input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 0 } } }; } };
  const context: InferenceContext = { threadId: "recover-once", turnId: "turn", requestKind: "turn" };
  const run = async (input = "a".repeat(1000), extra: Partial<InferenceContext> = {}) => {
    for await (const _ of cacheGuardedInference(provider, { model: "same", input }, new AbortController().signal,
      { ...context, ...extra }, "sdk-cache-recovery")) {}
  };
  await run(); await run();
  await assert.rejects(run(), error => error instanceof ContextCacheRecoveryRequired && streamFailureCode(error) === "context_length_exceeded");
  assert.equal(calls, 2, "recovery notification never spends a third full-context request");
  await assert.rejects(run(undefined, { turnId: "retry-turn" }), { code: "invalid_request" });
  await run(undefined, { requestKind: "compaction" }); await run(undefined, { requestKind: "compaction" });
  await assert.rejects(run(undefined, { requestKind: "compaction" }), { code: "invalid_request" });
  assert.equal(calls, 4, "cold compaction has its own bound and never enters SDK trim/retry recovery");
  await run("short summary"); assert.equal(calls, 5);
});

test("anonymous, unclassified, and native Messages clients retain the final refusal", async () => {
  const provider: Provider = { async *infer() { yield { type: "done", usage: {
    input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 0 } } }; } };
  for (const context of [{}, { threadId: "plain" }, { threadId: "messages", turnId: "t", requestKind: "turn", clientProtocol: "messages" }] as InferenceContext[]) {
    const run = async () => { for await (const _ of cacheGuardedInference(provider, { model: "m", input: "large" },
      new AbortController().signal, context, "no-sdk-cache-recovery")) {} };
    await run(); await run(); await assert.rejects(run(), { code: "invalid_request" });
  }
});

test("a late legacy cold completion and module reload cannot offer client recovery twice", async () => {
  const { contextCacheBudget } = await import("../context-cache-budget.js");
  const scope = "legacy-recovery", identity = "thread", model = "m";
  const budget = contextCacheBudget(scope, identity, model, 1000);
  const cold = { input: 200000, read: 0, uncached: 200000 };
  budget.record(cold); budget.record(cold);
  assert.throws(() => budget.beforeRequest("provider", true), { code: "context_length_exceeded" });
  const key = createHash("sha256").update(JSON.stringify([scope, identity, model])).digest("hex");
  const histories = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("harness-gateway/context-cache-budget/v1")];
  // The old record() replaces the object without knowing any new recovery fields.
  histories.set(key, { count: 3, bytes: 1000, cacheTokens: 200000, unknown: false, lastActivityAt: Date.now() });
  const fresh = await import(new URL("../context-cache-budget.js?recovery-adoption", import.meta.url).href);
  assert.throws(() => fresh.contextCacheBudget(scope, identity, model, 1000).beforeRequest("provider", true), { code: "invalid_request" });
});
