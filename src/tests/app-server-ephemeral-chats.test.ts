import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadServiceTiers } from "../thread-service-tiers.js";
import { AppServerRouter } from "../app-server-router.js";
import { ThreadReasoningStore } from "../thread-reasoning.js";
import { configureTelemetry } from "../telemetry.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;
const gateway = "subscription_gateway";
const prediction = (threadId: string) => ({ threadId, experimentalPredictionMode: true, ephemeral: true, excludeTurns: true, threadSource: "composer_predictions" });

// An engine whose chats named fork-* or eph-* are throwaway: its own chat read reports them ephemeral.
async function fixture(options: { forkIds?: string[]; read?: (id: string) => ObjectValue; reply?: (method: string, params: ObjectValue) => ObjectValue | undefined;
  hold?: (method: string, params: ObjectValue) => Promise<void> | undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-ephemeral-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model", "codex/other": "other" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "high"] }, "codex/other": { reasoningEfforts: ["low", "high"] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  let forks = 0;
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    await options.hold?.(method, params);
    const replied = options.reply?.(method, params); if (replied) return replied;
    if (method === "thread/read") {
      const id = String(params.threadId);
      return { thread: { id, modelProvider: gateway, model: "codex/model", ...(/^(fork|eph)/.test(id) ? { ephemeral: true } : {}), ...options.read?.(id) } };
    }
    if (method === "thread/fork") return { thread: { id: options.forkIds?.[forks++] ?? "fork", ephemeral: true }, modelProvider: gateway, model: "codex/model", serviceTier: null, reasoningEffort: "high" };
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  };
  const router = new AppServerRouter(config, backend, undefined, undefined, native); await router.initialize();
  return { calls, router, tiers: new ThreadServiceTiers(state, native), store: new ThreadReasoningStore(state, native) };
}

// Which of the router's per-chat containers still hold this id (a field that does not exist holds nothing).
const held = (router: AppServerRouter, id: string): string[] => {
  const maps = router as unknown as Record<string, { has(id: string): boolean } | undefined>;
  return ["routes", "tierRecords", "activeTurns", "settingsVersions", "ephemeralThreads", "chatSnapshots"].filter(name => maps[name]?.has(id));
};
const tracked = (router: AppServerRouter): string[] => [...(router as unknown as { ephemeralThreads: Set<string> }).ephemeralThreads];
const settingsUpdated = (threadId: string, settings: ObjectValue) => ({ method: "thread/settings/updated", emittedAtMs: Date.now(), params: { threadId, threadSettings: settings } });
const applied = { model: "codex/model", modelProvider: gateway, serviceTier: null, effort: "low" };

async function assertNothingDurable(f: Awaited<ReturnType<typeof fixture>>, id: string, why: string): Promise<void> {
  assert.equal(await f.tiers.read(id), undefined, `no tier row: ${why}`);
  assert.equal(await f.store.read(id), undefined, `no reasoning row: ${why}`);
}

for (const [name, forget] of [
  ["thread/unsubscribe", (r: AppServerRouter) => r.request("thread/unsubscribe", { threadId: "fork" })],
  ["thread/closed", (r: AppServerRouter) => r.observeNotification({ method: "thread/closed", params: { threadId: "fork" } })],
] as const) test(`a fork forgotten by ${name} is still not written to disk by a later turn`, async () => {
  const f = await fixture();
  await f.router.request("thread/fork", prediction("parent"));
  await forget(f.router);
  assert.deepEqual(held(f.router, "fork"), [], "the router forgot the fork");
  f.calls.length = 0;
  // The engine still has the fork loaded: the turn finds it again by reading the chat.
  await f.router.request("turn/start", { threadId: "fork", input: [], effort: "low" });
  assert.equal(f.calls[0].method, "thread/read", "the forgotten fork was probed");
  assert.ok(tracked(f.router).includes("fork"), "the probe recognized the fork as ephemeral");
  await f.router.observeNotification(settingsUpdated("fork", applied));
  await assertNothingDurable(f, "fork", "a turn and an applied settings change on a forgotten fork");
});

test("a fork evicted by the 256 cap is still not written to disk by a later turn", async () => {
  const f = await fixture({ forkIds: Array.from({ length: 257 }, (_, i) => `fork-${i}`) });
  for (let i = 0; i < 257; i++) await f.router.request("thread/fork", prediction("parent"));
  assert.deepEqual(held(f.router, "fork-0"), [], "the oldest fork was evicted");
  await f.router.request("turn/start", { threadId: "fork-0", input: [], effort: "low" });
  await f.router.observeNotification(settingsUpdated("fork-0", applied));
  await assertNothingDurable(f, "fork-0", "a turn on an evicted fork");
  assert.equal(tracked(f.router).length, 256, "the probed fork counts toward the cap");
});

// The engine is still answering a turn on the fork when it goes away; the answer must not make the chat durable.
for (const [name, goAway] of [
  ["thread/closed", async (r: AppServerRouter) => r.observeNotification({ method: "thread/closed", params: { threadId: "fork-0" } })],
  ["thread/unsubscribe", async (r: AppServerRouter) => { await r.request("thread/unsubscribe", { threadId: "fork-0" }); }],
  ["the 256 cap", async (r: AppServerRouter) => { for (let i = 0; i < 256; i++) await r.request("thread/fork", prediction("parent")); }],
] as const) test(`a turn in flight when the fork goes away by ${name} does not write its reasoning`, async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let started = false;
  const f = await fixture({ forkIds: Array.from({ length: 257 }, (_, i) => `fork-${i}`), hold: method => { if (method !== "turn/start") return; started = true; return gate; } });
  await f.router.request("thread/fork", prediction("parent"));
  const turn = f.router.request("turn/start", { threadId: "fork-0", input: [], effort: "high", model: "codex/model" });
  while (!started) await new Promise(resolve => setTimeout(resolve, 5));
  await goAway(f.router);
  assert.equal(tracked(f.router).includes("fork-0"), false, "the fork is no longer tracked while its turn is still running");
  release(); await turn;
  await assertNothingDurable(f, "fork-0", `a turn that was answered after ${name}`);
});

test("a durable chat whose turn is in flight still has its reasoning recorded", async () => {
  // Control for the in-flight tests: only a chat that was ephemeral when the request began is exempt.
  const f = await fixture();
  await f.router.request("turn/start", { threadId: "durable", input: [], effort: "high", model: "codex/model" });
  assert.equal((await f.store.read("durable"))?.effort, "high");
});

test("a fork the 256 cap evicted is still not written to disk by its own settings notification", async () => {
  const f = await fixture({ forkIds: Array.from({ length: 257 }, (_, i) => `fork-${i}`) });
  for (let i = 0; i < 257; i++) await f.router.request("thread/fork", prediction("parent"));
  assert.deepEqual(held(f.router, "fork-0"), [], "the oldest fork lost its route");
  // The engine keeps the fork subscribed, so it can still report an applied change with no turn before it.
  await f.router.observeNotification(settingsUpdated("fork-0", applied));
  await assertNothingDurable(f, "fork-0", "a settings notification on a fork the cap evicted");
  assert.deepEqual(held(f.router, "fork-0"), [], "and nothing about it was kept in memory");
});

test("settings that arrive for a chat before its thread/start returns are still recorded", async () => {
  // The evicted-fork guard must not turn into a rule that drops notifications for chats with no route yet.
  const f = await fixture();
  await f.router.observeNotification(settingsUpdated("early", applied));
  assert.equal((await f.store.read("early"))?.effort, "low");
  assert.equal((await f.tiers.read("early"))?.model, "codex/model");
});

test("a fork the cap evicted that is resumed is still memory-only even if its result is not flagged", async () => {
  const f = await fixture({ forkIds: Array.from({ length: 257 }, (_, i) => `fork-${i}`), read: () => ({ ephemeral: false }),
    reply: method => method === "thread/resume" ? { thread: { id: "fork-0" }, modelProvider: gateway, model: "codex/model", serviceTier: null, reasoningEffort: "high" } : undefined });
  for (let i = 0; i < 257; i++) await f.router.request("thread/fork", prediction("parent"));
  await f.router.request("thread/resume", { threadId: "fork-0" });
  await assertNothingDurable(f, "fork-0", "a resume of a fork the cap evicted");
  assert.ok(tracked(f.router).includes("fork-0"), "it is tracked again");
});

test("the ids of cap-evicted forks are themselves bounded to the newest 4096", async () => {
  const total = 256 + 4096 + 1;
  const f = await fixture({ forkIds: Array.from({ length: total }, (_, i) => `fork-${i}`) });
  for (let i = 0; i < total; i++) await f.router.request("thread/fork", prediction("parent"));
  const ids = (f.router as unknown as { evictedEphemeralIds: Set<string> }).evictedEphemeralIds;
  assert.equal(ids.size, 4096);
  assert.equal(ids.has("fork-0"), false, "the oldest evicted id was dropped");
  assert.ok(ids.has("fork-1") && ids.has("fork-4096"));
  assert.equal(tracked(f.router).length, 256);
});

test("forgetting an ephemeral chat also drops the chat snapshot it cached", async () => {
  const f = await fixture();
  await f.router.request("turn/start", { threadId: "eph-turn", input: [] });
  assert.deepEqual(held(f.router, "eph-turn").sort(), ["activeTurns", "chatSnapshots", "ephemeralThreads", "routes"], "the probe cached a snapshot for the ephemeral chat");
  await f.router.request("thread/unsubscribe", { threadId: "eph-turn" });
  assert.deepEqual(held(f.router, "eph-turn"), []);
});

test("a durable chat read by a probe is still recorded", async () => {
  // Control for the probe tests: only an ephemeral chat is exempt from its tier and reasoning rows.
  const f = await fixture();
  await f.router.request("turn/start", { threadId: "durable", input: [], effort: "low" });
  await f.router.observeNotification(settingsUpdated("durable", applied));
  assert.deepEqual(held(f.router, "durable").includes("ephemeralThreads"), false);
  assert.equal((await f.store.read("durable"))?.effort, "low");
  assert.equal((await f.tiers.read("durable"))?.model, "codex/model");
});

test("an ephemeral thread/start result is memory-only", async () => {
  const result = { modelProvider: gateway, model: "codex/model", serviceTier: null, reasoningEffort: "high" };
  const f = await fixture({ reply: method => method === "thread/start" ? { ...result, thread: { id: "eph-start", ephemeral: true } } : undefined });
  await f.router.request("thread/start", { model: "codex/model", ephemeral: true });
  await assertNothingDurable(f, "eph-start", "an ephemeral chat start");
  assert.deepEqual(held(f.router, "eph-start").sort(), ["ephemeralThreads", "routes"]);
  assert.equal(describe(f.router, "eph-start"), "codex/model", "its route is still kept in memory");
});

test("a durable thread/start result is recorded, so the memory-only test above can fail", async () => {
  const f = await fixture({ reply: method => method === "thread/start" ? { thread: { id: "kept" }, modelProvider: gateway, model: "codex/model", serviceTier: null, reasoningEffort: "high" } : undefined });
  await f.router.request("thread/start", { model: "codex/model" });
  assert.equal((await f.tiers.read("kept"))?.model, "codex/model");
  assert.equal((await f.store.read("kept"))?.effort, "high");
});

test("an ephemeral thread/resume result is memory-only", async () => {
  // The chat read does not flag it, so only the resume result can mark the chat throwaway.
  const f = await fixture({ read: () => ({ ephemeral: false }), reply: method => method === "thread/resume"
    ? { thread: { id: "resumed", ephemeral: true }, modelProvider: gateway, model: "codex/model", serviceTier: null, reasoningEffort: "high" } : undefined });
  await f.router.request("thread/resume", { threadId: "resumed" });
  await assertNothingDurable(f, "resumed", "an ephemeral chat resume");
  assert.ok(tracked(f.router).includes("resumed"));
});

test("re-tracking a fork moves it to the newest end of the cap", async () => {
  const ids = [...Array.from({ length: 256 }, (_, i) => `fork-${i}`), "fork-0", "fork-256"];
  const f = await fixture({ forkIds: ids });
  for (let i = 0; i < ids.length; i++) await f.router.request("thread/fork", prediction("parent"));
  // fork-0 was seen again, so fork-1 is now the oldest and goes when fork-256 arrives.
  assert.deepEqual(held(f.router, "fork-1"), [], "the oldest untouched fork is evicted");
  assert.deepEqual(held(f.router, "fork-0"), ["routes", "ephemeralThreads"], "the re-tracked fork is kept");
  assert.deepEqual(held(f.router, "fork-256"), ["routes", "ephemeralThreads"]);
  assert.equal(tracked(f.router).length, 256);
  assert.equal(tracked(f.router).at(-1), "fork-256");
  assert.equal(tracked(f.router).at(-2), "fork-0");
});

function describe(router: AppServerRouter, id: string): string | undefined { return router.describeThread(id).model; }
const routeOf = (router: AppServerRouter, id: string) => (router as unknown as { routes: Map<string, ObjectValue> }).routes.get(id);

test("a fork's in-memory route follows its applied settings, and nothing is written", async () => {
  const f = await fixture();
  await f.router.request("thread/fork", prediction("parent"));
  assert.deepEqual(routeOf(f.router, "fork"), { provider: gateway, model: "codex/model", serviceTier: null });
  await f.router.observeNotification(settingsUpdated("fork", { model: "codex/other", modelProvider: gateway, serviceTier: "fast", effort: "high" }));
  assert.deepEqual(routeOf(f.router, "fork"), { provider: gateway, model: "codex/other", serviceTier: "priority" }, "the route took the applied model and tier");
  assert.equal(describe(f.router, "fork"), "codex/other");
  await f.router.observeNotification(settingsUpdated("fork", { model: "codex/model", modelProvider: gateway, serviceTier: "default", effort: "low" }));
  assert.deepEqual(routeOf(f.router, "fork"), { provider: gateway, model: "codex/model", serviceTier: null }, "a later applied change replaces it again");
  // Settings that do not describe a gateway chat leave the route alone.
  await f.router.observeNotification(settingsUpdated("fork", { model: "native", modelProvider: "openai", serviceTier: null }));
  await f.router.observeNotification(settingsUpdated("fork", { model: "codex/other", modelProvider: gateway }));
  assert.deepEqual(routeOf(f.router, "fork"), { provider: gateway, model: "codex/model", serviceTier: null });
  await assertNothingDurable(f, "fork", "applied settings on a fork");
});
