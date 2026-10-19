import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { readFile, readdir, writeFile, mkdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { shimFiles } from "./shim-fixture.js";
import { modelCatalog } from "../catalog.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { writePrivateJson } from "../config.js";
import { gatewayIdentities } from "./identity-cases.js";

async function client(files?: Awaited<ReturnType<typeof shimFiles>>) {
  files ??= await shimFiles();
  const child = spawn(process.execPath, [files.cli, "codex-shim", "--config", files.config, "--codex", files.backend, "--", "app-server"], { stdio: ["pipe", "pipe", "pipe"], env: files.env });
  child.stderr.resume(); const lines = createInterface({ input: child.stdout }); let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  lines.on("line", line => {
    const message = JSON.parse(line); const entry = pending.get(message.id);
    if (entry) { clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); }
  });
  const rpc = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 5000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  await rpc("initialize", { clientInfo: { name: "gateway_test", version: "1" } });
  return { ...files, rpc, stop: async (keepCatalog = false) => { const closed = once(child, "close"); child.stdin.end(); await closed; lines.close(); if (!keepCatalog) files.close(); } };
}

test("live additions use a new gateway catalog while native and loaded gateway chats retain their engines", { timeout: 15000 }, async () => {
  const c = await client();
  try {
    const native = await c.rpc("thread/start", { model: "native" });
    const nativeEngine = await c.rpc("engine/info", { threadId: native.thread.id });
    const old = await c.rpc("thread/start", { model: "claude/model" });
    const oldEngine = await c.rpc("engine/info", { threadId: old.thread.id });
    assert.notEqual(nativeEngine.pid, oldEngine.pid);
    assert.equal(oldEngine.primaryAuthPresent, false);
    assert.equal(nativeEngine.stepModelSwitching, false);
    assert.equal(oldEngine.stepModelSwitching, true);
    c.value.providers[0].models["claude/new"] = "new";
    c.value.providers[0].modelMetadata = { "claude/new": { contextWindow: 1000000, reasoningEfforts: ["high"] } };
    c.setCatalog(modelCatalog(c.value));
    const latest = await c.rpc("thread/start", { model: "claude/new" });
    const latestEngine = await c.rpc("engine/info", { threadId: latest.thread.id });
    assert.notEqual(latestEngine.pid, oldEngine.pid);
    assert.deepEqual(latestEngine.catalog.find((m: { slug: string }) => m.slug === "claude/new"), { slug: "claude/new", context: 1000000 });
    assert.equal((await c.rpc("engine/info", { threadId: old.thread.id })).pid, oldEngine.pid);
    assert.equal((await c.rpc("engine/info", { threadId: native.thread.id })).pid, nativeEngine.pid);
    assert.equal((await c.rpc("model/list")).data.at(-1).model, "claude/new");
    assert.equal((await c.rpc("account/read")).account.email, "primary-test-account");
    assert.equal(await readFile(join(c.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
    await assert.rejects(c.rpc("turn/start", { threadId: old.thread.id, collaborationMode: { settings: { model: "claude/new" } } }), /older catalog/);
    await c.rpc("thread/unsubscribe", { threadId: old.thread.id });
    const resumed = await c.rpc("thread/resume", { threadId: old.thread.id, model: "claude/new" });
    assert.equal(resumed.modelProvider, "subscription_gateway");
    assert.equal((await c.rpc("engine/info", { threadId: old.thread.id })).pid, latestEngine.pid);
  } finally { await c.stop(); }
});

test("new gateway executors inherit agent limits changed after adapter initialization", { timeout: 15000 }, async () => {
  const c = await client();
  try {
    await writeFile(join(c.nativeHome, "agent-policy.json"), JSON.stringify({ agents: { max_concurrent_threads_per_session: 30 } }));
    const started = await c.rpc("thread/start", { model: "claude/model" });
    const engine = await c.rpc("engine/info", { threadId: started.thread.id });
    const settings = await readFile(join(engine.home, "config.toml"), "utf8");
    assert.ok(settings.includes('"max_concurrent_threads_per_session" = 30'));
    assert.equal(await readFile(join(c.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
    assert.equal(engine.primaryAuthPresent, false);
  } finally { await c.stop(); }
});

test("client agent choices survive obsolete gateway role policy", { timeout: 15000 }, async () => {
  const c = await client();
  try {
    const clientAgents = { max_concurrent_threads_per_session: 30, default_subagent_model: "claude/model", default_subagent_reasoning_effort: "low" };
    await writeFile(join(c.nativeHome, "agent-policy.json"), JSON.stringify({ agents: clientAgents }));
    const roles = join(c.nativeHome, "agents"); await mkdir(roles);
    const role = 'name = "reviewer"\nmodel = "claude/model"\nmodel_reasoning_effort = "low"\n';
    await writeFile(join(roles, "reviewer.toml"), role);
    const legacy = { version: 1, coordinator: "codex/obsolete", verifier: "codex/obsolete-review", worker: "qwen/obsolete-worker", effort: "high" };
    await writeFile(join(c.value.stateDirectory, "agent-policy.json"), JSON.stringify(legacy));
    const legacyProfiles = join(c.value.stateDirectory, "agent-profiles", createHash("sha256").update(JSON.stringify(legacy)).digest("hex").slice(0, 16));
    await mkdir(legacyProfiles, { recursive: true });
    await writeFile(join(legacyProfiles, "worker.toml"), 'model = "qwen/obsolete-worker"\n');
    const started = await c.rpc("thread/start", { model: "claude/model" });
    const engine = await c.rpc("engine/info", { threadId: started.thread.id });
    const settings = await readFile(join(engine.home, "config.toml"), "utf8");
    assert.match(settings, /"default_subagent_model" = "claude\/model"/);
    assert.match(settings, /"default_subagent_reasoning_effort" = "low"/);
    assert.match(settings, /"max_concurrent_threads_per_session" = 30/);
    assert.equal(settings.includes("obsolete"), false);
    assert.equal(await readlink(join(engine.home, "agents")), roles);
    assert.equal(await readFile(join(engine.home, "agents/reviewer.toml"), "utf8"), role);
    assert.equal(await readFile(join(c.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
    assert.equal(engine.primaryAuthPresent, false);
  } finally { await c.stop(); }
});

test("gateway failure leaves native discovery and primary account requests usable", { timeout: 15000 }, async () => {
  const c = await client();
  try {
    const thread = await c.rpc("thread/start", { model: "claude/model" });
    const before = await c.rpc("engine/info", { threadId: thread.thread.id });
    await assert.rejects(c.rpc("crash", { threadId: thread.thread.id }), /exited/);
    assert.equal((await c.rpc("account/read")).account.email, "primary-test-account");
    assert.equal((await c.rpc("model/list")).data[0].model, "native");
    // The chat's next request loads it on a new gateway executor first (docs/app-server.md, re-attaching a gateway chat).
    const after = await c.rpc("engine/info", { threadId: thread.thread.id });
    assert.notEqual(after.pid, before.pid); assert.equal(after.primaryAuthPresent, false);
  } finally { await c.stop(); }
});

test("concurrent non-strict discovery cannot hide a failure from a gateway start", async () => {
  const f = await shimFiles(); f.setCatalog({ models: [{ slug: "native", display_name: "collision", supported_reasoning_levels: [] }] });
  const catalog = new DesktopCatalog(f.value, [{ slug: "native" }], join(f.directory, "desktop.json"));
  try {
    const results = await Promise.allSettled([catalog.refresh(false), catalog.refresh(true)]);
    assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
    assert.equal(catalog.current().models[0].slug, "claude/model");
  } finally { f.close(); }
});

test("missing gateway access cannot route an unknown model through the native account", { timeout: 15000 }, async () => {
  const c = await client(); c.close();
  try {
    assert.equal((await c.rpc("thread/start", { model: "native" })).modelProvider, "openai");
    await assert.rejects(c.rpc("thread/start", { model: "claude/new-not-discovered" }), /fetch failed|HTTP|discovery/);
    assert.equal((await c.rpc("account/read")).account.email, "primary-test-account");
  } finally { await c.stop(); }
});

test("credential-free clients read saved gateway chats before model discovery and resume them", { timeout: 15000 }, async () => {
  const files = await shimFiles(); files.value.providers = []; files.value.clientOnly = true; await writePrivateJson(files.config, files.value);
  const first = await client(files); const started = await first.rpc("thread/start", { model: "claude/model" });
  await first.rpc("thread/unsubscribe", { threadId: started.thread.id }); await first.stop(true);
  const reopened = await client(files);
  try {
    const read = await reopened.rpc("thread/read", { threadId: started.thread.id, includeTurns: false }); assert.equal(read.thread.modelProvider, "subscription_gateway");
    const resumed = await reopened.rpc("thread/resume", { threadId: started.thread.id }); assert.equal(resumed.modelProvider, "subscription_gateway");
    assert.equal((await reopened.rpc("account/read")).account.email, "primary-test-account");
    assert.equal(await readFile(join(files.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { await reopened.stop(); }
});

for (const identity of gatewayIdentities) test(`a saved gateway chat resumes on a gateway executor whichever provider id it was saved with (${identity.name})`, { timeout: 15000 }, async () => {
  const c = await client();
  try {
    // Saved before this adapter started, as by an earlier release: the desktop resumes both with no model and no provider.
    const sessions = join(c.nativeHome, "sessions"); await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "saved-gateway.json"), JSON.stringify({ id: "saved-gateway", modelProvider: identity.provider, model: "claude/model" }));
    await writeFile(join(sessions, "saved-native.json"), JSON.stringify({ id: "saved-native", modelProvider: "openai", model: "native" }));
    const nativeEngine = await c.rpc("engine/info", {});
    const resumed = await c.rpc("thread/resume", { threadId: "saved-gateway", model: null, modelProvider: null });
    assert.deepEqual({ provider: resumed.modelProvider, model: resumed.model }, { provider: identity.provider, model: "claude/model" }, "a resume keeps the provider id the chat was saved with");
    const gatewayEngine = await c.rpc("engine/info", { threadId: "saved-gateway" });
    assert.notEqual(gatewayEngine.pid, nativeEngine.pid); assert.equal(gatewayEngine.primaryAuthPresent, false);
    const nativeResume = await c.rpc("thread/resume", { threadId: "saved-native", model: null, modelProvider: null });
    assert.deepEqual({ provider: nativeResume.modelProvider, model: nativeResume.model }, { provider: "openai", model: "native" });
    assert.equal((await c.rpc("engine/info", { threadId: "saved-native" })).pid, nativeEngine.pid);
    // A new gateway chat is recorded in the gateway's registry, so it is told apart without the provider id. This checkout has no
    // gateway SDK artifact, so its executor is a stock Codex and new chats keep the legacy id (docs/harness-identity.md).
    const started = await c.rpc("thread/start", { model: "claude/model" });
    assert.equal(started.modelProvider, "subscription_gateway");
    const registry = JSON.parse(await readFile(join(c.value.stateDirectory, "gateway-chats", (await readdir(join(c.value.stateDirectory, "gateway-chats"))).find(name => name.endsWith(".json"))!), "utf8"));
    // A saved `openai` chat that only its alias identified is written too when it is routed; a legacy one needs no entry.
    assert.deepEqual(registry.chats.map((chat: { id: string; origin: string }) => [chat.id, chat.origin]).sort(),
      [[started.thread.id, "start"], ...(identity.name === "openai" ? [["saved-gateway", "started"]] : [])].sort());
  } finally { await c.stop(); }
});
