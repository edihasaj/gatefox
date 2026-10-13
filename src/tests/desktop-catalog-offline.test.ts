import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createServer, type Server } from "node:http";
import { chmod, lstat, readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { DesktopCatalog } from "../desktop-catalog.js";
import { writePrivateJson } from "../config.js";
import { shimFiles } from "./shim-fixture.js";

async function fixture() {
  const files = await shimFiles(); files.value.providers = []; files.value.clientOnly = true;
  await writePrivateJson(files.config, files.value);
  const path = join(files.directory, "combined.json");
  const cachePath = join(files.value.stateDirectory, "desktop-public-models.json");
  const native = [{ slug: "native", priority: 1, identity: "not-public-cache-identity", model_messages: { instructions_template: "original client instructions" } }];
  const create = () => new DesktopCatalog(files.value, native, path);
  return { ...files, path, cachePath, native, create };
}

async function adapter(f: Awaited<ReturnType<typeof fixture>>) {
  const child = spawn(process.execPath, [f.cli, "codex-shim", "--config", f.config, "--codex", f.backend, "--", "app-server"], { env: f.env, stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: child.stdout }); let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const exited = once(child, "close");
  lines.on("line", line => {
    const message = JSON.parse(line); const request = pending.get(message.id);
    if (!request) return; pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), { code: message.error.code })); else request.resolve(message.result);
  });
  const rpc = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error("Adapter fixture timed out")); }, 5000);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  await rpc("initialize", { clientInfo: { name: "offline-catalog-test", version: "1" } });
  return { rpc, async stop() { child.stdin.end(); await exited; lines.close(); for (const value of pending.values()) clearTimeout(value.timer); } };
}

test("client-only cached names survive a new adapter and an overwritten combined catalog during an outage", { timeout: 15000 }, async () => {
  const f = await fixture(); let live; let restarted;
  try {
    live = await adapter(f);
    assert.deepEqual((await live.rpc("model/list")).data.map((row: { model: string }) => row.model), ["native", "claude/model"]);
    await live.stop(); live = undefined; f.close();
    // Each new native preflight writes this combined file again with providers=[].
    await writePrivateJson(join(f.value.stateDirectory, "desktop-models.json"), { models: f.native });
    restarted = await adapter(f);
    const models = await restarted.rpc("model/list");
    assert.deepEqual(models.data.map((row: { model: string }) => row.model), ["native", "claude/model"]);
    const combined = JSON.parse(await readFile(join(f.value.stateDirectory, "desktop-models.json"), "utf8"));
    assert.deepEqual(combined.models.map((row: { slug: string }) => row.slug), ["native", "claude/model"]);
    await assert.rejects(restarted.rpc("thread/start", { model: "claude/model" }), error => {
      assert.equal((error as Error & { code: number }).code, -32001);
      assert.match((error as Error).message, /Gateway model discovery is unavailable/);
      assert.equal((error as Error).message.includes("config.toml"), false); return true;
    });
    await assert.rejects(restarted.rpc("thread/start", { model: "claude/unavailable" }), error => (error as Error & { code: number }).code === -32001);
    assert.equal((await restarted.rpc("thread/start", { model: "native" })).modelProvider, "openai");
    assert.equal((await restarted.rpc("account/read")).account.email, "primary-test-account");
    await assert.rejects(lstat(join(f.value.stateDirectory, "desktop-generations")), { code: "ENOENT" });
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native"\n');
  } finally { await live?.stop(); await restarted?.stop(); f.close(); }
});

test("offline cache contains only extra public rows and an opaque source identity", async () => {
  const f = await fixture();
  try {
    const token = await readFile(join(f.value.stateDirectory, "client-token"), "utf8");
    f.setCatalog({ models: [{ slug: "claude/model", display_name: "Claude · Model", supported_reasoning_levels: [{ effort: "max", description: "Max", secret: "excluded-level-auth" }], input_modalities: ["text", "image"], auth: "excluded-model-auth", identity: "excluded-model-identity", model_messages: { instructions_template: "public instructions", token: "excluded-message-auth" } }] });
    await f.create().refresh(true);
    const text = await readFile(f.cachePath, "utf8"); const cache = JSON.parse(text);
    assert.deepEqual(Object.keys(cache).sort(), ["models", "source", "version"]);
    assert.equal(cache.version, 1); assert.match(cache.source, /^[a-f0-9]{64}$/);
    assert.equal(text.includes(token.trim()), false); assert.equal(text.includes("excluded-"), false); assert.equal(text.includes("not-public-cache-identity"), false);
    assert.deepEqual(cache.models.map((row: { slug: string }) => row.slug), ["claude/model"]);
    assert.deepEqual(cache.models[0].model_messages, { instructions_template: "" });
    assert.equal((await lstat(f.cachePath)).mode & 0o777, 0o600);
    f.close(); const restored = f.create(); await restored.initialize();
    assert.deepEqual(restored.current().models[0].input_modalities, ["text", "image"]);
    assert.deepEqual(restored.current().models[0].supported_reasoning_levels, [{ effort: "max", description: "Max" }]);
  } finally { f.close(); }
});

test("older live catalogs and offline caches cannot restore gateway agent instructions", async () => {
  const f = await fixture();
  const gateway = { slug: "claude/model", display_name: "Claude · Updated", supported_reasoning_levels: [{ effort: "max", description: "Max" }], input_modalities: ["text", "image"],
    service_tiers: [{ id: "priority", name: "Fast", description: "Priority routing" }], default_service_tier: null };
  const originalNative = structuredClone(f.native);
  try {
    f.setCatalog({ models: [{ ...gateway, model_messages: { instructions_template: "Old gateway policy: coordinate workers and call gateway_chat_title.", token: "exclude-message-secret" } }] });
    const live = f.create(); const first = await live.refresh(true);
    assert.deepEqual(first.models[0].model_messages, { instructions_template: "" });
    assert.deepEqual(live.combined().models[0], originalNative[0]);
    assert.deepEqual(f.native, originalNative);
    for (const model_messages of [{ instructions_template: "Another obsolete policy" }, { instructions_template: 42 }, undefined]) {
      f.setCatalog({ models: [{ ...gateway, ...(model_messages ? { model_messages } : {}) }] });
      assert.equal((await live.refresh(true)).revision, first.revision);
    }
    const cache = JSON.parse(await readFile(f.cachePath, "utf8"));
    cache.models[0].model_messages = { instructions_template: "Cached gateway worker policy", token: "exclude-cache-message-secret" };
    await writePrivateJson(f.cachePath, cache); f.close();
    const restored = f.create(); await restored.initialize();
    assert.equal(restored.current().revision, first.revision);
    assert.deepEqual(restored.current().models[0].model_messages, { instructions_template: "" });
    assert.deepEqual(restored.current().models[0].input_modalities, gateway.input_modalities);
    assert.deepEqual(restored.current().models[0].service_tiers, gateway.service_tiers);
    assert.equal(restored.current().models[0].display_name, gateway.display_name);
    const combined = JSON.parse(await readFile(f.path, "utf8"));
    assert.deepEqual(combined.models[0], originalNative[0]);
    assert.deepEqual(combined.models[1].model_messages, { instructions_template: "" });
    assert.equal(JSON.stringify(combined).includes("Cached gateway worker policy"), false);
    assert.equal(JSON.stringify(combined).includes("exclude-cache-message-secret"), false);
  } finally { f.close(); }
});

test("corrupt, unsafe, collided or wrong-source caches fall back to native discovery", async t => {
  for (const corruption of ["json", "version", "port", "token", "collision", "duplicate", "effort", "modality", "oversized", "public-file", "outer-auth"] as const) await t.test(corruption, async () => {
    const f = await fixture(); let unavailable: Server | undefined;
    try {
      await f.create().refresh(true); const cache = JSON.parse(await readFile(f.cachePath, "utf8"));
      if (corruption === "json") await writeFile(f.cachePath, "{", { mode: 0o600 });
      if (corruption === "oversized") await writeFile(f.cachePath, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
      if (corruption === "version") cache.version = 2;
      if (corruption === "port") {
        // An adjacent ephemeral port can belong to another concurrently running fixture.
        unavailable = createServer((_request, response) => { response.writeHead(503); response.end(); });
        await new Promise<void>(resolve => unavailable!.listen(0, "127.0.0.1", resolve));
        f.value.port = (unavailable.address() as { port: number }).port;
      }
      if (corruption === "token") await writeFile(join(f.value.stateDirectory, "client-token"), "rotated-client-token-" + "y".repeat(32), { mode: 0o600 });
      if (corruption === "collision") cache.models[0].slug = "native";
      if (corruption === "duplicate") cache.models.push(cache.models[0]);
      if (corruption === "effort") cache.models[0].supported_reasoning_levels = [{ effort: "invented" }];
      if (corruption === "modality") cache.models[0].input_modalities = ["text", "audio"];
      if (corruption === "outer-auth") cache.auth = "must-not-load";
      if (!["json", "oversized"].includes(corruption)) await writePrivateJson(f.cachePath, cache);
      if (corruption === "public-file") await chmod(f.cachePath, 0o644);
      f.close(); const restarted = f.create(); await restarted.initialize();
      assert.equal(restarted.current().models.length, 0);
      assert.deepEqual(restarted.combined().models.map(row => row.slug), ["native"]);
      assert.equal((await restarted.refresh(false)).models.length, 0);
    } finally { f.close(); await new Promise<void>(resolve => unavailable ? unavailable.close(() => resolve()) : resolve()); }
  });
});

test("a symlinked offline cache is ignored without reading or changing its target", async () => {
  const f = await fixture();
  try {
    const target = join(f.directory, "private-original.json"); const original = '{"auth":"do-not-read"}';
    await writeFile(target, original, { mode: 0o600 }); await symlink(target, f.cachePath); f.close();
    const catalog = f.create(); await catalog.initialize(); assert.equal(catalog.current().models.length, 0);
    assert.equal(await readFile(target, "utf8"), original); assert.equal((await lstat(f.cachePath)).isSymbolicLink(), true);
  } finally { f.close(); }
});

test("strict and discovery callers share a fetch but an outage never authorizes cached inference", async () => {
  const f = await fixture();
  try {
    await f.create().refresh(true); f.close(); const catalog = f.create(); await catalog.initialize();
    const results = await Promise.allSettled([catalog.refresh(false), catalog.refresh(true)]);
    assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
    if (results[1].status === "rejected") assert.equal(results[1].reason.code, -32001);
    assert.equal(catalog.current().models[0].slug, "claude/model");
  } finally { f.close(); }
});

test("successful recovery atomically replaces the offline public catalog", async () => {
  const f = await fixture();
  try {
    const catalog = f.create(); await catalog.refresh(true); const first = await readFile(f.cachePath, "utf8");
    f.setCatalog({ models: [{ slug: "claude/new", display_name: "Claude · New", supported_reasoning_levels: [{ effort: "ultra", description: "Ultra" }], input_modalities: ["text"] }] });
    await catalog.refresh(true); assert.notEqual(await readFile(f.cachePath, "utf8"), first);
    f.close(); const restarted = f.create(); await restarted.initialize();
    assert.deepEqual(restarted.current().models.map(row => row.slug), ["claude/new"]);
    assert.equal((await lstat(f.cachePath)).mode & 0o777, 0o600);
  } finally { f.close(); }
});

test("remote tier metadata survives offline restoration and model/list without private fields", async () => {
  const f = await fixture(); let live; let restarted;
  const tier = { id: "priority", name: "Fast", description: "Priority routing" };
  try {
    f.setCatalog({ models: [{ slug: "codex/sol", display_name: "Codex 2 · Sol", supported_reasoning_levels: [], service_tiers: [{ ...tier, auth: "excluded-tier-auth" }], additional_speed_tiers: ["fast"], default_service_tier: "priority" }] });
    live = await adapter(f);
    const model = (await live.rpc("model/list")).data.find((row: { model: string }) => row.model === "codex/sol");
    assert.deepEqual(model.serviceTiers, [tier]); assert.deepEqual(model.additionalSpeedTiers, ["fast"]); assert.equal(model.defaultServiceTier, "priority");
    await live.stop(); live = undefined; f.close();
    const cache = await readFile(f.cachePath, "utf8"); assert.equal(cache.includes("excluded-tier-auth"), false);
    restarted = await adapter(f);
    const restored = (await restarted.rpc("model/list")).data.find((row: { model: string }) => row.model === "codex/sol");
    assert.deepEqual(restored.serviceTiers, [tier]); assert.deepEqual(restored.additionalSpeedTiers, ["fast"]); assert.equal(restored.defaultServiceTier, "priority");
  } finally { await live?.stop(); await restarted?.stop(); f.close(); }
});

test("malformed remote service tiers cannot replace a validated catalog", async t => {
  const tier = { id: "priority", name: "Fast", description: "Priority routing" };
  for (const metadata of [
    { service_tiers: "priority" }, { service_tiers: [tier, tier] }, { service_tiers: [{ ...tier, name: false }] },
    { additional_speed_tiers: ["fast", "fast"] }, { service_tiers: [tier], default_service_tier: "unadvertised" },
  ]) await t.test(JSON.stringify(metadata), async () => {
    const f = await fixture();
    try {
      const catalog = f.create(); await catalog.refresh(true); const previous = await readFile(f.cachePath, "utf8");
      f.setCatalog({ models: [{ slug: "codex/sol", display_name: "Sol", supported_reasoning_levels: [], ...metadata }] });
      await assert.rejects(catalog.refresh(true), /Gateway model discovery is unavailable/);
      assert.equal(await readFile(f.cachePath, "utf8"), previous); assert.equal(catalog.current().models[0].slug, "claude/model");
    } finally { f.close(); }
  });
});

test("public rows keep numeric window limits and drop other values before caching or combining", async () => {
  const f = await fixture();
  const row = { display_name: "Codex 2 · Sol", supported_reasoning_levels: [], context_window: 500000, effective_context_window_percent: 95, truncation_policy: { mode: "tokens", limit: 10000 } };
  try {
    f.setCatalog({ models: [
      { ...row, slug: "codex/sol", max_context_window: 872000, auto_compact_token_limit: 400000, comp_hash: "excluded-hash" },
      { ...row, slug: "codex/strings", max_context_window: "872000", auto_compact_token_limit: true },
      { ...row, slug: "codex/invalid", max_context_window: null, auto_compact_token_limit: 1.5 },
      { ...row, slug: "codex/negative", max_context_window: -1, auto_compact_token_limit: { tokens: 400000 } },
    ] });
    const live = f.create(); const snapshot = await live.refresh(true);
    const [sol, ...dropped] = snapshot.models;
    assert.equal(sol.max_context_window, 872000); assert.equal(sol.auto_compact_token_limit, 400000);
    assert.equal(sol.effective_context_window_percent, 95); assert.deepEqual(sol.truncation_policy, { mode: "tokens", limit: 10000 });
    assert.equal(Object.hasOwn(sol, "comp_hash"), false);
    for (const model of dropped) assert.equal(Object.hasOwn(model, "max_context_window") || Object.hasOwn(model, "auto_compact_token_limit"), false, String(model.slug));
    const combined = JSON.parse(await readFile(f.path, "utf8"));
    assert.deepEqual(combined.models.map((model: { slug: string }) => model.slug), ["native", "codex/sol", "codex/strings", "codex/invalid", "codex/negative"]);
    assert.equal(combined.models[1].max_context_window, 872000); assert.equal(combined.models[1].auto_compact_token_limit, 400000);
    assert.equal((await readFile(f.cachePath, "utf8")).includes("excluded-hash"), false);
    f.close(); const restored = f.create(); await restored.initialize();
    assert.equal(restored.current().revision, snapshot.revision);
    assert.equal(restored.current().models[0].max_context_window, 872000);
  } finally { f.close(); }
});
