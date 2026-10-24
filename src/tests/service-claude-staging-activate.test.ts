import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { writePrivateJson } from "../config.js";
import { atomicWrite, sha256 } from "../service-claude-io.js";
import { ClaudeRetirementError } from "../service-claude-legacy.js";
import { writePendingClaudeConsolidation } from "../service-claude-receipt.js";
import { activatePendingClaudeConsolidation, readPendingClaudeConsolidation, stageClaudeConsolidation, type ClaudeDependencies } from "../service-claude-staging.js";
import type { ServicePlan } from "../service-plan.js";
import { allLabels, labels, legacyObjects, rewrite, rewriteMain, snapshot, withFixture, type Fixture } from "./service-claude-staging-support.js";

/** Existing cutover tests deliberately authorize the interruption they exercise. */
const stage = (f: Fixture, force = true) => stageClaudeConsolidation(f.config, f.deps(), force);
const activate = (f: Fixture, plan: ServicePlan = f.plan, extra: ClaudeDependencies = {}) => activatePendingClaudeConsolidation(f.config, plan, f.deps(extra));
const onDisk = async (f: Fixture): Promise<ServicePlan> => JSON.parse(await readFile(f.planPath, "utf8"));
const rejectsRetirement = (promise: Promise<unknown>, pattern: RegExp) => assert.rejects(promise, error => error instanceof ClaudeRetirementError && pattern.test(error.message));
const deferred = (f: Fixture, reason: string) => f.notices.some(notice => notice.event === "claude_consolidation_deferred" && notice.fields.reason === reason);
async function backupFiles(f: Fixture): Promise<string[]> {
  const root = join(f.state, "service-backups"); const out: string[] = [];
  for (const directory of (await readdir(root).catch(() => [] as string[])).filter(name => name.startsWith("claude-")))
    for (const name of await readdir(join(root, directory))) out.push(join(root, directory, name));
  return out;
}
const named = async (f: Fixture, prefix: string) => (await backupFiles(f)).filter(path => basename(path).startsWith(prefix));
/** Stages and activates, then puts the archived receipt back, as a crash between the plan commit and the archive would leave it. */
async function reopen(f: Fixture): Promise<ServicePlan> {
  await stage(f); const result = await activate(f);
  const [archived] = await named(f, "claude-activated.");
  await rename(archived!, f.receiptPath); return result;
}

test("a non-primary start defers and leaves the staged receipt", async () => {
  await withFixture(async f => {
    await stage(f); f.world.primary = false; const before = await snapshot(f);
    assert.deepEqual(await activate(f), f.plan);
    assert.equal((await readPendingClaudeConsolidation(f.state))?.phase, "staged"); assert.deepEqual(await snapshot(f), before);
    assert.deepEqual(f.world.mutating(), []); assert.ok(deferred(f, "not_primary"));
  });
});

test("activation retires the exact legacy jobs, commits the merged plan atomically and is idempotent", async () => {
  await withFixture(async f => {
    await stage(f); const receipt = (await readPendingClaudeConsolidation(f.state))!;
    const result = await activate(f);
    assert.deepEqual(result, receipt.candidatePlan); assert.deepEqual(await onDisk(f), receipt.candidatePlan);
    assert.equal(sha256(await readFile(f.planPath, "utf8")), receipt.candidatePlanSha256);
    assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
    for (const label of allLabels) await assert.rejects(stat(f.files[label]!), /ENOENT/);
    assert.deepEqual(f.world.ops("bootout"), allLabels); assert.deepEqual(f.world.ops("bootstrap"), []);
    assert.ok(f.world.calls.indexOf("commit") > f.world.calls.lastIndexOf(`bootout:${labels.studio}`), "no legacy job is stopped after the plan is committed");
    assert.equal(f.world.loaded.size, 0); assert.equal(f.world.processes.size, 0);
    assert.equal((await named(f, "retired-")).length, 4); assert.equal((await named(f, "claude-activated.")).length, 1);
    for (const path of await named(f, "retired-")) assert.equal((await stat(path)).mode & 0o777, 0o644);
    for (const label of allLabels) assert.equal((await stat(legacyObjects(f.home)[label]!.StandardOutPath)).mode & 0o777, 0o644, "legacy logs are preserved");
    const calls = f.world.calls.length;
    assert.deepEqual(await activate(f, result), result); assert.equal(f.world.calls.length, calls);
  });
});

test("a normal receipt defers for every loaded legacy kind without bootout or plan commit", async () => {
  for (const target of [labels.adapter, labels.inference, labels.tunnel]) {
    await withFixture(async f => {
      for (const label of allLabels) {
        if (label === target) continue;
        const pid = f.world.loaded.get(label)!; f.world.loaded.delete(label); f.world.processes.delete(pid);
      }
      await stage(f, false); const before = await snapshot(f);
      assert.deepEqual(await activate(f), f.plan);
      assert.ok(deferred(f, "loaded_legacy_job")); assert.deepEqual(f.world.ops("bootout"), []); assert.deepEqual(f.world.ops("commit"), []);
      assert.deepEqual(await snapshot(f), before);
    });
  }
});

test("a normal receipt can adopt exact legacy registrations after every job is unloaded", async () => {
  await withFixture(async f => {
    for (const label of allLabels) { const pid = f.world.loaded.get(label)!; f.world.loaded.delete(label); f.world.processes.delete(pid); }
    await stage(f, false); const receipt = (await readPendingClaudeConsolidation(f.state))!;
    assert.equal(receipt.allowInterruption, undefined);
    assert.deepEqual(await activate(f), receipt.candidatePlan);
    assert.deepEqual(f.world.ops("bootout"), []); assert.equal(f.world.calls.filter(call => call === "commit").length, 1);
  });
});

test("an old receipt without allowInterruption remains non-forcing", async () => {
  await withFixture(async f => {
    await stage(f, true); const raw = JSON.parse(await readFile(f.receiptPath, "utf8")); delete raw.allowInterruption;
    await writeFile(f.receiptPath, JSON.stringify(raw)); await chmod(f.receiptPath, 0o600);
    assert.deepEqual(await activate(f), f.plan);
    assert.ok(deferred(f, "loaded_legacy_job")); assert.deepEqual(f.world.mutating(), []);
  });
});

test("a forced receipt still refuses changed signature, plist, process argv, or process identity", async () => {
  const checks: Array<(f: Fixture) => Promise<ClaudeDependencies | void>> = [
    async () => ({ verifySignature: async () => false }),
    async f => { await rewrite(f, labels.adapter, object => { object.ThrottleInterval = 20; }); },
    async f => { f.world.processes.get(f.world.loaded.get(labels.adapter)!)!.args = "node /foreign.js"; },
    async () => ({ processes: { startMs: async () => undefined } }),
  ];
  for (const setup of checks) {
    await withFixture(async f => {
      await stage(f, true); const extra = await setup(f); const before = await snapshot(f);
      assert.deepEqual(await activate(f, f.plan, extra ?? {}), f.plan);
      assert.deepEqual(f.world.mutating(), []); assert.deepEqual(await snapshot(f), before);
    });
  }
});

interface Deferral { name: string; reason: string; setup(f: Fixture): Promise<ClaudeDependencies | void> }
const deferrals: Deferral[] = [
  { name: "an open Claude window", reason: "claude_gui_open", setup: async f => { f.world.extraRows.push("/Applications/Claude.app/Contents/MacOS/Claude"); } },
  { name: "an unanswered process census", reason: "process_census", setup: async f => { f.world.censusFails = true; } },
  { name: "a modified legacy plist", reason: "changed", setup: f => rewrite(f, labels.inference, object => { object.ThrottleInterval = 20; }) },
  { name: "a legacy plist with a rejected shape", reason: "legacy_shape", setup: f => rewrite(f, labels.adapter, object => { object.Program = "/bin/sh"; }) },
  { name: "a stale plan", reason: "stale_plan", setup: async f => {
    await writePrivateJson(f.planPath, { ...f.plan, components: [...f.plan.components, { id: "extra", kind: "tunnel", command: "/usr/bin/ssh", args: [], log: "/x.log" }] });
  } },
  { name: "a live definition that differs from the disk plist", reason: "process_mismatch", setup: async f => { f.world.processes.get(f.world.loaded.get(labels.tunnel)!)!.args = "/usr/bin/ssh -N other"; } },
  { name: "a stray process under an unloaded label", reason: "unmanaged_process", setup: async f => { f.world.loaded.delete(labels.studio); } },
  { name: "an unanswered launchd query", reason: "launchd_unknown", setup: async f => { f.world.printFails = true; } },
  { name: "a failed signature", reason: "signature", setup: async () => ({ verifySignature: async () => false }) },
  { name: "a changed main plist", reason: "changed", setup: f => rewriteMain(f, object => { object.ProgramArguments.push("--extra"); }) },
  { name: "a pending login consolidation", reason: "startup_pending", setup: async () => ({ pendingLogin: async () => ({ staged: true }) }) },
  { name: "an unsafe private log", reason: "log_unsafe", setup: async f => {
    await mkdir(join(f.state, "services"), { mode: 0o700 }); await writeFile(join(f.state, "services", "claude-inference.log"), "x"); await chmod(join(f.state, "services", "claude-inference.log"), 0o644);
  } },
  { name: "an unknown process start", reason: "identity_unknown", setup: async () => ({ processes: { startMs: async () => undefined } }) },
];
for (const item of deferrals) {
  test(`activation defers before any change: ${item.name}`, async () => {
    await withFixture(async f => {
      await stage(f); const extra = await item.setup(f); const before = await snapshot(f);
      assert.deepEqual(await activate(f, f.plan, extra ?? {}), f.plan);
      assert.equal((await readPendingClaudeConsolidation(f.state))?.phase, "staged"); assert.deepEqual(await snapshot(f), before);
      assert.deepEqual(f.world.mutating(), []); assert.ok(deferred(f, item.reason), item.reason);
    });
  });
}

test("a failed stop partway restores the exact earlier jobs and keeps the original plan", async () => {
  await withFixture(async f => {
    await stage(f); const before = await snapshot(f); f.world.failBootout.add(labels.inference);
    assert.deepEqual(await activate(f), f.plan);
    assert.deepEqual(await snapshot(f), before); assert.deepEqual(f.world.ops("bootstrap"), [labels.adapter]);
    assert.equal((await stat(f.files[labels.adapter]!)).mode & 0o777, 0o644);
    assert.equal(f.world.loaded.size, 4); assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
    assert.equal((await named(f, "claude-rolled-back.")).length, 1);
  });
});

test("a process that survives its stop fails closed on every start until it is gone, then recovers", async () => {
  await withFixture(async f => {
    await stage(f); const before = await snapshot(f); const pid = f.world.loaded.get(labels.adapter)!; f.world.stuck.add(labels.adapter);
    await rejectsRetirement(activate(f), /could not be restored/);
    const journal = (await readPendingClaudeConsolidation(f.state))!;
    assert.equal(journal.phase, "retiring"); assert.equal(journal.jobs[0]!.loaded, true); assert.equal(journal.jobs[0]!.pid, pid);
    await rejectsRetirement(activate(f), /could not be restored/);
    assert.deepEqual(f.world.ops("bootstrap"), [], "no old job is started while the old process may still run");
    f.world.processes.delete(pid);
    assert.deepEqual(await activate(f), f.plan);
    assert.deepEqual(f.world.ops("bootstrap"), [labels.adapter]); assert.deepEqual(await snapshot(f), before);
    assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
  });
});

test("a crash during retirement is rolled back on the next start", async () => {
  await withFixture(async f => {
    await stage(f); const before = await snapshot(f); const receipt = (await readPendingClaudeConsolidation(f.state))!;
    const jobs = receipt.jobs.map(job => { const pid = f.world.loaded.get(job.label)!; return { ...job, loaded: true, pid, startedAtMs: f.world.processes.get(pid)!.start }; });
    for (const label of [labels.adapter, labels.inference]) {
      await rename(f.files[label]!, join(receipt.backup, `retired-${label}.crash.plist`));
      const pid = f.world.loaded.get(label)!; f.world.loaded.delete(label); f.world.processes.delete(pid);
    }
    await writePendingClaudeConsolidation(f.state, { ...receipt, phase: "retiring", jobs });
    assert.deepEqual(await activate(f), f.plan);
    assert.deepEqual(f.world.ops("bootstrap"), [labels.adapter, labels.inference]); assert.deepEqual(await snapshot(f), before);
    assert.equal(await readPendingClaudeConsolidation(f.state), undefined); assert.equal(f.world.loaded.size, 4);
  });
});

test("recovery of a committed plan finishes quietly and re-archives the receipt", async () => {
  await withFixture(async f => {
    const candidate = await reopen(f);
    assert.equal((await readPendingClaudeConsolidation(f.state))?.phase, "committed");
    assert.deepEqual(await activate(f, candidate), candidate);
    assert.equal(await readPendingClaudeConsolidation(f.state), undefined); assert.equal((await named(f, "claude-activated.")).length, 1);
    assert.deepEqual(f.world.ops("bootstrap"), []);
  });
});

const committedFailures: Array<{ name: string; pattern: RegExp; setup(f: Fixture): Promise<ClaudeDependencies | void> }> = [
  { name: "a legacy job is loaded again", pattern: /is loaded/, setup: async f => { f.world.start(labels.adapter, legacyObjects(f.home)[labels.adapter]!.ProgramArguments); } },
  { name: "a foreign file occupies a retired path", pattern: /foreign file/, setup: async f => { await writeFile(f.files[labels.adapter]!, "other"); await chmod(f.files[labels.adapter]!, 0o644); } },
  { name: "the main association is gone", pattern: /could not be verified/, setup: f => rewriteMain(f, object => { delete object.AssociatedBundleIdentifiers; }) },
  { name: "the main signature fails", pattern: /could not be verified/, setup: async () => ({ verifySignature: async () => false }) },
  { name: "the receipt is corrupted", pattern: /unreadable/, setup: async f => { await writeFile(f.receiptPath, "{ not json"); await chmod(f.receiptPath, 0o600); } },
  { name: "the plan is back at the original", pattern: /no longer active/, setup: async f => { await writePrivateJson(f.planPath, f.plan); } },
];
for (const item of committedFailures) {
  test(`recovery of a committed plan fails closed: ${item.name}`, async () => {
    await withFixture(async f => {
      const candidate = await reopen(f); const extra = await item.setup(f);
      await rejectsRetirement(activate(f, candidate, extra ?? {}), item.pattern);
      assert.deepEqual(f.world.ops("bootstrap"), []);
      await stat(f.receiptPath);
    });
  });
}

test("recovery of a committed plan accepts a changed but still valid main service with a notice", async () => {
  await withFixture(async f => {
    const candidate = await reopen(f); await rewriteMain(f, object => { object.ProgramArguments.push("--extra"); });
    assert.deepEqual(await activate(f, candidate), candidate);
    assert.ok(deferred(f, "main_plist_changed")); assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
  });
});

test("a commit that fails before writing restores every legacy job", async () => {
  await withFixture(async f => {
    await stage(f); const before = await snapshot(f); f.world.commitHook = async () => { throw new Error("disk"); };
    assert.deepEqual(await activate(f), f.plan);
    assert.deepEqual(f.world.ops("bootstrap"), allLabels); assert.deepEqual(await snapshot(f), before);
    assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
  });
});

test("a commit that reports failure after it renamed is treated as committed", async () => {
  await withFixture(async f => {
    await stage(f); const receipt = (await readPendingClaudeConsolidation(f.state))!;
    f.world.commitHook = async (path, text) => { await atomicWrite(path, text); throw new Error("late"); };
    assert.deepEqual(await activate(f), receipt.candidatePlan);
    assert.deepEqual(f.world.ops("bootstrap"), []); assert.equal(await readPendingClaudeConsolidation(f.state), undefined);
  });
});

test("a commit with an unknown outcome keeps the journal and every later start fails closed", async () => {
  await withFixture(async f => {
    await stage(f); f.world.commitHook = async path => { await atomicWrite(path, "garbage\n"); throw new Error("torn"); };
    await rejectsRetirement(activate(f), /outcome is unknown/);
    assert.equal((await readPendingClaudeConsolidation(f.state))?.phase, "retiring");
    f.world.commitHook = undefined;
    await rejectsRetirement(activate(f), /changed during/);
    assert.deepEqual(f.world.ops("bootstrap"), []);
  });
});

test("a first restore failure does not stop the later jobs from being restored", async () => {
  await withFixture(async f => {
    await stage(f); f.world.failBootout.add(labels.tunnel); f.world.failBootstrap.add(labels.adapter);
    await rejectsRetirement(activate(f), /1 legacy Claude job/);
    assert.ok(f.world.loaded.has(labels.inference), "the later inference job was restored");
    assert.ok(f.world.loaded.has(labels.tunnel) && f.world.loaded.has(labels.studio));
    assert.ok(!f.world.loaded.has(labels.adapter)); await stat(f.files[labels.adapter]!);
    assert.ok(f.world.ops("bootstrap").includes(labels.inference));
    assert.ok(await readPendingClaudeConsolidation(f.state));
  });
});

test("a rollback never starts a job that was not running when retirement began", async () => {
  await withFixture(async f => {
    const pid = f.world.loaded.get(labels.studio)!; f.world.loaded.delete(labels.studio); f.world.processes.delete(pid);
    await stage(f); f.world.commitHook = async () => { throw new Error("disk"); };
    assert.deepEqual(await activate(f), f.plan);
    assert.deepEqual(f.world.ops("bootstrap"), [labels.adapter, labels.inference, labels.tunnel]);
    await stat(f.files[labels.studio]!); assert.ok(!f.world.loaded.has(labels.studio));
  });
});

test("a label swapped after the preflight is never stopped", async () => {
  await withFixture(async f => {
    await stage(f); const before = await snapshot(f);
    f.world.onBootout = label => { if (label === labels.adapter) f.world.processes.get(f.world.loaded.get(labels.inference)!)!.args = "node /other.js"; };
    assert.deepEqual(await activate(f), f.plan);
    assert.deepEqual(f.world.ops("bootout"), [labels.adapter]); assert.deepEqual(f.world.ops("bootstrap"), [labels.adapter]);
    assert.deepEqual(await snapshot(f), before);
  });
});

test("an unreadable receipt defers off the primary and stops the primary service", async () => {
  await withFixture(async f => {
    await stage(f); await writeFile(f.receiptPath, "{ not json"); await chmod(f.receiptPath, 0o600); const before = await snapshot(f);
    f.world.primary = false; assert.deepEqual(await activate(f), f.plan);
    f.world.primary = true; await rejectsRetirement(activate(f), /unreadable/);
    assert.deepEqual(f.world.mutating(), []); assert.deepEqual(await snapshot(f), before);
  });
});

const malformed: Array<{ name: string; change(job: Record<string, any>): void }> = [
  { name: "retiring job without loaded", change: job => { delete job.loaded; } },
  { name: "loaded job without a pid", change: job => { job.loaded = true; } },
  { name: "unloaded job with a pid", change: job => { job.loaded = false; job.pid = 4242; job.startedAtMs = 1; } },
];
for (const item of malformed) {
  test(`a malformed retiring receipt neither restores nor archives: ${item.name}`, async () => {
    await withFixture(async f => {
      await stage(f); const before = await snapshot(f);
      for (const label of [labels.adapter]) {
        await rename(f.files[label]!, join(f.root, "removed.plist")); const pid = f.world.loaded.get(label)!; f.world.loaded.delete(label); f.world.processes.delete(pid);
      }
      const receipt = JSON.parse(await readFile(f.receiptPath, "utf8")); receipt.phase = "retiring";
      for (const job of receipt.jobs) { job.loaded = false; }
      item.change(receipt.jobs[0]); await writeFile(f.receiptPath, JSON.stringify(receipt)); await chmod(f.receiptPath, 0o600);
      await rejectsRetirement(activate(f), /unreadable/);
      assert.deepEqual(f.world.ops("bootstrap"), []); assert.deepEqual(await named(f, "claude-rolled-back."), []); assert.deepEqual(await named(f, "claude-activated."), []);
      await stat(f.receiptPath); await assert.rejects(stat(f.files[labels.adapter]!), /ENOENT/);
      void before;
    });
  });
}

test("the plan on disk is untouched by an activation that was only deferred", async () => {
  await withFixture(async f => {
    await stage(f, false);
    const text = await readFile(f.planPath, "utf8"); await activate(f);
    assert.equal(await readFile(f.planPath, "utf8"), text); await unlink(f.receiptPath);
    assert.deepEqual(await activate(f), f.plan);
  });
});
