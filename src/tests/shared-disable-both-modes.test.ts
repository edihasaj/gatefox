import test from "node:test";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { disableSharing } from "../mac-shared-disable.js";
import { type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { archiveStoppedNativeHomeReceipt } from "../mac-shared-plan-swap.js";
import { executionHostHome, readOwner } from "../execution-host-storage.js";
import { nativeHomeOwnerPath, readNativeHomeOwner } from "../native-execution-host-storage.js";
import { archiveStoppedExecutionReceipt } from "../service-execution-recovery.js";
import { standInFixture } from "./launchd-stand-in.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // The stand-in host claims its receipts inside the test process: see src/tests/in-process-host.ts.

// Both sharing modes can be on together. Turning one off leaves the other on, so the relaunched supervisor starts a host at the
// same home and claims the receipt itself. The stand-in service claims receipts with the real claimHost, and the real
// archiveStoppedExecutionReceipt runs wherever the change archives, so a race with the claim fails here the way it would on a Mac.

const exists = (path: string) => access(path).then(() => true, () => false);
const planOnDisk = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ServicePlan;

test("archiving the host receipt after a relaunch that keeps a mode races the new host's claim and is refused", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true, sharedNativeExecutor: true });
  try {
    // What the earlier order did: restart onto the plan that keeps native, then archive.
    const { sharedExecutors: _off, ...next } = f.plan; await writePrivateJson(f.planPath, next);
    await f.launchd.restart();
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: false, sharedNativeExecutor: true }]);
    assert.equal((await readOwner(join(executionHostHome(f.config, f.nativeHome), "owner.json")))?.state, "running", "the new host already claimed the receipt");
    await assert.rejects(archiveStoppedExecutionReceipt({ configPath: f.config, nativeHome: f.nativeHome, codex: f.host.codex, sdkSha256: "0".repeat(64) }, join(f.directory, "backup")), /not fully stopped|fully stopped/);
  } finally { await f.cleanup(); }
});

test("turning off shared executors while shared native stays leaves the receipt to the new host's claim", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true, sharedNativeExecutor: true }); f.launchd.gap = 2;
  try {
    const result = await disableSharing(f.config, "shared-executors", true, f.deps);
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: false, sharedNativeExecutor: true }]);
    // Nothing was archived and nothing threw: the relaunched host took over the stopped receipts through claimHost.
    assert.deepEqual(f.calls, ["restart"]); assert.deepEqual(f.host.errors, []);
    const owner = await readOwner(join(executionHostHome(f.config, f.nativeHome), "owner.json"));
    assert.equal(owner?.state, "running"); assert.deepEqual(owner?.capabilities, ["native"]); assert.equal(owner?.pid, process.pid);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.state, "running");
    assert.equal(result.applied, true); assert.equal((await planOnDisk(f.planPath)).sharedExecutors, undefined); assert.equal((await planOnDisk(f.planPath)).sharedNativeExecutor, true);
    assert.ok(!(await readdir(result.backup as string)).some(name => name.endsWith("owner.json")), "no receipt was archived");
  } finally { await f.cleanup(); }
});

test("turning off shared native while shared executors stays releases only the native-home receipt", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true, sharedNativeExecutor: true }); f.launchd.gap = 2;
  try {
    const result = await disableSharing(f.config, "shared-native", true, f.deps);
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: true, sharedNativeExecutor: false }]);
    assert.deepEqual(f.calls, ["restart", "release-native"]); assert.deepEqual(f.host.errors, []);
    // The new host owns owner.json for gateway chats only; the stopped native-home receipt moved into the backup.
    const owner = await readOwner(join(executionHostHome(f.config, f.nativeHome), "owner.json"));
    assert.equal(owner?.state, "running"); assert.deepEqual(owner?.capabilities, ["gateway"]);
    assert.equal(await exists(nativeHomeOwnerPath(f.nativeHome)), false);
    const backup = await readdir(result.backup as string);
    assert.ok(backup.includes("native-execution-owner.json")); assert.ok(!backup.includes("execution-owner.json"));
    assert.equal((await planOnDisk(f.planPath)).sharedExecutors, true); assert.equal((await planOnDisk(f.planPath)).sharedNativeExecutor, undefined);
  } finally { await f.cleanup(); }
});

test("a native-home receipt that is not stopped is never released", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true, sharedNativeExecutor: true });
  try {
    // The running host still holds the native home.
    await assert.rejects(archiveStoppedNativeHomeReceipt({ configPath: f.config, nativeHome: f.nativeHome }, join(f.directory, "backup")), /Native execution ownership is not fully stopped; its receipt was preserved/);
    assert.equal((await readNativeHomeOwner(f.nativeHome))?.state, "running"); assert.ok(await exists(nativeHomeOwnerPath(f.nativeHome)));
    await assert.rejects(archiveStoppedNativeHomeReceipt({ configPath: join(f.directory, "other.json"), nativeHome: f.nativeHome }, join(f.directory, "backup")), /belongs to another configuration/);
  } finally { await f.cleanup(); }
});

test("a restart that times out during the throttle gap, with both modes on, rolls back onto a relaunch that claims the receipt", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true, sharedNativeExecutor: true }); f.launchd.gap = 3; f.launchd.restartTimesOut = true;
  try {
    const original = await readFile(f.planPath, "utf8");
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), /and the service, which was down, was started\.$/);
    assert.equal(await readFile(f.planPath, "utf8"), original);
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: true, sharedNativeExecutor: true }]); assert.deepEqual(f.host.errors, []);
    const owner = await readOwner(join(executionHostHome(f.config, f.nativeHome), "owner.json"));
    assert.equal(owner?.state, "running"); assert.deepEqual(new Set(owner?.capabilities), new Set(["native", "gateway"]));
  } finally { await f.cleanup(); }
});
