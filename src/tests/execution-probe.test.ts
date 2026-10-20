import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionProbeManager, executionProbeChildRunner, executionProbeReportValid, type ExecutionProbeChildResult, type ExecutionProbeHostSnapshot } from "../execution-probe.js";
import type { GatewaySdkRuntime } from "../gateway-sdk-runtime.js";

const runtime = (suffix = "a"): GatewaySdkRuntime => ({
  executable: `/private/release-${suffix}/package/gateway-sdk/gateway-codex`,
  binarySha256: suffix.repeat(64),
  selectedModelCompaction: true,
  executorIdentity: true,
});
const snapshot = (suffix = "a"): ExecutionProbeHostSnapshot => ({
  hostPid: 1234,
  startedAtMs: 1_700_000_000_000,
  runningRelease: "0.6.1",
  sourceCommit: suffix.repeat(40),
  catalogFingerprint: suffix.repeat(64),
});
const passed: ExecutionProbeChildResult = {
  sdkVerified: true, configVerified: true, directToolVerified: true, completedTurn: true, commandVerified: true,
};

test("execution probe coalesces concurrent readiness calls and includes only scrubbed proof", async () => {
  let calls = 0;
  const manager = new ExecutionProbeManager({
    runtime: async () => runtime(),
    snapshot: async () => snapshot(),
    runChild: async input => {
      calls++;
      assert.equal(input.sdkSha256, "a".repeat(64));
      assert.equal(input.catalogFingerprint, "a".repeat(64));
      return passed;
    },
  });
  const [first, second] = await Promise.all([manager.run(), manager.run()]);
  assert.equal(calls, 1);
  assert.equal(first.ready, true);
  assert.equal(first.reason, "ready");
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), ["catalogFingerprint", "checkedAt", "commandVerified", "completedTurn", "configVerified", "directToolVerified", "hostPid", "ready", "reason", "runningRelease", "sdkSha256", "sdkVerified", "sourceCommit", "startedAtMs"].sort());
  assert.equal(executionProbeReportValid(first), true);
  await manager.close();
});

test("execution probe refuses a host identity that changed during the canary", async () => {
  let read = 0;
  const manager = new ExecutionProbeManager({
    runtime: async () => runtime(),
    snapshot: async () => ++read === 1 ? snapshot() : { ...snapshot(), catalogFingerprint: "b".repeat(64) },
    runChild: async () => passed,
  });
  const result = await manager.run();
  assert.equal(result.ready, false);
  assert.equal(result.reason, "identity_changed");
  assert.equal(result.directToolVerified, true, "the proof is retained, but cannot prove this new host/catalog");
  await manager.close();
});

test("execution probe refuses a selected runtime that changed while the child ran", async () => {
  let read = 0;
  const manager = new ExecutionProbeManager({
    runtime: async () => ++read === 1 ? runtime() : runtime("b"),
    snapshot: async () => snapshot(),
    runChild: async () => passed,
  });
  const result = await manager.run();
  assert.equal(result.ready, false);
  assert.equal(result.reason, "runtime_changed");
  await manager.close();
});

test("execution probe bounds a stuck child and never accepts malformed public reports", async () => {
  const manager = new ExecutionProbeManager({
    runtime: async () => runtime(),
    snapshot: async () => snapshot(),
    timeoutMs: 10,
    runChild: async (_input, signal) => new Promise<ExecutionProbeChildResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
  });
  const result = await manager.run();
  assert.equal(result.ready, false);
  assert.equal(result.reason, "child_timeout");
  assert.equal(executionProbeReportValid({ ...result, error: "/private/secret" }), false, "an unknown diagnostic field cannot cross the RPC boundary");
  assert.equal(executionProbeReportValid({ ...result, reason: "bad" }), false);
  assert.equal(executionProbeReportValid({ ...result, checkedAt: "not-a-date" }), false);
  await manager.close();
});

test("execution probe close cancels its owned child", async () => {
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const manager = new ExecutionProbeManager({
    runtime: async () => runtime(),
    snapshot: async () => snapshot(),
    runChild: async (_input, signal) => {
      entered();
      return new Promise<ExecutionProbeChildResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("closed")), { once: true }));
    },
  });
  const probe = manager.run();
  await enteredPromise;
  await manager.close();
  const result = await probe;
  assert.equal(result.ready, false);
  assert.equal(result.reason, "child_cancelled");
});

test("execution probe close returns promptly during an unresolved initial lookup and never starts a child", async () => {
  let resolveRuntime!: (value: GatewaySdkRuntime | undefined) => void;
  let entered!: () => void;
  const enteredLookup = new Promise<void>(resolve => { entered = resolve; });
  const heldRuntime = new Promise<GatewaySdkRuntime | undefined>(resolve => { resolveRuntime = resolve; });
  let children = 0;
  const manager = new ExecutionProbeManager({
    runtime: async () => { entered(); return heldRuntime; },
    snapshot: async () => snapshot(),
    runChild: async () => { children++; return passed; },
  });
  const probe = manager.run();
  await enteredLookup;
  await manager.close();
  const result = await probe;
  assert.equal(result.reason, "child_cancelled");
  assert.equal(children, 0);
  resolveRuntime(runtime());
  await delay(10);
  assert.equal(children, 0, "a late verifier answer cannot start an owned child after close");
});

test("execution probe bounds the initial runtime lookup with the total deadline", { timeout: 5000 }, async () => {
  let children = 0;
  const manager = new ExecutionProbeManager({
    runtime: async () => new Promise<GatewaySdkRuntime | undefined>(() => {}),
    snapshot: async () => snapshot(),
    timeoutMs: 10,
    runChild: async () => { children++; return passed; },
  });
  const result = await manager.run();
  assert.equal(result.reason, "child_timeout");
  assert.equal(children, 0);
  await manager.close();
});

test("execution probe cannot publish readiness when close arrives during its post-child identity check", async () => {
  let calls = 0;
  let releaseLater!: (value: GatewaySdkRuntime | undefined) => void;
  let childCalls = 0;
  const manager = new ExecutionProbeManager({
    runtime: async () => ++calls === 1 ? runtime() : new Promise<GatewaySdkRuntime | undefined>(resolve => { releaseLater = resolve; }),
    snapshot: async () => snapshot(),
    runChild: async () => { childCalls++; return passed; },
  });
  const probe = manager.run();
  for (let attempt = 0; attempt < 100 && calls < 2; attempt++) await delay(5);
  assert.equal(calls, 2, "the child finished and post-child verification began");
  await manager.close();
  const result = await probe;
  assert.equal(childCalls, 1);
  assert.equal(result.reason, "child_cancelled");
  assert.equal(result.ready, false);
  releaseLater(runtime());
});

test("execution probe cancellation reaps the fixed child's descendants", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "gateway-probe-group-"));
  const child = executionProbeChildRunner(new URL("./execution-probe-child-fixture.js", import.meta.url));
  let ownedRoot = "";
  const manager = new ExecutionProbeManager({
    runtime: async () => ({ ...runtime(), executable: join(packageDirectory, "gateway-sdk", "gateway-codex") }),
    snapshot: async () => snapshot(),
    runChild: async (input, signal) => { ownedRoot = input.root; return child(input, signal); },
  });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    const probe = manager.run();
    let pid = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      pid = ownedRoot ? Number(await readFile(join(ownedRoot, "probe-descendant.pid"), "utf8").catch(() => "0")) : 0;
      if (pid > 0) break;
      await delay(10);
    }
    assert.ok(pid > 0 && alive(pid), "fixture descendant started");
    await manager.close();
    const result = await probe;
    assert.equal(result.reason, "child_cancelled");
    for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await delay(10);
    assert.equal(alive(pid), false, "the outer private process group reaped the SDK-like descendant");
    await assert.rejects(access(ownedRoot), { code: "ENOENT" }, "the manager removes its owned temporary root after reaping the group");
  } finally { await manager.close(); await rm(packageDirectory, { recursive: true, force: true }); }
});
