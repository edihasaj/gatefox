import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { type ServicePlan } from "../service-plan.js";
import { enableRollbackMessage, rollBackEnable, type EnableRollback, type PlanSwapServices } from "../mac-shared-plan-swap.js";
import { fastTiming, standInFixture, type StandInFixture } from "./launchd-stand-in.js";

// Every way rollBackEnable can end, and the message the caller builds for it: the message names the plan that runs and the one
// command that fixes it. The stand-in service is a launchd with KeepAlive; the services below wrap it where a call must fail.

const skip = process.platform !== "darwin";
const mode = "shared-executors";
interface Run { f: StandInFixture; original: string; next: ServicePlan; archived: string[]; backup: string }

/** A failed enable: the plan file holds `next`, and (unless `replace` is false) the replacement runs it as pid 1001. */
async function failedEnable(f: StandInFixture, replace = true): Promise<Run> {
  const original = await readFile(f.planPath, "utf8"); const next = { ...f.plan, sharedExecutors: true };
  await writePrivateJson(f.planPath, next); if (replace) await f.launchd.restart();
  return { f, original, next, archived: [], backup: join(f.directory, "backup") };
}
const rollback = (run: Run, services: PlanSwapServices, extra: { path?: string; beforePid?: number } = {}): Promise<EnableRollback> =>
  rollBackEnable({ configPath: run.f.config, state: run.f.directory, path: extra.path ?? run.f.planPath, original: run.original, previous: run.f.plan, next: run.next,
    beforePid: "beforePid" in extra ? extra.beforePid : 1000, archive: async () => { run.archived.push("archive"); }, services, timing: fastTiming });
const message = (run: Run, result: EnableRollback, path = run.f.planPath) => enableRollbackMessage(mode, new Error("replacement startup failed"), run.backup, path, result);

test("a rollback that ends clean has no message of its own", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f); const result = await rollback(run, f.launchd.services());
    assert.equal(result.outcome, "restored"); assert.equal(message(run, result), undefined); assert.deepEqual(run.archived, ["archive"]);
  } finally { await f.cleanup(); }
});

test("preserved: the message names the mode that still runs and the command to turn it off", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f); f.launchd.refuseIdle = true;
    const text = message(run, await rollback(run, f.launchd.services()))!;
    assert.match(text, /^Enabling shared-executors failed \(replacement startup failed\)\./);
    assert.match(text, /keeps running the plan with shared-executors; the plan file holds that plan/); assert.match(text, /run `gateway service shared-executors --disable --apply` when idle\.$/);
  } finally { await f.cleanup(); }
});

test("a service that cannot be read at the start leaves the plan file on the replacement plan and says which command to run", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f);
    const result = await rollback(run, { ...f.launchd.services(), status: async () => { throw new Error("launchctl failed"); } });
    assert.equal(result.outcome, "unchecked"); assert.equal(JSON.parse(await readFile(f.planPath, "utf8")).sharedExecutors, true, "nothing was written");
    const text = message(run, result)!; assert.match(text, /could not be checked, so which plan it runs is unknown; the plan file holds the plan with shared-executors/);
    assert.match(text, /`gateway service status`, then `gateway service shared-executors --disable --apply`/);
  } finally { await f.cleanup(); }
});

test("a plan that cannot be written back is not_restored, whether the original process or the replacement runs", { skip }, async () => {
  const f = await standInFixture({});
  try {
    // The plan file's parent is a file, so the write fails and the plan file keeps holding the replacement plan.
    const bad = join(f.planPath, "plan.json");
    const kept = await failedEnable(f, false);
    const previous = await rollback(kept, f.launchd.services(), { path: bad });
    assert.deepEqual(previous, { outcome: "not_restored", running: "previous" });
    const keptText = message(kept, previous, bad)!;
    assert.match(keptText, /could not be written back, so the plan file still holds the plan with shared-executors/); assert.match(keptText, /still runs the plan without shared-executors; to make the file match it, copy .*\/backup\/service-plan\.json over .*plan\.json\. No restart is needed\./);
    assert.doesNotMatch(keptText, /is restored|was restored/);
    await f.launchd.restart(); // The replacement now runs the plan with shared-executors.
    const replacement = await rollback(kept, f.launchd.services(), { path: bad });
    assert.deepEqual(replacement, { outcome: "not_restored", running: "replacement" });
    assert.match(message(kept, replacement, bad)!, /runs the plan with shared-executors; to go back, copy .*\/backup\/service-plan\.json over .*plan\.json, then run `gateway service restart` when idle\./);
    assert.equal(JSON.parse(await readFile(f.planPath, "utf8")).sharedExecutors, true);
  } finally { await f.cleanup(); }
});

test("a service that is down when the plan cannot be written back is told to be installed", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f); const services = { ...f.launchd.services(), status: async () => ({ installed: true }) };
    const result = await rollback(run, services, { path: join(f.planPath, "plan.json") });
    assert.deepEqual(result, { outcome: "not_restored", running: "down" }); assert.match(message(run, result)!, /The service is down; copy .* then run `gateway service install`\./);
  } finally { await f.cleanup(); }
});

test("a service that cannot be read after the plan went back asks for a status check and a restart", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f); const services = f.launchd.services(); let calls = 0;
    const result = await rollback(run, { ...services, status: async () => { if (calls++ > 0) throw new Error("launchctl failed"); return services.status(""); } });
    assert.equal(result.outcome, "unknown"); assert.equal(await readFile(f.planPath, "utf8"), run.original);
    assert.match(message(run, result)!, /restored from .*\/backup, but the service could not be checked; run `gateway service status`, then `gateway service restart` when idle\./);
  } finally { await f.cleanup(); }
});

test("a service that is down and cannot be started asks for an install", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f); const services = f.launchd.services(); let calls = 0;
    const result = await rollback(run, { ...services, status: async () => calls++ > 0 ? { installed: true } : services.status(""), install: async () => { throw new Error("bootstrap failed"); } });
    assert.equal(result.outcome, "down"); assert.match(message(run, result)!, /restored from .*\/backup, but the service is down and could not be started; run `gateway service install`\.$/);
  } finally { await f.cleanup(); }
});

/** A rollback whose idle restarts all fail; `after` answers the status read that follows the last failed restart (the one after the in-loop check). */
async function stuck(f: StandInFixture, after: () => Promise<Record<string, unknown>>) {
  const run = await failedEnable(f); const services = f.launchd.services(); f.launchd.refuseIdle = true; let tail = 0;
  const status = async () => f.launchd.restartCalls >= 1 + fastTiming.restartAttempts && tail++ === 1 ? after() : services.status("");
  return { run, result: await rollback(run, { ...services, status }) };
}

test("a replacement whose restart keeps failing, with the service unreadable afterwards, is reported as unknown", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const { run, result } = await stuck(f, async () => { throw new Error("launchctl failed"); });
    assert.equal(result.outcome, "unknown"); assert.equal(await readFile(f.planPath, "utf8"), run.original); assert.deepEqual(run.archived, []);
  } finally { await f.cleanup(); }
});

test("a replacement whose restart keeps failing, with the service gone afterwards, is reported as down", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const { run, result } = await stuck(f, async () => ({ installed: true }));
    assert.equal(result.outcome, "down"); assert.deepEqual(run.archived, []);
  } finally { await f.cleanup(); }
});

test("a late relaunch onto the restored plan is a restored service, and its receipt is archived", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const { run, result } = await stuck(f, async () => ({ installed: true, pid: 1500, statusCurrent: true }));
    assert.equal(result.outcome, "restored"); assert.deepEqual(run.archived, ["archive"]); assert.equal(await readFile(f.planPath, "utf8"), run.original);
  } finally { await f.cleanup(); }
});

test("stuck: when the replacement plan cannot be put back, the file holds the previous plan and the service still runs the replacement", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f); const services = f.launchd.services();
    // Every idle restart is refused and makes the plan directory read-only, so the file cannot be written back to name the replacement plan.
    const result = await rollback(run, { ...services, restart: async () => { await chmod(f.directory, 0o500); throw new Error("The unified service could not restart while idle"); } });
    assert.equal(result.outcome, "stuck"); assert.equal(await readFile(f.planPath, "utf8"), run.original);
    assert.match(message(run, result)!, /restored from .*\/backup, but the service still runs the plan with shared-executors; run `gateway service restart` when idle\.$/);
  } finally { await chmod(f.directory, 0o700); await f.cleanup(); }
});

test("an archive that fails leaves the plan file and the service matching, with the receipt kept for the next host", { skip }, async () => {
  const f = await standInFixture({});
  try {
    const run = await failedEnable(f); const result = await rollBackEnable({ configPath: f.config, state: f.directory, path: f.planPath, original: run.original, previous: f.plan, next: run.next,
      beforePid: 1000, archive: async () => { throw new Error("receipt could not be archived"); }, services: f.launchd.services(), timing: fastTiming });
    assert.equal(result.outcome, "archive_failed");
    const text = message(run, result)!; assert.match(text, /runs it, so the plan file and the service match\./); assert.match(text, /stays in place for the next host to take over\.$/);
  } finally { await f.cleanup(); }
});
