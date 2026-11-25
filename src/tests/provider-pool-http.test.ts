import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderPoolPins, forgetProviderPoolPins } from "../provider-pool-pins.js";
import { configureNetworkRetryTiming, resetNetworkRetryTiming } from "../providers/network-retry.js";
import { FakeSpark, eventually, openPool, type PoolHarness } from "./provider-pool-fixture.js";

const by = (pool: PoolHarness, name: string) => pool.sparks.find(spark => spark.name === name)!;
const other = (pool: PoolHarness, spark: FakeSpark) => pool.sparks.find(entry => entry !== spark)!;
const served = async (pool: PoolHarness, thread: string | undefined, body?: Record<string, unknown>) => {
  const reply = await pool.ask(thread, body); assert.equal(reply.status, 200, JSON.stringify(reply));
  return by(pool, reply.text.replace("from ", ""));
};
const run = (name: string, body: (pool: PoolHarness) => Promise<void>, options?: Parameters<typeof openPool>[0]) => test(name, { timeout: 60000 }, async () => {
  const pool = await openPool(options);
  try { await body(pool); } finally { resetNetworkRetryTiming(); await pool.close(); }
});

run("every conversation stays on one Spark over many turns, and both Sparks are used evenly", async pool => {
  const homes = new Map<string, FakeSpark>();
  for (let turn = 0; turn < 6; turn++) for (let n = 0; n < 40; n++) {
    const spark = await served(pool, `thread-${n}`); const home = homes.get(`thread-${n}`) ?? spark;
    homes.set(`thread-${n}`, home); assert.equal(spark, home, `thread-${n} moved on turn ${turn}`);
  }
  const split = pool.sparks.map(spark => [...homes.values()].filter(home => home === spark).length);
  assert.ok(Math.min(...split) >= 8, `one at a time, ties must spread by conversation: ${split}`);
  assert.ok(pool.sparks.every(spark => spark.chats.every(entry => homes.get(entry.session!) === spark)), "the conversation identifier reaches its own Spark");
});

run("web_search, function tools, effort and instructions reach the same Spark unchanged by the pool", async pool => {
  const request = { instructions: "Be brief.", reasoning: { effort: "medium" }, tools: [{ type: "web_search" }, { type: "function", name: "noop", parameters: { type: "object", properties: {} } }] };
  const spark = await served(pool, "tools", request); await served(pool, "tools", request);
  const bodies = spark.chats.map(entry => entry.body as any); assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.deepEqual(body.tools.map((tool: any) => tool.type), ["function"]); assert.equal(body.model, "qwen3.8-flash-next");
    assert.equal(body.chat_template_kwargs.reasoning_effort, "medium"); assert.match(JSON.stringify(body.messages), /Be brief/);
  }
  assert.deepEqual(bodies[0], bodies[1], "an identical turn must produce an identical prompt");
});

run("concurrent new conversations fill both Sparks and never exceed either one's slots", async pool => {
  let release = () => {}; const hold = new Promise<void>(resolve => { release = resolve; }); for (const spark of pool.sparks) spark.hold = hold;
  const pending = Array.from({ length: 26 }, (_, n) => pool.ask(`burst-${n}`));
  await eventually(() => pool.sparks.every(spark => spark.running === 10), "both Sparks fill to ten");
  await eventually(() => pool.admissions.load("qwen-1").queued + pool.admissions.load("qwen-2").queued === 6, "the rest wait");
  await delay(100); assert.deepEqual(pool.sparks.map(spark => spark.peak), [10, 10]);
  const row = await (await fetch(`${pool.base}/v1/availability?wait=2000`, { headers: pool.headers })).json() as any;
  const qwen = row.providers.find((p: any) => p.id === "qwen");
  assert.deepEqual([qwen.load, qwen.status, qwen.pool], [{ running: 20, queued: 6, limit: 20 }, "busy", ["qwen-1", "qwen-2"]], "twenty slots, never forty");
  assert.deepEqual([qwen.health.status, qwen.health.endpoints], ["healthy", { healthy: 2, total: 2 }]);
  release(); for (const reply of await Promise.all(pending)) assert.equal(reply.status, 200);
  assert.deepEqual(pool.sparks.map(spark => spark.peak), [10, 10]);
  assert.deepEqual(["qwen-1", "qwen-2"].map(id => pool.admissions.load(id)), [{ running: 0, queued: 0 }, { running: 0, queued: 0 }], "every slot is returned");
});

run("a queued new conversation takes a free slot on the other Spark; a warm one waits for its own", async pool => {
  for (const spark of pool.sparks) spark.slots = 1;
  await eventually(() => pool.admissions.limit("qwen-1") === 1 && pool.admissions.limit("qwen-2") === 1, "one slot each");
  const warm = await served(pool, "warm"); const cold = other(pool, warm);
  let freeWarm = () => {}; warm.hold = new Promise<void>(resolve => { freeWarm = resolve; }); let freeCold = () => {}; cold.hold = new Promise<void>(resolve => { freeCold = resolve; });
  const blockers = [pool.ask("block-1"), pool.ask("block-2")];
  await eventually(() => warm.running === 1 && cold.running === 1, "both busy");
  const warmTurn = pool.ask("warm"); const fresh = pool.ask("fresh");
  await eventually(() => pool.admissions.load("qwen-1").queued + pool.admissions.load("qwen-2").queued === 2, "both wait");
  freeCold(); cold.hold = undefined;
  assert.equal((await fresh).text, `from ${cold.name}`, "the new conversation uses the Spark that freed up");
  await delay(700); assert.equal(warm.chats.filter(entry => entry.session === "warm").length + cold.chats.filter(entry => entry.session === "warm").length, 1, "the warm one still waits");
  freeWarm(); assert.equal((await warmTurn).text, `from ${warm.name}`); await Promise.all(blockers);
});

run("a dead Spark moves its conversations at once, and they stay where they moved after it returns", async pool => {
  const homes = new Map<string, FakeSpark>(); for (let n = 0; n < 12; n++) homes.set(`t${n}`, await served(pool, `t${n}`));
  const dead = pool.sparks[0]; const alive = other(pool, dead); await dead.stop();
  const started = Date.now();
  for (const thread of homes.keys()) assert.equal(await served(pool, thread), alive);
  assert.ok(Date.now() - started < 8000, `failover must be quick, took ${Date.now() - started} ms`);
  for (let n = 0; n < 6; n++) assert.equal(await served(pool, `while-down-${n}`), alive);
  dead.seen = []; await dead.start(); await eventually(() => pool.admissions.limit("qwen-1") === 10, "capacity returns");
  for (const thread of homes.keys()) assert.equal(await served(pool, thread), alive, "no second cold prefill when the Spark returns");
  assert.equal(dead.chats.length, 0);
});

for (const mode of ["502", "503", "reset", "head-reset"] as const) run(`a Spark that answers ${mode} before any output loses the request to the other, once`, async pool => {
  configureNetworkRetryTiming({ sleep: async () => {} });
  const home = await served(pool, "chat"); const spare = other(pool, home); home.mode = mode;
  const before = home.chats.length; assert.equal(await served(pool, "chat"), spare);
  assert.equal(home.chats.length - before, mode.startsWith("5") ? 1 : 2, "a warm conversation retries a dropped connection once where its cache is; a dead worker's 5xx moves at once");
  assert.equal(spare.chats.filter(entry => entry.session === "chat").length, 1);
  home.mode = "ok"; assert.equal(await served(pool, "chat"), spare);
});

run("a brief restart of the front door keeps a warm conversation where its cache is", async pool => {
  const home = await served(pool, "warm"); home.mode = "reset";
  configureNetworkRetryTiming({ sleep: async () => { home.mode = "ok"; } });
  assert.equal(await served(pool, "warm"), home); assert.equal(other(pool, home).chats.length, 0);
});

for (const mode of ["400", "401", "429", "500", "empty"] as const) run(`an answer the model server itself gave (${mode}) is returned as it is and never replayed on the other Spark`, async pool => {
  const home = await served(pool, "chat"); home.mode = mode; const spare = other(pool, home); const before = spare.chats.length;
  const reply = await pool.ask("chat"); assert.notEqual(reply.status, 200); assert.equal(spare.chats.length, before);
  home.mode = "ok"; assert.equal(await served(pool, "chat"), home, "the conversation keeps its Spark");
});

run("a stream that breaks after output is never replayed; the client's retry fails over only if the Spark is really gone", async pool => {
  const home = await served(pool, "chat"); const spare = other(pool, home); home.mode = "mid-reset";
  const response = await fetch(`${pool.base}/v1/responses`, { method: "POST", headers: { ...pool.headers, "thread-id": "chat" }, body: JSON.stringify({ model: "qwen/qwen3.8-flash-next", input: "x", stream: true }) });
  const text = await response.text(); assert.match(text, /from /); assert.match(text, /response\.failed/);
  assert.equal(text.split("response.output_text.delta\n").length - 1 <= 1, true); assert.equal(spare.chats.length, 0, "no duplicate output from another Spark");
  home.mode = "ok"; assert.equal(await served(pool, "chat"), home, "one broken stream does not move a warm conversation");
  await home.stop(); assert.equal(await served(pool, "chat"), spare);
});

run("draining a Spark finishes its running work, moves its conversations and its waiting requests, and restores cleanly", async pool => {
  for (const spark of pool.sparks) spark.slots = 2;
  await eventually(() => pool.admissions.limit("qwen-1") === 2 && pool.admissions.limit("qwen-2") === 2, "two slots each");
  const home = await served(pool, "a"); const spare = other(pool, home); const pinned: string[] = ["a"];
  for (let n = 0; pinned.length < 4; n++) { assert.ok(n < 60); if (await served(pool, `more-${n}`) === home) pinned.push(`more-${n}`); }
  let release = () => {}; home.hold = new Promise<void>(resolve => { release = resolve; });
  const running = [pool.ask(pinned[0]), pool.ask(pinned[1])]; await eventually(() => home.running === 2, "two running");
  const waiting = pool.ask(pinned[2]); const id = home === pool.sparks[0] ? "qwen-1" : "qwen-2";
  await eventually(() => pool.admissions.load(id).queued === 1, "one waits for the Spark about to drain");
  home.slots = 0; await eventually(() => pool.admissions.limit(id) === 0, "drained");
  assert.equal((await waiting).text, `from ${spare.name}`, "a waiting request leaves the drained Spark");
  assert.equal(await served(pool, pinned[3]), spare); assert.equal(await served(pool, "brand-new"), spare);
  assert.equal(home.running, 2, "running work is not interrupted");
  release(); home.hold = undefined; for (const reply of await Promise.all(running)) assert.equal(reply.text, `from ${home.name}`);
  home.slots = 2; await eventually(() => pool.admissions.limit(id) === 2, "restored");
  assert.equal(await served(pool, pinned[3]), spare, "a moved conversation stays moved");
});

run("with both Sparks drained requests wait, and run as soon as either returns", async pool => {
  const home = await served(pool, "chat"); const spare = other(pool, home);
  for (const spark of pool.sparks) spark.slots = 0;
  await eventually(() => pool.admissions.limit("qwen-1") === 0 && pool.admissions.limit("qwen-2") === 0, "drained");
  let done = false; const waiting = pool.ask("chat").then(reply => { done = true; return reply; }); await delay(400); assert.equal(done, false);
  spare.slots = 10; assert.equal((await waiting).text, `from ${spare.name}`);
});

run("a caller that cancels while waiting leaves nothing behind", async pool => {
  for (const spark of pool.sparks) spark.slots = 0;
  await eventually(() => pool.admissions.limit("qwen-1") === 0 && pool.admissions.limit("qwen-2") === 0, "drained");
  const controller = new AbortController();
  const pending = fetch(`${pool.base}/v1/responses`, { method: "POST", signal: controller.signal, headers: { ...pool.headers, "thread-id": "gone" }, body: JSON.stringify({ model: "qwen/qwen3.8-flash-next", input: "x" }) }).catch(() => undefined);
  const queued = () => pool.admissions.load("qwen-1").queued + pool.admissions.load("qwen-2").queued;
  await eventually(() => queued() === 1, "waits"); controller.abort(); await pending; await eventually(() => queued() === 0, "leaves the queue");
  for (const spark of pool.sparks) spark.slots = 10;
  await eventually(() => pool.admissions.limit("qwen-1") === 10, "restored"); await delay(100);
  assert.equal(pool.sparks.reduce((sum, spark) => sum + spark.chats.length, 0), 0, "a cancelled request never starts");
});

run("a caller that cancels mid-answer frees its slot", async pool => {
  let release = () => {}; const hold = new Promise<void>(resolve => { release = resolve; }); for (const spark of pool.sparks) spark.hold = hold;
  const controller = new AbortController();
  const pending = fetch(`${pool.base}/v1/responses`, { method: "POST", signal: controller.signal, headers: { ...pool.headers, "thread-id": "gone" }, body: JSON.stringify({ model: "qwen/qwen3.8-flash-next", input: "x", stream: true }) }).then(r => r.text()).catch(() => undefined);
  const running = () => pool.admissions.load("qwen-1").running + pool.admissions.load("qwen-2").running;
  await eventually(() => running() === 1, "running"); controller.abort(); await pending; await eventually(() => running() === 0, "slot returned"); release();
});

run("with every Spark dead the request fails promptly and retryably, and recovers with the Sparks", async pool => {
  await served(pool, "chat"); for (const spark of pool.sparks) await spark.stop();
  configureNetworkRetryTiming({ sleep: async () => {}, budgetMs: 1000 });
  const reply = await pool.ask("chat"); assert.deepEqual([reply.status, reply.code], [503, "upstream_unavailable"]);
  assert.deepEqual(["qwen-1", "qwen-2"].map(id => pool.admissions.load(id).running), [0, 0]);
  for (const spark of pool.sparks) await spark.start();
  assert.equal((await pool.ask("chat")).status, 200);
});

run("a frozen Spark that accepts connections and never answers loses its conversations, a running one included", async pool => {
  const home = await served(pool, "chat"); const spare = other(pool, home); await served(pool, "idle-elsewhere"); home.mode = "frozen";
  const stuck = pool.ask("chat"); await eventually(() => home.frozen === 1, "the request reaches the frozen Spark");
  await delay(2000); assert.equal(spare.chats.filter(entry => entry.session === "chat").length, 0, "a short silence never moves a conversation");
  assert.equal((await stuck).text, `from ${spare.name}`); assert.equal(await served(pool, "chat"), spare);
  home.mode = "ok"; assert.equal(await served(pool, "chat"), spare);
  assert.deepEqual(["qwen-1", "qwen-2"].map(id => pool.admissions.load(id).running), [0, 0]);
});

run("a Spark that only stops publishing capacity keeps its conversations", async pool => {
  const home = await served(pool, "chat"); home.slots = undefined; await delay(1500);
  for (let n = 0; n < 5; n++) assert.equal(await served(pool, "chat"), home);
});

run("when this Mac loses its own network nobody is lost", async pool => {
  const home = await served(pool, "chat"); for (const spark of pool.sparks) await spark.stop(); await delay(1500);
  configureNetworkRetryTiming({ sleep: async () => {}, budgetMs: 10 }); assert.equal((await pool.ask("chat")).status, 503);
  for (const spark of pool.sparks) await spark.start(); await eventually(() => pool.admissions.limit("qwen-1") === 10 && pool.admissions.limit("qwen-2") === 10, "back");
  assert.equal(await served(pool, "chat"), home, "the conversation returns to its own cache");
});

run("missing capacity information falls back to the configured limit instead of stopping", async pool => {
  for (const spark of pool.sparks) spark.slots = undefined;
  await eventually(() => pool.admissions.limit("qwen-1") === 4 && pool.admissions.limit("qwen-2") === 4, "fallback");
  const home = await served(pool, "chat"); assert.equal(await served(pool, "chat"), home);
});

run("Qwen 1 and Qwen 2 can be chosen directly, share their slots with the pool and never fail over", async pool => {
  assert.equal(await served(pool, "direct", { model: "qwen-1/qwen3.8-flash-next" }), pool.sparks[0]); assert.equal(await served(pool, "direct", { model: "qwen-2/qwen3.8-flash-next" }), pool.sparks[1]);
  pool.sparks[0].slots = 1; await eventually(() => pool.admissions.limit("qwen-1") === 1, "one slot");
  let release = () => {}; pool.sparks[0].hold = new Promise<void>(resolve => { release = resolve; });
  const held = pool.ask("direct", { model: "qwen-1/qwen3.8-flash-next" }); await eventually(() => pool.sparks[0].running === 1, "held");
  for (let n = 0; n < 5; n++) assert.equal(await served(pool, `new-${n}`), pool.sparks[1], "the pool sees slots taken directly");
  release(); await held; await pool.sparks[0].stop(); configureNetworkRetryTiming({ sleep: async () => {}, budgetMs: 10 });
  assert.equal((await pool.ask("direct", { model: "qwen-1/qwen3.8-flash-next" })).status, 503, "an explicit choice is never redirected");
});

run("parallel requests of one new conversation share a Spark", async pool => {
  for (let n = 0; n < 15; n++) { const replies = await Promise.all(Array.from({ length: 5 }, () => pool.ask(`parallel-${n}`))); assert.equal(new Set(replies.map(reply => reply.text)).size, 1, `parallel-${n}`); }
});

run("session headers, Claude Messages sessions and cache keys are sticky too; a request without any identity still runs", async pool => {
  const viaSession = async () => (await pool.ask(undefined, {}, { "session-id": "only-session" })).text; assert.equal(await viaSession(), await viaSession());
  const viaKey = async () => (await pool.ask(undefined, { prompt_cache_key: "cache-key" })).text; const key = await viaKey(); for (let n = 0; n < 5; n++) assert.equal(await viaKey(), key);
  const viaMessages = async (agent?: string) => {
    const response = await fetch(`${pool.base}/v1/messages`, { method: "POST", headers: { ...pool.headers, "anthropic-version": "2023-06-01", ...(agent ? { "x-claude-code-agent-id": agent } : {}) }, body: JSON.stringify({ model: "qwen/qwen3.8-flash-next", max_tokens: 100, messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "", session_id: "11111111-2222-4333-8444-555555555555" }) } }) });
    const value = await response.json() as any; assert.equal(response.status, 200, JSON.stringify(value)); return value.content[0].text as string;
  };
  const main = await viaMessages(); for (let n = 0; n < 5; n++) assert.equal(await viaMessages(), main);
  const agent = await viaMessages("agent-7"); for (let n = 0; n < 5; n++) assert.equal(await viaMessages("agent-7"), agent);
  assert.equal((await pool.ask(undefined)).status, 200);
});

run("a configuration reload keeps conversations where they are, turns the pool off and on live, and tolerates a removed member", async pool => {
  const homes = new Map<string, FakeSpark>(); for (let n = 0; n < 8; n++) homes.set(`t${n}`, await served(pool, `t${n}`));
  pool.current.config = structuredClone(pool.config); for (const [thread, home] of homes) assert.equal(await served(pool, thread), home);
  const reduced = structuredClone(pool.config); reduced.providers = reduced.providers.filter(p => p.id !== "qwen-1"); pool.current.config = reduced;
  for (const thread of homes.keys()) assert.equal(await served(pool, thread), pool.sparks[1], "the remaining member serves everything");
  const off = structuredClone(pool.config); delete off.providers[0].pool; off.providers[0].baseUrl = `http://127.0.0.1:${pool.sparks[0].port}/v1`; pool.current.config = off;
  assert.equal(await served(pool, "t0"), pool.sparks[0], "without a pool the provider dials its own address again");
  pool.current.config = structuredClone(pool.config); assert.equal((await pool.ask("t1")).status, 200);
});

test("a restart reads back where every conversation lives, privately and without identifiers", { timeout: 30000 }, async () => {
  const first = await openPool(); const homes = new Map<string, string>(); let second: PoolHarness | undefined;
  try {
    for (let n = 0; n < 20; n++) homes.set(`secret-thread-${n}`, (await served(first, `secret-thread-${n}`)).name);
    // Load-balanced placement, not the hash, must be what is restored: force a placement the hash would not repeat.
    first.sparks[0].slots = 0; await eventually(() => first.admissions.limit("qwen-1") === 0, "drained");
    for (let n = 20; n < 30; n++) homes.set(`secret-thread-${n}`, (await served(first, `secret-thread-${n}`)).name);
    first.sparks[0].slots = 10; await new ProviderPoolPins(first.root, "qwen").flush(); await delay(400);
    const path = join(first.root, "provider-pool-qwen.json"); const text = await readFile(path, "utf8");
    assert.equal((await stat(path)).mode & 0o777, 0o600); assert.ok(!text.includes("secret-thread"));
    first.server.closeAllConnections(); await new Promise<void>(resolve => first.server.close(() => resolve())); forgetProviderPoolPins(first.root, "qwen");
    second = await openPool({ root: first.root, sparks: first.sparks });
    for (const [thread, home] of homes) assert.equal((await served(second, thread)).name, home, thread);
  } finally { if (second) await second.close(); else await first.close(); }
});

test("a damaged or foreign pin file is ignored, never fatal", { timeout: 30000 }, async () => {
  for (const damage of ["not json", "[]", '{"version":1,"pins":{"zz":["qwen-1",1],"' + "a".repeat(64) + '":["../x",1]}}', '{"version":2}']) {
    const first = await openPool(); const { writeFile } = await import("node:fs/promises");
    first.server.closeAllConnections(); await new Promise<void>(resolve => first.server.close(() => resolve())); forgetProviderPoolPins(first.root, "qwen");
    await writeFile(join(first.root, "provider-pool-qwen.json"), damage, { mode: 0o600 });
    const second = await openPool({ root: first.root, sparks: first.sparks }); try { assert.equal((await second.ask("x")).status, 200); } finally { await second.close(); await rm(first.root, { recursive: true, force: true }); }
  }
});
