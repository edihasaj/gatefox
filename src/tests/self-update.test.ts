import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { newerReleaseInstalled, releaseState, watchForUpgrade } from "../self-update.js";

test("an installed process knows its own release and the one current points to", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-release-"));
  try {
    for (const version of ["0.2.31", "0.2.32"]) { await mkdir(join(root, "releases", version, "package", "dist"), { recursive: true }); await writeFile(join(root, "releases", version, "package", "dist", "self-update.js"), ""); }
    await symlink("releases/0.2.31", join(root, "current"));
    const moduleUrl = pathToFileURL(join(root, "releases", "0.2.31", "package", "dist", "self-update.js")).href;
    assert.deepEqual(releaseState(moduleUrl), { running: "0.2.31", installed: "0.2.31" }); assert.equal(newerReleaseInstalled(releaseState(moduleUrl)), false);
    await rm(join(root, "current")); await symlink("releases/0.2.32", join(root, "current"));
    assert.deepEqual(releaseState(moduleUrl), { running: "0.2.31", installed: "0.2.32" }); assert.equal(newerReleaseInstalled(releaseState(moduleUrl)), true);
    assert.equal(releaseState(pathToFileURL(join(root, "checkout", "dist", "self-update.js")).href), undefined, "a checkout never upgrades itself");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the watcher upgrades after two idle checks, retries a refused upgrade, and stops when cancelled", async () => {
  const state = { running: "0.2.31", installed: "0.2.31" }; let idle = false; const attempts: boolean[] = []; let accept = false;
  const stop = watchForUpgrade("test", () => idle, () => { attempts.push(accept); return accept; }, { intervalMs: 10, state: () => state });
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await wait(50); assert.equal(attempts.length, 0, "nothing happens on the same release");
  state.installed = "0.2.32"; await wait(50); assert.equal(attempts.length, 0, "a busy process waits");
  idle = true; await wait(80); assert.ok(attempts.length >= 1 && attempts.every(value => !value), "a refused upgrade is retried");
  accept = true; await wait(80); const count = attempts.length; assert.equal(attempts.at(-1), true);
  await wait(60); assert.equal(attempts.length, count, "one accepted upgrade ends the watch");
  stop();
});
