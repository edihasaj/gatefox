import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { ThreadReasoningStore } from "../thread-reasoning.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;
const old = () => Date.now() - 60_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-reasoning-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low", "high"] } } },
    // Real Codex 2 rows publish the reasoning levels their native catalog offers; "codex/plain" is a
    // gateway model without reasoning control at all, so nothing may be restored onto it.
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model", "codex/plain": "plain" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }, "codex/plain": { reasoningEfforts: [] } } },
  ] };
  const thread: ObjectValue = { id: "persisted", modelProvider: "subscription_gateway", model: "codex/model" };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "thread/start") return { thread: { id: "test" }, modelProvider: params.modelProvider || "openai", model: params.model || "native", serviceTier: params.serviceTier ?? null };
    if (method === "thread/read") return { thread: { ...thread } };
    if (method === "thread/resume" || method === "thread/fork") return { thread: { id: "persisted" }, modelProvider: params.modelProvider, model: params.model, serviceTier: params.serviceTier ?? null };
    if (method === "turn/start") return { turn: { id: "active" } };
    return { status: "ok" };
  };
  // Port 1 is never a real gateway, so a catalog with a source stays on its offline cache.
  const source = (native: ObjectValue[]) => new DesktopCatalog(config, native, join(root, "desktop.json"));
  const router = async (catalog?: DesktopCatalog) => { const r = new AppServerRouter(config, backend, undefined, catalog, native); await r.initialize(); return r; };
  const store = new ThreadReasoningStore(state, native);
  let stamp = Date.now();
  const notify = async (threadId: string, settings: ObjectValue) => {
    const r = await router(); await r.observeNotification({ method: "thread/settings/updated", emittedAtMs: Math.max(++stamp, Date.now()), params: { threadId, threadSettings: { model: "codex/model", ...settings } } });
  };
  const rollout = async (threadId: string, lines: string[]) => {
    const sessions = join(native, "sessions"); await mkdir(sessions, { recursive: true, mode: 0o700 });
    const path = join(sessions, `rollout-2026-10-14-${threadId}.jsonl`);
    await writeFile(path, lines.map(line => line + "\n").join("")); return path;
  };
  const events = async () => { await flushTelemetry(); return readTelemetry(state, Date.now() - 60_000); };
  const forwarded = () => calls.at(-1)!.params;
  return { root, state, native, config, calls, thread, store, notify, rollout, router, source, events, forwarded };
}

test("a restart restores the effort and summary the chat last ran with", async () => {
  const f = await fixture();
  const first = await f.router();
  await first.request("thread/start", { model: "codex/model" });
  await first.request("turn/start", { threadId: "test", input: [], effort: "xhigh", summary: "concise" });
  const second = await f.router();
  await second.request("thread/resume", { threadId: "test" });
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_effort, "xhigh");
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_summary, "concise");
  assert.ok((await f.events()).some(event => event.event === "reasoning_restored" && event.source === "record"
    && event.method === "thread/resume" && event.provider === "gateway" && event.adjusted === false));
});

test("a missing record seeds from the chat rollout, where a later null keeps the earlier effort", async () => {
  const f = await fixture();
  f.thread.path = await f.rollout("persisted", [
    '{"type":"turn_context","payload":{"model":"codex/model","effort":"max","summary":"detailed"}}',
    '{"type":"turn_context","payload":{"effort":null}}',
  ]);
  const router = await f.router();
  await router.request("thread/resume", { threadId: "persisted" });
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_effort, "max");
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_summary, "detailed");
  assert.ok((await f.events()).some(event => event.event === "reasoning_restored" && event.source === "rollout"));
});

test("reasoning recorded for another chat never transfers", async () => {
  const f = await fixture();
  await f.store.write("other-chat", { model: "codex/model", effort: "max", atMs: old() });
  f.thread.path = await f.rollout("persisted", [
    '{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_id":"other-chat","thread_settings":{"reasoning_effort":"ultra"}}}',
  ]);
  const router = await f.router();
  await router.request("thread/resume", { threadId: "persisted" });
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_effort, undefined);
  assert.equal((await f.events()).some(event => event.event === "reasoning_unrecovered" && event.model === "codex/model"), true);
});

test("a caller-supplied effort wins over the record", async () => {
  const f = await fixture();
  await f.store.write("persisted", { model: "codex/model", effort: "max", atMs: old() });
  const router = await f.router();
  await router.request("thread/resume", { threadId: "persisted", config: { model_reasoning_effort: "low" } });
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_effort, "low");
  assert.equal((await f.events()).some(event => event.event === "reasoning_restored"), false);
});

test("a restored level is fitted to what the model offers", async () => {
  for (const [saved, expected] of [["max", "high"], ["minimal", "low"], ["quantum", "low"]] as Array<[string, string]>) {
    const f = await fixture();
    f.thread.model = "claude/model";
    await f.store.write("persisted", { model: "claude/model", effort: saved, atMs: old() });
    const router = await f.router();
    await router.request("thread/resume", { threadId: "persisted" });
    assert.equal((f.forwarded().config as ObjectValue).model_reasoning_effort, expected, `${saved} fits to ${expected}`);
    const resets = (await f.events()).filter(event => event.event === "reasoning_effort_reset");
    assert.equal(resets.length, 1, `${saved} reports one adjustment`);
    assert.deepEqual({ from: resets[0].from, to: resets[0].to, model: resets[0].model, method: resets[0].method },
      { from: /^[a-z]+$/.test(saved) && ["none","minimal","low","medium","high","xhigh","max","ultra"].includes(saved) ? saved : undefined, to: expected, model: "claude/model", method: "thread/resume" }, `${saved} resets to the fitted level`);
  }
});

test("a gateway fork inherits the parent chat's reasoning", async () => {
  const f = await fixture();
  const router = await f.router();
  await router.request("turn/start", { threadId: "persisted", input: [], effort: "high" });
  await router.request("thread/fork", { threadId: "persisted", serviceTier: null });
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_effort, "high");
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_summary, "auto");
  assert.ok((await f.events()).some(event => event.event === "reasoning_restored" && event.method === "thread/fork" && event.source === "record"));
});

test("a null settings notification never erases the saved reasoning", async () => {
  const f = await fixture();
  await f.store.write("persisted", { model: "codex/model", effort: "max", summary: "detailed", atMs: old() });
  await f.notify("persisted", { effort: null, summary: null });
  const untouched = await f.store.read("persisted");
  assert.equal(untouched!.effort, "max"); assert.equal(untouched!.summary, "detailed");
  await f.notify("persisted", { summary: "concise" });
  const after = await f.store.read("persisted");
  assert.equal(after!.effort, "max", "an unknown effort keeps the saved one"); assert.equal(after!.summary, "concise");
  const router = await f.router();
  await router.request("thread/resume", { threadId: "persisted" });
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_effort, "max");
  assert.equal((f.forwarded().config as ObjectValue).model_reasoning_summary, "concise");
});

test("a chat with nothing to recover receives no reasoning keys", async () => {
  const f = await fixture();
  const router = await f.router();
  await router.request("thread/resume", { threadId: "persisted" });
  const config = f.forwarded().config as ObjectValue;
  assert.equal(Object.hasOwn(config, "model_reasoning_effort"), false);
  assert.equal(Object.hasOwn(config, "model_reasoning_summary"), false);
});

test("an effort saved for one model is never carried onto the model that replaced it", async () => {
  const f = await fixture();
  await f.store.write("persisted", { model: "claude/model", effort: "max", atMs: old() });
  // The desktop reported a newer selection for another model without naming an effort at all.
  assert.equal(await f.store.write("persisted", { model: "codex/model", effort: null, summary: null, atMs: Date.now() }), false);
  assert.equal((await f.store.read("persisted"))!.model, "claude/model", "the other model's record is never rewritten");
  const router = await f.router();
  await router.request("thread/resume", { threadId: "persisted" });
  assert.equal(Object.hasOwn(f.forwarded().config as ObjectValue, "model_reasoning_effort"), false, "the resumed chat does not run Claude's Max");
  assert.ok((await f.events()).some(event => event.event === "reasoning_unrecovered" && event.model === "codex/model"));
});

test("a gateway model that offers no reasoning levels receives nothing back", async () => {
  const f = await fixture();
  f.thread.model = "codex/plain";
  await f.store.write("persisted", { model: "codex/plain", effort: "max", atMs: old() });
  const router = await f.router();
  await router.request("thread/resume", { threadId: "persisted" });
  const config = f.forwarded().config as ObjectValue;
  assert.equal(Object.hasOwn(config, "model_reasoning_effort"), false);
  assert.equal(Object.hasOwn(config, "model_reasoning_summary"), false);
  assert.equal((await f.events()).some(event => event.event === "reasoning_restored"), false, "a model with no reasoning control reports no restore");
});

test("a native resume reaches the engine exactly as sent, with or without a model", async () => {
  const f = await fixture();
  f.thread.modelProvider = "openai"; f.thread.model = "native";
  await f.store.write("persisted", { model: "native", effort: "max", atMs: old() });
  const router = await f.router(f.source([{ slug: "native", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }]));
  for (const params of [{ threadId: "persisted" }, { threadId: "persisted", model: "native" }, { threadId: "persisted", model: "native", modelProvider: "openai", config: { model: "native" } }]) {
    await router.request("thread/resume", structuredClone(params));
    assert.deepEqual(f.forwarded(), params, "the adapter adds no model, provider or effort to a native resume");
  }
  assert.equal((await f.events()).some(event => event.event === "reasoning_restored"), false, "a native chat reports no adapter restore");
});

test("a native fork reaches the engine exactly as sent, so the engine chooses its own effort", async () => {
  const f = await fixture();
  f.thread.modelProvider = "openai"; f.thread.model = "native";
  await f.store.write("persisted", { model: "native", effort: "max", atMs: old() });
  const router = await f.router(f.source([{ slug: "native", supported_reasoning_levels: [{ effort: "low" }, { effort: "max" }] }]));
  for (const params of [{ threadId: "persisted" }, { threadId: "persisted", model: "native" },
    { threadId: "persisted", model: "native", config: { model_reasoning_effort: "low" } }]) {
    await router.request("thread/fork", structuredClone(params));
    assert.deepEqual(f.forwarded(), params);
  }
  assert.equal((await f.events()).some(event => event.event === "reasoning_restored"), false);
});
