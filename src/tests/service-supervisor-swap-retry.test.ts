import test from "node:test";
import assert from "node:assert/strict";
import { swapWhenFree } from "../service-supervisor.js";

test("a live swap refused for a brief host probe retries within seconds and wins once the probe ends", async () => {
  let tries = 0; const waits: number[] = [];
  const result = await swapWhenFree(async () => ++tries === 3, () => true, 15, 2000, async ms => { waits.push(ms); });
  assert.equal(result, true); assert.equal(tries, 3); assert.deepEqual(waits, [2000, 2000]);
});

test("a swap still blocked by brief work after every retry says so, so the reason can be logged", async () => {
  let tries = 0;
  assert.equal(await swapWhenFree(async () => { tries++; return false; }, () => true, 4, 1, async () => {}), "busy");
  assert.equal(tries, 4);
});

test("any other refusal (a changed plan, an inactive candidate) is not retried", async () => {
  let tries = 0;
  assert.equal(await swapWhenFree(async () => { tries++; return false; }, () => false, 15, 1, async () => {}), false);
  assert.equal(tries, 1);
});
