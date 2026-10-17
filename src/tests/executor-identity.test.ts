import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executorOverrides, gatewayExecutorMarker, gatewayProviderIds, nativeEnvironment, newChatProvider, savedChatProvider } from "../executor-identity.js";
import { gatewayEnvironment } from "../gateway-engine-home.js";
import { nativeExecutionEnvironment } from "../native-execution-host-engine.js";
import { validateConfig, type GatewayConfig } from "../config.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import { AppServerRouter } from "../app-server-router.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";

const runtime: GatewaySdkRuntime = { executable: "/sdk/gateway-codex", binarySha256: "a".repeat(64), selectedModelCompaction: true, executorIdentity: true };

test("new gateway chats keep the legacy id unless a Mac opts into the native identity and its gateway SDK serves it", () => {
  // The default: the phone reaches gateway chats through the relay, so nothing needs the native identity.
  assert.equal(newChatProvider({}, runtime), "subscription_gateway");
  assert.equal(newChatProvider({ chatIdentity: "openai" }, runtime), "openai");
  assert.equal(newChatProvider({ chatIdentity: "legacy" }, runtime), "subscription_gateway");
  // A checkout without the artifact runs a stock Codex as the executor, whose `openai` is OpenAI's own provider.
  assert.equal(newChatProvider({}, undefined), "subscription_gateway");
  assert.equal(newChatProvider({ chatIdentity: "openai" }, undefined), "subscription_gateway");
  assert.equal(newChatProvider({ chatIdentity: "openai" }, { ...runtime, executorIdentity: undefined } as unknown as GatewaySdkRuntime), "subscription_gateway");
});

test("a resumed gateway chat names the provider it was saved with; an id no executor serves falls back to the legacy one", () => {
  assert.deepEqual([...gatewayProviderIds].sort(), ["openai", "subscription_gateway"]);
  assert.equal(savedChatProvider("openai"), "openai");
  assert.equal(savedChatProvider("subscription_gateway"), "subscription_gateway");
  for (const other of [undefined, null, "", "azure", 7]) assert.equal(savedChatProvider(other), "subscription_gateway");
});

test("an executor launch registers the gateway provider, points the built-in openai at the loopback gateway and turns analytics off", () => {
  const provider = { name: "Harness Gateway", base_url: "http://127.0.0.1:3457/v1", wire_api: "responses", requires_openai_auth: false,
    supports_websockets: false, request_max_retries: 2, stream_idle_timeout_ms: 90000, "auth.command": "/bin/gateway", "auth.args": ["token"] };
  assert.deepEqual(executorOverrides("openai", provider), {
    model_provider: "openai", "analytics.enabled": false, "shell_environment_policy.set.HARNESS_GATEWAY_EXECUTOR": "0", openai_base_url: "http://127.0.0.1:3457/v1",
    "model_providers.subscription_gateway.name": "Harness Gateway", "model_providers.subscription_gateway.base_url": "http://127.0.0.1:3457/v1",
    "model_providers.subscription_gateway.wire_api": "responses", "model_providers.subscription_gateway.requires_openai_auth": false,
    "model_providers.subscription_gateway.supports_websockets": false, "model_providers.subscription_gateway.request_max_retries": 2,
    "model_providers.subscription_gateway.stream_idle_timeout_ms": 90000, "model_providers.subscription_gateway.auth.command": "/bin/gateway",
    "model_providers.subscription_gateway.auth.args": ["token"],
  });
  // The legacy identity keeps the same registration and the same guards; only the default for new chats differs.
  const legacy = executorOverrides("subscription_gateway", provider);
  assert.equal(legacy.model_provider, "subscription_gateway"); assert.equal(legacy["analytics.enabled"], false);
  assert.equal(legacy.openai_base_url, "http://127.0.0.1:3457/v1");
  // Without a provider base URL (tests, fixtures) nothing points the built-in provider anywhere.
  assert.deepEqual(executorOverrides("openai", {}), { model_provider: "openai", "analytics.enabled": false, "shell_environment_policy.set.HARNESS_GATEWAY_EXECUTOR": "0" });
});

test("gateway executors carry the marker and native engines never do", () => {
  const prior = process.env[gatewayExecutorMarker];
  try {
    delete process.env[gatewayExecutorMarker];
    const env = gatewayEnvironment("/state/desktop-engine");
    assert.equal(env[gatewayExecutorMarker], "1"); assert.equal(env.CODEX_HOME, "/state/desktop-engine");
    assert.equal(process.env[gatewayExecutorMarker], undefined, "the adapter's own environment is not changed");
    assert.equal(nativeEnvironment(), process.env, "an unmarked environment is passed as it is");
    // An adapter started from inside a gateway chat inherits the marker; its native engine must not.
    process.env[gatewayExecutorMarker] = "1";
    const native = nativeEnvironment();
    assert.equal(Object.hasOwn(native, gatewayExecutorMarker), false); assert.equal(process.env[gatewayExecutorMarker], "1");
    assert.equal(native.PATH, process.env.PATH);
    // The shared native host builds its engine's environment the same way.
    const shared = nativeExecutionEnvironment("/native-home", true);
    assert.equal(Object.hasOwn(shared, gatewayExecutorMarker), false); assert.equal(shared.CODEX_HOME, "/native-home");
  } finally { if (prior === undefined) delete process.env[gatewayExecutorMarker]; else process.env[gatewayExecutorMarker] = prior; }
});

test("chatIdentity is optional, openai or legacy, and kept by validation", () => {
  const base = { version: 1, port: 1, stateDirectory: "/tmp/state", providers: [], clientOnly: true };
  assert.equal(Object.hasOwn(validateConfig({ ...base, port: 3457 }, "/tmp"), "chatIdentity"), false);
  assert.equal(validateConfig({ ...base, port: 3457, chatIdentity: "legacy" }, "/tmp").chatIdentity, "legacy");
  assert.equal(validateConfig({ ...base, port: 3457, chatIdentity: "openai" }, "/tmp").chatIdentity, "openai");
  for (const chatIdentity of ["native", "", true, null]) assert.throws(() => validateConfig({ ...base, port: 3457, chatIdentity }, "/tmp"), /chatIdentity must be openai or legacy/);
});

type ObjectValue = Record<string, unknown>;
async function listRouter(nativeProvider?: string) {
  const root = await mkdtemp(join(tmpdir(), "gateway-list-")); const nativeHome = join(root, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: join(root, "state"), providers: [
    { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { "codex/sol": "sol" } }] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "config/read") return { config: nativeProvider === undefined ? { model: "gpt-native" } : { model: "gpt-native", model_provider: nativeProvider } };
    if (method === "thread/list") return { data: [], nextCursor: null };
    return {};
  };
  const router = new AppServerRouter(config, backend, undefined, undefined, nativeHome);
  await router.initialize();
  const listed = async (params: ObjectValue) => { await router.request("thread/list", structuredClone(params)); return calls.filter(call => call.method === "thread/list").at(-1)!.params; };
  return { listed, calls, router, clean: () => rm(root, { recursive: true, force: true }) };
}

test("a chat list that asks only for the native default provider also lists the gateway's legacy chats; every other list is sent as it was", async () => {
  const f = await listRouter();
  try {
    const both = ["openai", "subscription_gateway"];
    // No filter means the engine's default provider, which is the native identity.
    assert.deepEqual(await f.listed({ limit: 50 }), { limit: 50, modelProviders: both });
    assert.deepEqual(await f.listed({ limit: 50, modelProviders: null, cursor: "c1" }), { limit: 50, modelProviders: both, cursor: "c1" });
    assert.deepEqual(await f.listed({ modelProviders: ["openai"], archived: false }), { modelProviders: both, archived: false });
    // An empty list already means every provider; a chosen set, another provider or a relation filter is the caller's choice.
    for (const params of [{ modelProviders: [] }, { modelProviders: ["openai", "ollama"] }, { modelProviders: ["subscription_gateway"] }, { modelProviders: ["ollama"] },
      { parentThreadId: "parent" }, { ancestorThreadId: "root", modelProviders: null }, { modelProviders: "openai" }, { modelProviders: [7] }]) {
      assert.deepEqual(await f.listed(params), params, JSON.stringify(params));
    }
    // A parent filter together with the default provider named explicitly still asks for that provider only.
    assert.deepEqual(await f.listed({ parentThreadId: "parent", modelProviders: ["openai"] }), { parentThreadId: "parent", modelProviders: both });
  } finally { await f.clean(); }
});

test("the native default provider is read once per connection, and again after a configuration write", async () => {
  const f = await listRouter();
  try {
    for (let page = 0; page < 3; page++) await f.listed({ limit: 10 });
    assert.equal(f.calls.filter(call => call.method === "config/read").length, 1);
    await f.router.request("config/value/write", { keyPath: "model_provider", value: "openai", mergeStrategy: "upsert" });
    await f.listed({ limit: 10 });
    assert.equal(f.calls.filter(call => call.method === "config/read").length, 2);
  } finally { await f.clean(); }
});

test("the native default provider comes from the engine's configuration", async () => {
  const azure = await listRouter("azure");
  try {
    assert.deepEqual(await azure.listed({}), { modelProviders: ["azure", "subscription_gateway"] });
    assert.deepEqual(await azure.listed({ modelProviders: ["openai"] }), { modelProviders: ["openai"] }, "openai is not this engine's default");
  } finally { await azure.clean(); }
});

test("the router accepts a new gateway chat recorded with either gateway id and refuses an answer from an engine that ignored the request", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-new-chat-")); const nativeHome = join(root, "native"); await mkdir(nativeHome, { mode: 0o700 });
  try {
    const config: GatewayConfig = { version: 1, port: 1, stateDirectory: join(root, "state"), providers: [
      { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { "codex/sol": "sol" } }] };
    let answer = "openai"; let created = 0;
    const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
      if (method === "thread/start") { const thread = { id: `chat-${++created}`, model: params.model, modelProvider: answer }; return { thread, model: params.model, modelProvider: answer, serviceTier: null }; }
      return {};
    };
    const router = new AppServerRouter(config, backend, undefined, undefined, nativeHome); await router.initialize();
    // The backends record the router's request for a gateway chat with the connection's identity.
    const started = await router.request("thread/start", { model: "codex/sol" });
    assert.equal(started.modelProvider, "openai");
    assert.deepEqual(router.describeThread("chat-1"), { provider: "gateway", model: "codex/sol", identity: "openai" });
    answer = "subscription_gateway"; await router.request("thread/start", { model: "codex/sol" });
    assert.deepEqual(router.describeThread("chat-2"), { provider: "gateway", model: "codex/sol", identity: "legacy" });
    answer = "azure";
    await assert.rejects(router.request("thread/start", { model: "codex/sol" }), /did not apply the requested gateway provider/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the router routes a native-model sub-agent to the gateway through ancestors it reads, with no registry entry or two levels deep", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-ancestors-")); const nativeHome = join(root, "native"); await mkdir(nativeHome, { mode: 0o700 });
  try {
    const config: GatewayConfig = { version: 1, port: 1, stateDirectory: join(root, "state"), providers: [
      { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { "codex/sol": "sol" } }] };
    const spawned = (parent: string, depth: number) => ({ subAgent: { thread_spawn: { parent_thread_id: parent, depth } } });
    const saved = new Map<string, ObjectValue>([
      ["lost-parent", { id: "lost-parent", model: "codex/sol", modelProvider: "openai" }],
      ["lost-sub-agent", { id: "lost-sub-agent", model: "gpt-6.1-sol", modelProvider: "openai", source: spawned("lost-parent", 1) }],
      ["root-chat", { id: "root-chat", model: "gpt-6.1-sol", modelProvider: "openai" }],
      ["middle-agent", { id: "middle-agent", model: "gpt-6.1-sol", modelProvider: "openai", source: spawned("root-chat", 1) }],
      ["deep-agent", { id: "deep-agent", model: "gpt-6.1-sol", modelProvider: "openai", source: spawned("middle-agent", 2) }],
      ["native-parent", { id: "native-parent", model: "gpt-6.1-sol", modelProvider: "openai" }],
      ["native-sub-agent", { id: "native-sub-agent", model: "gpt-6.1-sol", modelProvider: "openai", source: spawned("native-parent", 1) }],
    ]);
    const reads: string[] = [];
    const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
      if (method === "thread/read") { reads.push(String(params.threadId)); const thread = saved.get(String(params.threadId));
        if (!thread) throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 }); return { thread: { ...thread } }; }
      if (method === "turn/start") return { turn: { id: `turn-${reads.length}` } };
      return {};
    };
    await new GatewayChatRegistry(config.stateDirectory, nativeHome).record("root-chat", "start");
    const router = new AppServerRouter(config, backend, undefined, undefined, nativeHome); await router.initialize();
    for (const id of ["lost-sub-agent", "deep-agent", "native-sub-agent"]) await router.request("turn/start", { threadId: id, input: [] });
    assert.deepEqual(["lost-sub-agent", "deep-agent", "native-sub-agent"].map(id => router.describeThread(id).provider), ["gateway", "gateway", "native"]);
    // Each chat is read once: the routed chat by its probe, an ancestor by the walk, and the registered root never.
    assert.deepEqual(reads, ["lost-sub-agent", "lost-parent", "deep-agent", "middle-agent", "native-sub-agent", "native-parent"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
