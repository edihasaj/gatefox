import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { configureNetworkRetryTiming, resetNetworkRetryTiming } from "../providers/network-retry.js";
import { eventually, openPool } from "./provider-pool-fixture.js";

/** Reproducible: a failure names its seed. */
function random(seed: number): () => number { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; }; }

for (const seed of [1, 7, 42]) test(`random crashes, drains, restarts, cancellations and reloads never lose or leak a request (seed ${seed})`, { timeout: 90000 }, async () => {
  const next = random(seed); const shake = random(seed + 1000); const pool = await openPool(); for (const spark of pool.sparks) spark.latency = () => 2 + next() * 28; configureNetworkRetryTiming({ sleep: async (_ms, signal) => { await delay(5, undefined, { signal }); } });
  const up = [true, true]; const drained = [false, false]; let cancelled = 0, finished = 0, kills = 0, drains = 0, stop = false; const problems: string[] = [];
  // Never take the last serving Spark away: then every request that is not cancelled must succeed.
  const serving = (index: number) => up[index] && !drained[index];
  const disturb = (async () => {
    // Both serve first, so each holds conversations that the disturbances then move.
    await eventually(() => pool.sparks.every(spark => spark.chats.length > 20), "both Sparks work");
    while (!stop) {
      const index = shake() < 0.5 ? 0 : 1; const spark = pool.sparks[index]; const action = shake();
      if (action < 0.3 && serving(1 - index) && up[index]) { up[index] = false; kills++; await spark.stop(); }
      else if (action < 0.55 && !up[index]) { await spark.start(); up[index] = true; }
      else if (action < 0.7 && serving(1 - index)) { drained[index] = true; drains++; spark.slots = 0; }
      else if (action < 0.85) { drained[index] = false; spark.slots = 10; }
      else if (action < 0.95 && serving(1 - index)) spark.mode = shake() < 0.5 ? "503" : "reset";
      else { spark.mode = "ok"; pool.current.config = structuredClone(pool.config); }
      // A member that fails requests counts as not serving, so both can never fail at once.
      if (pool.sparks.every(entry => entry.mode !== "ok")) pool.sparks[0].mode = pool.sparks[1].mode = "ok";
      if (pool.sparks[index].mode !== "ok" && !serving(1 - index)) pool.sparks[index].mode = "ok";
      if (pool.sparks[1 - index].mode !== "ok" && !serving(index)) pool.sparks[1 - index].mode = "ok";
      await delay(30 + shake() * 50);
    }
  })();
  let id = 0;
  const client = async (worker: number) => {
    for (let n = 0; n < 100; n++) {
      const marker = `m${id++}`; const thread = `w${worker}-${Math.floor(next() * 4)}`;
      if (next() < 0.15) {
        const controller = new AbortController(); setTimeout(() => controller.abort(), next() * 25);
        await fetch(`${pool.base}/v1/responses`, { method: "POST", signal: controller.signal, headers: { ...pool.headers, "thread-id": thread }, body: JSON.stringify({ model: "qwen/qwen3.8-flash-next", input: `cancel-me ${marker}`, stream: true }) }).then(r => r.text()).catch(() => undefined); cancelled++; continue;
      }
      // A Spark may die after output began; that one failure is the client's to retry, exactly as Codex does.
      let reply = await pool.ask(thread, { input: marker }); for (let tries = 0; reply.status !== 200 && tries < 5; tries++) { await delay(20); reply = await pool.ask(thread, { input: marker }); }
      if (reply.status !== 200 || !/^from (one|two)$/.test(reply.text)) problems.push(`${marker} ${JSON.stringify(reply)}`); else finished++;
    }
  };
  try {
    await Promise.all(Array.from({ length: 24 }, (_, worker) => client(worker))); stop = true; await disturb;
    assert.deepEqual(problems, []); assert.equal(finished + cancelled, 24 * 100);
    assert.ok(pool.sparks.every(spark => spark.peak <= 10), `neither exceeded its slots: ${pool.sparks.map(spark => spark.peak)}`);
    assert.ok(kills >= 2 && drains >= 2, `the run must disturb: ${kills} kills, ${drains} drains`);
    await eventually(() => ["qwen", "qwen-1", "qwen-2"].every(name => { const load = pool.admissions.load(name); return load.running === 0 && load.queued === 0; }), "every slot and queue place is returned");
    for (const [index, spark] of pool.sparks.entries()) { if (!up[index]) await spark.start(); spark.mode = "ok"; spark.slots = 10; }
    await eventually(() => pool.admissions.limit("qwen-1") === 10 && pool.admissions.limit("qwen-2") === 10, "both return");
    const homes = new Map<string, string>(); for (let turn = 0; turn < 3; turn++) for (let n = 0; n < 12; n++) { const reply = await pool.ask(`after-${n}`); assert.equal(reply.status, 200); assert.equal(homes.get(`after-${n}`) ?? reply.text, reply.text); homes.set(`after-${n}`, reply.text); }
  } finally { stop = true; await disturb; resetNetworkRetryTiming(); await pool.close(); }
});
