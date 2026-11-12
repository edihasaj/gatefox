import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { migrateGatefox } from "../gatefox-migrate.js";
import { configIdentityPath, gatefoxConfigPath, legacyConfigPath, installRootIn, userConfigPath } from "../paths.js";
import { executionHostHome } from "../execution-host-storage.js";
import { managedInstallationForCommand, renderInstalledLauncher } from "../app-runtime.js";

const idle = async () => [];
async function fixture(platform = process.platform) {
  const home = await realpath(await mkdtemp("/tmp/gatefox-rename-"));
  const configRoot = dirname(legacyConfigPath(home, platform)), install = join(home, ".local/share/subscription-gateway");
  await mkdir(configRoot, { recursive: true, mode: 0o700 }); await mkdir(install, { recursive: true, mode: 0o700 });
  const config = join(configRoot, "gateway.json"), content = JSON.stringify({ version: 1, stateDirectory: ".state", providers: [{ id: "claude-primary", models: { "existing-alias": "existing-model" } }] });
  await writeFile(config, content, { mode: 0o600 }); await writeFile(join(configRoot, "private-credential"), "fixture", { mode: 0o600 });
  await writeFile(join(install, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 });
  const bin = join(home, ".local/bin"); await mkdir(bin, { mode: 0o700 });
  await writeFile(join(bin, "gatefox"), renderInstalledLauncher(install, join(bin, "gatefox")), { mode: 0o700 });
  const opts = { home, platform, busy: idle };
  const receipt = join(home, ".local/state/gatefox-rename/transaction.json");
  return { home, install, config, configRoot, bin, content, opts, receipt, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("rename preview writes nothing and reports canonical entry paths with preserved identities", async () => {
  const f = await fixture();
  try {
    const before = await readdir(f.home, { recursive: true });
    const result = await migrateGatefox(f.opts);
    assert.deepEqual(result.aliases.map(a => a.status), ["pending", "pending"]);
    assert.equal(result.applied, false);
    assert.deepEqual(await readdir(f.home, { recursive: true }), before);
  } finally { await f.cleanup(); }
});

test("Linux configuration aliases preserve the XDG backing path", async () => {
  const f = await fixture("linux");
  try {
    await migrateGatefox({ ...f.opts, apply: true });
    const canonical = gatefoxConfigPath(f.home, "linux");
    assert.equal(configIdentityPath(canonical, f.home, "linux"), f.config);
    assert.equal(userConfigPath(f.home, "linux"), f.config);
    assert.equal(await readFile(canonical, "utf8"), f.content);
    await migrateGatefox({ ...f.opts, apply: true, revert: true });
    assert.equal(await readFile(f.config, "utf8"), f.content);
  } finally { await f.cleanup(); }
});

test("apply and rollback preserve config bytes, file permissions, installer ownership and executor scope", async () => {
  const f = await fixture(), previousHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    const before = await lstat(f.config), nativeHome = join(f.home, ".codex");
    const scope = executionHostHome(f.config, nativeHome);
    assert.equal((await migrateGatefox({ ...f.opts, apply: true })).phase, "applied");
    const canonical = gatefoxConfigPath(f.home);
    assert.equal(await readFile(canonical, "utf8"), f.content);
    assert.equal((await lstat(f.config)).ino, before.ino);
    assert.equal((await lstat(f.config)).mode, before.mode);
    assert.equal(await readFile(join(f.configRoot, "private-credential"), "utf8"), "fixture");
    assert.equal(configIdentityPath(canonical), f.config);
    assert.equal(userConfigPath(f.home), f.config);
    assert.equal(executionHostHome(canonical, nativeHome), scope);
    assert.equal(scope.endsWith(createHash("sha256").update(f.config + "\0" + nativeHome).digest("hex").slice(0, 16)), true);
    assert.equal(installRootIn(join(f.home, ".local")), f.install);
    assert.equal((await managedInstallationForCommand(join(f.bin, "gatefox"))).root, f.install);
    assert.deepEqual((await migrateGatefox({ ...f.opts, apply: true })).aliases.map(a => a.status), ["compatible", "compatible"]);
    assert.equal((await migrateGatefox({ ...f.opts, apply: true, revert: true })).phase, "reverted");
    assert.equal(await readFile(f.config, "utf8"), f.content);
    assert.equal((await lstat(f.config)).ino, before.ino);
    assert.equal((await migrateGatefox({ ...f.opts, revert: true })).phase, "rollback_reverted");
    assert.equal((await migrateGatefox({ ...f.opts, apply: true, revert: true })).phase, "nothing_to_revert");
    assert.equal((await migrateGatefox({ ...f.opts, apply: true })).phase, "applied");
    assert.equal((await readdir(join(f.home, ".local/state/gatefox-rename"))).filter(name => name.includes(".reverted-")).length, 1);
  } finally { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; await f.cleanup(); }
});

test("an interrupted publication resumes from its recorded symlink inode", async () => {
  const f = await fixture();
  try {
    await migrateGatefox({ ...f.opts, apply: true });
    const journal = JSON.parse(await readFile(f.receipt, "utf8"));
    const last = journal.aliases[1];
    await unlink(last.path); delete last.ino; delete last.dev; delete last.ctimeMs;
    journal.phase = "prepared"; await writeFile(f.receipt, JSON.stringify(journal), { mode: 0o600 });
    assert.equal((await migrateGatefox({ ...f.opts, apply: true })).phase, "applied");
    assert.equal((await lstat(last.path)).isSymbolicLink(), true);
  } finally { await f.cleanup(); }
});

test("collisions, foreign links and active writers refuse before publication", async () => {
  const f = await fixture();
  try {
    await assert.rejects(migrateGatefox({ ...f.opts, apply: true, busy: async () => ["writer PID 123"] }), /stop GateFox together/);
    await assert.rejects(lstat(f.receipt), { code: "ENOENT" });
    const canonical = dirname(gatefoxConfigPath(f.home));
    await symlink("/unrelated", canonical);
    await assert.rejects(migrateGatefox({ ...f.opts, apply: true }), /Rename refused/);
    await unlink(canonical); await mkdir(canonical, { mode: 0o700 });
    await assert.rejects(migrateGatefox({ ...f.opts, apply: true }), /Rename refused/);
    assert.equal(await readFile(f.config, "utf8"), f.content);
  } finally { await f.cleanup(); }
});

test("an interruption before inode recording never adopts or removes an uncertain alias", async () => {
  const f = await fixture();
  try {
    await migrateGatefox({ ...f.opts, apply: true });
    const journal = JSON.parse(await readFile(f.receipt, "utf8"));
    delete journal.aliases[0].ino; delete journal.aliases[0].dev; delete journal.aliases[0].ctimeMs;
    journal.phase = "prepared"; await writeFile(f.receipt, JSON.stringify(journal), { mode: 0o600 });
    await assert.rejects(migrateGatefox({ ...f.opts, apply: true }), /before recording alias ownership/);
    await assert.rejects(migrateGatefox({ ...f.opts, apply: true, revert: true }), /Rename refused/);
    assert.equal((await lstat(journal.aliases[0].path)).isSymbolicLink(), true);
    assert.equal(await readFile(f.config, "utf8"), f.content);
  } finally { await f.cleanup(); }
});

test("concurrent migration calls serialize one publication and preserve its rollback receipt", async () => {
  const f = await fixture();
  try {
    const results = await Promise.all([migrateGatefox({ ...f.opts, apply: true }), migrateGatefox({ ...f.opts, apply: true })]);
    assert.equal(results.every(result => result.phase === "applied"), true);
    const journal = JSON.parse(await readFile(f.receipt, "utf8")); assert.equal(journal.aliases.length, 2);
    assert.equal((await migrateGatefox({ ...f.opts, apply: true, revert: true })).phase, "reverted");
  } finally { await f.cleanup(); }
});

test("rollback refuses a substituted alias even with an identical target", async () => {
  const f = await fixture();
  try {
    const result = await migrateGatefox({ ...f.opts, apply: true }), alias = result.aliases[1]!;
    const replacement = alias.path + ".replacement";
    await symlink(alias.backing, replacement); await rename(replacement, alias.path);
    await assert.rejects(migrateGatefox({ ...f.opts, apply: true, revert: true }), /Rename refused/);
    assert.equal((await lstat(result.aliases[0]!.path)).isSymbolicLink(), true, "rollback preflights all aliases first");
  } finally { await f.cleanup(); }
});

test("pending update transactions block the rename, and preexisting aliases are never adopted for rollback", async () => {
  const f = await fixture();
  try {
    const pending = join(f.install, "app-update-transaction.json"); await writeFile(pending, "{}", { mode: 0o600 });
    assert.match((await migrateGatefox(f.opts)).blockers.join(), /pending installation/);
    await assert.rejects(migrateGatefox({ ...f.opts, apply: true }), /pending installation/);
    await unlink(pending);
    const canonical = dirname(gatefoxConfigPath(f.home)); await symlink(f.configRoot, canonical);
    await migrateGatefox({ ...f.opts, apply: true });
    await migrateGatefox({ ...f.opts, apply: true, revert: true });
    assert.equal((await lstat(canonical)).isSymbolicLink(), true);
  } finally { await f.cleanup(); }
});
