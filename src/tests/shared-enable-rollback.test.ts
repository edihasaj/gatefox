import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { type ServicePlan } from "../service-plan.js";
import { executionHostHome, readOwner } from "../execution-host-storage.js";
import { rollBackEnable, relaunchOntoPlan } from "../mac-shared-plan-swap.js";
import { archiveStoppedExecutionReceipt } from "../service-execution-recovery.js";
import { fastTiming, standInFixture, type StandInFixture } from "./launchd-stand-in.js";

// enableSharedExecutors and enableSharedNative undo a failed migration through rollBackEnable. The stand-in service is a launchd
// with KeepAlive that claims receipts with the real claimHost, and the real archiveStoppedExecutionReceipt archives them.

const skip = process.platform !== "darwin";
const planOnDisk = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ServicePlan;
/** A migration that enabled `next` and failed: the replacement runs it and holds the host receipt. */
async function failedEnable(f: StandInFixture, next: ServicePlan) {
  const original = await readFile(f.planPath, "utf8"); await writePrivateJson(f.planPath, next); await f.launchd.restart();
  const archived: string[] = [];
  const rollback = (previous: ServicePlan, beforePid: number | undefined = 1000) => rollBackEnable({ configPath: f.config, state: f.directory, path: f.planPath, original, previous, next, beforePid,
    archive: async () => { archived.push("archive"); await archiveStoppedExecutionReceipt({ configPath: f.config, nativeHome: f.nativeHome, codex: f.host.codex, sdkSha256: "0".repeat(64) }, join(f.directory, "backup")); },
    services: f.launchd.services(), timing: fastTiming });
  return { original, archived, rollback };
}

test("a failed shared-executors enable is undone by the plan swap and the stopped receipt is archived once the service runs the previous plan", { skip }, async () => {
  const f = await standInFixture({}); f.launchd.gap = 2; f.launchd.startup = 3;
  try {
    const { original, archived, rollback } = await failedEnable(f, { ...f.plan, sharedExecutors: true });
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: true, sharedNativeExecutor: false }]);
    assert.equal((await rollback(f.plan)).outcome, "restored");
    assert.equal(await readFile(f.planPath, "utf8"), original);
    // The replacement host was stopped by the restart, the relaunch ran the previous plan without a host, and then the receipt was archived.
    assert.deepEqual(f.launchd.relaunched.at(-1), { pid: 1002, sharedExecutors: false, sharedNativeExecutor: false });
    assert.deepEqual(archived, ["archive"]); assert.deepEqual(f.host.errors, []);
    assert.deepEqual((await readdir(executionHostHome(f.config, f.nativeHome))).filter(name => name === "owner.json"), []);
  } finally { await f.cleanup(); }
});

test("a rollback to a plan that still shares native leaves the receipt to the relaunched host", { skip }, async () => {
  const f = await standInFixture({ sharedNativeExecutor: true });
  try {
    const { original, archived, rollback } = await failedEnable(f, { ...f.plan, sharedExecutors: true });
    assert.equal((await rollback(f.plan)).outcome, "restored");
    assert.equal(await readFile(f.planPath, "utf8"), original); assert.deepEqual(archived, []); assert.deepEqual(f.host.errors, []);
    const owner = await readOwner(join(executionHostHome(f.config, f.nativeHome), "owner.json"));
    assert.equal(owner?.state, "running"); assert.deepEqual(owner?.capabilities, ["native"]);
  } finally { await f.cleanup(); }
});

test("a refused migration restart leaves the original process, which needs no restart", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const next = { ...f.plan, sharedExecutors: true };
    const original = await readFile(f.planPath, "utf8"); await writePrivateJson(f.planPath, next);
    const outcome = await rollBackEnable({ configPath: f.config, state: f.directory, path: f.planPath, original, previous: f.plan, next, beforePid: 1000,
      archive: async () => assert.fail("nothing to archive"), services: f.launchd.services(), timing: fastTiming });
    assert.equal(outcome.outcome, "restored"); assert.equal(await readFile(f.planPath, "utf8"), original); assert.equal(f.launchd.restartCalls, 0);
  } finally { await f.cleanup(); }
});

test("a replacement whose restart is refused keeps running and the plan file keeps naming its plan", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const next = { ...f.plan, sharedExecutors: true }; const { archived, rollback } = await failedEnable(f, next);
    f.launchd.refuseIdle = true;
    assert.equal((await rollback(f.plan)).outcome, "preserved");
    assert.deepEqual(await planOnDisk(f.planPath), next); assert.deepEqual(archived, []);
    assert.equal(f.launchd.pid, 1001); assert.equal(f.launchd.restartCalls, 1 + fastTiming.restartAttempts);
    assert.equal((await readOwner(join(executionHostHome(f.config, f.nativeHome), "owner.json")))?.state, "running", "its receipt is untouched");
    assert.ok((await readdir(f.directory)).every(name => !name.endsWith(".tmp")));
  } finally { await f.cleanup(); }
});

test("an archive that fails after the service runs the previous plan is reported as such, with the plan restored", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const next = { ...f.plan, sharedExecutors: true }; const original = await readFile(f.planPath, "utf8");
    await writePrivateJson(f.planPath, next); await f.launchd.restart();
    const outcome = await rollBackEnable({ configPath: f.config, state: f.directory, path: f.planPath, original, previous: f.plan, next, beforePid: 1000,
      archive: async () => { throw new Error("receipt could not be archived"); }, services: f.launchd.services(), timing: fastTiming });
    assert.equal(outcome.outcome, "archive_failed"); assert.equal(await readFile(f.planPath, "utf8"), original);
  } finally { await f.cleanup(); }
});

test("a service that cannot be inspected or started is reported, not assumed", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const services = f.launchd.services();
    assert.equal(await relaunchOntoPlan({ ...services, status: async () => { throw new Error("launchctl failed"); } }, f.config, f.directory, 1000, fastTiming), "unknown");
    assert.equal(await relaunchOntoPlan({ ...services, status: async () => ({ installed: true }), install: async () => { throw new Error("bootstrap failed"); } }, f.config, f.directory, 1000, fastTiming), "down");
  } finally { await f.cleanup(); }
});
