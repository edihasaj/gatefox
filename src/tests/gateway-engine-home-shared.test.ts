import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readlink, lstat, stat, symlink, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gatewayEngineHome, dropDuplicateRootKeys } from "../gateway-engine-home.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-shared-home-"));
  const nativeHome = join(root, "native"); await mkdir(nativeHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model = "native-owned"\n', { mode: 0o600 });
  await writeFile(join(nativeHome, "auth.json"), "native-auth-fixture", { mode: 0o600 });
  return { root, nativeHome, close: () => rm(root, { recursive: true, force: true }) };
}

test("shared generations use one native writer-lock namespace while config and auth remain isolated", async () => {
  const f = await fixture();
  try {
    const options = { nativeHome: f.nativeHome, sharedWriterLocks: true, preserveConfig: true };
    const a = await gatewayEngineHome(join(f.root, "generation-a"), { model: "one" }, options);
    const b = await gatewayEngineHome(join(f.root, "generation-b"), { model: "two" }, options);
    const locks = join(f.nativeHome, "thread-writer-locks");
    assert.equal(await readlink(join(a, "thread-writer-locks")), locks);
    assert.equal(await readlink(join(b, "thread-writer-locks")), locks);
    await writeFile(join(a, "thread-writer-locks", "thread-id.lock"), "one-owner", { mode: 0o600 });
    assert.equal(await readFile(join(b, "thread-writer-locks", "thread-id.lock"), "utf8"), "one-owner");
    const first = await stat(join(a, "thread-writer-locks", "thread-id.lock"));
    const second = await stat(join(b, "thread-writer-locks", "thread-id.lock"));
    assert.equal(first.ino, second.ino); assert.equal(first.dev, second.dev);
    assert.equal((await stat(locks)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-owned"\n');
    assert.equal(await readFile(join(f.nativeHome, "auth.json"), "utf8"), "native-auth-fixture");
    await assert.rejects(lstat(join(a, "auth.json")), { code: "ENOENT" });
    assert.equal((await lstat(join(a, "config.toml"))).isSymbolicLink(), false);
  } finally { await f.close(); }
});

test("shared config preservation retains private SDK trust writes across connection setup", async () => {
  const f = await fixture();
  try {
    const state = join(f.root, "generation"); const options = { nativeHome: f.nativeHome, sharedWriterLocks: true, preserveConfig: true };
    const home = await gatewayEngineHome(state, { model: "first", openai_api_key: "must-not-copy", model_providers: { openai: { token: "must-not-copy" } } }, options);
    const config = join(home, "config.toml"); const initial = await readFile(config, "utf8");
    assert.equal(initial.includes("must-not-copy"), false);
    const saved = initial + '\n[projects."/private/work"]\ntrust_level = "trusted"\n';
    await writeFile(config, saved, { mode: 0o600 });
    await gatewayEngineHome(state, { model: "new-snapshot" }, options);
    assert.equal(await readFile(config, "utf8"), saved);
    assert.equal((await lstat(config)).mode & 0o777, 0o600);
    const next = await gatewayEngineHome(join(f.root, "next-generation"), { model: "new-snapshot" }, options);
    assert.match(await readFile(join(next, "config.toml"), "utf8"), /new-snapshot/);
    assert.equal((await readFile(join(next, "config.toml"), "utf8")).includes("trust_level"), false);
  } finally { await f.close(); }
});

test("snapshot keys are bare so line-based installers find them, and preserved duplicates are repaired", async () => {
  const f = await fixture();
  try {
    const state = join(f.root, "generation"); const options = { nativeHome: f.nativeHome, sharedWriterLocks: true, preserveConfig: true };
    const home = await gatewayEngineHome(state, { notify: ["/native/client", "turn-ended"], projects: { "/a b": { trust_level: "trusted" } } }, options);
    const config = join(home, "config.toml"); const initial = await readFile(config, "utf8");
    assert.match(initial, /^notify = \["\/native\/client", "turn-ended"\]$/m);
    assert.match(initial, /projects = \{ "\/a b" = \{ trust_level = "trusted" \} \}/);
    // A snapshot written by an older release, then edited by an installer that appended a bare key.
    const legacy = '"model" = "m"\n"notify" = ["/native/client", "turn-ended"]\n"sqlite_home" = "/x"\n\nnotify = ["/engine/client", "turn-ended"]\n[projects."/p"]\ntrust_level = "trusted"\n';
    await writeFile(config, legacy, { mode: 0o600 });
    await gatewayEngineHome(state, { model: "new" }, options);
    const repaired = await readFile(config, "utf8");
    assert.equal(repaired, '"model" = "m"\n"sqlite_home" = "/x"\n\nnotify = ["/engine/client", "turn-ended"]\n[projects."/p"]\ntrust_level = "trusted"\n');
    assert.equal((await lstat(config)).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test("duplicate repair ignores tables, multi-line values and distinct keys", () => {
  const text = 'a = 1\nb = [\n  1,\n]\nb = 2\n"a.b" = 3\n[t]\na = 4\n';
  assert.equal(dropDuplicateRootKeys(text), text);
  assert.equal(dropDuplicateRootKeys('a = "x = ]"\na = 2\n'), "a = 2\n");
  assert.equal(dropDuplicateRootKeys("x = 1\n"), "x = 1\n");
});

test("shared writer-lock collisions preserve unexpected directories and foreign links", async t => {
  for (const kind of ["directory", "foreign-link"] as const) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const state = join(f.root, "generation"); const home = join(state, "desktop-engine"); await mkdir(home, { recursive: true });
      const target = join(home, "thread-writer-locks"); const foreign = join(f.root, "foreign-locks"); await mkdir(foreign);
      if (kind === "directory") await mkdir(target); else await symlink(foreign, target, "dir");
      await assert.rejects(gatewayEngineHome(state, {}, { nativeHome: f.nativeHome, sharedWriterLocks: true }), /different native home/);
      assert.equal((await lstat(target)).isSymbolicLink(), kind === "foreign-link");
      if (kind === "foreign-link") assert.equal(await readlink(target), foreign);
    } finally { await f.close(); }
  });
});

test("preserved executor config rejects public, oversized and symlink snapshots", async t => {
  for (const kind of ["public", "oversized", "symlink"] as const) await t.test(kind, async () => {
    const f = await fixture();
    try {
      const state = join(f.root, "generation"); const home = join(state, "desktop-engine"); await mkdir(home, { recursive: true });
      const path = join(home, "config.toml");
      if (kind === "symlink") await symlink(join(f.nativeHome, "config.toml"), path);
      else { await writeFile(path, kind === "oversized" ? "x".repeat(1024 * 1024 + 1) : "private-content", { mode: 0o600 }); if (kind === "public") await chmod(path, 0o644); }
      await assert.rejects(gatewayEngineHome(state, {}, { nativeHome: f.nativeHome, preserveConfig: true }), /not a private owned file/);
      assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model = "native-owned"\n');
      if (kind === "symlink") assert.equal(await readlink(path), join(f.nativeHome, "config.toml"));
    } finally { await f.close(); }
  });
});

test("legacy executor setup does not create or share writer locks by default", async () => {
  const f = await fixture();
  try {
    const home = await gatewayEngineHome(join(f.root, "legacy"), {}, { nativeHome: f.nativeHome });
    await assert.rejects(lstat(join(home, "thread-writer-locks")), { code: "ENOENT" });
    await assert.rejects(lstat(join(f.nativeHome, "thread-writer-locks")), { code: "ENOENT" });
    await assert.rejects(gatewayEngineHome(f.root, {}, { nativeHome: join(f.root, "desktop-engine") }), /must be separate/);
  } finally { await f.close(); }
});
