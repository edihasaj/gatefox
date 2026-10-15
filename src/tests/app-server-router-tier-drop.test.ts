import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

type ObjectValue = Record<string, unknown>;
type Ran = { model: string; tier: string | null };
const gateway = "subscription_gateway";
const claude = "claude/model"; const codex = "codex/model";
let clock = Date.now();

/**
 * The backend models the pinned SDK: a session start drops a tier the model lacks, a running chat keeps the
 * tier it was given (any string is accepted, null clears to Standard), and a request carries the kept tier only
 * while the model offers it. It announces each accepted change the way the SDK does.
 */
async function fixture(readModel = claude) {
  const state = await mkdtemp(join(tmpdir(), "gateway-tier-drop-"));
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { [claude]: "model" }, modelMetadata: { [claude]: { reasoningEfforts: ["low", "high"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "unused", models: { [codex]: "model" },
      modelMetadata: { [codex]: { serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }] } } },
    { id: "turbo", type: "codex-subscription", label: "Turbo", credentialFile: "unused", models: { "turbo/model": "turbo-model" },
      modelMetadata: { "turbo/model": { serviceTiers: [{ id: "turbo", name: "Turbo", description: "Turbo routing" }] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const ran: Ran[] = []; const sdk = { model: readModel, tier: undefined as unknown };
  const control = { fail: false };
  const offers = (model: string, tier: unknown) => (model === codex && (tier === "priority" || tier === "fast")) || (model === "turbo/model" && tier === "turbo");
  const normal = (tier: unknown) => tier === "fast" ? "priority" : tier;
  let router: AppServerRouter;
  const announce = () => router.observeNotification({ emittedAtMs: clock = Math.max(clock + 1, Date.now()), method: "thread/settings/updated",
    params: { threadId: "t", threadSettings: { modelProvider: gateway, model: sdk.model, serviceTier: sdk.tier ?? null } } });
  const applyTier = (params: ObjectValue) => { if (Object.hasOwn(params, "serviceTier")) sdk.tier = normal(params.serviceTier); };
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    if (control.fail && method !== "thread/read") throw new Error("sdk rejected the request");
    const tier = Object.hasOwn(params, "serviceTier") ? params.serviceTier : (params.config as ObjectValue | undefined)?.service_tier;
    if (tier !== undefined && tier !== null && typeof tier !== "string") throw new Error("invalid params: serviceTier");
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (method === "thread/read") return { thread: { id: "t", modelProvider: gateway, model: readModel } };
    if (["thread/start", "thread/resume", "thread/fork"].includes(method)) {
      sdk.model = String(params.model);
      sdk.tier = tier === undefined || tier === null || offers(sdk.model, tier) ? normal(tier) ?? null : null;
      return { thread: { id: "t" }, modelProvider: params.modelProvider, model: params.model, serviceTier: sdk.tier };
    }
    if (method === "turn/start" || method === "thread/settings/update") {
      if (typeof params.model === "string") sdk.model = params.model;
      applyTier(params);
      if (method === "thread/settings/update") { await announce(); return { status: "queued" }; }
      const turnTier = normal(params.serviceTierForTurn ?? sdk.tier);
      ran.push({ model: sdk.model, tier: offers(sdk.model, turnTier) ? String(turnTier) : null });
      await announce(); return { turn: { id: "u" } };
    }
    return { status: "applied" };
  };
  router = new AppServerRouter(config, backend); await router.initialize();
  const recorded = async (name: string) => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === name); };
  const events = async () => (await recorded("service_tier_dropped")).map(event => Object.fromEntries(Object.entries(event).filter(([key]) => !["at", "host", "component", "pid"].includes(key))));
  // The mid-chat reset event no longer exists; asserting it stays absent keeps it from coming back.
  const resets = () => recorded("service_tier_reset");
  const last = () => calls.at(-1)!;
  return { router, calls, ran, events, resets, config, backend, last, control };
}
const dropped = (method: string, model: string, tier: string) => ({ event: "service_tier_dropped", method, model, tier });
const noTier = (params: ObjectValue) => !Object.hasOwn(params, "serviceTier");

test("a new chat on a row without Fast starts as Standard when the desktop sends its sticky Fast pick", async () => {
  const { router, last, events } = await fixture();
  await router.request("thread/start", { model: claude, serviceTier: "priority", cwd: "/work" });
  assert.equal(last().params.serviceTier, null);
  assert.deepEqual(await events(), [dropped("thread/start", claude, "priority")]);
});

test("a row that offers Fast keeps priority and records nothing", async () => {
  const { router, last, events } = await fixture();
  await router.request("thread/start", { model: codex, serviceTier: "priority" });
  assert.equal(last().params.serviceTier, "priority");
  assert.deepEqual(await events(), []);
});

test("a saved Fast default for a row that no longer offers it starts the chat as Standard", async () => {
  const f = await fixture();
  await f.router.request("config/batchWrite", { edits: [
    { keyPath: "model", value: codex, mergeStrategy: "upsert" }, { keyPath: "service_tier", value: "priority", mergeStrategy: "upsert" },
  ] });
  // The catalog changed after the default was saved.
  delete f.config.providers[1].modelMetadata![codex].serviceTiers;
  const later = new AppServerRouter(f.config, f.backend); await later.initialize();
  for (const params of [{}, { model: codex }]) {
    await later.request("thread/start", params);
    assert.equal(f.last().method, "thread/start"); assert.equal(f.last().params.serviceTier, null, JSON.stringify(params));
  }
  assert.deepEqual(await f.events(), [dropped("thread/start", codex, "priority"), dropped("thread/start", codex, "priority")]);
});

test("a tier sent only in config.service_tier is dropped to Standard at session start", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: claude, config: { service_tier: "priority", trusted: true } });
  assert.equal(f.last().params.serviceTier, null); assert.equal(Object.hasOwn(f.last().params.config as ObjectValue, "service_tier"), false);
  assert.equal((f.last().params.config as ObjectValue).trusted, true);
  for (const method of ["thread/resume", "thread/fork"]) {
    await f.router.request(method, { threadId: "t", model: claude, config: { service_tier: "priority" } });
    assert.equal(f.last().method, method); assert.equal(f.last().params.serviceTier, null, method);
    assert.equal(Object.hasOwn(f.last().params.config as ObjectValue, "service_tier"), false, method);
  }
  assert.deepEqual(await f.events(), ["thread/start", "thread/resume", "thread/fork"].map(method => dropped(method, claude, "priority")));
});

test("resume and fork drop an unsupported explicit tier to Standard instead of rejecting it", async () => {
  const { router, last, events } = await fixture();
  for (const method of ["thread/resume", "thread/fork"]) {
    await router.request(method, { threadId: "t", model: claude, serviceTier: "priority" });
    assert.equal(last().method, method); assert.equal(last().params.serviceTier, null, method);
  }
  assert.deepEqual(await events(), [dropped("thread/resume", claude, "priority"), dropped("thread/fork", claude, "priority")]);
});

test("a tier the chat inherits and the opened row lacks starts Standard at session start", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
  await f.router.request("thread/fork", { threadId: "t", model: claude });
  assert.equal(f.last().params.serviceTier, null); assert.equal(f.last().params.model, claude);
  assert.deepEqual(await f.events(), [dropped("thread/fork", claude, "priority")]);
});

test("a chat whose own row stopped offering its tier resumes as Standard", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
  // The catalog changed under the chat: its own row is still selected, but advertises no tiers.
  delete f.config.providers[1].modelMetadata![codex].serviceTiers;
  const later = new AppServerRouter(f.config, f.backend); await later.initialize();
  await later.request("thread/resume", { threadId: "t" });
  assert.equal(f.last().params.serviceTier, null); assert.equal(f.last().params.model, codex, "the chat keeps its own row");
  assert.deepEqual(await f.events(), [dropped("thread/resume", codex, "priority")]);
});

test("a parent or chat tier the gateway never read is forwarded with no tier and no error", async () => {
  for (const model of [claude, codex]) {
    for (const method of ["thread/resume", "thread/fork"]) {
      const { router, last, events } = await fixture(codex);
      await router.request(method, { threadId: "t", model });
      assert.equal(last().method, method); assert.ok(noTier(last().params), `${method} ${model}`);
      assert.deepEqual(await events(), []);
    }
  }
});

test("the gateway never clears or sets a tier inside a running chat and never fails over one", async () => {
  const { router, last, events, resets } = await fixture(codex);
  // The chat's tier was never read, and every row is a target: nothing is sent and nothing is thrown.
  for (const method of ["turn/start", "thread/settings/update", "turn/settings/update"]) {
    for (const model of [claude, codex]) {
      await router.request(method, { threadId: "t", turnId: "u", model });
      assert.equal(last().method, method); assert.deepEqual(last().params, { threadId: "t", turnId: "u", model }, `${method} ${model}`);
    }
  }
  assert.deepEqual(await events(), []); assert.deepEqual(await resets(), []);
});

test("an explicit or per-turn tier the row lacks reaches the SDK unchanged inside a chat", async () => {
  const { router, last, events, resets } = await fixture();
  await router.request("thread/start", { model: claude });
  for (const [method, sent] of [
    ["turn/start", { threadId: "t", serviceTier: "priority", model: claude, input: [] }],
    ["turn/start", { threadId: "t", serviceTierForTurn: "priority", input: [] }],
    ["thread/settings/update", { threadId: "t", model: claude, serviceTier: "priority" }],
    ["turn/settings/update", { threadId: "t", turnId: "u", model: claude, serviceTier: "priority" }],
    ["turn/start", { threadId: "t", serviceTier: "made-up", input: [] }],
  ] as Array<[string, ObjectValue]>) {
    await router.request(method, sent);
    assert.equal(last().method, method); assert.deepEqual(last().params, sent, method);
  }
  assert.deepEqual(await events(), []); assert.deepEqual(await resets(), []);
});

test("a Fast chat run on a Claude row and then on a Fast row runs Fast again, as native Codex does", async () => {
  for (const change of ["turn/start", "thread/settings/update"]) {
    const f = await fixture();
    await f.router.request("thread/start", { model: codex, serviceTier: "priority" });
    await f.router.request("turn/start", { threadId: "t", input: [] });
    const turn = async (model: string) => {
      if (change === "turn/start") await f.router.request("turn/start", { threadId: "t", model, input: [] });
      else { await f.router.request("thread/settings/update", { threadId: "t", model }); await f.router.request("turn/start", { threadId: "t", input: [] }); }
    };
    await turn(claude); await turn(codex);
    assert.deepEqual(f.ran, [{ model: codex, tier: "priority" }, { model: claude, tier: null }, { model: codex, tier: "priority" }], change);
    for (const call of f.calls.filter(call => ["turn/start", "thread/settings/update"].includes(call.method))) assert.notEqual(call.params.serviceTier, null, change);
    assert.deepEqual(await f.events(), []); assert.deepEqual(await f.resets(), []);
    // A new connection reads the same chat from the notification the SDK sent, still carrying Fast.
    const later = new AppServerRouter(f.config, f.backend); await later.initialize();
    await later.request("turn/start", { threadId: "t", model: claude, input: [] }); await later.request("turn/start", { threadId: "t", model: codex, input: [] });
    assert.deepEqual(f.ran.at(-1), { model: codex, tier: "priority" }, change);
  }
});

test("a tier chosen on a Claude row stays the chat's tier for the next Fast row", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: codex, serviceTier: null });
  await f.router.request("turn/start", { threadId: "t", model: claude, serviceTier: "priority", input: [] });
  assert.equal(f.last().params.serviceTier, "priority", "the explicit tier is forwarded, not replaced by null");
  await f.router.request("turn/start", { threadId: "t", model: codex, input: [] });
  assert.ok(noTier(f.last().params));
  assert.deepEqual(f.ran, [{ model: claude, tier: null }, { model: codex, tier: "priority" }]);
  await f.router.request("thread/fork", { threadId: "t", model: codex });
  assert.equal(f.last().params.serviceTier, "priority", "the gateway's own record of the chat matches what the SDK was sent");
});

test("a one-turn tier is stored as the turn's tier and never becomes the chat's", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: codex, serviceTier: null });
  await f.router.request("turn/start", { threadId: "t", model: claude, serviceTierForTurn: "priority", input: [] });
  assert.equal(f.last().params.serviceTierForTurn, "priority", "an unsupported per-turn tier is not omitted");
  await f.router.request("turn/settings/update", { threadId: "t", turnId: "u", model: codex });
  assert.ok(noTier(f.last().params));
  await f.router.request("thread/fork", { threadId: "t", model: codex });
  assert.equal(f.last().params.serviceTier, null, "the one-turn Fast did not change the chat's tier");
  assert.deepEqual(await f.events(), []);
});

test("a wrongly typed tier is passed to the SDK unchanged and the SDK answers it", async () => {
  for (const value of [5, true, { id: "priority" }, ["priority"]]) {
    const f = await fixture();
    await f.router.request("thread/start", { model: claude });
    await assert.rejects(f.router.request("thread/start", { model: codex, serviceTier: value }), /invalid params/);
    assert.deepEqual(f.last().params.serviceTier, value, "thread/start");
    await assert.rejects(f.router.request("thread/start", { model: claude, config: { service_tier: value } }), /invalid params/);
    assert.deepEqual((f.last().params.config as ObjectValue).service_tier, value, "config.service_tier");
    assert.ok(noTier(f.last().params));
    for (const method of ["thread/resume", "thread/fork", "turn/start", "thread/settings/update"]) {
      await assert.rejects(f.router.request(method, { threadId: "t", model: claude, serviceTier: value }), /invalid params/);
      assert.equal(f.last().method, method); assert.deepEqual(f.last().params.serviceTier, value, method);
    }
    assert.deepEqual(await f.events(), []);
  }
});

test("tier telemetry logs only known tier ids and carries exactly the model, tier and method", async () => {
  const { router, events } = await fixture();
  const cases: Array<[string, string]> = [["priority", "priority"], ["fast", "fast"], ["flex", "flex"], ["turbo", "turbo"], ["sk-live-secret-1234", "other"], ["PRIORITY", "other"], ["", "other"], ["a b/c", "other"]];
  for (const [tier] of cases) await router.request("thread/start", { model: claude, serviceTier: tier });
  await router.request("thread/start", { model: claude, serviceTier: "default" });
  assert.deepEqual(await events(), cases.map(([, logged]) => dropped("thread/start", claude, logged)));
});

test("a drop is recorded only after the SDK accepted the request", async () => {
  const f = await fixture();
  f.control.fail = true;
  await assert.rejects(f.router.request("thread/start", { model: claude, serviceTier: "priority" }), /sdk rejected/);
  await assert.rejects(f.router.request("thread/resume", { threadId: "t", model: claude, serviceTier: "priority" }), /sdk rejected/);
  assert.deepEqual(await f.events(), []);
  f.control.fail = false;
  await f.router.request("thread/start", { model: claude, serviceTier: "priority" });
  assert.deepEqual(await f.events(), [dropped("thread/start", claude, "priority")]);
});

test("a per-turn field on a session start is not a tier the gateway interprets", async () => {
  const { router, last, events } = await fixture();
  await router.request("thread/resume", { threadId: "t", model: claude, serviceTierForTurn: "priority" });
  assert.equal(last().params.serviceTierForTurn, "priority");
  assert.deepEqual(await events(), []);
});
