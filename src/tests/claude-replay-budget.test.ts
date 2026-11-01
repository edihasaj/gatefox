import test from "node:test";
import assert from "node:assert/strict";
import { claudeReplayBudget, ClaudeReplayBlocked } from "../providers/claude-replay-budget.js";
import type { ClaudeTokens } from "../providers/claude-stream.js";
import { streamFailureCode } from "../provider-failure.js";

const cold: ClaudeTokens = { input: 2, cacheRead: 40000, cacheWrite: 700000, output: 10 };
const budget = (id: string, bytes = 3000000, scope = "account-a", model = "opus") => claudeReplayBudget(scope, id, model, bytes)!;

test("two measured large cold rewrites stop the next seed or one-shot before spending again", () => {
  const first = budget("bounded");
  first.beforeRequest("seed"); first.record(cold);
  budget("bounded").beforeRequest("oneshot"); budget("bounded").record(cold);
  for (const mode of ["oneshot", "seed", "continued"] as const) assert.throws(() => budget("bounded").beforeRequest(mode), error =>
    error instanceof ClaudeReplayBlocked && error.status === 400 && error.code === "invalid_request");
  assert.equal(streamFailureCode(new ClaudeReplayBlocked()), "invalid_prompt", "the desktop receives a final error instead of reconnecting unchanged");
});

test("reconnects and an adopted module share the measured safety history", async () => {
  budget("upgrade").record(cold); budget("upgrade").record(cold);
  const specifier = new URL("../providers/claude-replay-budget.js?adopted", import.meta.url).href;
  const adopted = await import(specifier);
  assert.throws(() => adopted.claudeReplayBudget("account-a", "upgrade", "opus", 3000000)!.beforeRequest("oneshot"), { code: "invalid_request" });
  assert.doesNotThrow(() => budget("upgrade", 3000000, "account-b").beforeRequest("oneshot"));
  assert.doesNotThrow(() => budget("upgrade", 3000000, "account-a", "sonnet").beforeRequest("oneshot"));
});

test("known cache reuse clears the rewrite streak", () => {
  const b = budget("healthy"); b.record(cold);
  b.record({ input: 2, cacheRead: 700000, cacheWrite: 1000, output: 10 });
  b.record(cold); assert.doesNotThrow(() => b.beforeRequest("oneshot"));
  b.record(cold); assert.throws(() => b.beforeRequest("oneshot"));
  b.record({ input: 2, cacheRead: 700000, cacheWrite: 1000, output: 10 }); assert.doesNotThrow(() => b.beforeRequest("seed"));
});

test("large new results remain usable when the previously cached prefix is being read", () => {
  const b = budget("new-large-results"); b.record(cold);
  b.record({ input: 2, cacheRead: 740000, cacheWrite: 1000000, output: 1 });
  b.record({ input: 2, cacheRead: 1740000, cacheWrite: 2000000, output: 1 });
  assert.doesNotThrow(() => b.beforeRequest("continued"));
});

test("missing cache counts do not manufacture recovery, while small requests stay usable", () => {
  const b = budget("unknown"); b.record(cold); b.record({ output: 1 }); b.record(cold);
  assert.throws(() => b.beforeRequest("oneshot"));
  assert.doesNotThrow(() => budget("unknown", 1500000).beforeRequest("seed"), "client compaction halved the history");
  const small = budget("small");
  for (let i = 0; i < 10; i++) { small.beforeRequest("oneshot"); small.record({ cacheRead: 0, cacheWrite: 4000, output: 1 }); }
  const anonymous = claudeReplayBudget("anonymous-account", undefined, "opus", 3000000);
  anonymous.record(cold); anonymous.record(cold);
  assert.throws(() => claudeReplayBudget("anonymous-account", undefined, "opus", 3000000).beforeRequest("oneshot"));
  assert.doesNotThrow(() => claudeReplayBudget("anonymous-account", "identified", "opus", 3000000).beforeRequest("oneshot"));
});
