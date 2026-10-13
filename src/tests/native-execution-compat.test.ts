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

test("the actual desktop Code Mode host flag attaches only when the signed SDK confirms it already enabled", async () => {
  const calls: Message[] = []; let checks = 0;
  const args = ["-c", "features.code_mode_host=true", "app-server", flag, "-c", 'model="native"'];
  const result = await acquireNativeCompatible(async params => {
    calls.push(params);
    if (JSON.stringify(params.args) !== JSON.stringify(["app-server", "-c", 'model="native"'])) throw refusal();
    return record;
  }, args, "/original/home", async () => { checks++; return true; });
  assert.equal(result, record); assert.equal(checks, 1); assert.equal(calls.length, 4);
  assert.deepEqual(args, ["-c", "features.code_mode_host=true", "app-server", flag, "-c", 'model="native"']);
});

test("disabled or unavailable Code Mode host never loses its requested flag", async () => {
  const args = ["-c", "features.code_mode_host=true", "app-server", flag]; const calls: Message[] = [];
  await assert.rejects(acquireNativeCompatible(async params => { calls.push(params); throw refusal(); }, args, "/home", async () => false), /startup settings differ/);
  assert.equal(calls.length, 2); for (const call of calls) assert.ok((call.args as string[]).includes("features.code_mode_host=true"));
});

test("explicit false and conflicting Code Mode flags remain untouched and refused", async () => {
  for (const args of [["-c", "features.code_mode_host=false", "app-server"], ["--disable", "code_mode_host", "app-server"],
    ["-c", "features.code_mode_host=true", "--config=features.code_mode_host=false", "app-server"]]) {
    let calls = 0; let checks = 0;
    await assert.rejects(acquireNativeCompatible(async () => { calls++; throw refusal(); }, args, "/home", async () => { checks++; return true; }), /startup settings differ/);
    assert.equal(calls, 2); assert.equal(checks, 0);
  }
});
