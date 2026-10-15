import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

type ObjectValue = Record<string, unknown>;

async function fixture() {
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
    if (method === "thread/read") return { thread: { id: "t", modelProvider: "subscription_gateway", model: "claude/model" } };
    if (method === "thread/resume" || method === "thread/fork") return { thread: { id: "t" }, modelProvider: params.modelProvider, model: params.model, serviceTier: params.serviceTier ?? null };
    if (method === "turn/start") return { turn: { id: "u" } };
    return { status: "ok" };
  };
  const router = new AppServerRouter(config, backend); await router.initialize();
  const events = async () => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === "service_tier_dropped"); };
  return { router, calls, events };
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
