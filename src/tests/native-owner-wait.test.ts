import test from "node:test";
import assert from "node:assert/strict";
import { awaitHostNativeOwnership } from "../execution-host-client.js";

const held = () => Object.assign(new Error("Native execution ownership is held by a live owner; existing ownership was preserved"), { nativeOwnerHeld: true });

test("a host that claims the native home after the old host exits is waited for, not raced by a private engine", async () => {
  let calls = 0;
  const record = await awaitHostNativeOwnership(async () => { if (++calls < 3) throw held(); return { socketPath: "/host.sock" }; },
    async () => false, undefined, 2000, 5);
  assert.deepEqual(record, { socketPath: "/host.sock" });
  assert.equal(calls, 3);
});

test("private engines that already hold the native home are joined at once, as before", async () => {
  let calls = 0;
  const record = await awaitHostNativeOwnership(async () => { calls++; return { socketPath: "/host.sock" }; }, async () => true, undefined, 2000, 5);
  assert.equal(record, undefined); assert.equal(calls, 0);
});

test("the wait ends on its deadline or on cancellation, and any other refusal is thrown", async () => {
  assert.equal(await awaitHostNativeOwnership(async () => { throw held(); }, async () => false, undefined, 40, 5), undefined);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await awaitHostNativeOwnership(async () => ({ ok: true }), async () => false, cancelled.signal, 2000, 5), undefined);
  await assert.rejects(awaitHostNativeOwnership(async () => { throw new Error("socket changed"); }, async () => false, undefined, 2000, 5), /socket changed/);
});
