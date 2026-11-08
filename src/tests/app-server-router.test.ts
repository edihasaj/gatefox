import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { identityTest } from "./identity-cases.js";

// A saved gateway chat and its engine's notifications carry the identity under test. A new chat's request names the gateway's own
// provider (the backends record it with the connection's identity); a resume names the provider the chat was saved with.
let gateway = "subscription_gateway";
const test = identityTest(identity => { gateway = identity.provider; });

type ObjectValue = Record<string, unknown>;
let notificationTimestamp = Date.now();
const appliedSettings = (router: AppServerRouter, threadId: string, model: string, serviceTier: string | null) => router.observeNotification({
  method: "thread/settings/updated", emittedAtMs: notificationTimestamp = Math.max(notificationTimestamp + 1, Date.now()), params: { threadId, threadSettings: { modelProvider: gateway, model, serviceTier } },
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-app-server-"));
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low", "high"] } } },
    // A real Codex 2 row carries the reasoning levels its native catalog publishes.
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" },
      modelMetadata: { "codex/model": { reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (method === "thread/start") return { thread: { id: "test" }, modelProvider: params.modelProvider || "openai", model: params.model || "native", serviceTier: params.serviceTier ?? null };
    if (method === "thread/read") return { thread: { id: "persisted", modelProvider: gateway, model: "codex/model" } };
    if (method === "thread/resume" || method === "thread/fork") return { thread: { id: "persisted" }, modelProvider: params.modelProvider, model: params.model, serviceTier: params.serviceTier ?? null };
    if (method === "turn/start") return { turn: { id: "active" } };
    if (method === "turn/settings/update") return { status: "applied" };
    return { status: "ok" };
  };
  const router = new AppServerRouter(config, backend); await router.initialize();
  return { directory, config, calls, backend, router };
}

test("adapter paginates native models first and preserves native settings", async () => {
  const { router } = await fixture();
  const one = await router.request("model/list", { limit: 2 });
  assert.deepEqual((one.data as ObjectValue[]).map(model => model.model), ["native", "claude/model"]);
  const two = await router.request("model/list", { limit: 2, cursor: one.nextCursor });
  assert.deepEqual((two.data as ObjectValue[]).map(model => model.displayName), ["Codex 2 · model"]);
  assert.equal(two.nextCursor, null);
  const config = (await router.request("config/read", {})).config as ObjectValue;
  assert.equal(config.model, "native"); assert.equal(config.model_provider, "openai");
  await assert.rejects(router.request("model/list", { cursor: "native-private-cursor" }), /Invalid gateway model cursor/);
});

test("gateway chat starts with an explicit provider and supported reasoning default", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: "claude/model", modelProvider: "openai", config: { trusted: true } });
  const forwarded = calls.at(-1)!.params;
  assert.equal(forwarded.modelProvider, "gatefox");
  assert.equal((forwarded.config as ObjectValue).model_reasoning_effort, "low");
  assert.equal((forwarded.config as ObjectValue).trusted, true);
  await router.request("turn/start", { threadId: "test", model: "codex/model", input: [] });
  assert.equal(calls.at(-1)!.method, "turn/start");
  const count = calls.length;
  await assert.rejects(router.request("turn/start", { threadId: "test", model: "native", input: [] }), /Start a new chat/);
  assert.equal(calls.length, count);
});

test("native chat never receives a gateway alias and persisted gateway chats retain their provider", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: "native" });
  const count = calls.length;
  await assert.rejects(router.request("thread/resume", { threadId: "test", model: "claude/model" }), /Start a new chat/);
  await assert.rejects(router.request("turn/start", { threadId: "test", model: "native", collaborationMode: { settings: { model: "claude/model" } } }), /Start a new chat/);
  assert.equal(calls.length, count);
  await router.request("thread/resume", { threadId: "persisted" });
  assert.equal(calls.at(-1)!.params.modelProvider, gateway, "a resume names the provider the chat was saved with, so its record is never rewritten");
  assert.equal(calls.at(-1)!.params.model, "codex/model");
});

test("live settings keep provider boundaries and forward thread controls unchanged", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: "native" });
  const count = calls.length;
  for (const method of ["thread/settings/update", "turn/settings/update"]) {
    await assert.rejects(router.request(method, { threadId: "test", turnId: "active", model: "claude/model" }), /Start a new chat/);
  }
  assert.equal(calls.length, count);
  await router.request("thread/start", { model: "claude/model" });
  const params = { threadId: "test", model: "codex/model", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, effort: "high" };
  const sent = structuredClone(params);
  await router.request("thread/settings/update", params);
  assert.deepEqual(calls.at(-1)!.params, sent);
  await appliedSettings(router, "test", "codex/model", null);
  await router.request("thread/resume", { threadId: "test" });
  assert.equal(calls.at(-1)!.params.model, "codex/model");
  await assert.rejects(router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "native" }), /Start a new chat/);
});

test("steering and goal operations retain their active-turn and authorization fields", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: "claude/model" });
  const steer = { threadId: "test", expectedTurnId: "active", input: [{ type: "text", text: "changed direction" }], clientUserMessageId: "client-message" };
  const sentSteer = structuredClone(steer);
  await router.request("turn/steer", steer); assert.deepEqual(calls.at(-1)!.params, sentSteer);
  const goal = { threadId: "test", objective: "fixture objective", status: "paused", origin: "user", tokenBudget: 10000 };
  const sentGoal = structuredClone(goal);
  await router.request("thread/goal/set", goal); assert.deepEqual(calls.at(-1)!.params, sentGoal);
});

test("desktop config overrides select the gateway before its first turn", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: null, modelProvider: "openai", config: { model: "claude/model" } });
  assert.equal(calls.at(-1)!.params.modelProvider, "gatefox");
  await router.request("turn/start", { threadId: "test", collaborationMode: { settings: { model: "codex/model" } } });
  await assert.rejects(router.request("turn/start", { threadId: "test", collaborationMode: { settings: { model: "native" } } }), /Start a new chat/);
});

test("gateway default writes stay in private adapter preferences and survive restart", async () => {
  const { router, directory, config, backend, calls } = await fixture();
  const written = await router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "claude/model", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
  ] });
  assert.equal(calls.length, 0); assert.equal(written.filePath, join(directory, "desktop-preferences.json"));
  assert.equal((await stat(String(written.filePath))).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(String(written.filePath), "utf8")); assert.equal(saved.model, "claude/model");
  const reopened = new AppServerRouter(config, backend); await reopened.initialize();
  const view = (await reopened.request("config/read", {})).config as ObjectValue;
  assert.equal(view.model, "claude/model"); assert.equal(view.model_provider, "openai");
  await reopened.request("thread/start", {});
  assert.equal(calls.at(-1)!.params.modelProvider, "gatefox");
  assert.equal((calls.at(-1)!.params.config as ObjectValue).model_reasoning_effort, "high");
  await assert.rejects(router.request("config/value/write", { keyPath: "model", value: "codex/model", mergeStrategy: "replace", filePath: "/native/config.toml" }), /custom config-file target/);
  await assert.rejects(router.request("config/value/write", { keyPath: "model", value: "codex/model", mergeStrategy: "replace", expectedVersion: "native-version" }), /native config version guard/);
});


test("combined native catalogs do not duplicate gateway rows", async () => {
  const { config } = await fixture();
  const router = new AppServerRouter(config, async () => ({ data: [{ model: "native" }, { model: "claude/model" }], nextCursor: null }));
  const models = (await router.request("model/list", {})).data as ObjectValue[];
  assert.deepEqual(models.map(model => model.model), ["native", "claude/model", "codex/model"]);
});


test("gateway defaults stay private and every other config write reaches the native engine", async () => {
  const { router, calls, directory } = await fixture();
  await router.request("config/batchWrite", { edits: [{ keyPath: "model", value: "native", mergeStrategy: "upsert" }, { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" }] });
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await readFile(join(directory, "desktop-preferences.json"), "utf8")).model, "native");
  await router.request("thread/start", {});
  assert.equal(calls.at(-1)!.params.model, "native");
  assert.equal((calls.at(-1)!.params.config as ObjectValue).model_reasoning_effort, "high");
  const count = calls.length;
  const params = { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "upsert" };
  const sent = structuredClone(params);
  await router.request("config/value/write", params);
  assert.deepEqual(calls.slice(count), [{ method: "config/value/write", params: sent }], "the native write is forwarded exactly as the caller sent it");
  assert.equal(JSON.parse(await readFile(join(directory, "desktop-preferences.json"), "utf8")).model, "native", "a native write saves no gateway default");
});

test("independent desktop connections refresh reasoning preferences and preserve unrelated writes", async () => {
  const { config, backend, directory, calls } = await fixture();
  config.providers[0]!.modelMetadata = { "claude/model": { reasoningEfforts: ["low", "high", "max"] } };
  const first = new AppServerRouter(config, backend); await first.initialize();
  await first.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "claude/model", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
  ] });
  const second = new AppServerRouter(config, backend); await second.initialize();
  await first.request("config/value/write", { keyPath: "model_reasoning_effort", value: "max", mergeStrategy: "upsert" });
  assert.equal(((await second.request("config/read", {})).config as ObjectValue).model_reasoning_effort, "max");
  await second.request("config/value/write", { keyPath: "model_reasoning_summary", value: "detailed", mergeStrategy: "upsert" });
  const saved = JSON.parse(await readFile(join(directory, "desktop-preferences.json"), "utf8"));
  assert.equal(saved.model_reasoning_effort, "max");
  assert.equal(((await first.request("config/read", {})).config as ObjectValue).model_reasoning_summary, "detailed");
  await second.request("thread/start", {});
  assert.equal((calls.at(-1)!.params.config as ObjectValue).model_reasoning_effort, "max");
});

test("separate adapter processes merge concurrent private preference edits", async () => {
  const { config, router, directory } = await fixture();
  await router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "claude/model", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" },
  ] });
  const code = `import { AppServerRouter } from ${JSON.stringify(new URL("../app-server-router.js", import.meta.url).href)};
    const router = new AppServerRouter(JSON.parse(process.argv[1]), async () => ({}));
    await router.initialize();
    await router.request("config/value/write", {keyPath:process.argv[2], value:process.argv[3], mergeStrategy:"upsert"});`;
  const execute = promisify(execFile);
  await Promise.all([
    execute(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(config), "model_reasoning_effort", "max"]),
    execute(process.execPath, ["--input-type=module", "-e", code, JSON.stringify(config), "model_reasoning_summary", "detailed"]),
  ]);
  const saved = JSON.parse(await readFile(join(directory, "desktop-preferences.json"), "utf8"));
  assert.equal(saved.model_reasoning_effort, "max"); assert.equal(saved.model_reasoning_summary, "detailed");
  assert.equal(((await router.request("config/read", {})).config as ObjectValue).model_reasoning_effort, "max");
});

test("desktop reasoning display writes persist without selecting a gateway model", async () => {
  const { config, directory, calls, backend } = await fixture();
  const request = async (method: string, params: ObjectValue) => method === "config/read"
    ? { config: { model: "native", desktop: { nativeOnly: true } } } : backend(method, params);
  const first = new AppServerRouter(config, request); await first.initialize();
  const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  await first.request("config/batchWrite", { edits: [
    { keyPath: "desktop.enabled-reasoning-efforts", value: efforts, mergeStrategy: "replace" },
    { keyPath: "desktop.show-ultra-in-model-picker-slider", value: true, mergeStrategy: "replace" },
  ] });
  assert.equal(calls.length, 0);
  const saved = JSON.parse(await readFile(join(directory, "desktop-preferences.json"), "utf8"));
  assert.equal(saved.model, undefined);
  assert.deepEqual(saved.desktop["enabled-reasoning-efforts"], efforts);
  const reopened = new AppServerRouter(config, request); await reopened.initialize();
  const read = (await reopened.request("config/read", { includeLayers: false })).config as ObjectValue;
  assert.equal(read.model, "native");
  assert.deepEqual(read.desktop, { nativeOnly: true, "enabled-reasoning-efforts": efforts, "show-ultra-in-model-picker-slider": true });
});

test("desktop preference writes merge across connections and a mixed batch saves only after its native part is allowed", async () => {
  const { router, config, directory, backend } = await fixture();
  const other = new AppServerRouter(config, backend); await other.initialize();
  await Promise.all([
    router.request("config/value/write", { keyPath: "desktop.enabled-reasoning-efforts", value: ["high", "max"], mergeStrategy: "replace" }),
    other.request("config/value/write", { keyPath: "desktop.show-ultra-in-model-picker-slider", value: true, mergeStrategy: "upsert" }),
  ]);
  const path = join(directory, "desktop-preferences.json");
  const before = await readFile(path, "utf8");
  const saved = JSON.parse(before);
  assert.deepEqual(saved.desktop, { "enabled-reasoning-efforts": ["high", "max"], "show-ultra-in-model-picker-slider": true });
  await router.request("config/batchWrite", { edits: [
    { keyPath: "desktop.enabled-reasoning-efforts", value: ["low"], mergeStrategy: "replace" },
    { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "upsert" },
  ] });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).desktop, { "enabled-reasoning-efforts": ["low"], "show-ultra-in-model-picker-slider": true });
  await assert.rejects(router.request("config/batchWrite", { edits: [
    { keyPath: "desktop.enabled-reasoning-efforts", value: ["medium"], mergeStrategy: "replace" },
    { keyPath: "model_providers.subscription_gateway.base_url", value: "http://127.0.0.1:3457/v1", mergeStrategy: "upsert" },
  ] }), /cannot be saved into native Codex configuration/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).desktop, { "enabled-reasoning-efforts": ["low"], "show-ultra-in-model-picker-slider": true }, "a refused mixed batch saves nothing");
  await assert.rejects(router.request("config/value/write", { keyPath: "desktop.enabled-reasoning-efforts", value: ["bogus"], mergeStrategy: "replace" }), /unsupported value/);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).desktop, { "enabled-reasoning-efforts": ["low"], "show-ultra-in-model-picker-slider": true });
});

test("model list defaults follow valid private choices while native defaults remain intact otherwise", async () => {
  const { config, backend } = await fixture();
  const request = async (method: string, params: ObjectValue) => method === "model/list"
    ? { data: [{ id: "native", model: "native", isDefault: true }], nextCursor: null } : backend(method, params);
  const first = new AppServerRouter(config, request); await first.initialize();
  const second = new AppServerRouter(config, request); await second.initialize();
  assert.equal(((await first.request("model/list", {})).data as ObjectValue[])[0].isDefault, true);
  await second.request("config/value/write", { keyPath: "model", value: "claude/model", mergeStrategy: "upsert" });
  const rows = (await first.request("model/list", {})).data as ObjectValue[];
  assert.deepEqual(rows.filter(row => row.isDefault).map(row => row.model), ["claude/model"]);
  assert.equal(((await first.request("config/read", {})).config as ObjectValue).model, "claude/model");
  assert.equal(rows[0].model, "native");
});

test("provider switch refusals are application errors rather than config validation failures", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: "claude/model" });
  const before = calls.length;
  await assert.rejects(router.request("thread/settings/update", { threadId: "test", model: "native", effort: "high" }),
    error => error instanceof Error && (error as { code?: number }).code === -32002);
  assert.equal(calls.length, before);
});

async function fastFixture() {
  const f = await fixture();
  const tier = { id: "priority", name: "Fast", description: "Priority routing" };
  f.config.providers[1].modelMetadata = { "codex/model": { ...f.config.providers[1]?.modelMetadata?.["codex/model"], serviceTiers: [tier], additionalSpeedTiers: ["fast"] } };
  const router = new AppServerRouter(f.config, f.backend); await router.initialize();
  return { ...f, router, tier };
}

test("model/list advertises exact SDK service tiers while standard models have none", async () => {
  const { router, tier } = await fastFixture();
  const rows = (await router.request("model/list", {})).data as ObjectValue[];
  assert.deepEqual(rows[2].serviceTiers, [tier]); assert.deepEqual(rows[2].additionalSpeedTiers, ["fast"]); assert.equal(rows[2].defaultServiceTier, null);
  assert.deepEqual(rows[1].serviceTiers, []); assert.deepEqual(rows[1].additionalSpeedTiers, []);
  const capabilities = await router.request("modelProvider/capabilities/read", {});
  assert.deepEqual(capabilities, { status: "ok" });
});

test("private Fast preferences survive connections and preserve explicit chat request overrides", async () => {
  const { router, config, backend, calls, directory } = await fastFixture();
  await router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "codex/model", mergeStrategy: "upsert" },
    { keyPath: "service_tier", value: "fast", mergeStrategy: "upsert" },
    { keyPath: "model_reasoning_summary", value: "detailed", mergeStrategy: "upsert" },
  ] });
  const second = new AppServerRouter(config, backend); await second.initialize();
  const params = { cwd: directory, config: { trusted: true, model_reasoning_effort: "none", model_reasoning_summary: "concise" } };
  await second.request("thread/start", params);
  const started = calls.at(-1)!.params;
  assert.equal(started.serviceTier, "fast"); assert.equal(started.cwd, directory);
  assert.equal((started.config as ObjectValue).model_reasoning_effort, "none");
  assert.equal((started.config as ObjectValue).model_reasoning_summary, "concise");
  assert.equal((started.config as ObjectValue).trusted, true);
  await second.request("thread/resume", { threadId: "persisted" }); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  await second.request("thread/fork", { threadId: "persisted", serviceTier: null }); assert.equal(calls.at(-1)!.params.serviceTier, null);
  await second.request("thread/start", { model: "codex/model", serviceTier: "default" }); assert.equal(calls.at(-1)!.params.serviceTier, "default");
  await second.request("thread/start", { model: "codex/model", config: { service_tier: null } });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false); assert.equal((calls.at(-1)!.params.config as ObjectValue).service_tier, null);
  await second.request("thread/start", { model: "claude/model" }); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  await second.request("thread/start", { model: "native", serviceTier: "flex", config: { service_tier: "default" } });
  assert.equal(calls.at(-1)!.params.serviceTier, "flex"); assert.equal((calls.at(-1)!.params.config as ObjectValue).service_tier, "default");
});

test("declared gateway defaults apply only to new gateway chats and never override explicit Standard", async () => {
  const { config, backend, calls } = await fastFixture();
  config.providers[1].modelMetadata!["codex/model"].defaultServiceTier = "priority";
  const router = new AppServerRouter(config, backend); await router.initialize();
  await router.request("thread/start", { model: "codex/model" }); assert.equal(calls.at(-1)!.params.serviceTier, "priority");
  await router.request("thread/start", { model: "codex/model", serviceTier: null }); assert.equal(calls.at(-1)!.params.serviceTier, null);
  await router.request("thread/resume", { threadId: "persisted" }); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  await router.request("thread/start", { model: "native" }); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  await router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "codex/model", mergeStrategy: "upsert" }, { keyPath: "service_tier", value: "default", mergeStrategy: "upsert" },
  ] });
  await router.request("thread/start", { model: "codex/model" }); assert.equal(calls.at(-1)!.params.serviceTier, "default");
});

test("a Fast chat keeps its tier inside the chat and starts Standard only when a session opens on a row without it", async () => {
  const { router, calls } = await fastFixture();
  await router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
  // The SDK keeps the chosen tier and leaves it off a request itself, so the gateway sends no tier at all.
  for (const method of ["turn/start", "turn/settings/update", "thread/settings/update"]) {
    await router.request(method, { threadId: "test", turnId: "active", model: "claude/model" });
    assert.equal(calls.at(-1)!.method, method); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false, method);
  }
  // A session start drops the tier, as the SDK does when it builds the session.
  for (const method of ["thread/resume", "thread/fork"]) {
    await router.request(method, { threadId: "test", model: "claude/model" });
    assert.equal(calls.at(-1)!.method, method); assert.equal(calls.at(-1)!.params.serviceTier, null, method);
  }
  await router.request("thread/settings/update", { threadId: "test", model: "codex/model", serviceTier: "priority" });
  await router.request("thread/settings/update", { threadId: "test", model: "claude/model", serviceTier: "priority" });
  assert.deepEqual(calls.at(-1)!.params, { threadId: "test", model: "claude/model", serviceTier: "priority" }, "an explicit unsupported tier reaches the SDK, which accepts and keeps it");
  await router.request("thread/settings/update", { threadId: "test", model: "claude/model", serviceTier: null });
  assert.deepEqual(calls.at(-1)!.params, { threadId: "test", model: "claude/model", serviceTier: null }, "the caller's own null is forwarded, not invented");
  await appliedSettings(router, "test", "claude/model", "priority");
  await router.request("turn/start", { threadId: "test", input: [] });
  await router.request("turn/start", { threadId: "test", serviceTierForTurn: "priority", input: [] });
  assert.equal(calls.at(-1)!.params.serviceTierForTurn, "priority", "a per-turn tier passes through unchanged");
  const after = calls.length;
  await assert.rejects(router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "claude/model", mergeStrategy: "upsert" }, { keyPath: "service_tier", value: "priority", mergeStrategy: "upsert" },
  ] }), error => (error as { code: number }).code === -32002 && /does not offer that speed.*save again/.test((error as Error).message));
  assert.equal(calls.length, after);
});

test("changing the saved default model does not transfer the previous model's Fast preference", async () => {
  const { router, config, backend, calls } = await fastFixture();
  await router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "codex/model", mergeStrategy: "upsert" }, { keyPath: "service_tier", value: "priority", mergeStrategy: "upsert" },
  ] });
  const other = new AppServerRouter(config, backend); await other.initialize();
  await other.request("config/value/write", { keyPath: "model", value: "claude/model", mergeStrategy: "upsert" });
  assert.equal(Object.hasOwn((await router.request("config/read", {})).config as ObjectValue, "service_tier"), false);
  await router.request("thread/start", {}); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
});

test("an explicit standard tier for one turn overrides Fast without changing the thread's saved tier", async () => {
  const { router, calls } = await fastFixture();
  await router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
  await router.request("turn/start", { threadId: "test", model: "claude/model", serviceTierForTurn: "default", input: [] });
  assert.equal(calls.at(-1)!.params.serviceTierForTurn, "default");
  await router.request("turn/start", { threadId: "test", input: [] });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false, "the chat's Fast tier is neither cleared nor re-sent");
  await router.request("thread/settings/update", { threadId: "test", serviceTier: null });
  await appliedSettings(router, "test", "claude/model", null);
  await router.request("turn/start", { threadId: "test", input: [] });
});

test("active turn tiers remain separate from future thread settings during model switches", async () => {
  const { router, calls } = await fastFixture();
  await router.request("thread/start", { model: "codex/model" });
  await router.request("turn/start", { threadId: "test", input: [] });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: "priority" });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false, "the active turn keeps its Fast tier; the SDK leaves it off the request");
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: null });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
  await router.request("turn/start", { threadId: "test", model: "codex/model", input: [] });
  assert.equal(calls.at(-1)!.params.model, "codex/model"); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  await router.request("thread/settings/update", { threadId: "test", serviceTier: "priority" });
  await appliedSettings(router, "test", "codex/model", "priority");
  await router.request("turn/start", { threadId: "test", input: [] });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: null });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
  await router.request("turn/start", { threadId: "test", model: "claude/model", input: [] });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
});

test("one-turn Fast aliases normalize before reaching the SDK and targetUnavailable changes stay unapplied", async () => {
  const { config, backend, calls } = await fastFixture();
  let unavailable = false;
  const router = new AppServerRouter(config, (method, params) => method === "turn/settings/update" && unavailable ? Promise.resolve({ status: "targetUnavailable" }) : backend(method, params));
  await router.initialize(); await router.request("thread/start", { model: "codex/model" });
  await router.request("turn/start", { threadId: "test", serviceTierForTurn: "fast", input: [] });
  assert.equal(calls.at(-1)!.params.serviceTierForTurn, "priority");
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  unavailable = true;
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: null });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
});

test("a freshly attached gateway chat with an unread tier changes models without a tier being sent", async () => {
  const { config, backend, calls } = await fastFixture();
  const router = new AppServerRouter(config, backend); await router.initialize();
  await router.request("thread/settings/update", { threadId: "persisted", model: "claude/model" });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false, "the gateway does not know the chat's tier, so it leaves the SDK's own in place");
  await router.request("thread/settings/update", { threadId: "persisted", model: "codex/model" });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  await router.request("thread/settings/update", { threadId: "persisted", model: "claude/model", serviceTier: null });
});

test("steering an existing turn preserves its active model and temporary tier", async () => {
  const { router } = await fastFixture();
  await router.request("thread/start", { model: "codex/model" });
  await router.request("turn/start", { threadId: "test", serviceTierForTurn: "priority", input: [] });
  // The SDK returns the same turn ID while steering; only future thread settings change.
  await router.request("turn/start", { threadId: "test", serviceTierForTurn: "default", model: "claude/model", input: [] });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: null });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
});

test("loaded resume's authoritative tier takes precedence when the SDK ignores an explicit override", async () => {
  const { config, backend, calls } = await fastFixture();
  const router = new AppServerRouter(config, async (method, params) => {
    const result = await backend(method, params);
    return method === "thread/resume" ? { ...result, serviceTier: "priority" } : result;
  });
  await router.initialize();
  const resumed = await router.request("thread/resume", { threadId: "persisted", serviceTier: null });
  assert.equal(calls.at(-1)!.params.serviceTier, null); assert.equal(resumed.serviceTier, "priority");
  await router.request("turn/start", { threadId: "persisted", model: "claude/model", input: [] });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false, "the authoritative Fast tier stays on the chat; nothing clears it");
  await router.request("thread/settings/update", { threadId: "persisted", serviceTier: null });
  await appliedSettings(router, "persisted", "codex/model", null);
  await router.request("turn/start", { threadId: "persisted", model: "claude/model", input: [] });
});

test("private Fast defaults cannot replace a saved or parent chat's Standard tier on resume or fork", async () => {
  const { router, config, backend, calls } = await fastFixture();
  await router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: "codex/model", mergeStrategy: "upsert" }, { keyPath: "service_tier", value: "priority", mergeStrategy: "upsert" },
  ] });
  await router.request("thread/start", { model: "codex/model", serviceTier: null });
  await router.request("thread/settings/update", { threadId: "test", serviceTier: null });
  await appliedSettings(router, "test", "codex/model", null);
  const other = new AppServerRouter(config, backend); await other.initialize();
  for (const method of ["thread/resume", "thread/fork"]) {
    await other.request(method, { threadId: "persisted" });
    if (method === "thread/resume") assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
    else assert.equal(calls.at(-1)!.params.serviceTier, null);
    await other.request(method, { threadId: "persisted", serviceTier: "priority" });
    assert.equal(calls.at(-1)!.params.serviceTier, "priority");
    await other.request("thread/settings/update", { threadId: "persisted", serviceTier: null });
    await appliedSettings(other, "persisted", "codex/model", null);
  }
  await other.request("thread/start", {}); assert.equal(calls.at(-1)!.params.serviceTier, "priority");
});

test("gateway forks inherit the authoritative parent tier rather than private or executor defaults", async () => {
  const { router, config, backend, calls } = await fastFixture();
  await router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
  await router.request("thread/fork", { threadId: "test" }); assert.equal(calls.at(-1)!.params.serviceTier, "priority");
  await router.request("thread/fork", { threadId: "test", serviceTier: null }); assert.equal(calls.at(-1)!.params.serviceTier, null);
  await router.request("thread/settings/update", { threadId: "test", serviceTier: null });
  await appliedSettings(router, "test", "codex/model", null);
  await router.request("thread/fork", { threadId: "test" }); assert.equal(calls.at(-1)!.params.serviceTier, null);
  const other = new AppServerRouter(config, backend); await other.initialize();
  await other.request("thread/fork", { threadId: "unknown-parent" });
  assert.equal(calls.at(-1)!.method, "thread/fork"); assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false, "an unread parent tier is left to the SDK, with no error");
  await other.request("thread/fork", { threadId: "unknown-parent", model: "claude/model" });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
  await other.request("thread/fork", { threadId: "unknown-parent", config: { service_tier: "default" } });
  assert.equal(Object.hasOwn(calls.at(-1)!.params, "serviceTier"), false);
});

test("resuming a gateway chat keeps the reasoning it last ran with unless the caller changes it", async () => {
  const { router, calls } = await fixture();
  // The chat's own effort is recorded when a turn carries it, and a resume restores it
  // instead of resetting a Max chat to a default; the saved summary travels with it.
  await router.request("turn/start", { threadId: "persisted", input: [], effort: "max", summary: "detailed" });
  await router.request("thread/resume", { threadId: "persisted" });
  let config = calls.at(-1)!.params.config as ObjectValue;
  assert.equal(config.model_reasoning_effort, "max");
  assert.equal(config.model_reasoning_summary, "detailed");
  await router.request("thread/resume", { threadId: "persisted", config: { model_reasoning_effort: "high" } });
  assert.equal((calls.at(-1)!.params.config as ObjectValue).model_reasoning_effort, "high");
  // Switching models on resume still needs a level the new model supports.
  await router.request("thread/resume", { threadId: "persisted", model: "claude/model", serviceTier: null });
  assert.equal((calls.at(-1)!.params.config as ObjectValue).model_reasoning_effort, "low");
});
