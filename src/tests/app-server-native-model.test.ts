import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { ThreadReasoningStore } from "../thread-reasoning.js";
import { configureTelemetry } from "../telemetry.js";
import type { GatewayConfig } from "../config.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};

// A native chat on GPT-6.1 Sol at high effort, while the native configuration defaults to GPT-6 Astra.
const chat = { id: "chat", modelProvider: "openai", model: "gpt-6.1-sol", reasoningEffort: "high", path: "/no/rollout.jsonl" };
const configured = { model: "gpt-6-astra", modelProvider: "openai" };
const levels = ["low", "medium", "high", "xhigh"].map(effort => ({ effort }));

// The signed SDK's own rules (0.162.0-alpha.17.2, app-server thread_processor.rs). Resume restores the chat's
// persisted model, provider and effort unless has_model_resume_override: a non-null typed model or provider, or a
// `model` or `model_reasoning_effort` config key. A fork never restores them; it runs the model it names or the
// configured default. Both were confirmed with the signed SDK and a mock upstream.
function sdk(method: string, params: ObjectValue): ObjectValue {
  const config = object(params.config);
  const override = (params.model ?? null) !== null || (params.modelProvider ?? null) !== null
    || Object.hasOwn(config, "model") || Object.hasOwn(config, "model_reasoning_effort");
  if (method === "thread/resume" && !override) return { thread: { id: params.threadId }, model: chat.model, modelProvider: chat.modelProvider, reasoningEffort: chat.reasoningEffort, serviceTier: null };
  const model = typeof params.model === "string" ? params.model : typeof config.model === "string" ? config.model : configured.model;
  const thread = { id: method === "thread/fork" ? "fork" : params.threadId, ...(params.ephemeral === true ? { ephemeral: true } : {}) };
  return { thread, model, modelProvider: params.modelProvider ?? configured.modelProvider, reasoningEffort: config.model_reasoning_effort ?? null, serviceTier: null };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-native-model-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" }, modelMetadata: { "codex/model": { reasoningEfforts: ["low", "high"] } } },
  ] };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params });
    if (method === "model/list") return { data: [], nextCursor: null };
    if (method === "thread/read") return { thread: { ...chat } };
    if (method === "thread/resume" || method === "thread/fork") return sdk(method, params);
    return {};
  };
  // The chat's own record, as the adapter wrote it from the chat's last turn.
  await new ThreadReasoningStore(state, native).write("chat", { model: chat.model, effort: chat.reasoningEffort, atMs: Date.now() - 60_000 });
  const catalog = new DesktopCatalog(config, [{ slug: "gpt-6-astra", supported_reasoning_levels: levels }, { slug: "gpt-6.1-sol", supported_reasoning_levels: levels }], join(root, "desktop.json"));
  const router = new AppServerRouter(config, backend, undefined, catalog, native); await router.initialize();
  const sent = (method: string) => calls.filter(call => call.method === method).at(-1)!.params;
  return { router, sent };
}

// ChatGPT 26.1007.71326 (app.asar, webview app-shared bundle): after "Authenticated workspace changed" restarts the
// local engine, the renderer resumes each open chat with model and provider null. The provider is the Copilot
// proxy's, which the desktop app never configures. The config carries only desktop feature and app keys.
const desktopResume = { threadId: "chat", history: null, path: chat.path, model: null, modelProvider: null, cwd: "/work",
  personality: null, excludeTurns: true, config: { "apps.connector_openai_pages.tools": { "chatgpt_space.create_presentation": { enabled: false } } } };
// The main process's own resume (same bundle, .vite/build): also no model, with statsig feature keys as config.
const mainProcessResume = { threadId: "chat", history: null, path: null, model: null, modelProvider: null, cwd: null, approvalPolicy: null,
  sandbox: null, config: { "features.request_permissions_tool": true }, personality: null, excludeTurns: true };
// Its forks: "Fork into local" and "Move to worktree" name the chat's latest model and effort; a side chat names neither.
const forkBase = { threadId: "chat", path: null, cwd: "/work", runtimeWorkspaceRoots: ["/work"], threadSource: "user", excludeTurns: true };
const forkIntoLocal = { ...forkBase, model: chat.model, config: { model_reasoning_effort: "high" } };
const sideChat = { ...forkBase, config: {}, developerInstructions: "side chat", ephemeral: true };

for (const [name, shape] of [["renderer", desktopResume], ["main process", mainProcessResume]] as const) {
  test(`a native chat keeps its own model when the desktop's ${name} resumes it after an engine restart`, async () => {
    const f = await fixture();
    const result = await f.router.request("thread/resume", structuredClone(shape) as ObjectValue);
    assert.equal(result.model, "gpt-6.1-sol", "not the configured default gpt-6-astra");
    assert.equal(result.reasoningEffort, "high");
    assert.deepEqual(f.sent("thread/resume"), shape, "the adapter adds nothing, so the engine's own restore runs");
  });
}

test("a resume that names a model is forwarded byte-identical, with no effort added", async () => {
  const f = await fixture();
  // The typed model, a config model, and both together all reach the engine as sent.
  for (const shape of [{ ...desktopResume, model: chat.model }, { ...desktopResume, config: { model: chat.model } },
    { ...desktopResume, model: "gpt-6-astra", config: { model: chat.model } }, { ...desktopResume, model: chat.model, modelProvider: "openai" }]) {
    await f.router.request("thread/resume", structuredClone(shape));
    assert.deepEqual(f.sent("thread/resume"), shape);
  }
  assert.equal((await f.router.request("thread/resume", { ...desktopResume, model: chat.model })).model, "gpt-6.1-sol");
});

test("a resume that names no model receives no effort even when the engine will not restore", async () => {
  const f = await fixture();
  // A provider alone, or a null config model, blocks the engine's restore and runs the configured default.
  for (const shape of [{ ...desktopResume, modelProvider: "openai" }, { ...desktopResume, config: { model: null } }]) {
    const result = await f.router.request("thread/resume", structuredClone(shape));
    assert.deepEqual(f.sent("thread/resume"), shape);
    assert.deepEqual({ model: result.model, reasoningEffort: result.reasoningEffort }, { model: "gpt-6-astra", reasoningEffort: null }, "the native answer, without Sol's effort");
  }
});

test("a native fork that names no model reaches the engine unchanged, as the desktop's side chat sends it", async () => {
  const f = await fixture();
  const result = await f.router.request("thread/fork", structuredClone(sideChat));
  assert.deepEqual(f.sent("thread/fork"), sideChat, "the parent's effort for Sol does not ride onto the configured default model");
  assert.deepEqual({ model: result.model, reasoningEffort: result.reasoningEffort }, { model: "gpt-6-astra", reasoningEffort: null });
});

test("a native fork is forwarded byte-identical; naming the model without an effort gets the engine's own effort", async () => {
  const f = await fixture();
  assert.equal((await f.router.request("thread/fork", structuredClone(forkIntoLocal))).model, "gpt-6.1-sol");
  assert.deepEqual(f.sent("thread/fork"), forkIntoLocal, "the desktop's own effort wins");
  // The desktop sends no effort when it has none for the chat: the adapter adds none, so the engine's own effort applies.
  const named = { ...forkBase, model: chat.model };
  const result = await f.router.request("thread/fork", structuredClone(named));
  assert.deepEqual(f.sent("thread/fork"), named);
  assert.deepEqual({ model: result.model, effort: result.reasoningEffort }, { model: "gpt-6.1-sol", effort: null }, "the engine's own effort, not the adapter's saved one");
  await f.router.request("thread/fork", { ...forkBase, model: "gpt-6-astra" });
  assert.deepEqual(f.sent("thread/fork"), { ...forkBase, model: "gpt-6-astra" });
});

test("native turn and settings requests reach the engine exactly as sent", async () => {
  const f = await fixture();
  await f.router.request("thread/resume", structuredClone(desktopResume));
  const turn = { threadId: "chat", input: [{ type: "text", text: "hi" }], model: "gpt-6-astra", effort: "low", summary: "auto", serviceTier: null };
  const settings = { threadId: "chat", model: "gpt-6-astra", effort: "xhigh", config: { model_reasoning_effort: "xhigh" } };
  await f.router.request("turn/start", structuredClone(turn));
  assert.deepEqual(f.sent("turn/start"), turn);
  await f.router.request("thread/settings/update", structuredClone(settings));
  assert.deepEqual(f.sent("thread/settings/update"), settings);
  await f.router.request("turn/start", { threadId: "chat", input: [] });
  assert.deepEqual(f.sent("turn/start"), { threadId: "chat", input: [] });
});
