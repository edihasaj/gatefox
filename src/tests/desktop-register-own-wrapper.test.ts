import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access, chmod, link, lstat, mkdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { macDesktop, ownWrapper } from "../mac-desktop.js";
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

/** An override refusal must name CODEX_CLI_PATH and give the next step, while never echoing the refused path. */
const overrideRefusal = (foreign: string) => (error: unknown) => {
  const message = (error as Error).message;
  assert.match(message, /^Another desktop CLI override is active; it was not replaced\./);
  assert.match(message, /CODEX_CLI_PATH/, "the refusal names the variable it refused");
  assert.match(message, /run `launchctl unsetenv CODEX_CLI_PATH`, then register again/, "the refusal gives the next step");
  assert.equal(message.includes(foreign), false, "the refused path itself never appears in the message");
  return true;
};

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
 * for the verify step, so a refusal can never quietly replace or delete it. A seed that returns `null` could not
 * be built on this machine (a link across volumes, a restricted source file); each test reports such a shape
 * as skipped instead of passing over it quietly.
 */
const trickyPaths: Array<{ name: string; seed: (f: Fixture) => Promise<string | null>; verify?: (f: Fixture) => Promise<void> }> = [
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
  { name: "a hard link in the state directory to someone else's file", seed: async f => {
    // A second name for a root-owned file: same volume, regular file, exact wrapper name, right directory, and
    // only the owner differs. The gateway never writes the target; the uid rule only guards replacing a launchctl
    // value and clearing FORCE_CLI, never this file.
    const path = join(f.state, "desktop-wrapper-aaaaaaaaaaaaaaaa");
    if (process.getuid?.() === 0) return null; // as root the file would be ours by uid, so nothing to prove
    try { await link("/private/etc/hosts", path); }
    catch (error) { const code = (error as NodeJS.ErrnoException).code; if (code === "EXDEV" || code === "EPERM") return null; throw error; }
    return path;
  }, verify: async f => {
    const path = join(f.state, "desktop-wrapper-aaaaaaaaaaaaaaaa");
    const info = await lstat(path);
    assert.ok(info.isFile(), "the link is still a plain file, not a replaced one");
    assert.notEqual(info.uid, process.getuid?.(), "and it still belongs to its original owner");
    assert.equal((await readFile("/private/etc/hosts", "utf8")).length > 0, true, "the gateway never writes the file behind the link");
    await unlink(path);
  } },
];

/**
 * The ownership rule is a uid rule, and a hard link is the case that proves it: same volume, exact wrapper name,
 * right directory, plain regular file, and only the owner differs. `stat` and `uid` are seams so the test needs
 * no root-owned file.
 */
test("ownWrapper requires the wrapper file to belong to this user", mac, async () => {
  const f = await fixture();
  const wrapper = join(f.state, "desktop-wrapper-0123456789abcdef");
  const mine = process.getuid?.() ?? 0; const other = mine === 0 ? 1 : 0;
  const stat = (uid: number) => async () => ({ isFile: () => true, isSymbolicLink: () => false, uid });
  assert.equal(await ownWrapper(f.state, wrapper, stat(other)), false, "a regular wrapper someone else owns is foreign");
  assert.equal(await ownWrapper(f.state, wrapper, stat(mine)), true, "the same wrapper owned by this user is ours");
});

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
        await assert.rejects(macDesktop("register", f.config, f.app, restoreOnly, f.exec), overrideRefusal(foreign), `${name} restoreOnly=${restoreOnly}`);
        assert.equal(f.values.get(PATH_KEY), foreign, `${name}: the foreign path is never replaced`);
        assert.equal(f.values.get(FORCE), "1", `${name}: no proof, so the FORCE_CLI value is untouched`);
        assert.equal(f.calls.some(call => call.includes(PATH_KEY) && !call.startsWith("getenv ")), false, `${name}: no setenv or unsetenv for CODEX_CLI_PATH`);
        assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, `${name}: no setenv or unsetenv for FORCE_CLI`);
      });
    }
  }
});

test("registration refuses a CODEX_CLI_PATH that reaches a wrapper name only through spelling, a link, or a directory", mac, async (t) => {
  for (const shape of trickyPaths) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await staleOwnPair(f);
      const path = await shape.seed(f);
      if (path === null) { t.skip(`${shape.name}: cannot be built on this machine`); return; }
      f.values.set(PATH_KEY, path);
      await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), overrideRefusal(path), shape.name);
      assert.equal(f.values.get(PATH_KEY), path, shape.name + ": the path is never replaced");
      assert.equal(f.values.get(FORCE), "1", shape.name + ": the FORCE_CLI value is untouched");
      assert.equal(f.calls.some(call => (call.includes(PATH_KEY) || call.includes(FORCE)) && !call.startsWith("getenv ")), false, shape.name + ": no setenv or unsetenv");
      await shape.verify?.(f);
    });
  }
});

test("the nameless refusal of a foreign FORCE_CLI value never carries that value", mac, async () => {
  const f = await fixture();
  await inDesktopHome(f, async () => {
    await staleOwnPair(f);
    const foreign = "foreign-sentinel-7f3e"; f.values.set(FORCE, foreign);
    await assert.rejects(macDesktop("register", f.config, f.app, true, f.exec), (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /^Another desktop CLI mode is active; it was not replaced$/, "a value other than 1 gets the nameless refusal");
      assert.equal(message.includes(foreign), false, "the foreign FORCE_CLI value itself never appears in the message");
      return true;
    });
    assert.equal(f.values.get(FORCE), foreign, "the refusal leaves the foreign value alone");
    assert.equal(f.calls.some(call => call.includes(FORCE) && !call.startsWith("getenv ")), false, "no setenv or unsetenv for the foreign value");
  });
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

test("unregistration leaves a look-alike in the state directory and its FORCE_CLI untouched", mac, async (t) => {
  for (const shape of trickyPaths) {
    const f = await fixture();
    await inDesktopHome(f, async () => {
      await staleOwnPair(f);
      const path = await shape.seed(f);
      if (path === null) { t.skip(`${shape.name}: cannot be built on this machine`); return; }
      f.values.set(PATH_KEY, path);
      const result = await macDesktop("unregister", f.config, f.app, false, f.exec);
      assert.equal(result.registered, false, shape.name);
      assert.equal(f.calls.includes(`unsetenv ${PATH_KEY}`), false, shape.name + ": an unproven path is not ours to clear");
      assert.equal(f.calls.includes(`unsetenv ${FORCE}`), false, shape.name + ": no proof for the pair, so the value stays");
      assert.equal(f.values.get(PATH_KEY), path, shape.name); assert.equal(f.values.get(FORCE), "1", shape.name);
      await shape.verify?.(f);
    });
  }
});

test("status separates owning a stale wrapper from what future launches use", mac, async (t) => {
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
      const path = await shape.seed(f);
      if (path === null) { t.skip(`${shape.name}: cannot be built on this machine`); continue; }
      f.values.set(PATH_KEY, path);
      const foreign = await macDesktop("status", f.config, f.app, false, f.exec);
      assert.equal(foreign.activeForFutureLaunches, false, `${shape.name} is not ours`);
      assert.equal(foreign.legacyForceCli, false, `${shape.name} proves nothing about the 1`);
      assert.equal("staleWrapper" in foreign, false, shape.name);
    }
  });
});
