import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, validateConfig, type GatewayConfig } from "../config.js";
import { createGatewayHandler, adoptGatewayHandler, type GatewayServer } from "../server.js";
import { AdmissionRegistry } from "../admission-registry.js";
import type { Provider } from "../providers/provider.js";

const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
const qwen = { id: "qwen", type: "chat-completions-api" as const, baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "UNUSED_TEST_KEY", models: { qwen: "qwen" }, capacityDiscovery: true };
const other = { id: "other", type: "claude-subscription" as const, models: { other: "other" } };
const discover = { intervalMs: 10, probe: async () => ({ limit: 2, observedAt: Date.now() }) };

async function until(check: () => boolean, message: string): Promise<void> {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (check()) return; await delay(5); }
  assert.fail(message);
}
async function listen(server: GatewayServer): Promise<string> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: GatewayServer): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

test("hot swaps share one capacity budget, freeze retired reloads and release old snapshots", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-hot-swap-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: root, maxConcurrent: 8, providers: [qwen] });
  const registry = new AdmissionRegistry();
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  let reloadDone = (_value: GatewayConfig) => {}; let waitReload = false; let reloadEntered = false;
  const delayedReload = new Promise<GatewayConfig>(resolve => { reloadDone = resolve; });
  let live = 0; let peak = 0; let calls = 0;
  const factory = (): Provider => ({ async *infer() {
    calls++; live++; peak = Math.max(peak, live);
    try { await held; yield { type: "text", text: "ok" }; yield { type: "done", usage }; }
    finally { live--; }
  } });
  const first = await createGatewayHandler(config, factory, async () => {
    if (waitReload) { reloadEntered = true; return delayedReload; } return config;
  }, { admissionRegistry: registry, upstreamCapacity: discover, onFailure() {} });
  const server = adoptGatewayHandler(createServer(), first); const base = await listen(server);
  const headers = { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json" };
  const post = () => fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "qwen", input: "hello" }) });
  let health: Promise<Response> | undefined;
  try {
    await until(() => registry.limit("qwen") === 2, "initial capacity must be two");
    const old = [post(), post()]; await until(() => calls === 2, "old generation must fill capacity");
    waitReload = true; health = fetch(base + "/health");
    await until(() => reloadEntered, "old reload must be suspended");
    const next = { ...config, maxConcurrent: 7, providers: [qwen, other] };
    const second = await createGatewayHandler(next, factory, undefined, { upstreamCapacity: discover, onFailure() {} });
    adoptGatewayHandler(server, second);
    assert.strictEqual(second.admissionState!.registry, registry);
    await until(() => registry.limit("qwen") === 2, "the shared limit must remain two");
    const fresh = [post(), post()];
    await until(() => registry.load("qwen").queued === 2, "new generation must queue behind old work");
    assert.equal(calls, 2);
    reloadDone({ ...config, maxConcurrent: 64, providers: [{ ...qwen, capacityDiscovery: false }] });
    await (await health).text();
    assert.equal(registry.limit("qwen"), 2, "retired reload must not overwrite the newer policy");
    assert.equal(registry.limit("other"), 7);
    release();
    const responses = await Promise.all([...old, ...fresh]);
    assert.ok(responses.every(response => response.status === 200));
    await Promise.all(responses.map(response => response.text()));
    assert.equal(peak, 2, "a hot swap must not create another two inference slots");
    const third = await createGatewayHandler({ ...next, providers: [other] }, factory, undefined, { onFailure() {} });
    adoptGatewayHandler(server, third);
    await until(() => registry.size() === 1, "retired base snapshots must release the removed provider");
  } finally {
    release(); reloadDone(config); await health?.catch(() => undefined); await close(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown legacy budgets hold discovered admission even when discovery fails", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-legacy-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: root, maxConcurrent: 8, providers: [qwen, other] });
  let legacyResponse: ServerResponse | undefined; let legacyBusy = false; let calls = 0;
  const legacy = { handle: (_req: unknown, res: ServerResponse) => {
    legacyBusy = true; legacyResponse = res; res.once("close", () => { legacyBusy = false; });
  }, isIdle: () => !legacyBusy, abortAll: () => { legacyResponse?.destroy(); } };
  const server = adoptGatewayHandler(createServer(), legacy); const base = await listen(server);
  const headers = { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json" };
  const old = fetch(base + "/legacy");
  try {
    await until(() => legacyBusy, "legacy work must start");
    const next = await createGatewayHandler(config, () => ({ async *infer() {
      calls++; yield { type: "text", text: "ok" }; yield { type: "done", usage };
    } }), undefined, { upstreamCapacity: { intervalMs: 10, probe: async () => undefined }, onFailure() {} });
    adoptGatewayHandler(server, next);
    const registry = next.admissionState!.registry;
    assert.equal(registry.limit("qwen"), 0, "hold is synchronous before any request arrives");
    assert.equal(registry.limit("other"), 8, "unrelated provider behavior remains unchanged");
    const fresh = fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "qwen", input: "hello" }) });
    await until(() => registry.load("qwen").queued === 1, "new work waits for the unknown budget");
    await delay(30); assert.equal(calls, 0, "failed discovery cannot open the fallback while legacy work remains");
    legacyResponse!.end("done"); await (await old).text();
    assert.equal((await fresh).status, 200);
    assert.equal(calls, 1); assert.equal(registry.limit("qwen"), 8);
  } finally { legacyResponse?.end(); await close(server); await rm(root, { recursive: true, force: true }); }
});

test("closing a server retires its capacity poller", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-close-")); let polls = 0;
  const config = validateConfig({ version: 1, port: 0, stateDirectory: root, providers: [qwen] });
  const handler = await createGatewayHandler(config, () => ({ async *infer() { yield { type: "done", usage }; } }), undefined,
    { upstreamCapacity: { intervalMs: 10, probe: async () => { polls++; return { limit: 2, observedAt: Date.now() }; } } });
  const server = adoptGatewayHandler(createServer(), handler); await listen(server);
  try {
    await until(() => polls >= 2, "poller must run before shutdown");
    await close(server); const stopped = polls; await delay(50);
    assert.equal(polls, stopped, "shutdown must stop all further capacity collection");
  } finally { if (server.listening) await close(server); await rm(root, { recursive: true, force: true }); }
});

test("a shared source observation expires even after its owning handler retires", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "capacity-expiry-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: root, maxConcurrent: 8, providers: [qwen] });
  const factory = (): Provider => ({ async *infer() { yield { type: "done", usage }; } });
  const first = await createGatewayHandler(config, factory, undefined, { upstreamCapacity: {
    intervalMs: 60_000, probe: async () => ({ limit: 2, observedAt: Date.now() - 29_000 }),
  } });
  const server = adoptGatewayHandler(createServer(), first); await listen(server);
  const registry = first.admissionState!.registry;
  try {
    await until(() => registry.limit("qwen") === 2, "the nearly stale observation must be accepted");
    const next = await createGatewayHandler(config, factory, undefined, { upstreamCapacity: {
      intervalMs: 60_000, probe: () => new Promise(() => {}),
    } });
    adoptGatewayHandler(server, next);
    assert.strictEqual(next.admissionState!.registry, registry);
    assert.equal(registry.limit("qwen"), 2);
    await delay(1100);
    assert.equal(registry.limit("qwen"), 8, "retiring the old watcher cannot extend source freshness");
  } finally { await close(server); await rm(root, { recursive: true, force: true }); }
});
