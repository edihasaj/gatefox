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
  return { launchctl, bootstrapped, stopped, loaded };
};
const run = (f: Awaited<ReturnType<typeof fixture>>, launchctl: RollbackLaunchctl) =>
  rollbackConsolidation({ jobs: f.jobs, serviceLabel: label, targetPath: f.targetPath, planPath: f.planPath, trash: f.trash, replacementAttempted: true, launchctl });
const esrch = () => Object.assign(new Error("Boot-out failed"), { stderr: "Boot-out failed: 3: No such process" });

test("rollback treats a replacement that launchd already dropped as stopped and still restores every old job", async () => {
  const f = await fixture(); const s = stub();
  const failures = await run(f, { ...s.launchctl, bootout: async name => { await bootoutJob(`gui/501/${name}`, async () => { throw esrch(); }); s.loaded.delete(name); } });
  assert.deepEqual(failures, []);
  assert.deepEqual(s.bootstrapped, f.jobs.map(job => job.path));
  for (const job of f.jobs) assert.equal(await readFile(job.path, "utf8"), job.text);
  assert.equal((await readdir(f.trash)).length, 2);
});

test("a failing bootout of a replacement that is then proven unloaded still restores the old jobs", async () => {
  const f = await fixture(); const s = stub();
  const failures = await run(f, { ...s.launchctl, bootout: async name => { s.loaded.delete(name); throw new Error("secret /private/path value"); } });
  assert.deepEqual(failures, []);
  assert.deepEqual(s.bootstrapped, f.jobs.map(job => job.path));
  assert.equal((await readdir(f.trash)).length, 2);
});

test("a replacement that is still loaded stays the only service: no plan retirement and no old job bootstrap", async () => {
  const f = await fixture(); const s = stub({ bootout: async () => { throw new Error("secret /private/path value"); } });
  const failures = await run(f, s.launchctl);
  assert.deepEqual(failures, [{ step: "replacement_still_loaded" }]);
  assert.deepEqual(s.bootstrapped, []);
  assert.equal(await readFile(f.planPath, "utf8"), "{}");
  assert.equal(await readFile(f.targetPath, "utf8"), "new daemon");
  await assert.rejects(readdir(f.trash), { code: "ENOENT" });
  assert.doesNotMatch(JSON.stringify(failures), /secret|private/);
});

test("an unanswerable loaded check is treated as still loaded", async () => {
  const f = await fixture(); const s = stub({ isLoaded: async () => { throw new Error("launchctl unavailable"); } });
  assert.deepEqual(await run(f, s.launchctl), [{ step: "replacement_still_loaded" }]);
  assert.deepEqual(s.bootstrapped, []);
});

test("one failing restart step does not skip the others, and the failure is named by fixed class", async () => {
  const f = await fixture(); const s = stub({ bootstrap: async path => { if (path === f.jobs[0].path) throw new Error("secret bootstrap detail"); } });
  const bootstrapped: string[] = [];
  const failures = await run(f, { ...s.launchctl, bootstrap: async path => { if (path === f.jobs[0].path) throw new Error("secret bootstrap detail"); bootstrapped.push(path); } });
  assert.deepEqual(failures, [{ step: "restart_job", label: f.jobs[0].label }]);
  assert.deepEqual(bootstrapped, [f.jobs[1].path]);
  for (const job of f.jobs) assert.equal(await readFile(job.path, "utf8"), job.text);
  assert.doesNotMatch(JSON.stringify(failures), /secret|private/);
});
