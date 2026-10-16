import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "../config.js";
import { servicePlanPath, type ServicePlan } from "../service-plan.js";
import { disableSharing, sharingDisableFailureMessage, type SharingDisableDependencies } from "../mac-shared-disable.js";
import { safeErrorMessage } from "../error-message.js";

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
  const fromParse = sharingDisableFailureMessage("shared-executors", syntax, "/tmp/backup", true);
  assert.match(fromParse, /Invalid JSON data/);
  assert.doesNotMatch(fromParse, /SECRET|pid/);
  assert.match(fromParse, /^Turning off shared-executors failed \(Invalid JSON data\)\. The previous plan is restored from \/tmp\/backup and the service was restarted\.$/);
  assert.equal(sharingDisableFailureMessage("shared-native", new Error("launchctl bootstrap failed"), "/tmp/backup", false),
    "Turning off shared-native failed (launchctl bootstrap failed). The previous plan is restored from /tmp/backup; start it with gateway service install.");
  assert.match(sharingDisableFailureMessage("shared-native", "not an error", "/tmp/backup", false), /failed \(Unknown failure\)\./);
});

/**
 * A stand-in for launchd with KeepAlive. A restart makes the running service exit after its idle guard and launchd starts it
 * again at once, from whatever plan is on disk at that instant: there is no gap in which a stop could be observed.
 */
class KeepAliveLaunchd {
  pid = 1000; relaunched: Array<{ pid: number; sharedExecutors: boolean }> = []; refuseIdle = false;
  constructor(private readonly planPath: string) {}
  async restart(): Promise<void> {
    if (this.refuseIdle) throw new Error("The unified service could not restart while idle; inspect gateway service status");
    const plan = JSON.parse(await readFile(this.planPath, "utf8")) as ServicePlan;
    this.pid += 1; this.relaunched.push({ pid: this.pid, sharedExecutors: plan.sharedExecutors === true });
  }
}
async function fixture(): Promise<{ directory: string; config: string; plan: string; launchd: KeepAliveLaunchd; calls: string[]; deps: Partial<SharingDisableDependencies> }> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-disable-"));
  const config = join(directory, "gateway.json"); const plan = servicePlanPath(directory);
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: directory, clientOnly: true, providers: [] });
  await writePrivateJson(plan, { version: 1, config, sharedExecutors: true, components: [
    { id: "native", kind: "native", command: "/usr/bin/true", args: ["--native-home", join(directory, "native"), "--relay-home", join(directory, "relay"), "--codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "--daemon"], log: join(directory, "native.log") }] });
  const launchd = new KeepAliveLaunchd(plan); const calls: string[] = [];
  const deps: Partial<SharingDisableDependencies> = {
    registration: async () => true, maintenance: async () => {}, status: async () => ({ pid: launchd.pid }), sdk: async codex => ({ codex, sdkSha256: "0".repeat(64) }),
    restart: async () => { calls.push("restart"); await launchd.restart(); }, install: async () => { calls.push("install"); },
    archive: async () => { calls.push("archive"); },
  };
  return { directory, config, plan, launchd, calls, deps };
}
const planOnDisk = async (path: string) => JSON.parse(await readFile(path, "utf8")) as ServicePlan;

test("turning sharing off wins against a KeepAlive relaunch that comes back at once", { skip: process.platform !== "darwin" }, async () => {
  const { directory, config, plan, launchd, calls, deps } = await fixture();
  try {
    const result = await disableSharing(config, "shared-executors", true, deps);
    // The relaunch read the plan without sharing, so it could not take the shared host back; nothing reported a changed owner.
    assert.deepEqual(launchd.relaunched, [{ pid: 1001, sharedExecutors: false }]);
    assert.deepEqual(calls, ["restart", "archive"]);
    assert.equal(result.applied, true);
    assert.equal((await planOnDisk(plan)).sharedExecutors, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a service that refuses the idle restart keeps running its previous plan, restored byte for byte", { skip: process.platform !== "darwin" }, async () => {
  const { directory, config, plan, launchd, calls, deps } = await fixture();
  try {
    const original = await readFile(plan, "utf8"); launchd.refuseIdle = true;
    await assert.rejects(disableSharing(config, "shared-executors", true, deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(The unified service could not restart while idle; inspect gateway service status\)\. The previous plan is restored from .+ and the service kept running\.$/);
      return true;
    });
    assert.equal(await readFile(plan, "utf8"), original);
    assert.deepEqual(calls, ["restart"]); assert.deepEqual(launchd.relaunched, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a corrupt receipt after the relaunch reports exactly Invalid JSON data and restarts onto the previous plan", { skip: process.platform !== "darwin" }, async () => {
  const { directory, config, plan, launchd, calls, deps } = await fixture();
  try {
    const original = await readFile(plan, "utf8");
    deps.archive = async () => { calls.push("archive"); JSON.parse('{"state": SECRET_TOKEN_FROM_RECEIPT'); };
    await assert.rejects(disableSharing(config, "shared-executors", true, deps), (error: Error) => {
      assert.match(error.message, /^Turning off shared-executors failed \(Invalid JSON data\)\. The previous plan is restored from .+shared-executors-disable-\d+ and the service was restarted\.$/);
      assert.doesNotMatch(error.message, /SECRET|state/);
      return true;
    });
    assert.equal(safeErrorMessage(new SyntaxError("Unexpected token S in JSON at position 10")), "Invalid JSON data");
    assert.equal(await readFile(plan, "utf8"), original);
    // First relaunch on the plan without sharing, then a second one that read the restored plan back.
    assert.deepEqual(launchd.relaunched, [{ pid: 1001, sharedExecutors: false }, { pid: 1002, sharedExecutors: true }]);
    assert.deepEqual(calls, ["restart", "archive", "restart"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
