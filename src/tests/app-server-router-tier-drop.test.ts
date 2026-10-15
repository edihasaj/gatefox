import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

type ObjectValue = Record<string, unknown>;

async function fixture(readModel = "claude/model") {
  const state = await mkdtemp(join(tmpdir(), "gateway-tier-drop-"));
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low", "high"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "unused", models: { "codex/model": "model" },
      modelMetadata: { "codex/model": { serviceTiers: [{ id: "priority", name: "Fast", description: "Priority routing" }] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (method === "thread/start") return { thread: { id: "t" }, modelProvider: params.modelProvider, model: params.model, serviceTier: params.serviceTier ?? null };
    if (method === "thread/read") return { thread: { id: "t", modelProvider: "subscription_gateway", model: readModel } };
    if (method === "thread/resume" || method === "thread/fork") return { thread: { id: "t" }, modelProvider: params.modelProvider, model: params.model, serviceTier: params.serviceTier ?? null };
    if (method === "turn/start") return { turn: { id: "u" } };
    return { status: "ok" };
  };
  const router = new AppServerRouter(config, backend); await router.initialize();
  const recorded = async (name: string) => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === name); };
  const events = () => recorded("service_tier_dropped");
  const resets = () => recorded("service_tier_reset");
  return { router, calls, events, resets, config, backend };
}

test("a new chat on a row without Fast starts as Standard when the desktop sends its sticky Fast pick", async () => {
  const { router, calls, events } = await fixture();
  await router.request("thread/start", { model: "claude/model", serviceTier: "priority", cwd: "/work" });
  assert.equal(calls.at(-1)!.params.serviceTier, null);
  const [event] = await events();
  assert.equal(event.model, "claude/model"); assert.equal(event.tier, "priority"); assert.equal(event.method, "thread/start");
  assert.deepEqual(Object.keys(event).filter(key => !["at", "host", "component", "pid"].includes(key)).sort(), ["event", "method", "model", "tier"]);
});

test("the first turn on a row without Fast runs as Standard", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/start", { model: "claude/model" });
  await router.request("turn/start", { threadId: "t", serviceTier: "priority", input: [] });
  assert.equal(calls.at(-1)!.method, "turn/start"); assert.equal(calls.at(-1)!.params.serviceTier, null);
});

test("a row that offers Fast keeps priority and records nothing", async () => {
  const { router, calls, events } = await fixture();
  await router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
  assert.equal(calls.at(-1)!.params.serviceTier, "priority");
  assert.deepEqual(await events(), []);
});

test("resume, fork and settings updates drop an unsupported explicit tier instead of rejecting it", async () => {
  const { router, calls, events } = await fixture();
  for (const method of ["thread/resume", "thread/fork", "thread/settings/update"]) {
    await router.request(method, { threadId: "t", model: "claude/model", serviceTier: "priority" });
    assert.equal(calls.at(-1)!.method, method); assert.equal(calls.at(-1)!.params.serviceTier, null, method);
  }
  assert.equal((await events()).length, 3);
});

test("a stale peer's turn start runs a Fast chat as Standard instead of failing it", async () => {
  const { router, calls, events, resets } = await fixture();
  await router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
  await router.request("turn/start", { threadId: "t", model: "claude/model", input: [] });
  assert.equal(calls.at(-1)!.params.serviceTier, null);
  const [event] = await resets();
  assert.equal(event.from, "priority"); assert.equal(event.model, "claude/model"); assert.equal(event.method, "turn/start");
  assert.deepEqual(await events(), [], "nothing was explicitly requested, so this is a reset rather than a drop");
});

test("a same-model chat whose row stopped offering Fast resumes and turns as Standard", async () => {
  const f = await fixture();
  await f.router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
  // The catalog changed under the chat: the row is still selected, but it advertises no tiers.
  delete f.config.providers[1].modelMetadata!["codex/model"].serviceTiers;
  const stale = new AppServerRouter(f.config, f.backend); await stale.initialize();
  await stale.request("turn/start", { threadId: "t", input: [] });
  assert.equal(f.calls.at(-1)!.method, "turn/start"); assert.equal(f.calls.at(-1)!.params.serviceTier, null);
  await stale.request("thread/resume", { threadId: "t" });
  assert.equal(f.calls.at(-1)!.method, "thread/resume"); assert.equal(f.calls.at(-1)!.params.serviceTier, null);
  assert.equal(f.calls.at(-1)!.params.model, "codex/model", "the chat keeps its own row");
  assert.equal((await f.resets()).length, 2);
});

test("forking a Fast chat into a model without Fast opens it as Standard", async () => {
  const { router, calls, resets } = await fixture();
  await router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
  await router.request("thread/fork", { threadId: "t", model: "claude/model" });
  assert.equal(calls.at(-1)!.params.serviceTier, null); assert.equal(calls.at(-1)!.params.model, "claude/model");
  assert.equal((await resets()).length, 1);
});

test("an unread tier switching to a row with no speed options needs no explicit choice", async () => {
  const { router, calls } = await fixture("codex/model");
  await router.request("turn/start", { threadId: "t", model: "claude/model", input: [] });
  assert.equal(calls.at(-1)!.method, "turn/start"); assert.equal(calls.at(-1)!.params.serviceTier, null);
});

test("an unread tier still needs an explicit choice before a row that offers Fast", async () => {
  const { router, calls } = await fixture();
  await assert.rejects(router.request("turn/start", { threadId: "t", model: "codex/model", input: [] }),
    error => (error as { code: number }).code === -32002);
  assert.equal(calls.some(call => call.method === "turn/start"), false, "the turn is not forwarded when the target row could have carried the tier");
});

test("every routed method resets a Fast chat's tier to Standard and records it when the selected row lacks Fast", async () => {
  for (const method of ["turn/start", "turn/settings/update", "thread/settings/update", "thread/resume", "thread/fork"]) {
    const { router, calls, resets } = await fixture();
    await router.request("thread/start", { model: "codex/model", serviceTier: "priority" });
    await router.request(method, { threadId: "t", model: "claude/model" });
    assert.equal(calls.at(-1)!.method, method); assert.equal(calls.at(-1)!.params.serviceTier, null, method);
    const [event] = await resets();
    assert.equal(event.method, method); assert.equal(event.from, "priority"); assert.equal(event.model, "claude/model");
  }
});

test("forking a chat with an unknown tier into a row without speed options opens it as Standard", async () => {
  const { router, calls } = await fixture();
  await router.request("thread/fork", { threadId: "t", model: "claude/model" });
  assert.equal(calls.at(-1)!.method, "thread/fork"); assert.equal(calls.at(-1)!.params.serviceTier, null);
});

test("forking a chat with an unknown tier into a row that offers Fast still needs an explicit choice", async () => {
  const { router, calls } = await fixture();
  await assert.rejects(router.request("thread/fork", { threadId: "t", model: "codex/model" }), error => (error as { code: number }).code === -32002);
  assert.equal(calls.some(call => call.method === "thread/fork"), false);
});
