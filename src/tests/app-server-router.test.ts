import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

type ObjectValue = Record<string, unknown>;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-app-server-"));
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low", "high"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (method === "thread/start") return { thread: { id: "test" }, modelProvider: params.modelProvider || "openai", model: params.model || "native" };
    if (method === "thread/read") return { thread: { id: "persisted", modelProvider: "subscription_gateway", model: "codex/model" } };
    if (method === "thread/resume") return { thread: { id: "persisted" }, modelProvider: params.modelProvider, model: params.model };
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
  assert.equal(forwarded.modelProvider, "subscription_gateway");
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
  assert.equal(calls.at(-1)!.params.modelProvider, "subscription_gateway");
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
  await router.request("thread/settings/update", params);
  assert.deepEqual(calls.at(-1)!.params, params);
  await router.request("thread/resume", { threadId: "test" });
  assert.equal(calls.at(-1)!.params.model, "codex/model");
  await assert.rejects(router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "native" }), /Start a new chat/);
});

test("steering and goal operations retain their active-turn and authorization fields", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: "claude/model" });
  const steer = { threadId: "test", expectedTurnId: "active", input: [{ type: "text", text: "changed direction" }], clientUserMessageId: "client-message" };
  await router.request("turn/steer", steer); assert.deepEqual(calls.at(-1)!.params, steer);
  const goal = { threadId: "test", objective: "fixture objective", status: "paused", origin: "user", tokenBudget: 10000 };
  await router.request("thread/goal/set", goal); assert.deepEqual(calls.at(-1)!.params, goal);
});

test("desktop config overrides select the gateway before its first turn", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: null, modelProvider: "openai", config: { model: "claude/model" } });
  assert.equal(calls.at(-1)!.params.modelProvider, "subscription_gateway");
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
  assert.equal(calls.at(-1)!.params.modelProvider, "subscription_gateway");
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


test("native model choices are saved separately and all other native config writes are blocked", async () => {
  const { router, calls, directory } = await fixture();
  await router.request("config/batchWrite", { edits: [{ keyPath: "model", value: "native", mergeStrategy: "upsert" }, { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "upsert" }] });
  assert.equal(calls.length, 0);
  assert.equal(JSON.parse(await readFile(join(directory, "desktop-preferences.json"), "utf8")).model, "native");
  await router.request("thread/start", {});
  assert.equal(calls.at(-1)!.params.model, "native");
  assert.equal((calls.at(-1)!.params.config as ObjectValue).model_reasoning_effort, "high");
  const count = calls.length;
  await assert.rejects(router.request("config/value/write", { keyPath: "sandbox_mode", value: "danger-full-access", mergeStrategy: "upsert" }), /managed separately/);
  assert.equal(calls.length, count);
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
