import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { deferReason } from "../app-server-step-promotion.js";
import { CompactionRecoveryError } from "../compaction-recovery.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;
const activeModel = (router: AppServerRouter) => (router as unknown as { activeTurns: Map<string, { route: { model?: string } }> }).activeTurns.get("test")?.route.model;

interface Options { enabled?: boolean; threadStatus?: string; reject?: unknown; turnStatus?: string }

async function fixture(options: Options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-step-promotion-"));
  const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: directory, ...(options.enabled === false ? {} : { midTurnModelSwitch: true }), providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/model": "model" }, modelMetadata: { "claude/model": { reasoningEfforts: ["low"] } } },
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model", "codex/other": "other" }, modelMetadata: { "codex/model": { reasoningEfforts: ["low"] }, "codex/other": { reasoningEfforts: ["low"] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [{ id: "native", model: "native", displayName: "Native", hidden: false }], nextCursor: null };
    if (method === "config/read") return { config: { model: "native", model_provider: "openai" }, origins: {}, layers: null };
    if (method === "thread/start") return { thread: { id: "test" }, modelProvider: params.modelProvider || "openai", model: params.model || "native", serviceTier: null };
    if (method === "turn/start") return { turn: { id: "active" } };
    if (method === "turn/settings/update") { if (options.reject) throw options.reject; return { status: options.turnStatus ?? "applied" }; }
    if (method === "thread/settings/update") return { status: options.threadStatus ?? "applied" };
    return { status: "ok" };
  };
  const router = new AppServerRouter(config, backend); await router.initialize();
  await router.request("thread/start", { model: "codex/model" }); await router.request("turn/start", { threadId: "test", input: [] });
  calls.length = 0;
  return { router, calls, methods: () => calls.map(call => call.method) };
}

test("off by default: a picker change during a turn reaches only the next turn", async () => {
  const { router, methods } = await fixture({ enabled: false });
  assert.equal((await router.request("thread/settings/update", { threadId: "test", model: "claude/model" })).status, "applied");
  assert.deepEqual(methods(), ["thread/settings/update"]);
  assert.equal(activeModel(router), "codex/model");
});

test("enabled: the picker change is sent after the thread update to the running turn and recorded once applied", async () => {
  const { router, calls, methods } = await fixture();
  assert.equal((await router.request("thread/settings/update", { threadId: "test", model: "claude/model" })).status, "applied");
  assert.deepEqual(methods(), ["thread/settings/update", "turn/settings/update"], "the next turn is settled first, then the running turn is offered the change");
  assert.deepEqual(calls[1].params, { threadId: "test", turnId: "active", model: "claude/model" }, "only the model, with the running turn's id");
  assert.equal(activeModel(router), "claude/model");
});

test("an SDK refusal or an unapplied answer keeps the turn's model and never fails the picker change", async () => {
  const sdk = Object.assign(new Error("Cannot switch models mid-turn"), { code: -32600 });
  for (const options of [{ reject: sdk }, { reject: new CompactionRecoveryError("switch", "Switch back") }, { reject: new Error("lost") }, { turnStatus: "targetUnavailable" }]) {
    const { router, methods } = await fixture(options);
    assert.equal((await router.request("thread/settings/update", { threadId: "test", model: "claude/model" })).status, "applied");
    assert.deepEqual(methods(), ["thread/settings/update", "turn/settings/update"]);
    assert.equal(activeModel(router), "codex/model");
  }
});

test("nothing is offered without a running turn, a different model, an applied thread update or a gateway model", async () => {
  const finished = await fixture();
  await finished.router.observeNotification({ method: "turn/completed", params: { threadId: "test", turn: { id: "active" } } });
  await finished.router.request("thread/settings/update", { threadId: "test", model: "claude/model" });
  assert.deepEqual(finished.methods(), ["thread/settings/update"], "an idle chat needs no promotion");
  const same = await fixture();
  await same.router.request("thread/settings/update", { threadId: "test", model: "codex/model", effort: "low" });
  assert.deepEqual(same.methods(), ["thread/settings/update"], "the turn already runs on that model");
  const refused = await fixture({ threadStatus: "targetUnavailable" });
  await refused.router.request("thread/settings/update", { threadId: "test", model: "claude/model" });
  assert.deepEqual(refused.methods(), ["thread/settings/update"], "a thread update the SDK did not apply is not promoted");
  const effort = await fixture();
  await effort.router.request("thread/settings/update", { threadId: "test", effort: "low" });
  assert.deepEqual(effort.methods(), ["thread/settings/update"], "a change without a model is not promoted");
});

test("deferral reasons name the guard that refused", () => {
  assert.equal(deferReason(new CompactionRecoveryError("switch", "x")), "context");
  assert.equal(deferReason(Object.assign(new Error("x"), { code: -32600 })), "review_group");
  assert.equal(deferReason(new CompactionRecoveryError("busy")), "error");
  assert.equal(deferReason(undefined), "error");
});
