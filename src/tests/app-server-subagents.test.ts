import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { modelCatalog } from "../catalog.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";
import type { GatewayConfig } from "../config.js";

type Value = Record<string, unknown>;
const alias = "codex/sol";
const nativeChild = "gpt-6.1-sol";
const otherNative = "gpt-6.1-max";
const parent = (parentThreadId: string) => ({ source: { subAgent: { thread_spawn: { parent_thread_id: parentThreadId, depth: 1 } } } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-subagents-"));
  const stateDirectory = join(root, "state"); const nativeHome = join(root, "native");
  await mkdir(nativeHome, { recursive: true, mode: 0o700 });
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory, providers: [
    { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { [alias]: "sol" } },
  ] };
  const saved = new Map<string, Value>([
    ["gateway-parent", { id: "gateway-parent", modelProvider: "openai", model: alias }],
    ["legacy-child", { id: "legacy-child", modelProvider: "subscription_gateway", model: nativeChild, ...parent("gateway-parent") }],
    ["openai-child", { id: "openai-child", modelProvider: "openai", model: nativeChild, ...parent("gateway-parent") }],
    ["gateway-native-without-parent", { id: "gateway-native-without-parent", modelProvider: "subscription_gateway", model: nativeChild }],
  ]);
  await new GatewayChatRegistry(stateDirectory, nativeHome).record("gateway-parent", "start");
  await new GatewayChatRegistry(stateDirectory, nativeHome).record("gateway-native-without-parent", "start");
  const calls: Array<{ method: string; params: Value }> = [];
  const backend = async (method: string, params: Value): Promise<Value> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "thread/read") return { thread: structuredClone(saved.get(String(params.threadId))!) };
    if (method === "thread/resume") {
      const thread = saved.get(String(params.threadId))!;
      // Real resume replies may omit source, so this proves the router retains only
      // metadata it learned from the saved record, never fields the caller supplied.
      return { thread: { id: thread.id, modelProvider: thread.modelProvider, model: thread.model }, modelProvider: thread.modelProvider, model: thread.model };
    }
    if (method === "turn/start") return { turn: { id: "turn" } };
    if (method.endsWith("/settings/update")) return { status: "applied" };
    return {};
  };
  const source = { isNative: (model: string) => [nativeChild, otherNative].includes(model), nativeSlugs: new Set([nativeChild, otherNative]),
    refresh: async () => ({ models: modelCatalog(config).models }) } as unknown as DesktopCatalog;
  const router = new AppServerRouter(config, backend, undefined, source, nativeHome); await router.initialize();
  return { router, calls, sent: (method: string) => calls.filter(call => call.method === method).at(-1)!.params };
}

test("saved native-model gateway sub-agents resume on their owning executor without rewriting caller settings", async () => {
  const f = await fixture();
  for (const [threadId, provider] of [["legacy-child", "subscription_gateway"], ["openai-child", "openai"]] as const) {
    const implicit = { threadId, model: null, modelProvider: null, config: { caller: "kept" }, effort: "high", permissions: { mode: "full" } };
    const first = await f.router.request("thread/resume", structuredClone(implicit));
    assert.deepEqual(f.sent("thread/resume"), { ...implicit, config: { caller: "kept", web_search: "disabled" } },
      `${threadId}: only the gateway transport restriction is added`);
    assert.deepEqual({ provider: first.modelProvider, model: first.model }, { provider, model: nativeChild });
    const explicit = { threadId, model: nativeChild, modelProvider: null, config: { caller: "kept" }, effort: "low", permissions: { mode: "read" } };
    const second = await f.router.request("thread/resume", structuredClone(explicit));
    assert.deepEqual(f.sent("thread/resume"), { ...explicit, modelProvider: provider, config: { caller: "kept", web_search: "disabled" } },
      `${threadId}: exact saved native model keeps its provider and caller settings`);
    assert.deepEqual({ provider: second.modelProvider, model: second.model }, { provider, model: nativeChild });
    await f.router.request("thread/resume", { threadId });
    assert.deepEqual(f.sent("thread/resume"), { threadId, config: { web_search: "disabled" } }, `${threadId}: metadata survives a reply that omits source`);
    const turn = { threadId, model: nativeChild, input: [], effort: "high" };
    await f.router.request("turn/start", structuredClone(turn)); assert.deepEqual(f.sent("turn/start"), turn);
    const settings = { threadId, model: nativeChild, effort: "low" };
    await f.router.request("thread/settings/update", structuredClone(settings)); assert.deepEqual(f.sent("thread/settings/update"), settings);
  }
});

test("only the saved child native model is allowed on a gateway route", async () => {
  const f = await fixture();
  await f.router.request("thread/resume", { threadId: "legacy-child" });
  for (const model of [otherNative]) {
    await assert.rejects(f.router.request("thread/resume", { threadId: "legacy-child", model }), (error: Error & { code?: number }) =>
      error.code === -32002 && /cannot change a loaded chat/.test(error.message));
  }
  await assert.rejects(f.router.request("thread/resume", { threadId: "legacy-child", model: nativeChild, modelProvider: "openai" }), (error: Error & { code?: number }) =>
    error.code === -32002 && /cannot change a loaded chat/.test(error.message));
  await assert.rejects(f.router.request("thread/resume", { threadId: "legacy-child", model: "missing/alias" }), /absent from both/);
  await assert.rejects(f.router.request("thread/resume", { threadId: "gateway-native-without-parent", model: null, modelProvider: null }), /needs a currently configured model alias/);
});
