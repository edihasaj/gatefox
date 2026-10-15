import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadServiceTiers } from "../thread-service-tiers.js";
import { AppServerRouter, inheritsParentSettings } from "../app-server-router.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { ThreadReasoningStore } from "../thread-reasoning.js";
import { configureTelemetry } from "../telemetry.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;

// The desktop's composer predictions (26.1007.71326): resume the chat, then fork it in
// prediction mode. The SDK forks from the loaded parent's effective settings and refuses any
// override, so this exact shape must reach the owning engine unchanged.
const prediction = (threadId: string) => ({ threadId, experimentalPredictionMode: true, ephemeral: true, excludeTurns: true, threadSource: "composer_predictions" });

// The signed SDK's own validation (0.162.0-alpha.17.2, thread_fork_inner).
function sdkFork(params: ObjectValue): void {
  const overrides = ["model", "modelProvider", "serviceTier", "cwd", "runtimeWorkspaceRoots", "approvalPolicy", "approvalsReviewer", "sandbox", "permissions", "baseInstructions", "developerInstructions"]
    .some(key => params[key] !== undefined && (params[key] !== null || key === "serviceTier"))
    || Object.keys((params.config ?? {}) as ObjectValue).length > 0;
  if (params.experimentalPredictionMode === true && overrides) throw Object.assign(new Error("`experimentalPredictionMode` cannot be combined with configuration overrides"), { code: -32600 });
}

interface Options { source?: Pick<DesktopCatalog, "isNative" | "refresh"> | null; unique?: boolean; forkThread?: ObjectValue }

async function fixture(parent: ObjectValue, options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-prediction-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "high"] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  let forks = 0;
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, ...parent } };
    if (method === "thread/resume") return { thread: { id: params.threadId }, modelProvider: parent.modelProvider, model: parent.model, serviceTier: null };
    // The fork result carries the parent's effective settings, exactly as the SDK replies.
    if (method === "thread/fork") {
      sdkFork(params);
      return { thread: options.forkThread ?? { id: options.unique ? `fork-${forks++}` : "fork", ephemeral: true }, modelProvider: parent.modelProvider, model: parent.model, serviceTier: null, reasoningEffort: "high" };
    }
    if (method === "turn/start") return { turn: { id: "turn-1" } };
    return {};
  };
  const catalog = new DesktopCatalog(config, [{ slug: "native", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }], join(root, "desktop.json"));
  const source = options.source === undefined ? catalog : options.source ?? undefined;
  const router = new AppServerRouter(config, backend, undefined, source as DesktopCatalog | undefined, native); await router.initialize();
  return { calls, router, state, tiers: new ThreadServiceTiers(state, native), store: new ThreadReasoningStore(state, native) };
}

// Which of the router's per-chat containers still hold this id (a field that does not exist holds nothing).
const held = (router: AppServerRouter, id: string): string[] => {
  const maps = router as unknown as Record<string, { has(id: string): boolean } | undefined>;
  return ["routes", "tierRecords", "activeTurns", "settingsVersions", "ephemeralThreads"].filter(name => maps[name]?.has(id));
};
const settingsUpdated = (threadId: string) => ({ method: "thread/settings/updated", emittedAtMs: Date.now(),
  params: { threadId, threadSettings: { model: "codex/model", modelProvider: "subscription_gateway", serviceTier: null, effort: "low" } } });

test("a native prediction fork reaches the engine exactly as the desktop sent it", async () => {
  const f = await fixture({ modelProvider: "openai", model: "native" });
  // A saved effort is what made the adapter add a config key to every native fork.
  await f.store.write("parent", { model: "native", effort: "max", atMs: Date.now() - 60_000 });
  await f.router.request("thread/resume", { threadId: "parent" });
  const result = await f.router.request("thread/fork", prediction("parent"));
  assert.equal((result.thread as ObjectValue).id, "fork");
  assert.deepEqual(f.calls.at(-1), { method: "thread/fork", params: prediction("parent") });
});

test("a gateway prediction fork is forwarded unchanged and never refused over its tier", async () => {
  // A connection that has not read this chat's tier refuses an ordinary fork; a prediction
  // fork carries no tier, so the SDK inherits the parent's own.
  const f = await fixture({ modelProvider: "subscription_gateway", model: "codex/model" });
  await f.store.write("parent", { model: "codex/model", effort: "high", atMs: Date.now() - 60_000 });
  await f.router.request("thread/fork", prediction("parent"));
  // The backends still route it to the engine that owns the parent; the router adds nothing.
  assert.deepEqual(f.calls, [{ method: "thread/fork", params: prediction("parent") }]);
});

test("an ordinary fork keeps the adapter's settings and only prediction forks inherit", async () => {
  const f = await fixture({ modelProvider: "openai", model: "native" });
  await f.store.write("parent", { model: "native", effort: "max", atMs: Date.now() - 60_000 });
  // An ordinary fork that names the chat's own model ("Fork into local") still receives its effort.
  await f.router.request("thread/fork", { threadId: "parent", model: "native" });
  assert.equal(((f.calls.at(-1)!.params.config ?? {}) as ObjectValue).model_reasoning_effort, "max");
  assert.equal(inheritsParentSettings("thread/fork", { experimentalPredictionMode: false }), false);
  assert.equal(inheritsParentSettings("thread/resume", { experimentalPredictionMode: true }), false);
  // A caller that adds an override to a prediction fork receives the SDK's own refusal.
  await assert.rejects(f.router.request("thread/fork", { ...prediction("parent"), config: { model_reasoning_effort: "low" } }),
    { code: -32600, message: "`experimentalPredictionMode` cannot be combined with configuration overrides" });
  assert.deepEqual(f.calls.at(-1)!.params.config, { model_reasoning_effort: "low" });
});

test("an ordinary fork is not a prediction fork just because it asks to be ephemeral", async () => {
  const f = await fixture({ modelProvider: "openai", model: "native" });
  await f.store.write("parent", { model: "native", effort: "max", atMs: Date.now() - 60_000 });
  await f.router.request("thread/fork", { threadId: "parent", model: "native", ephemeral: true });
  assert.equal(((f.calls.at(-1)!.params.config ?? {}) as ObjectValue).model_reasoning_effort, "max", "the adapter still restores the chat's effort");
  // Only experimentalPredictionMode makes a fork inherit; the mode alone is enough.
  assert.equal(inheritsParentSettings("thread/fork", { ephemeral: true }), false);
  assert.equal(inheritsParentSettings("thread/fork", { ephemeral: true, excludeTurns: true, threadSource: "composer_predictions" }), false);
  assert.equal(inheritsParentSettings("thread/fork", { experimentalPredictionMode: true }), true);
});

test("a gateway prediction fork whose result is not flagged ephemeral still writes nothing durable", async () => {
  // The request alone marks it throwaway: the engine's reply need not repeat the flag.
  const f = await fixture({ modelProvider: "subscription_gateway", model: "codex/model" }, { source: null, forkThread: { id: "fork" } });
  await f.router.request("thread/fork", prediction("parent"));
  assert.equal(await f.tiers.read("fork"), undefined, "no tier record");
  assert.equal(await f.store.read("fork"), undefined, "no reasoning record");
  assert.deepEqual(held(f.router, "fork").sort(), ["ephemeralThreads", "routes"], "the fork is tracked as throwaway with only its route");
});

test("a gateway prediction fork records nothing durable and its turns route without a probe", async () => {
  const f = await fixture({ modelProvider: "subscription_gateway", model: "codex/model" }, { source: null });
  const result = await f.router.request("thread/fork", prediction("parent"));
  assert.equal((result.thread as ObjectValue).id, "fork");
  // The result's effort and tier must not reach either private store under the throwaway id.
  assert.equal(await f.tiers.read("fork"), undefined, "no tier record for a prediction fork");
  assert.equal(await f.store.read("fork"), undefined, "no reasoning record for a prediction fork");
  assert.equal(held(f.router, "fork").includes("tierRecords"), false, "no tier record is kept in memory either");
  f.calls.length = 0;
  await f.router.request("turn/start", { threadId: "fork", input: [], effort: "low" });
  assert.deepEqual(f.calls, [{ method: "turn/start", params: { threadId: "fork", input: [], effort: "low" } }], "the kept route reaches the engine without a thread/read probe");
  await f.router.observeNotification(settingsUpdated("fork"));
  assert.equal(await f.tiers.read("fork"), undefined, "an applied settings change does not record the fork's tier");
  assert.equal(await f.store.read("fork"), undefined, "neither a turn nor a settings change records the fork's reasoning");
});

for (const [name, close] of [
  ["thread/unsubscribe", (r: AppServerRouter) => r.request("thread/unsubscribe", { threadId: "fork" })],
  ["thread/closed", (r: AppServerRouter) => r.observeNotification({ method: "thread/closed", params: { threadId: "fork" } })],
] as const) test(`${name} leaves nothing of a prediction fork behind in the router`, async () => {
  const f = await fixture({ modelProvider: "subscription_gateway", model: "codex/model" }, { source: null });
  await f.router.request("thread/fork", prediction("parent"));
  await f.router.request("turn/start", { threadId: "fork", input: [] });
  await f.router.observeNotification(settingsUpdated("fork"));
  assert.deepEqual(held(f.router, "fork").sort(), ["activeTurns", "ephemeralThreads", "routes", "settingsVersions"], "the setup must fill the containers the cleanup is meant to empty");
  await close(f.router);
  assert.deepEqual(held(f.router, "fork"), []);
  f.calls.length = 0;
  await f.router.request("turn/start", { threadId: "fork", input: [] });
  assert.equal(f.calls[0].method, "thread/read", "the forgotten id is no longer known to the router");
});

test("only the newest 256 prediction forks stay routed", async () => {
  const f = await fixture({ modelProvider: "subscription_gateway", model: "codex/model" }, { source: null, unique: true });
  for (let i = 0; i < 257; i++) await f.router.request("thread/fork", prediction("parent"));
  assert.deepEqual(held(f.router, "fork-0"), [], "the oldest fork is evicted along with its route");
  assert.deepEqual(held(f.router, "fork-1"), ["routes", "ephemeralThreads"]);
  assert.deepEqual(held(f.router, "fork-256"), ["routes", "ephemeralThreads"]);
  assert.equal(((f.router as unknown as { ephemeralThreads?: Set<string> }).ephemeralThreads)?.size, 256);
});

test("a native prediction fork writes nothing durable", async () => {
  const f = await fixture({ modelProvider: "openai", model: "native" });
  const savedAt = Date.now() - 60_000;
  await f.store.write("parent", { model: "native", effort: "max", atMs: savedAt });
  await f.router.request("thread/fork", prediction("parent"));
  assert.equal(await f.store.read("fork"), undefined, "the fork's reported effort is never recorded for its throwaway id");
  assert.equal(await f.tiers.read("fork"), undefined);
  assert.deepEqual(await f.store.read("parent"), { model: "native", effort: "max", atMs: savedAt }, "the parent keeps its own record");
});

test("a prediction fork survives an unreadable preferences file", async () => {
  const f = await fixture({ modelProvider: "subscription_gateway", model: "codex/model" });
  await writeFile(join(f.state, "desktop-preferences.json"), "{ truncated", { mode: 0o600 });
  // The adapter's own settings are not consulted, so this breakage cannot reach the fork ...
  const result = await f.router.request("thread/fork", prediction("parent"));
  assert.equal((result.thread as ObjectValue).id, "fork");
  // ... while an ordinary fork, which does need them, is refused.
  await assert.rejects(f.router.request("thread/fork", { threadId: "parent" }), /preferences are unreadable/);
});

test("a prediction fork survives a catalog refresh that throws", async () => {
  const source = { isNative: () => false, refresh: async () => { throw new Error("catalog unavailable"); } };
  const f = await fixture({ modelProvider: "subscription_gateway", model: "codex/model" }, { source });
  const result = await f.router.request("thread/fork", prediction("parent"));
  assert.equal((result.thread as ObjectValue).id, "fork");
  await assert.rejects(f.router.request("thread/fork", { threadId: "parent" }), /catalog unavailable/);
});
