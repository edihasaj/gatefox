import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import type { GatewayConfig } from "../config.js";
import { identityTest } from "./identity-cases.js";

let gateway = "subscription_gateway";
const test = identityTest(identity => { gateway = identity.provider; });
type ObjectValue = Record<string, unknown>;

async function resume(saved: string, connections: string[]) {
  const state = await mkdtemp(join(tmpdir(), "gateway-retired-alias-"));
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: connections.map(id => (
    { id, type: "codex-subscription", label: id, credentialFile: "unused", models: { [`${id}/model`]: "model" } })) };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "thread/read") return { thread: { id: "t", modelProvider: gateway, model: saved } };
    if (method === "thread/resume") return { thread: { id: "t" }, modelProvider: params.modelProvider, model: params.model };
    return { status: "applied" };
  };
  const router = new AppServerRouter(config, backend, undefined, undefined, join(state, "native-home"));
  await router.initialize();
  await router.request("thread/resume", { threadId: "t" });
  return calls.at(-1)!;
}

test("a chat saved under a renamed connection resumes on the primary replacement", async () => {
  const call = await resume("claude/model", ["claude-primary", "claude-secondary"]);
  assert.equal(call.method, "thread/resume");
  assert.equal(call.params.model, "claude-primary/model");
});

test("a chat saved under a renamed connection resumes on its only replacement", async () => {
  const call = await resume("claude/model", ["claude-work"]);
  assert.equal(call.params.model, "claude-work/model");
});

test("an offered alias resumes unchanged", async () => {
  const call = await resume("claude-secondary/model", ["claude-primary", "claude-secondary"]);
  assert.equal(call.params.model, "claude-secondary/model");
});
