import test from "node:test";
import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macDesktop } from "../mac-desktop.js";
import { prepareDesktop } from "../desktop-launch.js";
import { writePrivateJson } from "../config.js";
import { FORCE, inDesktopHome, PATH_KEY, desktopFixture, type DesktopFixture as Fixture } from "./desktop-fixture.js";

const mac = { skip: process.platform !== "darwin" };
const fixture = () => desktopFixture("own-wrapper");

/**
 * Session holds an older wrapper in our state dir; the receipt names a different one and FORCE_CLI=1 is still
 * set. `onDisk` covers both halves of ownership: a regular file we still have, and one a cleanup already removed.
 */
async function staleOwnPair(f: Fixture, onDisk = true) {
  const { wrapper } = await prepareDesktop(f.config, f.app);
  await writePrivateJson(f.receipt, { wrapper, registeredAt: new Date().toISOString() });
  const stale = join(f.state, "desktop-wrapper-89fafe006c5dc3e4");
  if (onDisk) { await writeFile(stale, "#!/bin/sh\nexec /gone/older-codex \"$@\"\n"); await chmod(stale, 0o700); }
  f.values.set(PATH_KEY, stale); f.values.set(FORCE, "1");
  return { wrapper, stale };
}

const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };

/** Names inside our state directory that a generated wrapper never has. */
const lookalikeNames: Array<[string, (f: Fixture) => string]> = [
  ["another directory", f => join(f.root, "other", "desktop-wrapper-0123456789abcdef")],
  ["a suffix in the state directory", f => join(f.state, "desktop-wrapper-0123456789abcdef.sh")],
  ["a short hash in the state directory", f => join(f.state, "desktop-wrapper-0123")],
  ["a prefix in the state directory", f => join(f.state, "notdesktop-wrapper-0123456789abcdef")],
  ["16 characters that are not hex", f => join(f.state, "desktop-wrapper-zzzzzzzzzzzzzzzz")],
  ["uppercase hex", f => join(f.state, "desktop-wrapper-0123456789ABCDEF")],
  ["an uppercase prefix", f => join(f.state, "DESKTOP-WRAPPER-0123456789abcdef")],
  ["a subdirectory of the state directory", f => join(f.state, "sub", "desktop-wrapper-0123456789abcdef")],
  ["a sibling of the state directory", f => join(f.root, "state-x", "desktop-wrapper-0123456789abcdef")],
];

/**
 * Paths that reach a wrapper name only through spelling or a link. Each seed leaves the object it created behind
 * for the verify step, so a refusal can never quietly replace or delete it.
 */
const trickyPaths: Array<{ name: string; seed: (f: Fixture) => Promise<string>; verify?: (f: Fixture) => Promise<void> }> = [
  { name: "a relative wrapper name", seed: async () => "desktop-wrapper-0123456789abcdef" },
  { name: "a wrapper behind a symlink that climbs back into the state directory", seed: async f => {
    const elsewhere = join(f.root, "elsewhere"); await mkdir(elsewhere, { recursive: true, mode: 0o700 });
    await writeFile(join(elsewhere, "desktop-wrapper-123456789abcdef0"), "#!/bin/sh\nexit 0\n");
    await symlink(elsewhere, join(f.state, "link"));
    // Built by hand: path.join would collapse the `..` and leave a plain path inside the state directory.
    return `${join(f.state, "link")}/../desktop-wrapper-123456789abcdef0`;
  }, verify: async f => assert.ok(await exists(join(f.root, "elsewhere", "desktop-wrapper-123456789abcdef0")), "the file behind the link is still there") },
  { name: "a symlink in the state directory", seed: async f => {
    const path = join(f.state, "desktop-wrapper-23456789abcdef01"); await symlink(join(f.root, "elsewhere-cli"), path); return path;
  }, verify: async f => assert.equal(await readlink(join(f.state, "desktop-wrapper-23456789abcdef01")), join(f.root, "elsewhere-cli"), "the symlink still points where it did") },
  { name: "a directory with a wrapper name", seed: async f => {
    const path = join(f.state, "desktop-wrapper-3456789abcdef012"); await mkdir(path, { mode: 0o700 }); return path;
  }, verify: async f => assert.ok((await lstat(join(f.state, "desktop-wrapper-3456789abcdef012"))).isDirectory(), "the directory was never replaced") },
  { name: "a wrapper name with a trailing slash", seed: async f => join(f.state, "desktop-wrapper-456789abcdef0123") + "/" },
];

test("registration replaces an older gateway wrapper the receipt no longer names and clears its FORCE_CLI", mac, async () => {
  for (const restoreOnly of [true, false]) {
    for (const onDisk of [true, false]) {
      const f = await fixture();
      await inDesktopHome(f, async () => {
        const { wrapper } = await staleOwnPair(f, onDisk);
        const label = `restoreOnly=${restoreOnly} wrapperOnDisk=${onDisk}`;
        const result = await macDesktop("register", f.config, f.app, restoreOnly, f.exec);
        assert.equal(result.registered, true, label);
        assert.equal(f.values.get(PATH_KEY), wrapper, label + ": the current wrapper replaces the stale one");
        assert.equal(f.values.has(FORCE), false, label + ": the proven legacy hook is cleared");
        assert.ok(f.calls.includes(`unsetenv ${FORCE}`), label);
        assert.equal(f.calls.some(call => call.startsWith(`setenv ${FORCE}`)), false, label);
      });
    }
  }
});

test("registration refuses a CODEX_CLI_PATH that only looks like one of our wrappers", mac, async () => {
  for (const restoreOnly of [true, false]) {
    for (const [name, path] of lookalikeNames) {
      const f = await fixture();
      await inDesktopHome(f, async () => {
        await staleOwnPair(f);
        const foreign = path(f); f.values.set(PATH_KEY, foreign);
        await assert.rejects(macDesktop("register", f.config, f.app, restoreOnly, f.exec), /Another desktop CLI override is active; it was not replaced/, `${name} restoreOnly=${restoreOnly}`);
        assert.equal(f.values.get(PATH_KEY), foreign, `${name}: the foreign path is never replaced`);
        assert.equal(f.values.get(FORCE), "1", `${name}: no proof, so the FORCE_CLI value is untouched`);
        assert.equal(f.calls.some(call => call.includes(PATH_KEY) && !call.startsWith("getenv ")), false, `${name}: no setenv or unsetenv for CODEX_CLI_PATH`);
        assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, `${name}: no setenv or unsetenv for FORCE_CLI`);
      });
    }
  }
});

test("registration refuses a CODEX_CLI_PATH that reaches a wrapper name only through spelling, a link, or a directory", mac, async () => {
  for (const shape of trickyPaths) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await staleOwnPair(f);
      const path = await shape.seed(f); f.values.set(PATH_KEY, path);
      await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), /Another desktop CLI override is active; it was not replaced/, shape.name);
      assert.equal(f.values.get(PATH_KEY), path, shape.name + ": the path is never replaced");
      assert.equal(f.values.get(FORCE), "1", shape.name + ": the FORCE_CLI value is untouched");
      assert.equal(f.calls.some(call => (call.includes(PATH_KEY) || call.includes(FORCE)) && !call.startsWith("getenv ")), false, shape.name + ": no setenv or unsetenv");
      await shape.verify?.(f);
    });
  }
});

test("unregistration clears an older gateway wrapper the receipt no longer names", mac, async () => {
  for (const onDisk of [true, false]) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      const { stale } = await staleOwnPair(f, onDisk);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false, `wrapperOnDisk=${onDisk}`);
      assert.ok(f.calls.includes(`unsetenv ${PATH_KEY}`), `wrapperOnDisk=${onDisk}`); assert.ok(f.calls.includes(`unsetenv ${FORCE}`), `wrapperOnDisk=${onDisk}`);
      assert.equal(f.values.has(PATH_KEY), false, `wrapperOnDisk=${onDisk}`); assert.equal(f.values.has(FORCE), false, `wrapperOnDisk=${onDisk}`);
      assert.equal(await exists(stale), onDisk, "registration never deletes a wrapper file");
    });
  }
});

test("unregistration leaves a look-alike in the state directory and its FORCE_CLI untouched", mac, async () => {
  for (const shape of trickyPaths) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await staleOwnPair(f);
      const path = await shape.seed(f); f.values.set(PATH_KEY, path);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false, shape.name);
      assert.equal(f.calls.includes(`unsetenv ${PATH_KEY}`), false, shape.name + ": an unproven path is not ours to clear");
      assert.equal(f.calls.includes(`unsetenv ${FORCE}`), false, shape.name + ": no proof for the pair, so the value stays");
      assert.equal(f.values.get(PATH_KEY), path, shape.name); assert.equal(f.values.get(FORCE), "1", shape.name);
      await shape.verify?.(f);
    });
  }
});

test("status separates owning a stale wrapper from what future launches use", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    const { wrapper, stale: stalePath } = await staleOwnPair(f);
    const stale = await macDesktop("status", f.config, f.app, false, f.exec);
    assert.equal(stale.registered, true);
    assert.equal(stale.activeForFutureLaunches, false, "the session points at a wrapper the receipt no longer names");
    assert.equal(stale.staleWrapper, true, `wrapper=${stalePath}`);
    assert.equal(stale.legacyForceCli, true, "the receipt names a wrapper, so the 1 beside our older wrapper is ours");
    f.values.set(PATH_KEY, wrapper);
    const active = await macDesktop("status", f.config, f.app, false, f.exec);
    assert.equal(active.activeForFutureLaunches, true, "the registered wrapper is the active one");
    assert.equal("staleWrapper" in active, false, "nothing stale when the session already uses it");
    for (const [name, lookalike] of lookalikeNames) {
      f.values.set(PATH_KEY, lookalike(f));
      const foreign = await macDesktop("status", f.config, f.app, false, f.exec);
      assert.equal(foreign.activeForFutureLaunches, false, `a look-alike (${name}) is not ours`);
      assert.equal("staleWrapper" in foreign, false, name);
    }
    for (const shape of trickyPaths) {
      const path = await shape.seed(f); f.values.set(PATH_KEY, path);
      const foreign = await macDesktop("status", f.config, f.app, false, f.exec);
      assert.equal(foreign.activeForFutureLaunches, false, `${shape.name} is not ours`);
      assert.equal(foreign.legacyForceCli, false, `${shape.name} proves nothing about the 1`);
      assert.equal("staleWrapper" in foreign, false, shape.name);
    }
  });
});
