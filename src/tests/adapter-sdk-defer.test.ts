import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gatewaySdkChangeReader } from "../self-update.js";

async function layout() {
  const root = await realpath(await mkdtemp("/tmp/gw-sdkdefer-"));
  for (const release of ["1.5.9", "1.6.0"]) await mkdir(join(root, "releases", release, "package", "dist"), { recursive: true });
  return { root, moduleUrl: pathToFileURL(join(root, "releases/1.5.9/package/dist/self-update.js")).href, remove: () => rm(root, { recursive: true, force: true }) };
}
const pending = () => ({ running: "1.5.9", installed: "1.6.0" });

test("an adapter moves under its app only when the installed release changes the gateway SDK", async () => {
  const f = await layout();
  try {
    const receipts = (mine?: string, theirs?: string) => async (directory: string) => directory.includes("/1.6.0/") ? theirs : mine;
    assert.equal(await gatewaySdkChangeReader(f.moduleUrl, pending, receipts("sdk-a", "sdk-a"))(), false, "same SDK: wait for the app's relaunch");
    assert.equal(await gatewaySdkChangeReader(f.moduleUrl, pending, receipts("sdk-a", "sdk-b"))(), true, "another SDK: move now");
    assert.equal(await gatewaySdkChangeReader(f.moduleUrl, pending, receipts(undefined, "sdk-b"))(), true, "an unknown SDK keeps the earlier move");
    let reads = 0; const counted = gatewaySdkChangeReader(f.moduleUrl, pending, async directory => { reads++; return directory.includes("/1.6.0/") ? "x" : "x"; });
    await counted(); await counted(); assert.equal(reads, 2, "a known answer is cached per installed release");
  } finally { await f.remove(); }
});

test("no newer release means nothing to move to", async () => {
  const f = await layout();
  try { assert.equal(await gatewaySdkChangeReader(f.moduleUrl, () => ({ running: "1.6.0", installed: "1.6.0" }), async () => "a")(), false); }
  finally { await f.remove(); }
});
