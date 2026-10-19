import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { servicePlanPath, type ServicePlan } from "../service-plan.js";
import { disableSharing, sharingDisableFailureMessage } from "../mac-shared-disable.js";
import { safeErrorMessage } from "../error-message.js";
import { executionHostHome } from "../execution-host-storage.js";
import { standInFixture } from "./launchd-stand-in.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // The stand-in host claims its receipts inside the test process: see src/tests/in-process-host.ts.

test("disabling a sharing mode previews the remaining plan without touching the service", { skip: process.platform !== "darwin" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-disable-"));
  const config = join(directory, "gateway.json");
  try {
    await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: directory, clientOnly: true, providers: [] });
    await assert.rejects(disableSharing(config, "shared-executors"), /nothing is shared/);
    await writePrivateJson(servicePlanPath(directory), { version: 1, config, sharedExecutors: true, sharedNativeExecutor: true, components: [
      { id: "native", kind: "native", command: "/usr/bin/true", args: ["--native-home", join(directory, "native"), "--relay-home", join(directory, "relay"), "--codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "--daemon"], log: join(directory, "native.log") }] });
    const preview = await disableSharing(config, "shared-executors");
    assert.deepEqual(preview, { mode: "shared-executors", enabled: true, remaining: { sharedNativeExecutor: true, sharedExecutors: false }, applied: false,
      next: "gateway service shared-executors --disable --apply after local and remote chats finish" });
    assert.deepEqual((await disableSharing(config, "shared-native")).remaining, { sharedNativeExecutor: false, sharedExecutors: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the failure message collapses a JSON parse error but keeps an ordinary reason", () => {
  let syntax: unknown = new Error("expected JSON.parse to throw");
  try { JSON.parse('{"pid": SECRET_TOKEN_FROM_PLAN'); } catch (error) { syntax = error; }
  assert.ok(syntax instanceof SyntaxError);
  const fromParse = sharingDisableFailureMessage("shared-executors", syntax, "/tmp/backup", "restarted");
  assert.match(fromParse, /Invalid JSON data/);
  assert.doesNotMatch(fromParse, /SECRET|pid/);
  assert.equal(fromParse, "Turning off shared-executors failed (Invalid JSON data). The previous plan is restored from /tmp/backup and the service was restarted.");
  const reason = new Error("launchctl bootstrap failed");
  assert.equal(sharingDisableFailureMessage("shared-native", reason, "/tmp/backup", "kept"), "Turning off shared-native failed (launchctl bootstrap failed). The previous plan is restored from /tmp/backup and the service kept running.");
  assert.equal(sharingDisableFailureMessage("shared-native", reason, "/tmp/backup", "started"), "Turning off shared-native failed (launchctl bootstrap failed). The previous plan is restored from /tmp/backup, and the service, which was down, was started.");
  assert.equal(sharingDisableFailureMessage("shared-native", reason, "/tmp/backup", "stuck"),
    "Turning off shared-native failed (launchctl bootstrap failed). The plan file is restored from /tmp/backup; the service still runs the plan without shared-native; run `gateway service restart` when idle.");
  assert.match(sharingDisableFailureMessage("shared-native", reason, "/tmp/backup", "down"), /service is down and could not be started; run `gateway service install`\.$/);
  assert.match(sharingDisableFailureMessage("shared-native", reason, "/tmp/backup", "unknown"), /could not be checked; run `gateway service status`/);
  const lost = sharingDisableFailureMessage("shared-native", "not an error", "/tmp/backup", "not_restored");
  assert.match(lost, /failed \(Unknown failure\)\./); assert.match(lost, /could not be written back/); assert.doesNotMatch(lost, /is restored|was restored/);
  const where = (running: "previous" | "replacement" | "down" | "unknown") => sharingDisableFailureMessage("shared-native", reason, "/tmp/backup", "not_restored", { running, path: "/state/service-plan.json" });
  assert.match(where("previous"), /still holds the plan without shared-native \(\/state\/service-plan\.json\)\..*still runs the plan with shared-native; .*copy \/tmp\/backup\/service-plan\.json over \/state\/service-plan\.json\. No restart is needed\.$/);
  assert.match(where("replacement"), /runs the plan without shared-native; to go back, copy \/tmp\/backup\/service-plan\.json over \/state\/service-plan\.json, then run `gateway service restart` when idle\.$/);
  assert.match(where("down"), /The service is down; copy \/tmp\/backup\/service-plan\.json over \/state\/service-plan\.json, then run `gateway service install`\.$/);
  assert.match(where("unknown"), /could not be checked; run `gateway service status`, copy .* then run `gateway service restart` when idle\.$/);
});

const planOnDisk = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ServicePlan;

test("turning sharing off wins against a KeepAlive relaunch, through the throttle gap, and archives the stopped receipt afterwards", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true }); f.launchd.gap = 2;
  try {
    const result = await disableSharing(f.config, "shared-executors", true, f.deps);
    // The relaunch read the plan without sharing, so it could not take the shared host back.
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: false, sharedNativeExecutor: false }]);
    assert.deepEqual(f.calls, ["restart", "archive"]); assert.deepEqual(f.host.errors, []);
    assert.equal(result.applied, true); assert.equal((await planOnDisk(f.planPath)).sharedExecutors, undefined);
    // The real archive moved the stopped receipt into the backup.
    assert.deepEqual(await readdir(executionHostHome(f.config, f.nativeHome)).then(names => names.filter(name => name === "owner.json")), []);
    assert.ok((await readdir(result.backup as string)).includes("execution-owner.json"));
  } finally { await f.cleanup(); }
});

test("a service that refuses the idle restart keeps running its previous plan, restored byte for byte", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true });
  try {
    const original = await readFile(f.planPath, "utf8"); f.launchd.refuseIdle = true;
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(The unified service could not restart while idle; inspect gateway service status\)\. The previous plan is restored from .+ and the service kept running\.$/);
      return true;
    });
    assert.equal(await readFile(f.planPath, "utf8"), original);
    assert.deepEqual(f.calls, ["restart"]); assert.deepEqual(f.launchd.relaunched, []);
    assert.ok((await readdir(f.directory)).every(name => !name.endsWith(".tmp")), "the atomic restore leaves no temporary file");
  } finally { await f.cleanup(); }
});

test("a rollback waits for the relaunched service to answer before it restarts it, because an immediate restart is refused", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true }); f.launchd.startup = 4;
  try {
    const original = await readFile(f.planPath, "utf8");
    f.deps.archive = async () => {
      f.calls.push("archive");
      // The relaunched service starts its host before inference: asked now, its maintenance check and idle guard refuse.
      await assert.rejects(f.launchd.restart(), /fetch failed/);
      throw new Error("archive failed");
    };
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(archive failed\)\. The previous plan is restored from .+ and the service was restarted\.$/);
      return true;
    });
    assert.equal(await readFile(f.planPath, "utf8"), original);
    // First the relaunch on the plan without sharing, then the restart that read the restored plan back and claimed its host.
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: false, sharedNativeExecutor: false }, { pid: 1002, sharedExecutors: true, sharedNativeExecutor: false }]);
    assert.equal(f.launchd.pid, 1002); assert.deepEqual(f.host.errors, []);
    assert.equal(f.launchd.restartCalls, 3, "the forward restart, the refused probe, and one rollback restart that needed no retry");
  } finally { await f.cleanup(); }
});

test("a rollback retries a restart that the idle guard refuses for a moment", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true });
  try {
    f.deps.archive = async () => { f.calls.push("archive"); f.launchd.restartFailures = 2; throw new Error("archive failed"); };
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), /and the service was restarted\.$/);
    assert.equal(f.launchd.restartCalls, 4, "one forward restart and three rollback attempts");
    assert.equal(f.launchd.pid, 1002); assert.equal((await planOnDisk(f.planPath)).sharedExecutors, true);
  } finally { await f.cleanup(); }
});

test("a rollback whose restart never succeeds reports the stuck state, with the plan file restored and the service still on the next plan", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true });
  try {
    const original = await readFile(f.planPath, "utf8");
    f.deps.archive = async () => { f.calls.push("archive"); f.launchd.restartFailures = 99; throw new Error("archive failed"); };
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(archive failed\)\. The plan file is restored from .+shared-executors-disable-\d+; the service still runs the plan without shared-executors; run `gateway service restart` when idle\.$/);
      return true;
    });
    assert.equal(await readFile(f.planPath, "utf8"), original);
    assert.equal(f.launchd.pid, 1001); assert.equal(f.launchd.restartCalls, 4);
    // The recorded recovery works: a restart when idle relaunches onto the restored plan, which claims the host again.
    f.launchd.restartFailures = 0; await f.launchd.restart();
    assert.deepEqual(f.launchd.relaunched.at(-1), { pid: 1002, sharedExecutors: true, sharedNativeExecutor: false }); assert.deepEqual(f.host.errors, []);
  } finally { await f.cleanup(); }
});

test("a restart that exits the service and times out leaves it down, and the rollback starts it on the restored plan", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true }); f.launchd.gap = 3; f.launchd.restartTimesOut = true;
  try {
    const original = await readFile(f.planPath, "utf8");
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(The unified service could not restart while idle; inspect gateway service status\)\. The previous plan is restored from .+, and the service, which was down, was started\.$/);
      return true;
    });
    assert.equal(await readFile(f.planPath, "utf8"), original);
    assert.deepEqual(f.calls, ["restart", "install"]);
    // The only relaunch read the restored plan, so no process ever ran the plan without sharing.
    assert.deepEqual(f.launchd.relaunched, [{ pid: 1001, sharedExecutors: true, sharedNativeExecutor: false }]); assert.deepEqual(f.host.errors, []);
  } finally { await f.cleanup(); }
});

test("a plan that turns unreadable mid-change fails with exactly Invalid JSON data and restarts onto the previous plan", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true });
  try {
    const original = await readFile(f.planPath, "utf8");
    // Another writer leaves a corrupt plan; the service's own restart reads it first, as macService does, and the real parser throws.
    f.deps.restart = async () => { f.calls.push("restart"); await writeFile(f.planPath, '{"version": 1, "sharedExecutors": SECRET_TOKEN_FROM_PLAN', { mode: 0o600 }); await f.launchd.restart(); };
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(Invalid JSON data\)\. The previous plan is restored from .+shared-executors-disable-\d+ and the service kept running\.$/);
      assert.doesNotMatch(error.message, /SECRET|sharedExecutors": /);
      return true;
    });
    assert.equal(safeErrorMessage(new SyntaxError("Unexpected token S in JSON at position 10")), "Invalid JSON data");
    assert.equal(await readFile(f.planPath, "utf8"), original);
    assert.equal(f.launchd.pid, 1000, "the service never left its plan");
  } finally { await f.cleanup(); }
});

test("a corrupt host receipt is refused before anything changes", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true });
  try {
    const original = await readFile(f.planPath, "utf8"); const receipt = join(executionHostHome(f.config, f.nativeHome), "owner.json");
    await writeFile(receipt, '{"state": SECRET_TOKEN_FROM_RECEIPT', { mode: 0o600 });
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.equal(error.message, "Execution host ownership receipt is unreadable");
      return true;
    });
    assert.equal(await readFile(f.planPath, "utf8"), original); assert.deepEqual(f.calls, []); assert.deepEqual(f.launchd.relaunched, []);
    assert.ok(!(await readdir(f.directory)).includes("service-backups"));
  } finally { await f.cleanup(); }
});

test("a rollback that cannot write the previous plan back says so instead of claiming it restored", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true });
  try {
    // The plan path becomes a non-empty directory, so the rename of the restored plan onto it fails.
    f.deps.archive = async () => { await rm(f.planPath); await mkdir(f.planPath); await writeFile(join(f.planPath, "keep"), "x"); throw new Error("archive failed"); };
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(archive failed\)\. The previous plan could not be written back, so the plan file still holds the plan without shared-executors/);
      assert.doesNotMatch(error.message, /is restored|was restored|restarted/);
      // The restart relaunched the service on the plan without sharing, so the message says that plan runs and how to go back.
      assert.match(error.message, /The service runs the plan without shared-executors; to go back, copy .*\/service-plan\.json over .*service-plan\.json, then run `gateway service restart` when idle\.$/);
      return true;
    });
    assert.ok((await readdir(f.directory)).every(name => !name.endsWith(".tmp")), "no temporary plan is left behind");
  } finally { await f.cleanup(); }
});

test("a rollback that cannot write the plan back while the original process still runs says the previous plan runs and needs no restart", { skip: process.platform !== "darwin" }, async () => {
  const f = await standInFixture({ sharedExecutors: true });
  try {
    f.deps.restart = async () => { await rm(f.planPath); await mkdir(f.planPath); await writeFile(join(f.planPath, "keep"), "x"); throw new Error("idle restart refused"); };
    await assert.rejects(disableSharing(f.config, "shared-executors", true, f.deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(idle restart refused\)\. The previous plan could not be written back/);
      assert.match(error.message, /The service still runs the plan with shared-executors; to make the file match it, copy .*\/service-plan\.json over .*service-plan\.json\. No restart is needed\.$/);
      return true;
    });
    assert.equal(f.launchd.pid, 1000, "the service never left its plan");
  } finally { await f.cleanup(); }
});
