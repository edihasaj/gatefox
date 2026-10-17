import assert from "node:assert/strict";
import nodeTest from "node:test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { EngineHint } from "../chat-identity.js";
import { modelCatalog } from "../catalog.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";
import { ThreadReasoningStore } from "../thread-reasoning.js";
import { ThreadServiceTiers } from "../thread-service-tiers.js";
import { TurnTelemetry } from "../turn-telemetry.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { GatewayConfig } from "../config.js";
import { identityTest, legacyProvider, type GatewayIdentityCase } from "./identity-cases.js";

type ObjectValue = Record<string, unknown>;
type Call = { method: string; params: ObjectValue; hint?: EngineHint };
const sol = "codex/sol"; const opus = "claude/opus"; const native = "gpt-native"; const nativeSol = "gpt-6.1-sol";
const prediction = (threadId: string) => ({ threadId, experimentalPredictionMode: true, ephemeral: true, excludeTurns: true, threadSource: "composer_predictions" });
// The desktop's resume after an engine restart: no model and no provider, so the SDK restores the chat's own.
const desktopResume = (threadId: string) => ({ threadId, history: null, path: null, model: null, modelProvider: null, cwd: "/work", personality: null, excludeTurns: true });

let identity: GatewayIdentityCase = { name: "legacy", provider: legacyProvider };
const test = identityTest(selected => { identity = selected; });

/**
 * A backend that answers like the signed SDK: a resume or fork with no model override restores the saved chat, one with an
 * override applies it, and every saved chat lives in one table, as rollouts and SQLite do. Saved gateway chats carry the
 * identity under test; whatever the router sends is what the engine applies.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-router-identity-"));
  const state = join(root, "state"); const nativeHome = join(root, "native"); await mkdir(nativeHome, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { [sol]: "sol" },
      modelMetadata: { [sol]: { reasoningEfforts: ["low", "high"], serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }] } } },
    { id: "claude", type: "claude-subscription", label: "Claude", models: { [opus]: "opus" }, modelMetadata: { [opus]: { reasoningEfforts: ["low", "high"] } } },
  ] };
  const saved = new Map<string, ObjectValue>([
    ["gw", { id: "gw", modelProvider: identity.provider, model: sol }],
    // A gateway chat on a native slug is only known by its registry entry; its sub-agent by that parent.
    ["gw-native-slug", { id: "gw-native-slug", modelProvider: identity.provider, model: nativeSol }],
    ["gw-sub", { id: "gw-sub", modelProvider: identity.provider, model: nativeSol, source: { subAgent: { thread_spawn: { parent_thread_id: "gw-native-slug", depth: 1 } } } }],
    ["nat", { id: "nat", modelProvider: "openai", model: native }],
  ]);
  const calls: Call[] = []; let created = 0;
  // When set, the next thread/start is answered with exactly this thread, whatever the request said.
  const next: { thread?: ObjectValue } = {};
  const backend = async (method: string, params: ObjectValue, hint?: EngineHint): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params), ...(hint ? { hint } : {}) });
    const config = (params.config ?? {}) as ObjectValue;
    if (method === "model/list") return { data: [{ id: native, model: native }], nextCursor: null };
    if (method === "thread/read") {
      const thread = saved.get(String(params.threadId));
      if (!thread) throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 });
      return { thread: { ...thread } };
    }
    if (method === "thread/start" && next.thread) {
      const thread = next.thread; next.thread = undefined; saved.set(String(thread.id), thread);
      return { thread, model: thread.model, modelProvider: thread.modelProvider, serviceTier: null, reasoningEffort: null };
    }
    if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
      const parent = saved.get(String(params.threadId)) ?? {};
      const override = method === "thread/start" || (params.model ?? null) !== null || (params.modelProvider ?? null) !== null || Object.hasOwn(config, "model");
      const model = override ? params.model ?? config.model ?? native : parent.model;
      const thread = { id: method === "thread/resume" ? params.threadId : `${method === "thread/start" ? "started" : "fork"}-${++created}`,
        modelProvider: override ? params.modelProvider ?? (method === "thread/fork" ? parent.modelProvider : "openai") : parent.modelProvider, model,
        ...(params.ephemeral === true ? { ephemeral: true } : {}) };
      if (method !== "thread/resume" && params.ephemeral !== true) saved.set(String(thread.id), thread);
      return { thread, model: thread.model, modelProvider: thread.modelProvider, serviceTier: params.serviceTier ?? null, reasoningEffort: config.model_reasoning_effort ?? null };
    }
    if (method === "turn/start") return { turn: { id: `turn-${++created}` } };
    if (method.endsWith("/settings/update")) return { status: "applied" };
    return {};
  };
  // The adapter knows the native catalog, so a native slug outranks any alias spelled the same.
  const source = { isNative: (model: string) => [native, nativeSol].includes(model), nativeSlugs: new Set([native, nativeSol]),
    refresh: async () => ({ models: modelCatalog(config).models }) } as unknown as DesktopCatalog;
  await new GatewayChatRegistry(state, nativeHome).record("gw-native-slug", "start");
  const connect = async () => { const router = new AppServerRouter(config, backend, undefined, source, nativeHome); await router.initialize(); return router; };
  const router = await connect();
  const sent = (method: string) => calls.filter(call => call.method === method).at(-1)!;
  const events = async (name: string) => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === name); };
  return { root, state, nativeHome, config, calls, router, connect, sent, events, next,
    tiers: new ThreadServiceTiers(state, nativeHome), reasoning: new ThreadReasoningStore(state, nativeHome) };
}
let stamp = Date.now();
const settingsUpdated = (threadId: string, threadSettings: ObjectValue) => ({ method: "thread/settings/updated", emittedAtMs: stamp = Math.max(stamp + 1, Date.now()), params: { threadId, threadSettings } });

nodeTest("a new chat's engine is the router's hint: an alias or the gateway's own provider id is the gateway, \"openai\" never is", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: sol, modelProvider: "openai" });
  assert.deepEqual(f.sent("thread/start").hint, { engine: "gateway" });
  assert.equal(f.sent("thread/start").params.modelProvider, legacyProvider, "the router asks for a gateway chat; the backends record it with the connection's identity");
  const nativeStart = { model: native, modelProvider: "openai", config: { trusted: true } };
  await f.router.request("thread/start", structuredClone(nativeStart));
  assert.deepEqual(f.sent("thread/start"), { method: "thread/start", params: nativeStart, hint: { engine: "native" } });
  await f.router.request("thread/start", { modelProvider: legacyProvider });
  assert.deepEqual(f.sent("thread/start").hint, { engine: "gateway" }, "a caller that names the gateway provider keeps getting it");
  await f.router.request("thread/start", {});
  assert.deepEqual(f.sent("thread/start").hint, { engine: "native" });
  // Only thread/start carries a hint; every other request follows the chat.
  await f.router.request("turn/start", { threadId: "nat", input: [] });
  assert.equal(f.sent("turn/start").hint, undefined);
});

test("the desktop's resume with no model restores a saved gateway chat on the gateway and leaves a native one byte-for-byte", async () => {
  const f = await fixture();
  const resumed = await f.router.request("thread/resume", desktopResume("gw"));
  const forwarded = f.sent("thread/resume").params;
  assert.deepEqual({ provider: forwarded.modelProvider, model: forwarded.model, answered: resumed.model }, { provider: identity.provider, model: sol, answered: sol },
    "the resume names the provider the chat was saved with, so neither its rollout nor its SQLite row is rewritten");
  assert.equal(f.router.describeThread("gw").provider, "gateway");
  // A gateway chat saved on a native slug is still the gateway's; no gateway row serves that slug, so its resume is refused
  // with the gateway's own message instead of running on the native engine.
  await assert.rejects(f.router.request("thread/resume", desktopResume("gw-native-slug")), /needs a currently configured model alias/);
  assert.equal(f.router.describeThread("gw-native-slug").provider, "gateway");
  assert.equal(f.calls.filter(call => call.method === "thread/resume").length, 1);
  const nativeResume = desktopResume("nat");
  await f.router.request("thread/resume", structuredClone(nativeResume));
  assert.deepEqual(f.sent("thread/resume"), { method: "thread/resume", params: nativeResume }, "nothing added, not even a hint");
  assert.equal(f.router.describeThread("nat").provider, "native");
});

test("a new chat keeps the engine the router sent it to when the reply classifies differently", async () => {
  const f = await fixture();
  // Sent to the native engine (a native model, the native provider id), but the reply names the gateway's own provider id.
  // The router chose the engine, so the chat stays native: it is never written to the gateway's tier or reasoning stores.
  f.next.thread = { id: "disagreeing", modelProvider: legacyProvider, model: native };
  await f.router.request("thread/start", { model: native, modelProvider: "openai", effort: "high" });
  assert.deepEqual(f.sent("thread/start").hint, { engine: "native" });
  assert.deepEqual(f.router.describeThread("disagreeing"), { provider: "native", model: native });
  assert.equal(await f.tiers.read("disagreeing"), undefined); assert.equal(await f.reasoning.read("disagreeing"), undefined);
  await f.router.request("turn/start", { threadId: "disagreeing", input: [], effort: "low" });
  assert.equal(f.sent("turn/start").hint, undefined);
  assert.equal(f.router.describeThread("disagreeing").provider, "native", "the remembered route still decides");
});

test("forks follow their chat: a gateway fork gets the gateway's request, a native or prediction fork reaches the engine as sent", async () => {
  const f = await fixture();
  await f.router.request("thread/resume", { threadId: "gw" });
  const fork = await f.router.request("thread/fork", { threadId: "gw" });
  assert.equal(f.sent("thread/fork").params.modelProvider, legacyProvider);
  assert.equal(f.sent("thread/fork").params.model, sol);
  assert.equal(f.router.describeThread(String((fork.thread as ObjectValue).id)).provider, "gateway");
  const predicted = await f.router.request("thread/fork", prediction("gw"));
  assert.deepEqual(f.sent("thread/fork").params, prediction("gw"), "a prediction fork carries no override");
  assert.equal(f.router.describeThread(String((predicted.thread as ObjectValue).id)).provider, "gateway", "the throwaway fork stays with its gateway parent");
  const nativeFork = { threadId: "nat", path: null, cwd: "/work", excludeTurns: true, config: {} };
  const forked = await f.router.request("thread/fork", structuredClone(nativeFork));
  assert.deepEqual(f.sent("thread/fork").params, nativeFork);
  assert.equal(f.router.describeThread(String((forked.thread as ObjectValue).id)).provider, "native");
  const nativePrediction = await f.router.request("thread/fork", prediction("nat"));
  assert.deepEqual(f.sent("thread/fork").params, prediction("nat"));
  assert.equal(f.router.describeThread(String((nativePrediction.thread as ObjectValue).id)).provider, "native");
});

test("turns and settings updates reach the engine as sent, and switching a chat across engines is refused", async () => {
  const f = await fixture();
  const switched = /cannot change a loaded chat between native and gateway providers/;
  for (const [threadId, model, other] of [["gw", opus, native], ["gw-sub", undefined, native], ["nat", native, sol]] as const) {
    const turn = { threadId, input: [{ type: "text", text: "hi" }], ...(model ? { model } : {}), effort: "low" };
    await f.router.request("turn/start", structuredClone(turn));
    assert.deepEqual(f.sent("turn/start").params, turn, threadId);
    const settings = { threadId, ...(model ? { model } : {}), effort: "high" };
    await f.router.request("thread/settings/update", structuredClone(settings));
    assert.deepEqual(f.sent("thread/settings/update").params, settings, threadId);
    const count = f.calls.length;
    for (const method of ["turn/start", "thread/settings/update", "turn/settings/update", "thread/resume"]) {
      await assert.rejects(f.router.request(method, { threadId, turnId: "turn-1", model: other, input: [] }), (error: Error & { code?: number }) => switched.test(error.message) && error.code === -32002, `${threadId} ${method}`);
    }
    assert.equal(f.calls.length, count, "a refused switch reaches no engine");
  }
  assert.equal(f.router.describeThread("gw-sub").provider, "gateway", "a sub-agent of a gateway chat is a gateway chat");
});

test("the tier and reasoning stores are written for gateway chats only", async () => {
  const f = await fixture();
  await f.router.request("thread/resume", { threadId: "gw", serviceTier: "priority" });
  await f.router.request("turn/start", { threadId: "gw", input: [], effort: "high" });
  await f.router.observeNotification(settingsUpdated("gw", { modelProvider: identity.provider, model: sol, serviceTier: "priority", effort: "high" }), "gateway");
  const tier = await f.tiers.read("gw");
  assert.deepEqual({ model: tier?.model, serviceTier: tier?.serviceTier }, { model: sol, serviceTier: "priority" });
  assert.equal((await f.reasoning.read("gw"))?.effort, "high");
  await f.router.request("thread/resume", { threadId: "nat", serviceTier: "priority" });
  await f.router.request("turn/start", { threadId: "nat", input: [], effort: "high" });
  await f.router.observeNotification(settingsUpdated("nat", { modelProvider: "openai", model: native, serviceTier: "priority", effort: "high" }), "native");
  assert.equal(await f.tiers.read("nat"), undefined); assert.equal(await f.reasoning.read("nat"), undefined);
  // The emitting engine decides for a chat this connection never routed: the native identity is still the gateway's from a gateway engine.
  await f.router.observeNotification(settingsUpdated("unseen-gateway", { modelProvider: "openai", model: sol, serviceTier: null, effort: "low" }), "gateway");
  assert.equal((await f.tiers.read("unseen-gateway"))?.model, sol);
  await f.router.observeNotification(settingsUpdated("unseen-native", { modelProvider: legacyProvider, model: sol, serviceTier: null, effort: "low" }), "native");
  assert.equal(await f.tiers.read("unseen-native"), undefined, "a native engine's chat is never written, whatever its settings say");
  assert.equal(await f.reasoning.read("unseen-native"), undefined);
});

test("a chat classified without a provider id is described by kind, with the saved identity for gateway chats", async () => {
  const f = await fixture();
  for (const id of ["gw", "gw-native-slug", "gw-sub", "nat"]) await f.router.request("turn/start", { threadId: id, input: [] });
  const gatewayIdentity = identity.name === "legacy" ? "legacy" : "openai";
  assert.deepEqual(f.router.describeThread("gw"), { provider: "gateway", model: sol, identity: gatewayIdentity });
  assert.deepEqual(f.router.describeThread("gw-native-slug"), { provider: "gateway", model: nativeSol, identity: gatewayIdentity });
  assert.deepEqual(f.router.describeThread("gw-sub"), { provider: "gateway", model: nativeSol, identity: gatewayIdentity });
  assert.deepEqual(f.router.describeThread("nat"), { provider: "native", model: native });
  // Turn records carry the identity; native turns have none.
  const turns = new TurnTelemetry(threadId => f.router.describeThread(threadId));
  turns.observe({ method: "turn/started", params: { threadId: "gw", turn: { id: "t1" } } });
  turns.observe({ method: "turn/started", params: { threadId: "nat", turn: { id: "t2" } } });
  turns.close();
  const started = await f.events("turn_started");
  assert.equal(started.find(event => event.threadId === "gw")?.identity, gatewayIdentity);
  assert.equal(Object.hasOwn(started.find(event => event.threadId === "nat")!, "identity"), false);
});

test("gateway_chat_classified names only the rule and the method, once per chat per connection", async () => {
  const f = await fixture();
  for (const id of ["gw", "gw-native-slug", "gw-sub", "nat"]) await f.router.request("turn/start", { threadId: id, input: [] });
  await f.router.request("turn/start", { threadId: "nat", input: [] });
  const rules = (events: Awaited<ReturnType<typeof f.events>>) => events.map(event => event.rule).sort();
  const expected = identity.name === "legacy" ? ["legacy_provider", "legacy_provider", "legacy_provider", "native"] : ["alias", "native", "parent", "registry"];
  const first = await f.events("gateway_chat_classified");
  assert.deepEqual(rules(first), [...expected].sort());
  for (const event of first) {
    assert.equal(event.method, "turn/start");
    assert.deepEqual(Object.keys(event).sort(), ["at", "component", "event", "host", "method", "pid", "rule"], "no id, model or provider");
  }
  // Another connection classifies the same chats again, once each.
  const second = await f.connect();
  await second.request("thread/resume", { threadId: "nat" });
  const after = await f.events("gateway_chat_classified");
  assert.equal(after.length, first.length + 1);
  assert.deepEqual({ rule: after.at(-1)!.rule, method: after.at(-1)!.method }, { rule: "native", method: "thread/resume" });
});

nodeTest("an alias that equals a native slug is refused once the native catalog is known", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-alias-collision-"));
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: join(root, "state"), providers: [
    { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { [nativeSol]: "sol" } }] };
  assert.throws(() => new DesktopCatalog(config, [{ slug: nativeSol }], join(root, "desktop.json")), /collides with a native model ID/);
  // A scoped alias, or one that names no native slug, is accepted.
  for (const alias of ["codex/gpt-6.1-sol", "claude-sonnet-4-6"]) {
    assert.doesNotThrow(() => new DesktopCatalog({ ...config, providers: [{ ...config.providers[0], models: { [alias]: "sol" } }] }, [{ slug: nativeSol }], join(root, "desktop.json")));
  }
  assert.deepEqual(await readdir(root), [], "validation writes nothing");
});
