import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { AppServerBackends } from "../app-server-backends.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import type { GatewayConfig } from "../config.js";
import type { Message } from "../app-server-connection.js";

// Signed SDK 0.162.0-alpha.17.2, legacy history, a started chat that was never sent a
// message and is no longer loaded: thread/read says "thread not loaded", while the
// request's own answer is an empty list, a notLoaded unsubscribe, or "no rollout found".
const id = "01a1d000-0000-7000-8000-000000000001";
const absent = (message: string) => Object.assign(new Error(message), { code: -32600 });
const sdk = async (method: string): Promise<Message> => {
  if (method === "thread/read") throw absent(`thread not loaded: ${id}`);
  if (method === "thread/attachment/list") return { data: [], nextCursor: null };
  if (method === "thread/unsubscribe") return { status: "notLoaded" };
  if (method === "thread/resume" || method === "thread/delete" || method === "thread/archive") throw absent(`no rollout found for thread id ${id}`);
  return {};
};
const config = async (): Promise<GatewayConfig> => ({ version: 1, port: 3457, stateDirectory: await mkdtemp(join(tmpdir(), "gw-absent-")),
  providers: [{ id: "claude", type: "claude-subscription", models: { "claude/model": "model" } }] });

test("router returns the SDK's own resume answer for a chat no SDK knows", async () => {
  const calls: string[] = [];
  const router = new AppServerRouter(await config(), async (method, params) => { calls.push(method); return sdk(method); });
  await router.initialize();
  await assert.rejects(router.request("thread/resume", { threadId: id }), { code: -32600, message: `no rollout found for thread id ${id}` });
  assert.deepEqual(calls, ["thread/read", "thread/resume"]);
});

test("router still fails closed when the provider probe fails for another reason", async () => {
  const router = new AppServerRouter(await config(), async method => { if (method === "thread/read") throw Object.assign(new Error("Shared executor host connection was lost"), { code: -32001 }); return {}; });
  await router.initialize();
  await assert.rejects(router.request("thread/resume", { threadId: id }), { code: -32001 });
});

test("backends answer an unbound unknown chat the way the native SDK does", async () => {
  const native = { closed: false, exited: new Promise<never>(() => {}), drained: Promise.resolve(), ready: Promise.resolve(),
    request: (method: string) => sdk(method), send() {}, stop() {} };
  const backends = new AppServerBackends("codex", ["app-server"], await config(), {}, {}, {} as DesktopCatalog, async () => {}, () => {}, undefined, () => native);
  assert.deepEqual(await backends.request("thread/attachment/list", { threadId: id }), { data: [], nextCursor: null });
  assert.deepEqual(await backends.request("thread/unsubscribe", { threadId: id }), { status: "notLoaded" });
  await assert.rejects(backends.request("thread/delete", { threadId: id }), { message: `no rollout found for thread id ${id}` });
  await assert.rejects(backends.request("thread/archive", { threadId: id }), { message: `no rollout found for thread id ${id}` });
});
