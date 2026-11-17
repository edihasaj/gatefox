import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderConfig } from "../config.js";
import { deferredRefreshIntervalSeconds, refreshDeferred, type DeferredRefreshDeps } from "../model-auto-latest/deferred-refresh.js";
import type { CatalogResult } from "../model-auto-latest/discovery.js";
import { ChatGPTRefreshDeferred } from "../auth/chatgpt.js";

const provider = (id: string) => ({ id, type: "codex-subscription", label: id, models: {} }) as unknown as ProviderConfig;
const now = 2_000_000_000;

function harness(options: { mains?: boolean; attempts?: Record<string, number> } = {}) {
  const events: string[] = []; let saved: Record<string, number> | undefined;
  const deps: DeferredRefreshDeps = {
    onMains: async () => { events.push("power"); return options.mains ?? true; },
    stayAwake: async work => { events.push("awake"); try { return await work(); } finally { events.push("asleep"); } },
    readAttempts: async () => ({ ...(options.attempts ?? {}) }),
    writeAttempts: async (_path, attempts) => { events.push("record"); saved = attempts; },
  };
  const refreshes: Array<{ id: string; refresh: boolean | undefined }> = [];
  const discover = async (p: ProviderConfig, opts?: { refresh?: boolean }) => {
    refreshes.push({ id: p.id, refresh: opts?.refresh }); events.push("discover");
    if (opts?.refresh !== true) throw new ChatGPTRefreshDeferred();
    return [{ model: "gpt-6.2-sol", metadata: { displayName: "GPT-6.2-Sol" } }] as never;
  };
  return { deps, events, refreshes, discover, saved: () => saved };
}

test("a deferred provider is renewed once, on mains power, while sleep is held off, and its new catalog replaces the deferral", async () => {
  const h = harness();
  const results = new Map<string, CatalogResult>([["codex-secondary", { deferred: true }], ["codex-primary", { rows: [] }]]);
  const retried = await refreshDeferred("/c.json", [provider("codex-primary"), provider("codex-secondary")], results, h.discover, undefined, { totalMs: 5_000 }, now, h.deps);
  assert.deepEqual(retried, ["codex-secondary"]);
  assert.deepEqual(h.refreshes, [{ id: "codex-secondary", refresh: true }]);
  assert.deepEqual(h.events, ["power", "record", "awake", "discover", "asleep"], "the attempt is recorded before any network call");
  assert.deepEqual(h.saved(), { "codex-secondary": now });
  const result = results.get("codex-secondary")!;
  assert.ok("rows" in result && result.rows.some(row => row.id === "gpt-6.2-sol"));
});

test("on battery, within six hours of the last attempt, or with nothing deferred, no login is renewed", async () => {
  for (const [label, options, results] of [
    ["battery", { mains: false }, new Map<string, CatalogResult>([["codex-secondary", { deferred: true }]])],
    ["recent attempt", { attempts: { "codex-secondary": now - deferredRefreshIntervalSeconds + 60 } }, new Map<string, CatalogResult>([["codex-secondary", { deferred: true }]])],
    ["nothing deferred", {}, new Map<string, CatalogResult>([["codex-secondary", { failed: true }]])],
  ] as const) {
    const h = harness(options);
    const retried = await refreshDeferred("/c.json", [provider("codex-secondary")], results, h.discover, undefined, { totalMs: 5_000 }, now, h.deps);
    assert.deepEqual(retried, [], label);
    assert.deepEqual(h.refreshes, [], label);
    assert.equal(h.saved(), undefined, label);
  }
});

test("an attempt older than six hours is due again, and records for removed providers are dropped", async () => {
  const h = harness({ attempts: { "codex-secondary": now - deferredRefreshIntervalSeconds, "gone": now - 10 } });
  const results = new Map<string, CatalogResult>([["codex-secondary", { deferred: true }]]);
  assert.deepEqual(await refreshDeferred("/c.json", [provider("codex-secondary")], results, h.discover, undefined, { totalMs: 5_000 }, now, h.deps), ["codex-secondary"]);
  assert.deepEqual(h.saved(), { "codex-secondary": now });
});
