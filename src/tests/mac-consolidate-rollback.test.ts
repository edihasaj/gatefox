import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootoutJob } from "../launchctl.js";
import { rollbackConsolidation, type RollbackLaunchctl } from "../mac-consolidate-rollback.js";

const label = "com.edihasaj.subscription-gateway";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gw-rollback-")); const trash = join(root, "trash"); const agents = join(root, "agents"); await mkdir(agents);
  const jobs = [".desktop", ".tunnel.studio"].map(suffix => ({ path: join(agents, label + suffix + ".plist"), label: label + suffix, text: `old ${suffix}`, loaded: true }));
  const targetPath = join(agents, label + ".plist"); const planPath = join(root, "service-plan.json");
  await writeFile(targetPath, "new daemon"); await writeFile(planPath, "{}");
  return { root, trash, jobs, targetPath, planPath };
}
const stub = (overrides: Partial<RollbackLaunchctl> = {}) => {
  const bootstrapped: string[] = []; const stopped: string[] = []; const loaded = new Set([label]);
  const launchctl: RollbackLaunchctl = { isLoaded: async name => loaded.has(name), bootout: async name => { stopped.push(name); loaded.delete(name); },
    bootstrap: async path => { bootstrapped.push(path); }, ...overrides };
  return { launchctl, bootstrapped, stopped };
};

test("rollback treats a replacement that launchd already dropped as stopped and still restores every old job", async () => {
  const f = await fixture(); const { launchctl, bootstrapped } = stub({
    bootout: async name => { await bootoutJob(`gui/501/${name}`, async () => { throw Object.assign(new Error("Boot-out failed"), { stderr: "Boot-out failed: 3: No such process" }); }); } });
  const failures = await rollbackConsolidation({ jobs: f.jobs, serviceLabel: label, targetPath: f.targetPath, planPath: f.planPath, trash: f.trash, replacementAttempted: true, launchctl });
  assert.deepEqual(failures, []);
  assert.deepEqual(bootstrapped, f.jobs.map(job => job.path));
  for (const job of f.jobs) assert.equal(await readFile(job.path, "utf8"), job.text);
  assert.equal((await readdir(f.trash)).length, 2);
});

test("one failing rollback step does not skip the others, and the failures are named by fixed class", async () => {
  const f = await fixture(); const { launchctl, bootstrapped } = stub({ bootout: async () => { throw new Error("secret /private/path value"); },
    bootstrap: async path => { if (path === f.jobs[0].path) throw new Error("secret bootstrap detail"); bootstrapped.push(path); } });
  const failures = await rollbackConsolidation({ jobs: f.jobs, serviceLabel: label, targetPath: f.targetPath, planPath: f.planPath, trash: f.trash, replacementAttempted: true, launchctl });
  assert.deepEqual(failures, [{ step: "stop_replacement" }, { step: "restart_job", label: f.jobs[0].label }]);
  assert.deepEqual(bootstrapped, [f.jobs[1].path]);
  for (const job of f.jobs) assert.equal(await readFile(job.path, "utf8"), job.text);
  assert.doesNotMatch(JSON.stringify(failures), /secret|private/);
});
