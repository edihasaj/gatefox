import test from "node:test";
import assert from "node:assert/strict";
import { acquireNativeCompatible } from "../native-execution-compat.js";
import type { Message } from "../app-server-connection.js";

const flag = "--analytics-default-enabled";
const refusal = () => Object.assign(new Error("Native execution startup settings differ; existing ownership was preserved"), { code: -32000 });
const record = { kind: "native", pid: 123, revision: "existing-owner" };

for (const first of ["desktop", "relay"]) {
  test(`a new client attaches to an older ${first}-first owner without replacing it`, async () => {
    const args = ["app-server", "-c", "analytics.enabled=false", ...(first === "relay" ? [flag] : [])];
    const original = [...args]; const calls: Message[] = [];
    const result = await acquireNativeCompatible(async params => {
      calls.push(params);
      if (calls.length === 1) throw refusal();
      assert.equal((params.args as string[]).includes(flag), first === "desktop");
      assert.ok((params.args as string[]).includes("analytics.enabled=false"));
      assert.equal(params.cwd, "/original/home");
      return record;
    }, args, "/original/home");
    assert.equal(result, record); assert.equal(calls.length, 2); assert.deepEqual(args, original);
  });
}

test("current hosts receive the original startup settings exactly once", async () => {
  const args = ["app-server", flag]; let calls = 0;
  assert.equal(await acquireNativeCompatible(async params => {
    calls++; assert.equal(params.args, args); return record;
  }, args, "/original/home"), record);
  assert.equal(calls, 1);
});

test("transport, unavailable host, malformed and unrelated errors never trigger compatibility retries", async () => {
  const failures = [new Error("Socket disconnected"), Object.assign(new Error("Execution host is quiescing for an idle restart"), { code: -32000 }),
    Object.assign(new Error("Native execution startup settings differ; existing ownership was preserved"), { code: -32001 }),
    Object.assign(new Error("Native execution startup settings differ; other error"), { code: -32000 }), { code: -32000 }];
  for (const failure of failures) {
    let calls = 0;
    await assert.rejects(acquireNativeCompatible(async () => { calls++; throw failure; }, ["app-server", flag], "/home"), error => error === failure);
    assert.equal(calls, 1);
  }
});

test("incompatible settings remain rejected after one bounded default-only retry", async () => {
  const calls: Message[] = []; const failure = refusal(); const args = ["app-server", flag, "--profile", "different"];
  await assert.rejects(acquireNativeCompatible(async params => { calls.push(params); throw failure; }, args, "/different/home"), error => error === failure);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { args: ["app-server", "--profile", "different"], cwd: "/different/home" });
});
