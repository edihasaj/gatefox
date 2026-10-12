import test from "node:test";
import assert from "node:assert/strict";
import { Admission } from "../admission.js";

test("bursts wait in FIFO order without exceeding provider concurrency", async () => {
  const queue = new Admission(4); let maximum = 0; const order: number[] = [];
  await Promise.all(Array.from({ length: 30 }, async (_, index) => {
    const release = await queue.acquire(new AbortController().signal);
    maximum = Math.max(maximum, queue.running); order.push(index);
    await new Promise(resolve => setImmediate(resolve)); release(); release();
  }));
  assert.equal(maximum, 4); assert.deepEqual(order, Array.from({ length: 30 }, (_, index) => index));
  assert.equal(queue.running, 0); assert.equal(queue.queued, 0);
});
test("queue is bounded, cancelled waiters never run, and later work recovers", async () => {
  const queue = new Admission(1, 2); const release = await queue.acquire(new AbortController().signal);
  const cancelled = new AbortController(); const waiting = queue.acquire(cancelled.signal);
  const rejected = assert.rejects(waiting); const next = queue.acquire(new AbortController().signal);
  await assert.rejects(queue.acquire(new AbortController().signal), { code: "busy", status: 429 });
  cancelled.abort(); await rejected; assert.equal(queue.queued, 1);
  release(); const nextRelease = await next; assert.equal(queue.running, 1); nextRelease();
  assert.equal(queue.running, 0); assert.equal(queue.queued, 0);
});
test("live concurrency limits start waiting work and never preempt active providers", async () => {
  const queue = new Admission(1); const first = await queue.acquire(new AbortController().signal);
  const next = queue.acquire(new AbortController().signal); queue.setLimit(2);
  const second = await next; queue.setLimit(1); assert.equal(queue.running, 2);
  first(); second(); assert.equal(queue.running, 0);
});
