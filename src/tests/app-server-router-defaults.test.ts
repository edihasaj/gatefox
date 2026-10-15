import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import type { DesktopCatalog } from "../desktop-catalog.js";

type ObjectValue = Record<string, unknown>;

// Rows whose declared defaults differ from the old medium/auto fallback: Codex's
// own default effort is high, a reasoning-free row defaults to no summaries, and
// the row advertises a Fast default tier the adapter must never apply on its own.
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-defaults-"));
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low", "high"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "unused",
      models: { "codex/model": "model", "codex/plain": "plain" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "high",
        serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }], defaultServiceTier: "priority" },
        "codex/plain": { reasoningEfforts: [] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "thread/start") return { thread: { id: "test" }, modelProvider: params.modelProvider || "openai", model: params.model || "native", serviceTier: params.serviceTier ?? null };
    if (method === "thread/read") return { thread: { id: "persisted", modelProvider: "subscription_gateway", model: "codex/model" } };
    if (method === "thread/resume" || method === "thread/fork") return { thread: { id: "persisted" }, modelProvider: params.modelProvider, model: params.model, serviceTier: params.serviceTier ?? null };
    return { status: "ok" };
  };
  const router = new AppServerRouter(config, backend); await router.initialize();
  return { directory, config, calls, backend, router, forwarded: () => calls.at(-1)!.params, forwardedConfig: () => calls.at(-1)!.params.config as ObjectValue };
}

test("a new gateway chat starts with the row's reasoning defaults", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: "codex/model" });
  assert.equal(f.forwardedConfig().model_reasoning_effort, "high", "the row's default effort replaces the medium fallback");
  assert.equal(f.forwardedConfig().model_reasoning_summary, "auto");
  await f.router.request("thread/start", { model: "codex/plain" });
  assert.equal(f.forwardedConfig().model_reasoning_effort, "none");
  assert.equal(f.forwardedConfig().model_reasoning_summary, "none", "the row's summary default replaces auto");
});

test("saved preferences and explicit choices still outrank the row's defaults", async () => {
  const f = await fixture();
  await f.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "codex/model", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "low", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_summary", value: "detailed", mergeStrategy: "upsert" },
  ] });
  await f.router.request("thread/start", { model: "codex/model" });
  assert.equal(f.forwardedConfig().model_reasoning_effort, "low", "the saved effort for the configured model wins");
  assert.equal(f.forwardedConfig().model_reasoning_summary, "detailed");
  await f.router.request("thread/start", { model: "codex/model", config: { model_reasoning_effort: "xhigh" } });
  assert.equal(f.forwardedConfig().model_reasoning_effort, "xhigh", "the caller's explicit effort wins over both");
});

test("Fast is never a new-chat default from a row or a saved preference", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: "codex/model" });
  assert.equal(f.forwarded().serviceTier, null, "a row's default_service_tier does not start a chat in Fast; the start is sent as Standard");
  // A gateway Fast default is no longer saved, so an older file stands in for a saved one.
  await writeFile(join(f.directory, "desktop-preferences.json"), JSON.stringify({ model: "codex/model", service_tier: "fast" }));
  await f.router.request("thread/start", {});
  assert.equal(f.forwarded().serviceTier, null, "a saved tier does not start a chat in Fast either");
  await f.router.request("thread/start", { serviceTier: null });
  assert.equal(f.forwarded().serviceTier, null, "an explicit Standard still passes through");
  await f.router.request("thread/start", { serviceTier: "fast" });
  assert.equal(f.forwarded().serviceTier, "fast", "Fast remains selectable per chat");
  const claude = await f.router.request("thread/start", { model: "claude/model", serviceTier: "fast" });
  assert.equal(claude.serviceTier, null, "a tier the row does not offer becomes Standard instead of failing the start");
  assert.equal(f.forwarded().serviceTier, null);
});

test("a new chat after a Fast chat starts Standard while the Fast chat keeps Fast", async () => {
  const f = await fixture();
  const fast = await f.router.request("thread/start", { model: "codex/model", serviceTier: "fast" });
  assert.equal(fast.serviceTier, "fast");
  await f.router.request("thread/start", { model: "codex/model" });
  assert.equal(f.forwarded().serviceTier, null, "the next new chat is Standard");
  await f.router.request("thread/resume", { threadId: "test" });
  assert.equal(f.forwarded().serviceTier, "priority", "resuming the Fast chat restores its own tier");
});

test("the default effort a discovered gateway row advertises is the effort a new chat gets", async () => {
  const f = await fixture();
  const level = (effort: string) => ({ effort, description: effort });
  // Discovery can omit the default, or name one the row does not offer; the static catalog never does.
  const rows = [
    { slug: "codex/undeclared", display_name: "Undeclared", description: "", supported_reasoning_levels: ["low", "medium", "high"].map(level), default_reasoning_level: null, input_modalities: ["text"] },
    { slug: "codex/unoffered", display_name: "Unoffered", description: "", supported_reasoning_levels: ["low", "medium"].map(level), default_reasoning_level: "xhigh", input_modalities: ["text"] },
  ];
  const source = { isNative: (model: string) => model === "native", nativeRow: () => undefined, refresh: async () => ({ models: rows }) } as unknown as DesktopCatalog;
  const router = new AppServerRouter(f.config, f.backend, undefined, source, join(f.directory, "native-home")); await router.initialize();
  const listed = (await router.request("model/list", {})).data as ObjectValue[];
  for (const slug of ["codex/undeclared", "codex/unoffered"]) {
    const advertised = listed.find(row => row.model === slug)!.defaultReasoningEffort;
    assert.equal(advertised, "medium", `${slug} advertises an effort it offers`);
    await router.request("thread/start", { model: slug });
    assert.equal(f.forwardedConfig().model_reasoning_effort, advertised, `${slug} starts with the advertised effort`);
  }
});
