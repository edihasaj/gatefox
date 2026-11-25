import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AdmissionRegistry } from "../admission-registry.js";
import { AvailabilityService } from "../availability/service.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { LiveConfig } from "../live-config.js";
import { adoptGatewayHandler, createGatewayHandler, startGateway } from "../server.js";
import { PoolReach } from "../provider-pool-reach.js";
import { ProviderPool, pooledHealth } from "../provider-pool.js";
import { ProviderPoolPins, maximumPins, pinLifetimeMs } from "../provider-pool-pins.js";
import { Admission } from "../admission.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { FakeSpark, eventually, openPool, poolConfig } from "./provider-pool-fixture.js";

test("turning a running Qwen provider into a pool applies live, with saved chats on the same model name", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-pool-live-")); const sparks = [new FakeSpark("one"), new FakeSpark("two")]; const router = new FakeSpark("router");
  for (const spark of [...sparks, router]) await spark.start();
  const wide = poolConfig(root, sparks.map(spark => spark.port), p => { p[0].baseUrl = `http://127.0.0.1:${router.port}/v1`; });
  const before = { ...structuredClone(wide), providers: [structuredClone(wide.providers[0])] }; delete before.providers[0].pool;
  const path = join(root, "gateway.json"); const write = (config: GatewayConfig) => writeFile(path, JSON.stringify(config)); await write(before);
  const { loadConfig } = await import("../config.js"); const initial = await loadConfig(path); const live = new LiveConfig(path, initial);
  const server = await startGateway(initial, undefined, () => live.current(), { onFailure() {}, upstreamCapacity: { intervalMs: 25 } });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const headers = { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json", "thread-id": "saved" };
  const ask = async (model = "qwen/qwen3.8-flash-next") => { const response = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model, input: "x" }) }); const value = await response.json() as any; return response.status === 200 ? value.output[0].content[0].text as string : response.status; };
  try {
    assert.equal(await ask(), "from router");
    await write(wide); const home = await ask(); assert.match(String(home), /one|two/); assert.equal(live.rejection, undefined, "no restart is needed"); assert.equal(await ask(), home);
    const rows = ((await (await fetch(base + "/v1/availability?wait=3000", { headers })).json()) as any).providers;
    assert.ok(rows.some((row: any) => /^qwen-[12]$/.test(row.id) && row.lastSuccessAt), "a machine added live records its own outcomes");
    assert.deepEqual([await ask("qwen-1/qwen3.8-flash-next"), await ask("qwen-2/qwen3.8-flash-next")], ["from one", "from two"]);
    await delay(300); const dialed = router.dialed; const probed = sparks[0].dialed; await delay(600);
    assert.ok(sparks[0].dialed > probed, "the machines are still probed"); assert.equal(router.dialed, dialed, "nothing dials the address the pool replaced");
    // Rollback: the same file without the field, and what an older release, which ignores the field, would do.
    await write(before); assert.equal(await ask(), "from router"); assert.equal(await ask("qwen-1/qwen3.8-flash-next"), 404);
    const seen = router.chats.length; const older = new ChatCompletionsAPI(wide.providers[0]);
    for await (const _ of older.infer({ model: "qwen3.8-flash-next", input: "x" }, new AbortController().signal)) { /* drained */ }
    assert.equal(router.chats.length, seen + 1);
    await write({ ...wide, providers: [{ ...wide.providers[0], pool: ["qwen-1", "nope"] }, ...wide.providers.slice(1)] }); assert.equal(await ask(), "from router"); assert.equal(live.rejection, "invalid", "a broken pool is refused and the last good configuration serves");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const spark of [...sparks, router]) await spark.stop(); await new ProviderPoolPins(root, "qwen").flush(); await rm(root, { recursive: true, force: true }); }
});

test("an in-place update keeps conversations and slot counts across handler generations", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-pool-swap-")); const sparks = [new FakeSpark("one"), new FakeSpark("two")]; for (const spark of sparks) { spark.slots = 1; await spark.start(); }
  const config = poolConfig(root, sparks.map(spark => spark.port)); const registry = new AdmissionRegistry();
  const options = { onFailure() {}, upstreamCapacity: { intervalMs: 25 }, admissionRegistry: registry };
  const server = createServer(); adoptGatewayHandler(server, await createGatewayHandler(config, undefined, undefined, options)); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = await gatewayToken(root);
  const ask = async (thread: string) => { const response = await fetch(base + "/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "thread-id": thread }, body: JSON.stringify({ model: "qwen/qwen3.8-flash-next", input: "x" }) }); return ((await response.json()) as any).output[0].content[0].text as string; };
  try {
    await eventually(() => registry.limit("qwen-1") === 1 && registry.limit("qwen-2") === 1, "capacity");
    const homes = new Map<string, string>(); for (let n = 0; n < 12; n++) homes.set(`t${n}`, await ask(`t${n}`));
    let release = () => {}; const busy = sparks.find(spark => `from ${spark.name}` === homes.get("t0"))!; busy.hold = new Promise<void>(resolve => { release = resolve; });
    const running = ask("t0"); await eventually(() => busy.running === 1, "running on the old generation");
    adoptGatewayHandler(server, await createGatewayHandler(config, undefined, undefined, { onFailure() {}, upstreamCapacity: { intervalMs: 25 } }));
    for (const [thread, home] of homes) if (home !== homes.get("t0")) assert.equal(await ask(thread), home);
    for (let n = 0; n < 4; n++) assert.notEqual(await ask(`fresh-${n}`), homes.get("t0"), "the new generation counts the slot the old one holds");
    release(); busy.hold = undefined; assert.equal(await running, homes.get("t0"));
    for (const [thread, home] of homes) assert.equal(await ask(thread), home); assert.ok(sparks.every(spark => spark.peak <= 1));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); for (const spark of sparks) await spark.stop(); await new ProviderPoolPins(root, "qwen").flush(); await rm(root, { recursive: true, force: true }); }
});

test("a managed route may keep naming the pooled model; its health and slots come from the members", { timeout: 30000 }, async () => {
  const pool = await openPool({ start: { availability: new AvailabilityService() } });
  try {
    const routes = { "managed/local-first": { purpose: "routine", candidates: ["qwen/qwen3.8-flash-next", "sub/sonnet"], maxContextBytes: 262144, contextWindow: 32768, minRemainingPercent: 2, allowPaid: false } };
    const { validateConfig } = await import("../config.js");
    pool.current.config = validateConfig({ ...structuredClone(pool.config), providers: [...structuredClone(pool.config.providers), { id: "sub", type: "claude-subscription", models: { "sub/sonnet": "claude-sonnet-5-5" }, modelMetadata: { "sub/sonnet": { contextWindow: 200000 } } }], managedRouting: { routes } });
    const ask = () => pool.ask("worker", { model: "managed/local-first" });
    const first = await ask(); assert.equal(first.status, 200, JSON.stringify(first)); assert.equal((await ask()).text, first.text);
    await pool.sparks.find(spark => `from ${spark.name}` !== first.text)!.stop(); assert.equal((await ask()).text, first.text, "one dead member does not take the local model away");
  } finally { await pool.close(); }
});

test("tailnet members are checked and dialed as the addresses they name", () => {
  const config = poolConfig("/tmp/pool-tailnet", [18001, 18002], p => { p[0].tailnet = true; p[0].baseUrl = "http://dgx.example.com:4000/v1"; [p[1], p[2]].forEach((m: any, index) => { m.tailnet = true; m.baseUrl = `http://100.64.0.${index + 1}:4001/v1`; }); });
  assert.deepEqual(config.providers.slice(1).map(provider => [provider.baseUrl, provider.tailnet]), [["http://100.64.0.1:4001/v1", true], ["http://100.64.0.2:4001/v1", true]]);
});

test("a member counts as lost only while another one demonstrably answers", () => {
  const reach = new PoolReach(); const all = ["a", "b"]; const lost = () => all.filter(id => reach.lost(id, all));
  for (let n = 0; n < 9; n++) { reach.miss("a"); reach.miss("b"); } assert.deepEqual(lost(), [], "both silent: this Mac's own network");
  reach.hit("b"); assert.deepEqual(lost(), [], "one answer may only mean the other's is still on its way"); reach.hit("a"); reach.hit("b"); assert.deepEqual(lost(), []);
  reach.miss("a"); reach.miss("a"); assert.deepEqual(lost(), []); reach.miss("a"); assert.deepEqual(lost(), ["a"]); reach.hit("a"); assert.deepEqual(lost(), []);
});

test("pins are bounded, expire and prefer recent conversations", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-pool-pins-")); let now = 1_800_000_000_000;
  try {
    const pins = new ProviderPoolPins(root, "qwen", () => now); const keys = Array.from({ length: maximumPins + 10 }, (_, n) => pins.key(`c${n}`));
    pins.set(keys[0], "qwen-1"); for (const key of keys.slice(1, maximumPins)) pins.set(key, "qwen-2"); assert.equal(pins.get(keys[0]), "qwen-1");
    for (const key of keys.slice(maximumPins)) pins.set(key, "qwen-2"); assert.equal(pins.get(keys[0]), "qwen-1", "recently used"); assert.equal(pins.get(keys[1]), undefined, "idle longest");
    now += pinLifetimeMs + 1; assert.equal(pins.get(keys[0]), undefined); await pins.flush();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("new conversations follow room, not order, across unequal Sparks", async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-pool-room-")); const limits = [10, 5]; const admissions = [new Admission(10), new Admission(5)]; const held: Array<() => void> = [];
  try {
    const pool = new ProviderPool("qwen", admissions.map((admission, index) => ({ id: `qwen-${index + 1}`, adapter: { async *infer() {} }, admission, limit: () => limits[index] })), new ProviderPoolPins(root, "qwen"));
    for (let n = 0; n < 15; n++) held.push(await pool.lease({ threadId: `t${n}` }).acquire(new AbortController().signal));
    assert.deepEqual(admissions.map(admission => [admission.running, admission.queued]), [[10, 0], [5, 0]]); held.forEach(release => { release(); release(); });
    assert.deepEqual(admissions.map(admission => admission.running), [0, 0], "releasing twice returns one slot once");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a waiting request leaves a lost Spark even while the request ahead of it, already answering, keeps its place", { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "provider-pool-wait-")); const admissions = [new Admission(1), new Admission(1)]; let lost = -1; const pins = new ProviderPoolPins(root, "qwen");
  try {
    const pool = new ProviderPool("qwen", admissions.map((admission, index) => ({ id: `qwen-${index + 1}`, adapter: { async *infer() {} }, admission, limit: () => 1, lost: () => lost === index })), pins, { pollMs: 10 });
    const enter = () => pool.lease({ threadId: "warm" }).acquire(new AbortController().signal);
    const ahead = await enter(); const home = admissions.findIndex(admission => admission.running === 1);
    const waiting = enter(); await delay(100); assert.deepEqual([admissions[home].queued, admissions[1 - home].running], [1, 0], "it waits where its cache is");
    lost = home; const release = await waiting; assert.deepEqual([admissions[home].running, admissions[home].queued, admissions[1 - home].running], [1, 0, 1]);
    release(); ahead(); assert.deepEqual(admissions.map(admission => admission.running), [0, 0]);
  } finally { await pins.flush(); await rm(root, { recursive: true, force: true }); }
});

test("diagnostics count requests per machine and each failover, and say nothing without a pool", async () => {
  const { summarizeTelemetry } = await import("../diagnostics.js"); const base = { at: new Date().toISOString(), host: "h", component: "gateway", pid: 1 };
  assert.deepEqual(summarizeTelemetry([{ ...base, event: "pool_member_selected", pool: "qwen", member: "qwen-1", reason: "pinned" }, { ...base, event: "pool_member_selected", pool: "qwen", member: "qwen-1", reason: "pinned" },
    { ...base, event: "pool_failover", pool: "qwen", from: "qwen-1", to: "qwen-2", reason: "unreachable" }], new Date()).providerPools, { "qwen qwen-1:pinned": 2, "qwen failover qwen-1->qwen-2:unreachable": 1 });
  assert.equal(Object.hasOwn(summarizeTelemetry([], new Date()), "providerPools"), false);
});

test("pool health is honest about partial and total loss", () => {
  const up = { status: "healthy" as const, observedAt: 5, latencyMs: 3, endpoints: { healthy: 1, total: 1 }, servedModels: ["m"], missingModels: [] }; const down = { status: "unhealthy" as const, observedAt: 4, endpoints: { healthy: 0, total: 1 }, servedModels: [], missingModels: [], reason: "unreachable" as const };
  assert.equal(pooledHealth([up, up])!.status, "healthy"); assert.deepEqual([pooledHealth([up, down])!.status, pooledHealth([up, down])!.servedModels, pooledHealth([up, down])!.observedAt], ["degraded", ["m"], 4]);
  assert.equal(pooledHealth([down, down])!.status, "unhealthy"); assert.equal(pooledHealth([undefined, undefined]), undefined); assert.equal(pooledHealth([up, undefined])!.status, "degraded");
});
