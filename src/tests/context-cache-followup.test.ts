import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import { contextCacheBudget, ContextCacheBlocked } from "../context-cache-budget.js";
import { claudeReplayBudget } from "../providers/claude-replay-budget.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { readEvents } from "../protocol/sse.js";
import type { Provider } from "../providers/provider.js";
import { startGateway } from "../server.js";

const warm = { input: 371369, read: 371143, uncached: 226 };
const rebuild = { input: 367934, read: 46749, uncached: 321185 };
const claudeWarm = { input: 2, cacheRead: 371143, cacheWrite: 226, output: 1 };
const claudeRebuild = { input: 2, cacheRead: 46749, cacheWrite: 321183, output: 1 };

test("follow-up messages during a large chat's rebuild never trip the cache stop", () => {
  const budget = () => contextCacheBudget("followup-incident", "thread", "opus", 3000000);
  budget().record(warm);
  budget().record(warm, { cancelled: true }); // The first follow-up closes the live session.
  budget().beforeRequest("provider"); budget().record(rebuild, { cancelled: true }); // The second cancels the rebuild.
  budget().beforeRequest("provider"); budget().record(rebuild);
  assert.doesNotThrow(() => budget().beforeRequest("provider"), "this request would have continued the rebuilt session");
  budget().record(warm);
});

test("Claude's own replay budget forgives the same sequence", () => {
  const budget = () => claudeReplayBudget("followup-native", "thread", "opus", 3000000);
  budget().record(claudeWarm, { cancelled: true });
  budget().beforeRequest("seed"); budget().record(claudeRebuild, { cancelled: true });
  budget().beforeRequest("seed"); budget().record(claudeRebuild);
  assert.doesNotThrow(() => budget().beforeRequest("continued"));
});

test("a cancellation that reported no usage still gives the rebuild its pass", () => {
  const budget = contextCacheBudget("followup-silent", "thread", "opus", 1000);
  budget.record(undefined, { cancelled: true });
  budget.record(rebuild);
  budget.record(rebuild);
  assert.doesNotThrow(() => budget.beforeRequest("provider"), "the pass covered only the first rebuild");
  budget.record(rebuild);
  assert.throws(() => budget.beforeRequest("provider"), ContextCacheBlocked);
});

test("repeated resends after an excused rebuild still stop", () => {
  const budget = contextCacheBudget("followup-then-broken", "thread", "opus", 1000);
  budget.record(warm, { cancelled: true });
  budget.record(rebuild); budget.record(rebuild);
  assert.doesNotThrow(() => budget.beforeRequest("provider"));
  budget.record(rebuild);
  assert.throws(() => budget.beforeRequest("provider"), ContextCacheBlocked);
});

test("a client that disconnects and retries in a loop still reaches the stop", () => {
  const budget = contextCacheBudget("followup-loop", "thread", "opus", 1000);
  let spent = 0;
  assert.throws(() => { for (;;) { budget.beforeRequest("provider"); spent++; budget.record(rebuild, { cancelled: true }); assert.ok(spent < 20); } }, ContextCacheBlocked);
  assert.equal(spent, 6, "four forgiven rebuilds, then the two ordinary misses");
});

test("real cache reuse restores the forgiveness a long chat has used", () => {
  const budget = contextCacheBudget("followup-reuse", "thread", "opus", 1000);
  for (let round = 0; round < 3; round++) {
    for (let cancel = 0; cancel < 4; cancel++) { budget.beforeRequest("provider"); budget.record(rebuild, { cancelled: true }); }
    budget.record(warm);
  }
  assert.doesNotThrow(() => budget.beforeRequest("provider"));
});

test("a tiny request does not renew the allowance", () => {
  const budget = contextCacheBudget("followup-tiny", "thread", "opus", 1000);
  const uncached = { input: 200000, read: 0, uncached: 200000 };
  let spent = 0;
  assert.throws(() => { for (let round = 0; round < 20; round++) {
    for (let cancel = 0; cancel < 4; cancel++) { budget.beforeRequest("provider"); spent++; budget.record(uncached, { cancelled: true }); }
    budget.record({ input: 1, read: 0, uncached: 1 });
  } }, ContextCacheBlocked);
  assert.equal(spent, 6, "the second round spends only the two ordinary misses");
});

test("cancellations without usage stay inside the bounded history", () => {
  const histories = (globalThis as unknown as Record<symbol, Map<string, unknown>>)[Symbol.for("harness-gateway/context-cache-budget/v1")];
  for (let identity = 0; identity < 4200; identity++) contextCacheBudget("followup-bound", String(identity), "opus", 1000).record(undefined, { cancelled: true });
  assert.ok(histories.size <= 4096);
});

test("the stop tells the person how to clear it", () => {
  for (const blocked of [new ContextCacheBlocked(), new ContextCacheBlocked(true)]) {
    assert.match(blocked.message, /Wait 5 minutes without sending anything, then send one message/);
    assert.match(blocked.message, /Each attempt during the pause restarts the wait/);
    assert.doesNotMatch(blocked.message, /Restore provider/);
  }
});

const coldProvider = (finish: boolean): Provider => ({ async *infer(_request, _signal, context) {
  context?.observeCacheUsage?.({ inputTokens: 200000, cachedTokens: 0 });
  if (finish) yield { type: "done", usage: { input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 0 } } };
} });
const send = async (provider: Provider, scope: string, cancelled: () => boolean, seen?: (value: boolean | undefined) => void) => {
  const wrapped: Provider = { infer: (request, signal, context) => { seen?.(context?.callerCancelled?.()); return provider.infer(request, signal, context); } };
  for await (const _ of cacheGuardedInference(wrapped, { model: "m", input: "large" }, new AbortController().signal, { threadId: "t" }, scope, { cancelled })) { /* drained */ }
};

test("only the caller's own cancellation of an unfinished request is forgiven", async () => {
  // A timeout or shutdown aborts the request too, but the caller did not cancel it.
  await send(coldProvider(false), "not-cancelled", () => false); await send(coldProvider(false), "not-cancelled", () => false);
  await assert.rejects(send(coldProvider(false), "not-cancelled", () => false), ContextCacheBlocked);
  // Codex disconnects straight after a finished response, which cancelled nothing.
  await send(coldProvider(true), "finished", () => true); await send(coldProvider(true), "finished", () => true);
  await assert.rejects(send(coldProvider(true), "finished", () => true), ContextCacheBlocked);
  await send(coldProvider(false), "cancelled", () => true); await send(coldProvider(false), "cancelled", () => true);
  await assert.doesNotReject(send(coldProvider(false), "cancelled", () => true));
});

test("the provider can read the caller's cancellation", async () => {
  const seen: Array<boolean | undefined> = [];
  await send(coldProvider(false), "exposed", () => true, value => seen.push(value));
  assert.deepEqual(seen, [true]);
});

test("two follow-ups through the server leave the rebuilt chat able to continue", { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join("/tmp", "gateway-followup-"));
  let calls = 0; let cancelled!: () => void; let cancel = new Promise<void>(resolve => { cancelled = resolve; });
  // The first two requests report a cold rebuild and wait to be cancelled, as the live incident did.
  const provider: Provider = { async *infer(_request, signal, context) {
    calls++;
    const interrupted = calls <= 2;
    context?.observeCacheUsage?.({ inputTokens: 367934, cachedTokens: 46749, cacheWriteTokens: 321183 });
    if (interrupted) {
      cancelled();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return;
    }
    yield { type: "text", text: "continued" };
    yield { type: "done", usage: { input_tokens: 367934, output_tokens: 1, total_tokens: 367935, input_tokens_details: { cached_tokens: calls === 3 ? 46749 : 367900 } } };
  } };
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, timeoutMs: 5000, maxConcurrent: 4,
    providers: [{ id: "fixture", type: "claude-subscription", models: { alias: "upstream" } }] };
  const server = await startGateway(config, () => provider, undefined, { heartbeatMs: 20 });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json", "session_id": "followup-chat" };
  const post = (signal?: AbortSignal) => fetch(url, { method: "POST", headers, signal, body: JSON.stringify({ model: "alias", input: "large history", stream: true }) });
  const failedStream = async (stream: Response) => { for await (const event of readEvents(stream.body!)) if (event.type === "response.failed") return true; return false; };
  try {
    for (let follow = 0; follow < 2; follow++) {
      const client = new AbortController();
      const running = post(client.signal);
      await cancel; cancel = new Promise<void>(resolve => { cancelled = resolve; });
      client.abort();
      await running.then(stream => stream.body?.cancel(), () => undefined);
      await delay(50);
    }
    assert.equal(await failedStream(await post()), false, "the completed rebuild is not a cache stop");
    assert.equal(await failedStream(await post()), false, "and neither is the warm request after it");
    assert.equal(calls, 4);
  } finally {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
    await rm(directory, { recursive: true, force: true });
  }
});
