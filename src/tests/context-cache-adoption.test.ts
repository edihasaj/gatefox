import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

test("old idle cache strikes get one warm-up on policy adoption while active requests and later blocks survive", async () => {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const histories = new Map<string, unknown>(); const active = new Map<string, number>();
  const key = (identity: string) => createHash("sha256").update(JSON.stringify(["adoption", identity, "model"])).digest("hex");
  const old = { count: 2, bytes: 1000, cacheTokens: 200000, unknown: false };
  histories.set(key("legacy"), { ...old });
  histories.set(key("days-old"), { ...old, lastActivityAt: Date.now() - 3 * 24 * 60 * 60_000 });
  histories.set(key("running"), { ...old, lastActivityAt: Date.now() - 20 * 60_000 });
  active.set(key("running"), 1);
  globals[Symbol.for("harness-gateway/context-cache-budget/v1")] = histories;
  globals[Symbol.for("harness-gateway/context-cache-inflight/v1")] = active;
  Reflect.deleteProperty(globals, Symbol.for("harness-gateway/context-cache-idle-adoption/v1"));
  const fresh = await import(new URL("../context-cache-budget.js?adoption=first", import.meta.url).href);
  const budget = (identity: string) => fresh.contextCacheBudget("adoption", identity, "model", 1000);
  for (const identity of ["legacy", "days-old"]) {
    assert.doesNotThrow(() => budget(identity).beforeRequest("provider"));
    budget(identity).record({ input: 200000, read: 0, uncached: 200000 });
    assert.doesNotThrow(() => budget(identity).beforeRequest("provider"));
    budget(identity).record({ input: 200000, read: 199000, uncached: 1000 });
    assert.doesNotThrow(() => budget(identity).beforeRequest("provider"));
  }
  assert.throws(() => budget("running").beforeRequest("provider"), { code: "invalid_request" });
  const cold = { input: 200000, read: 0, uncached: 200000 };
  budget("new-block").record(cold); budget("new-block").record(cold);
  assert.throws(() => budget("new-block").beforeRequest("provider"), { code: "invalid_request" });
  const next = await import(new URL("../context-cache-budget.js?adoption=second", import.meta.url).href);
  assert.throws(() => next.contextCacheBudget("adoption", "new-block", "model", 1000).beforeRequest("provider"), { code: "invalid_request" });
  active.clear();
});
