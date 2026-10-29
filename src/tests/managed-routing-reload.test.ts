import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateAliasesAgainstNative, validateConfig } from "../config.js";
import { LiveConfig } from "../live-config.js";
import { managedFixture } from "./managed-routing-fixture.js";

test("managed aliases cannot shadow a native model", () => {
  assert.throws(() => validateAliasesAgainstNative(managedFixture("/unused"), new Set(["managed/routine"])), /collides/);
});
test("a refused provider rebind still withdraws a deliberately removed managed alias", async () => {
  const root = await mkdtemp(join(tmpdir(), "managed-reload-"));
  try {
    const before = validateConfig(managedFixture(root));
    const path = join(root, "gateway.json");
    await writeFile(path, JSON.stringify(before));
    const live = new LiveConfig(path, before); await live.current();
    const after = structuredClone(before); delete after.managedRouting;
    after.providers[0].baseUrl = "http://127.0.0.1:9999/v1";
    await writeFile(path, JSON.stringify(after));
    const served = await live.current();
    assert.equal(live.rejection, "rebind"); assert.equal(served.managedRouting, undefined);
    assert.equal(served.providers[0].baseUrl, before.providers[0].baseUrl);
  } finally { await rm(root, { recursive: true, force: true }); }
});
