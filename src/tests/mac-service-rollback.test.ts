import test from "node:test";
import assert from "node:assert/strict";
import { replaceLegacyService, type LegacyReplacementTools } from "../mac-service.js";

type State = "alive" | "gone" | "reused" | "unknown";
function fixture(options: { state?: State; replacement?: boolean; bootstrapFails?: boolean; bootstrapLoads?: boolean; exitsImmediately?: boolean; reusedAfterDisable?: boolean; stayAlive?: boolean } = {}) {
  const calls: string[] = []; const backups: string[] = []; let installed = true; let pid: number | undefined = 41; let state = options.state ?? "alive"; let oldWrites = 0; let now = 0;
  const tools: LegacyReplacementTools = {
    status: async () => { calls.push(`status:${installed ? pid ?? "idle" : "absent"}`); return { installed, pid }; },
    processStart: async current => current === 41 ? 1000 : current === 77 ? 2000 : undefined,
    processState: async identity => {
      calls.push(`process:${identity.pid}`);
      if (options.replacement && identity.pid === 41) { installed = true; pid = 77; return "gone"; }
      return state;
    },
    disable: async () => { calls.push("disable"); if (options.reusedAfterDisable) { state = "reused"; installed = false; pid = undefined; } },
    enable: async () => { calls.push("enable"); },
    signalIdleExit: current => { calls.push(`signal:${current}`); if (options.exitsImmediately) { installed = false; pid = undefined; } },
    bootout: async () => { calls.push("bootout"); installed = false; pid = undefined; },
    write: async value => { calls.push(`write:${value}`); if (value === "old") oldWrites++; },
    backup: async value => { calls.push("backup"); backups.push(value); },
    discardBackup: async () => { calls.push("discard-backup"); },
    bootstrap: async () => { calls.push("bootstrap"); if (options.bootstrapFails && oldWrites === 0) { if (options.bootstrapLoads) { installed = true; pid = 77; } throw new Error("replacement bootstrap failed"); } },
    sleep: async () => { calls.push("sleep"); now += 100; if (!options.stayAlive) { state = "gone"; installed = false; pid = undefined; } },
    now: () => now,
  };
  return { calls, backups, tools, setState: (next: State) => { state = next; } };
}

test("legacy replacement waits for the recorded old PID before changing the plist or starting the new job", async () => {
  const f = fixture({ exitsImmediately: true });
  await replaceLegacyService("old", "new", f.tools);
  assert.ok(f.calls.indexOf("sleep") > f.calls.indexOf("signal:41"), f.calls.join(", "));
  assert.equal(f.calls.includes("bootout"), false, "the idle protocol unloads its own old job");
  assert.ok(f.calls.indexOf("write:new") > f.calls.indexOf("sleep"), f.calls.join(", "));
  assert.ok(f.calls.indexOf("write:new") < f.calls.lastIndexOf("enable"), f.calls.join(", "));
  assert.deepEqual(f.calls.slice(-2), ["bootstrap", "discard-backup"]);
});

test("a draining old PID times out without bootstrapping either definition", async () => {
  const f = fixture({ state: "alive", stayAlive: true, exitsImmediately: true });
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /rollback incomplete/);
  assert.equal(f.calls.includes("bootout"), false);
  assert.equal(f.calls.includes("bootstrap"), false);
  assert.equal(f.calls.includes("write:new"), false);
  assert.equal(f.calls.includes("enable"), false, "an absent job with an alive old PID is never restarted");
});

test("an ambiguous process inspection blocks replacement before any bootstrap", async () => {
  const f = fixture({ state: "unknown" });
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /Cannot confirm the old managed service exited/);
  assert.equal(f.calls.includes("bootout"), false);
  assert.equal(f.calls.includes("bootstrap"), false);
});

test("an unknown process state after the job vanishes leaves it stopped instead of bootstrapping", async () => {
  const f = fixture({ exitsImmediately: true }); let checks = 0; const state = f.tools.processState;
  f.tools.processState = async identity => { if (++checks === 1) return "alive"; await state(identity); return "unknown"; };
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /rollback incomplete/);
  assert.equal(f.calls.includes("write:new"), false);
  assert.equal(f.calls.includes("bootstrap"), false);
});

test("an unreadable original process identity blocks before disabling or bootstrapping", async () => {
  const f = fixture();
  f.tools.processStart = async () => undefined;
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /Cannot identify the running managed service/);
  assert.deepEqual(f.calls, ["status:41"], "nothing changes when identity capture fails");
});

test("an unreadable launchctl status blocks before any service mutation", async () => {
  const f = fixture();
  f.tools.status = async () => { throw new Error("launchctl print timed out"); };
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /launchctl print timed out/);
  assert.equal(f.calls.includes("disable"), false);
  assert.equal(f.calls.includes("bootstrap"), false);
});

test("the teardown deadline uses elapsed monotonic time even when status inspection is expensive", async () => {
  const f = fixture({ stayAlive: true }); let now = 0; const status = f.tools.status;
  f.tools.status = async () => { now += 13_000; return status(); };
  f.tools.now = () => now;
  f.tools.sleep = async () => { f.calls.push("sleep"); };
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /Cannot confirm the managed service is unloaded/);
  assert.equal(f.calls.filter(call => call === "sleep").length, 1);
  assert.equal(f.calls.includes("bootstrap"), false);
});

test("a PID reused while disable is in flight is not signalled and is safe to replace", async () => {
  const f = fixture({ reusedAfterDisable: true });
  await replaceLegacyService("old", "new", f.tools);
  assert.equal(f.calls.some(call => call.startsWith("signal:")), false);
  assert.equal(f.calls.includes("bootout"), false);
  assert.equal(f.calls.includes("bootstrap"), true);
});

test("a reused PID proves the old writer is gone, while an intervening loaded job blocks the switch", async () => {
  const reused = fixture({ reusedAfterDisable: true });
  await replaceLegacyService("old", "new", reused.tools);
  assert.ok(reused.calls.includes("bootstrap"));
  const changed = fixture({ replacement: true });
  await assert.rejects(replaceLegacyService("old", "new", changed.tools), /Service restarted before migration/);
  assert.equal(changed.calls.includes("bootout"), false);
  assert.equal(changed.calls.includes("bootstrap"), false);
});

test("rollback after a replacement bootstrap failure proves the replacement is absent before restoring the old plist", async () => {
  const f = fixture({ bootstrapFails: true });
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /replacement bootstrap failed/);
  const failedBootstrap = f.calls.indexOf("bootstrap"); const restore = f.calls.lastIndexOf("write:old");
  assert.equal(f.calls.filter(call => call === "bootout").length, 0, "the already-absent replacement does not need another stop");
  assert.ok(restore > failedBootstrap, f.calls.join(", "));
  assert.ok(f.calls.slice(failedBootstrap + 1, restore).includes("status:absent"), f.calls.join(", "));
  assert.deepEqual(f.calls.slice(-2), ["bootstrap", "discard-backup"]);
});

test("a loaded job after replacement bootstrap failure is never booted out or overwritten by rollback", async () => {
  const f = fixture({ bootstrapFails: true, bootstrapLoads: true });
  await assert.rejects(replaceLegacyService("old", "new", f.tools), /replacement bootstrap failed; rollback incomplete: The replacement service is still loaded/);
  assert.equal(f.calls.filter(call => call === "bootout").length, 0, "a replacement that might be live is never unloaded by rollback");
  assert.equal(f.calls.filter(call => call === "bootstrap").length, 1, "the old job is not started over an uncertain replacement");
  assert.equal(f.calls.includes("write:old"), false);
  assert.equal(f.calls.includes("backup"), true, "the prior definition remains recoverable");
  assert.equal(f.calls.includes("discard-backup"), false, "the backup stays after incomplete rollback");
  assert.deepEqual(f.backups, ["old"]);
  assert.ok(f.calls.indexOf("backup") < f.calls.indexOf("write:new"));
});
