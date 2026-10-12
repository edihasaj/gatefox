import test from "node:test";
import assert from "node:assert/strict";
import { CompactionPolicy } from "../compaction-policy.js";
import type { CompactionState } from "../compaction-state.js";

const row = { slug: "gateway/model", context_window: 272000, max_context_window: 400000, effective_context_window_percent: 95, auto_compact_token_limit: 250000 };
const known: CompactionState = { emittedAtMs: 10, usage: { lastTokens: 244800, contextWindow: 900000, emittedAtMs: 10 } };
const failed: CompactionState = { emittedAtMs: 10, compaction: { turnId: "compact", status: "failed", emittedAtMs: 10 } };

test("executor policy preserves SDK distinct window formulas, clamp, defaults, and frozen model metadata", () => {
  const metadata = { ...row }; const policy = new CompactionPolicy([metadata]);
  assert.deepEqual(policy.target("chat", row.slug), { effectiveContextWindow: 258400, autoCompactTokenLimit: 244800 });
  metadata.context_window = 100; metadata.effective_context_window_percent = 1;
  assert.equal(policy.target("chat", row.slug)!.effectiveContextWindow, 258400);
  const capped = new CompactionPolicy([row], { model_context_window: 500000, model_auto_compact_token_limit: 999999 });
  assert.deepEqual(capped.target("chat", row.slug), { effectiveContextWindow: 380000, autoCompactTokenLimit: 360000 });
  const defaulted = new CompactionPolicy([{ slug: row.slug, max_context_window: 400001 }]);
  assert.deepEqual(defaulted.target("chat", row.slug), { effectiveContextWindow: 380000, autoCompactTokenLimit: 360000 });
});

test("last numeric CLI override outranks loaded settings and recognized per-chat overrides remain isolated", () => {
  const policy = new CompactionPolicy([row], { model_context_window: 100000, model_auto_compact_token_limit: 50000 }, [
    "-c", "model_context_window=300_000", "--config=model_context_window=200000", "-cmodel_auto_compact_token_limit=100000",
  ]);
  assert.deepEqual(policy.target("other", row.slug), { effectiveContextWindow: 190000, autoCompactTokenLimit: 100000 });
  policy.remember("chat", { model_context_window: 150000, model_auto_compact_token_limit: 70000, sandbox_mode: "danger-full-access" });
  assert.deepEqual(policy.target("chat", row.slug), { effectiveContextWindow: 142500, autoCompactTokenLimit: 70000 });
  assert.equal(policy.target("other", row.slug)!.effectiveContextWindow, 190000);
  policy.remember("chat", { model_context_window: null });
  assert.deepEqual(policy.target("chat", row.slug), { effectiveContextWindow: 258400, autoCompactTokenLimit: 100000 });
});

test("cold SDK reload replaces prior numeric, goal, and scope overrides rather than merging old sessions", () => {
  const policy = new CompactionPolicy([row], { model_context_window: 100000, model_auto_compact_token_limit: 50000 });
  policy.remember("chat", { model_context_window: 300000, model_auto_compact_token_limit: 150000,
    model_auto_compact_token_limit_scope: "body_after_prefix", features: { goals: false } });
  assert.equal(policy.target("chat", row.slug), undefined); assert.equal(policy.goalsEnabled("chat"), false);
  policy.remember("other", { model_context_window: 200000 });
  policy.remember("chat", {});
  assert.deepEqual(policy.target("chat", row.slug), { effectiveContextWindow: 95000, autoCompactTokenLimit: 50000 });
  assert.equal(policy.goalsEnabled("chat"), true);
  assert.equal(policy.target("other", row.slug)!.effectiveContextWindow, 190000);
  policy.remember("chat", { model_context_window: 150000 });
  assert.deepEqual(policy.target("chat", row.slug), { effectiveContextWindow: 142500, autoCompactTokenLimit: 50000 });
});

test("unknown dimensions, body-after-prefix scope, and invalid overrides never fabricate a downshift budget", () => {
  for (const invalid of [-1, 0, 1.5, NaN, Infinity, "100000"]) {
    const policy = new CompactionPolicy([row], { model_context_window: invalid });
    assert.equal(policy.target("chat", row.slug), undefined); assert.deepEqual(policy.decision("chat", row.slug, known), { action: "none" });
  }
  assert.equal(new CompactionPolicy([row], {}, ["-c", "model_context_window=invalid"]).target("chat", row.slug), undefined);
  assert.equal(new CompactionPolicy([{ slug: row.slug }]).target("chat", row.slug), undefined);
  assert.equal(new CompactionPolicy([row, row]).target("chat", row.slug), undefined);
  const scoped = new CompactionPolicy([row], { model_auto_compact_token_limit_scope: "body_after_prefix" });
  assert.deepEqual(scoped.decision("chat", row.slug, known), { action: "none" });
  assert.deepEqual(scoped.decision("chat", row.slug, failed), { action: "compact", reason: "failed" });
  assert.deepEqual(new CompactionPolicy([]).decision("chat", row.slug, failed), { action: "compact", reason: "failed" });
  const perChat = new CompactionPolicy([row]);
  perChat.remember("chat", { model_auto_compact_token_limit_scope: "body_after_prefix" });
  assert.equal(perChat.target("chat", row.slug), undefined);
  assert.ok(perChat.target("other", row.slug));
  perChat.remember("chat", { model_auto_compact_token_limit_scope: "total" });
  assert.ok(perChat.target("chat", row.slug));
});

test("downshift recovery honors usable hard cap and rejects incompatible compaction hashes", () => {
  const policy = new CompactionPolicy([{ ...row, effective_context_window_percent: 80 }]);
  const atCap = { ...known, usage: { ...known.usage!, lastTokens: 217600 } };
  assert.equal(policy.target("chat", row.slug)!.autoCompactTokenLimit, 244800);
  assert.deepEqual(policy.decision("chat", row.slug, atCap), { action: "compact", reason: "downshift" });
  assert.deepEqual(policy.decision("chat", row.slug, { ...known, usage: { ...known.usage!, lastTokens: 10 } }), { action: "none" });
  const hashed = new CompactionPolicy([{ ...row, comp_hash: "new" }, { slug: "source", context_window: 1000000, comp_hash: "old" }]);
  assert.deepEqual(hashed.decision("chat", row.slug, failed, "source"), { action: "reject", reason: "unsupported-compaction-hash" });
  assert.deepEqual(hashed.decision("chat", row.slug, failed, row.slug), { action: "reject", reason: "unsupported-compaction-hash" },
    "current thread model equality cannot establish the previous turn's hash");
  assert.equal(hashed.sourceHash("source"), "old");
});

test("goal guard uses stable default, confirmed configuration, final SDK toggle precedence, and per-chat settings", () => {
  assert.equal(new CompactionPolicy([]).goalsEnabled("chat"), true);
  assert.equal(new CompactionPolicy([], { features: { goals: false } }).goalsEnabled("chat"), false);
  assert.equal(new CompactionPolicy([], { features: { goals: { enabled: false } } }).goalsEnabled("chat"), false);
  const disabled = new CompactionPolicy([], { features: { goals: true } }, ["--disable", "goals", "-c", "features.goals=true"]);
  assert.equal(disabled.goalsEnabled("chat"), false, "SDK toggles apply after -c values regardless of position");
  const enabled = new CompactionPolicy([], {}, ["--disable=goals", "--enable=goals", "--config=features.goals=false"]);
  assert.equal(enabled.goalsEnabled("chat"), false, "SDK processes all disables after enables, regardless of argv order");
  assert.equal(new CompactionPolicy([], {}, ["--enable=goals", "--config=features.goals=false"]).goalsEnabled("chat"), true);
  disabled.remember("chat", { features: { goals: true } });
  assert.equal(disabled.goalsEnabled("chat"), true); assert.equal(disabled.goalsEnabled("other"), false);
  disabled.remember("chat", { "features.goals": false }); assert.equal(disabled.goalsEnabled("chat"), false);
});
