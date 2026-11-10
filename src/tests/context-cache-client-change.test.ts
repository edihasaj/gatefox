import assert from "node:assert/strict";
import test from "node:test";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import { contextCacheBudget, ContextCacheBlocked } from "../context-cache-budget.js";
import { claudeReplayBudget } from "../providers/claude-replay-budget.js";
import type { Provider } from "../providers/provider.js";

// 8 November 2026: a resumed 600k chat seeded cold, then Codex added 39 tools 17 s later.
const coldSeed = { input: 594783, read: 0, uncached: 594783 };
const toolReseed = { input: 606740, read: 39795, uncached: 566945 };
const warm = { input: 607500, read: 606740, uncached: 760 };
const claudeCold = { input: 2, cacheRead: 0, cacheWrite: 594781, output: 1 };
const claudeReseed = { input: 2, cacheRead: 39795, cacheWrite: 566943, output: 1 };

test("a reseed the caller forced by adding tools does not stop the warm continuation", () => {
  const budget = () => contextCacheBudget("client-change-incident", "thread", "opus", 3000000);
  budget().beforeRequest("provider"); budget().record(coldSeed);
  budget().beforeRequest("provider"); budget().record(toolReseed, { clientChange: true });
  assert.doesNotThrow(() => budget().beforeRequest("provider"), "this request would have continued the reseeded session");
  budget().record(warm);
});

test("without the client-change mark the same sequence still stops", () => {
  const budget = () => contextCacheBudget("client-change-unmarked", "thread", "opus", 3000000);
  budget().record(coldSeed); budget().record(toolReseed); budget().record(toolReseed);
  assert.throws(() => budget().beforeRequest("provider"), ContextCacheBlocked);
});

test("Claude's native budget excuses a tool-catalog reseed too", () => {
  const budget = () => claudeReplayBudget("client-change-native", "thread", "opus", 3000000);
  budget().beforeRequest("seed"); budget().record(claudeCold);
  budget().beforeRequest("seed"); budget().record(claudeReseed, { clientChange: true });
  assert.doesNotThrow(() => budget().beforeRequest("continued"));
});

test("a catalog that changes on every request still reaches the stop", () => {
  const budget = contextCacheBudget("client-change-flap", "thread", "opus", 1000);
  let spent = 0;
  assert.throws(() => { for (;;) { budget.beforeRequest("provider"); spent++; budget.record(toolReseed, { clientChange: true }); assert.ok(spent < 20); } }, ContextCacheBlocked);
  assert.equal(spent, 7, "four excused rebuilds, then three ordinary misses");
});

test("a real cache hit renews the allowance for later catalog changes", () => {
  const budget = contextCacheBudget("client-change-renew", "thread", "opus", 1000);
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) { budget.beforeRequest("provider"); budget.record(toolReseed, { clientChange: true }); }
    budget.beforeRequest("provider"); budget.record(warm);
  }
  assert.doesNotThrow(() => budget.beforeRequest("provider"));
});

test("the shared provider guard hears a provider's client-change rebuild", async () => {
  const provider = (mark: boolean): Provider => ({ async *infer(_request, _signal, context) {
    if (mark) context?.observeClientRebuild?.();
    context?.observeCacheUsage?.({ inputTokens: toolReseed.input, cachedTokens: toolReseed.read });
  } });
  const send = async (mark: boolean, scope: string) => { for await (const _ of cacheGuardedInference(provider(mark), { model: "m", input: "large" }, new AbortController().signal, { threadId: "t" }, scope)) { /* drained */ } };
  await send(false, "guard-marked"); await send(true, "guard-marked");
  await assert.doesNotReject(send(false, "guard-marked"));
  await send(false, "guard-unmarked"); await send(false, "guard-unmarked"); await send(false, "guard-unmarked");
  await assert.rejects(send(false, "guard-unmarked"), ContextCacheBlocked);
});
