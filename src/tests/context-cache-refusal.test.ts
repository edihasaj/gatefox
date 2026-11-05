import assert from "node:assert/strict";
import test from "node:test";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import { contextCacheBudget, ContextCacheBlocked } from "../context-cache-budget.js";
import { claudeReplayBudget } from "../providers/claude-replay-budget.js";
import { ProviderError, providerRefusal, type Provider } from "../providers/provider.js";

const large = 3_000_000;
const rebuild = { input: 367934, read: 46749, uncached: 321185 };
const warm = { input: 371369, read: 371143, uncached: 226 };
const claudeRebuild = { input: 2, cacheRead: 46749, cacheWrite: 321183, output: 1 };

test("a refusal does not make the recovery that follows it trip the stop", () => {
  const budget = contextCacheBudget("refusal-recovers", "thread", "opus", large);
  budget.record(rebuild, { refused: true });
  budget.beforeRequest("provider"); budget.record(rebuild);
  assert.doesNotThrow(() => budget.beforeRequest("provider"), "the rebuilt session continues cheaply");
  budget.record(warm);
});

test("Claude's own budget lets the same recovery continue", () => {
  const budget = () => claudeReplayBudget("refusal-native", "thread", "opus", large);
  budget().record(claudeRebuild, { refused: true });
  budget().beforeRequest("seed"); budget().record(claudeRebuild);
  assert.doesNotThrow(() => budget().beforeRequest("continued"));
});

test("repeated refusals reach the stop after two resends", () => {
  const budget = contextCacheBudget("refusal-repeats", "thread", "opus", large);
  let spent = 0;
  assert.throws(() => { for (;;) { budget.beforeRequest("provider"); spent++; budget.record(rebuild, { refused: true }); assert.ok(spent < 20); } }, ContextCacheBlocked);
  assert.equal(spent, 2);
});

test("refusals that report no usage still count on a large chat", () => {
  const budget = contextCacheBudget("refusal-silent", "thread", "opus", large);
  let spent = 0;
  assert.throws(() => { for (;;) { budget.beforeRequest("provider"); spent++; budget.record(undefined, { refused: true }); assert.ok(spent < 20); } }, ContextCacheBlocked);
  assert.equal(spent, 2);
});

test("a silent refusal on a small chat is not a large miss", () => {
  const budget = contextCacheBudget("refusal-small", "thread", "opus", 1000);
  for (let index = 0; index < 6; index++) { budget.beforeRequest("provider"); budget.record(undefined, { refused: true }); }
  assert.doesNotThrow(() => budget.beforeRequest("provider"));
});

test("cancelling a refusal does not excuse it", () => {
  const budget = contextCacheBudget("refusal-cancelled", "thread", "opus", large);
  budget.record(rebuild, { refused: true, cancelled: true }); budget.record(rebuild, { refused: true, cancelled: true });
  assert.throws(() => budget.beforeRequest("provider"), ContextCacheBlocked);
});

test("only a refusal is recognized as one", () => {
  assert.equal(providerRefusal(new ProviderError("invalid_request", "refused", 400, { code: "invalid_request", event: "claude.result", reason: "reasoning_extraction" })), true);
  assert.equal(providerRefusal(new ProviderError("invalid_request", "other", 400, { code: "invalid_request", event: "claude.result" })), false);
  assert.equal(providerRefusal(new Error("reasoning_extraction")), false);
});

test("the shared guard records a refused request", async () => {
  let calls = 0;
  const provider: Provider = { async *infer() { calls++; throw new ProviderError("invalid_request", "refused", 400, { code: "invalid_request", event: "claude.result", reason: "reasoning_extraction" }); yield* []; } };
  const send = async () => { for await (const _ of cacheGuardedInference(provider, { model: "m", input: "x".repeat(large) }, new AbortController().signal, { threadId: "t" }, "refusal-shared")) { /* drained */ } };
  await assert.rejects(send(), { code: "invalid_request" }); await assert.rejects(send(), { code: "invalid_request" });
  await assert.rejects(send(), ContextCacheBlocked);
  assert.equal(calls, 2);
});
