import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function fixture(parent: ObjectValue) {
  const root = await mkdtemp(join(tmpdir(), "gateway-prediction-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "high"] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, ...parent } };
    if (method === "thread/resume") return { thread: { id: params.threadId }, modelProvider: parent.modelProvider, model: parent.model, serviceTier: null };
    if (method === "thread/fork") { sdkFork(params); return { thread: { id: "fork", ephemeral: true }, modelProvider: parent.modelProvider, model: parent.model, serviceTier: null }; }
    return {};
  };
  const catalog = new DesktopCatalog(config, [{ slug: "native", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }], join(root, "desktop.json"));
  const router = new AppServerRouter(config, backend, undefined, catalog, native); await router.initialize();
  return { calls, router, store: new ThreadReasoningStore(state, native) };
}

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
  await f.router.request("thread/fork", { threadId: "parent" });
  assert.equal(((f.calls.at(-1)!.params.config ?? {}) as ObjectValue).model_reasoning_effort, "max");
  assert.equal(inheritsParentSettings("thread/fork", { experimentalPredictionMode: false }), false);
  assert.equal(inheritsParentSettings("thread/resume", { experimentalPredictionMode: true }), false);
  // A caller that adds an override to a prediction fork receives the SDK's own refusal.
  await assert.rejects(f.router.request("thread/fork", { ...prediction("parent"), config: { model_reasoning_effort: "low" } }),
    { code: -32600, message: "`experimentalPredictionMode` cannot be combined with configuration overrides" });
  assert.deepEqual(f.calls.at(-1)!.params.config, { model_reasoning_effort: "low" });
});
