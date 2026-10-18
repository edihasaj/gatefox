import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppServerBackends } from "../app-server-backends.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { GatewayChatRegistry } from "../gateway-chat-registry.js";
import { shimFiles } from "./shim-fixture.js";

const alias = "claude/model";
const nativeChild = "gpt-6.1-sol";
const otherNative = "gpt-6.1-max";

test("the owning gateway executor accepts only its saved child native model", { timeout: 20_000 }, async () => {
  const f = await shimFiles({ serve: false });
  const priorHome = process.env.CODEX_HOME; process.env.CODEX_HOME = f.nativeHome;
  let backend: AppServerBackends | undefined;
  try {
    // The fixture's two SDK processes share the saved-thread store, as the actual
    // native and executor SDKs do through Codex's rollout state.
    const script = await readFile(f.backend, "utf8");
    await writeFile(f.backend, script.replace(/const home=.*?;\nconst readThread/, `const home=${JSON.stringify(f.nativeHome)};\nconst readThread`), { mode: 0o700 });
    const sessions = join(f.nativeHome, "sessions"); await mkdir(sessions, { recursive: true });
    const parent = { id: "parent", modelProvider: "openai", model: alias };
    const child = { id: "child", modelProvider: "subscription_gateway", model: nativeChild,
      source: { subAgent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } } };
    await writeFile(join(sessions, "parent.json"), JSON.stringify(parent));
    await writeFile(join(sessions, "child.json"), JSON.stringify(child));
    await new GatewayChatRegistry(f.value.stateDirectory, f.nativeHome).record("parent", "start");
    const catalog = new DesktopCatalog(f.value, [{ slug: nativeChild }, { slug: otherNative }], join(f.directory, "desktop.json"));
    backend = new AppServerBackends(f.backend, ["app-server", "--listen", "stdio://"], f.value, {}, {}, catalog, async () => {}, () => {});
    await backend.request("initialize", { clientInfo: { name: "backends-subagents", version: "1" }, capabilities: { experimentalApi: true } });
    backend.notify({ method: "initialized" });

    const resumed = await backend.request("thread/resume", { threadId: "child", model: nativeChild });
    assert.deepEqual({ provider: resumed.modelProvider, model: resumed.model }, { provider: "subscription_gateway", model: nativeChild });
    await assert.doesNotReject(backend.request("thread/resume", { threadId: "child", config: { model: nativeChild } }),
      "the frozen executor recognizes config.model with the same precedence as the router");
    await assert.rejects(backend.request("thread/resume", { threadId: "child", config: { model: otherNative } }), /older catalog/);
    await assert.rejects(backend.request("thread/resume", { threadId: "child", config: { model: "missing/alias" } }), /older catalog/);
    await assert.rejects(backend.request("thread/resume", { threadId: "child", model: otherNative }), /older catalog/);
    await assert.rejects(backend.request("thread/resume", { threadId: "child", model: "missing/alias" }), /older catalog/);

    const internals = backend as unknown as { bindings: Map<string, { connection: { request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> } }> };
    const engine = internals.bindings.get("child")!;
    const request = engine.connection.request.bind(engine.connection);
    engine.connection.request = async (method, params) => {
      if (method !== "thread/read") return request(method, params);
      if (params.threadId === "mismatched") return { thread: { id: "another-child", model: nativeChild,
        modelProvider: "subscription_gateway", source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } } };
      if (params.threadId === "foreign-native-child") return { thread: { id: "foreign-native-child", model: nativeChild,
        modelProvider: "openai", source: { subAgent: { thread_spawn: { parent_thread_id: "native-parent" } } } } };
      return request(method, params);
    };
    // Simulate a stale binding from a shared rollout store. Neither a different
    // returned id nor a parent-shaped child whose ancestry is native is owned.
    internals.bindings.set("mismatched", engine);
    internals.bindings.set("foreign-native-child", engine);
    await assert.rejects(backend.request("thread/resume", { threadId: "mismatched", config: { model: nativeChild } }), /older catalog/);
    await assert.rejects(backend.request("thread/resume", { threadId: "foreign-native-child", config: { model: nativeChild } }), /older catalog/);
  } finally {
    await backend?.stop(); await f.close();
    if (priorHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorHome;
  }
});
