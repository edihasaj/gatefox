import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generationsKept, hasUnidentifiedProcess, planBundles, planGenerations, planReleases, pruneRetained } from "../app-updates/retention.js";

const now = Date.UTC(2026, 10, 5);
const day = 86_400_000;

test("release planning keeps current, previous, one spare and anything in use, comparing versions numerically", () => {
  const names = ["1.5.2", "1.5.10", "1.5.9", "1.6.0", "1.6.1", "not-a-release", ".retired-1.0.0-1"];
  assert.deepEqual(planReleases(names, "1.6.1", "1.6.0", ""), ["1.5.9", "1.5.2"]);
  assert.deepEqual(planReleases(names, "1.6.1", "1.6.0", "n/Users/x/share/releases/1.5.2/package/dist/cli.js"), ["1.5.9"]);
});

test("generation planning keeps the newest, recent and referenced ones", () => {
  const entries = Array.from({ length: generationsKept + 3 }, (_, index) => ({ name: `shared-v1-g${index}`, modifiedMs: now - (index + 1) * day }));
  entries.push({ name: "unrelated", modifiedMs: now - 90 * day });
  const removed = planGenerations(entries, "HOME=/state/desktop-generations/shared-v1-g13/desktop-engine", now);
  assert.deepEqual(removed, ["shared-v1-g12", "shared-v1-g14"], "g13 is in use, and a foreign folder is never touched");
  assert.deepEqual(planGenerations([{ name: "shared-v1-new", modifiedMs: now - day }], "", now), [], "recent ones stay even beyond the count");
  const recent = Array.from({ length: generationsKept + 2 }, (_, index) => ({ name: `shared-v1-r${index}`, modifiedMs: now - 3600_000 }));
  assert.deepEqual(planGenerations(recent, "", now), []);
});

async function world() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-retention-"));
  const root = join(directory, "install"), state = join(directory, "state"), generations = join(state, "desktop-generations");
  await mkdir(generations, { recursive: true });
  for (const name of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"]) {
    await mkdir(join(root, "releases", name), { recursive: true }); await writeFile(join(root, "releases", name, ".gateway-release"), `${name}\n`);
  }
  await mkdir(join(root, "releases", "0.9.0"));
  await symlink("releases/1.4.0", join(root, "current"));
  await writeFile(join(root, "previous-release"), "releases/1.3.0\n");
  for (let index = 0; index < generationsKept + 2; index++) {
    const path = join(generations, `shared-v1-g${String(index).padStart(2, "0")}`); await mkdir(path);
    const when = new Date(now - (index + 4) * day); await utimes(path, when, when);
  }
  return { directory, root, state, generations };
}

test("pruning removes only what the plan allows and needs a release marker", async () => {
  const w = await world();
  try {
    const result = await pruneRetained({ installRoot: w.root, stateDirectory: w.state, now, inventory: async () => "/releases/1.1.0/package" });
    assert.deepEqual(result.releases, ["1.0.0"], "1.1.0 is in use, and 0.9.0 has no marker");
    assert.deepEqual((await readdir(join(w.root, "releases"))).sort(), ["0.9.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"]);
    assert.deepEqual(result.generations.sort(), ["shared-v1-g12", "shared-v1-g13"]);
    assert.equal((await readdir(w.generations)).length, generationsKept);
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("an incomplete inventory or an open update removes nothing", async () => {
  const w = await world();
  try {
    const blind = await pruneRetained({ installRoot: w.root, stateDirectory: w.state, now, inventory: async () => undefined });
    assert.deepEqual(blind, { releases: [], generations: [], skipped: "inventory_incomplete" });
    await writeFile(join(w.root, "app-update-transaction.json"), "{}");
    let asked = false;
    const open = await pruneRetained({ installRoot: w.root, stateDirectory: w.state, now, inventory: async () => { asked = true; return ""; } });
    assert.equal(open.skipped, "update_in_progress");
    assert.equal(asked, false);
    assert.equal((await readdir(join(w.root, "releases"))).length, 6);
    assert.equal((await readdir(w.generations)).length, generationsKept + 2);
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("a failing inventory never throws into a finished update", async () => {
  const w = await world();
  try {
    const result = await pruneRetained({ installRoot: w.root, stateDirectory: w.state, now, inventory: async () => { throw new Error("boom"); } });
    assert.deepEqual([result.releases, result.generations], [[], []]);
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});

test("a process running through current without an open entry point stops all pruning", () => {
  const command = "node /Users/x/.local/share/subscription-gateway/current/package/dist/cli.js serve";
  const files = "p41\nn/Users/x/.local/share/subscription-gateway/releases/1.2.0/package/dist/cli.js\np42\nn/tmp/other\n";
  assert.equal(hasUnidentifiedProcess(files, `41 ${command}`), false);
  assert.equal(hasUnidentifiedProcess(files, `42 ${command}`), true);
  assert.equal(hasUnidentifiedProcess(files, "42 /bin/zsh"), false);
});

test("bundle planning keeps the protected rollback, one spare and anything in use", () => {
  const bundle = (id: string) => `.Harness-Gateway-Update-${id}.app`;
  const entries = ["0a", "1b", "2c", "3d", "4e"].map((id, index) => ({ name: bundle(id), modifiedMs: now - index * day }));
  entries.push({ name: "GateFox.app", modifiedMs: now - 90 * day }, { name: ".Harness-Gateway-Update.app", modifiedMs: now - 90 * day });
  assert.deepEqual(planBundles(entries, [bundle("1b")], `n/Users/x/Applications/${bundle("3d")}/Contents/MacOS/node`), [bundle("2c"), bundle("4e")],
    "1b is protected, 0a is the newest spare, 3d is in use, and other names are never touched");
  assert.deepEqual(planBundles(entries.slice(0, 1), [], ""), [], "a single bundle always stays");
});

test("pruning removes old rollback bundles beside the app only when asked", async () => {
  const w = await world();
  const apps = join(w.directory, "Applications");
  try {
    await mkdir(join(apps, "GateFox.app"), { recursive: true });
    const ids = ["aa", "bb", "cc", "dd"];
    for (const [index, id] of ids.entries()) {
      const path = join(apps, `.Harness-Gateway-Update-${id}.app`); await mkdir(path);
      const when = new Date(now - index * day); await utimes(path, when, when);
    }
    const untouched = await pruneRetained({ installRoot: w.root, stateDirectory: w.state, now, inventory: async () => "" });
    assert.equal(untouched.bundles, undefined);
    assert.equal((await readdir(apps)).length, 5);
    const result = await pruneRetained({ installRoot: w.root, stateDirectory: w.state, now, inventory: async () => "",
      appDirectory: apps, keepBundles: [join(apps, ".Harness-Gateway-Update-cc.app")] });
    assert.deepEqual(result.bundles?.sort(), [".Harness-Gateway-Update-bb.app", ".Harness-Gateway-Update-dd.app"]);
    assert.deepEqual((await readdir(apps)).sort(), [".Harness-Gateway-Update-aa.app", ".Harness-Gateway-Update-cc.app", "GateFox.app"]);
  } finally { await rm(w.directory, { recursive: true, force: true }); }
});
