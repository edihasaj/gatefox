import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;
// The SDK (core/src/session/step_activation.rs check_legacy_model_safety) rejects an active-turn model switch between rows whose
// node_repl or review settings differ, and app-server maps that to JSON-RPC -32600 with its own reason. The router forwards it unchanged.
const reason = "Cannot switch models mid-turn: the destination has different node_repl or auto review settings";
const rejection = () => Object.assign(new Error(reason), { code: -32600 });

/** The model the router records for the chat's active turn. */
const activeModel = (router: AppServerRouter) => (router as unknown as { activeTurns: Map<string, { route: { model?: string } }> }).activeTurns.get("test")?.route.model;

async function fixture(reject: (method: string, params: ObjectValue) => boolean, switched: ObjectValue = { status: "applied" }) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-step-switch-"));
  const tier = { id: "priority", name: "Fast", description: "Priority routing" };
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" }, modelMetadata: { "codex/model": { reasoningEfforts: ["low"], serviceTiers: [tier] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (reject(method, params)) throw rejection();
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (method === "thread/start") return { thread: { id: "test" }, modelProvider: params.modelProvider || "openai", model: params.model || "native", serviceTier: params.serviceTier ?? null };
    if (method === "turn/start") return { turn: { id: "active" } };
    if (method === "turn/settings/update") return params.model ? switched : { status: "applied" };
    if (method === "thread/settings/update") return { status: "queued" };
    return { status: "ok" };
  };
  const router = new AppServerRouter(config, backend); await router.initialize();
  await router.request("thread/start", { model: "codex/model" }); await router.request("turn/start", { threadId: "test", input: [] });
  return { router, calls };
}

test("a rejected active-turn model switch reaches the client with the SDK's code and reason, and the turn keeps its model", async () => {
  const { router, calls } = await fixture((method, params) => method === "turn/settings/update" && params.model === "claude/model");
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: null });
  await assert.rejects(router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" }), error => {
    assert.equal((error as { code?: number }).code, -32600); assert.equal((error as Error).message, reason); return true;
  });
  assert.equal(calls.at(-1)!.method, "turn/settings/update", "the request reached the SDK, which gave the answer");
  assert.equal(activeModel(router), "codex/model", "the refused switch is not recorded: the turn keeps codex/model");
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: "priority" });
  assert.equal(calls.at(-1)!.params.serviceTier, "priority");
});

test("an applied active-turn model switch is recorded for the active turn", async () => {
  const { router, calls } = await fixture(() => false);
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: null });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" });
  assert.equal(activeModel(router), "claude/model");
  // Mid-chat tiers pass through like native Codex: the SDK keeps the choice and applies it only where the model offers it.
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: "priority" });
  assert.equal(calls.at(-1)!.params.serviceTier, "priority");
});

test("thread settings updates, which change the next turn, are never checked for the active turn and still forward", async () => {
  const { router, calls } = await fixture((method, params) => method === "turn/settings/update" && params.model === "claude/model");
  const result = await router.request("thread/settings/update", { threadId: "test", model: "claude/model", serviceTier: null });
  assert.equal(result.status, "queued");
  const sent = calls.at(-1)!; assert.equal(sent.method, "thread/settings/update"); assert.equal(sent.params.model, "claude/model");
});

test("a model switch the SDK answers without applying it is not recorded either", async () => {
  const { router } = await fixture(() => false, { status: "targetUnavailable" });
  await router.request("turn/settings/update", { threadId: "test", turnId: "active", serviceTier: null });
  assert.equal((await router.request("turn/settings/update", { threadId: "test", turnId: "active", model: "claude/model" })).status, "targetUnavailable");
  assert.equal(activeModel(router), "codex/model", "an unapplied switch is not recorded");
});
