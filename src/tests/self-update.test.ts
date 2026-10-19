import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { newerReleaseInstalled, releaseState, watchForUpgrade } from "../self-update.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

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

test("the watcher tells the upgrade how long a newer release has waited, and logs how it moved", async () => {
  const home = await mkdtemp(join(tmpdir(), "gateway-upgrade-events-")); configureTelemetry(home, "test");
  const state = { running: "0.4.4", installed: "0.4.5" }; const waited: number[] = []; let accept = false;
  const stop = watchForUpgrade("service", () => true, ({ pendingMs }) => { waited.push(pendingMs); return accept ? { mode: "quiet" as const, loadedChats: 3 } : false; }, { intervalMs: 10, state: () => state });
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await wait(120); assert.ok(waited.length >= 2 && waited.at(-1)! > waited[0], "the wait grows while the release stays installed");
    state.installed = "0.4.4"; await wait(40); state.installed = "0.4.5"; const restarted = waited.length;
    await wait(60); assert.ok(waited[restarted] < waited[restarted - 1], "a release that was taken back starts the wait again");
    accept = true; await wait(60); await flushTelemetry();
    const events = (await readTelemetry(home, Date.now() - 60_000)).filter(event => event.event === "self_upgrade");
    assert.deepEqual(events.map(event => [event.component, event.from, event.to, event.mode, event.loadedChats]), [["service", "0.4.4", "0.4.5", "quiet", 3]]);
  } finally { stop(); await rm(home, { recursive: true, force: true }); }
});
