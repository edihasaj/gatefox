import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { installPending } from "../app-updates.js";
import { cleanupUpdateStage, confirmPlannedStage, planUpdateStageCleanup, removePlannedStage, type StageExpectation } from "../app-updates/cleanup.js";
import { beginInstallationTransaction, runCanonicalInstall, swapAndCommitInstallationTransaction, type TransactionCommand } from "../app-updates/transaction.js";
import type { Command } from "../app-updates/types.js";

const exec = promisify(execFile);
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const source = "a".repeat(40);
const exists = (path: string) => lstat(path).then(() => true, () => false);
const noop: TransactionCommand = async () => {};

/** A managed installation root holding one finished stage laid out the way the updater leaves it. */
async function stageWorld(version = "0.2.0") {
  const directory = await mkdtemp(join(tmpdir(), "gateway-app-cleanup-"));
  const root = join(directory, "install"); await mkdir(root, { mode: 0o700 }); await chmod(root, 0o700);
  const archiveName = `harness-gateway-${version}-macos-arm64.tar.gz`, zipName = `Harness-Gateway-${version}-macos-arm64.zip`;
  const backendSha256 = sha("backend-bytes");
  const stage = join(root, `app-update-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
  await writeFile(join(stage, archiveName), "backend-bytes", { mode: 0o600 });
  const manifest = { schemaVersion: 1, version, source, branch: "production", appAsset: zipName, appSha256: "c".repeat(64), backendAsset: archiveName, backendSha256 };
  await writeFile(join(stage, "app-update.json"), JSON.stringify(manifest), { mode: 0o600 });
  const backendRoot = join(stage, "backend", `harness-gateway-${version}-macos-arm64`), deep = join(backendRoot, "pkg", "deep");
  await mkdir(deep, { recursive: true, mode: 0o700 });
  const file = join(deep, "file.js"); await writeFile(file, "x", { mode: 0o644 });
  const appBundle = join(stage, "app", "Harness Gateway.app"); await mkdir(appBundle, { recursive: true, mode: 0o700 });
  const pending: StageExpectation = { version, source, backendSha256, backendArchive: join(stage, archiveName) };
  const writeManifest = (change: Record<string, unknown>) => writeFile(join(stage, "app-update.json"), JSON.stringify({ ...manifest, ...change }), { mode: 0o600 });
  // Things that must survive: the retained rollback bundle, the releases and the state file.
  const retained = join(directory, ".Harness-Gateway-Update-keep.app"); await mkdir(join(retained, "Contents"), { recursive: true });
  await mkdir(join(root, "releases", "0.1.0"), { recursive: true }); await writeFile(join(root, "app-update.json"), "{}", { mode: 0o600 });
  const survivors = async () => [await exists(retained), await exists(join(root, "releases", "0.1.0")), await exists(join(root, "app-update.json"))];
  return { directory, root, stage, pending, retained, archiveName, backendRoot, deep, file, appBundle, writeManifest, survivors, done: () => rm(directory, { recursive: true, force: true }) };
}
type World = Awaited<ReturnType<typeof stageWorld>>;
async function withStage(run: (w: World) => Promise<void>): Promise<void> {
  const w = await stageWorld(); try { await run(w); } finally { await w.done(); }
}
const refused = async (w: World, reason: string, options: Parameters<typeof cleanupUpdateStage>[2] = {}) => {
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending, options), { removed: false, reason });
  assert.equal(await exists(w.file), true, "nothing was deleted");
};

test("a finished stage is removed whole while the retained bundle, releases and state stay", () => withStage(async w => {
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending, { protect: [w.retained] }), { removed: true });
  assert.equal(await exists(w.stage), false);
  assert.deepEqual(await w.survivors(), [true, true, true]);
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending), { removed: false, reason: "missing" }, "a second run is harmless");
}));

test("planning and confirming only inspect, and the plan can be removed through an injected deletion", () => withStage(async w => {
  const plan = await planUpdateStageCleanup(w.root, w.pending);
  assert.ok(plan.ok); if (!plan.ok) return;
  assert.ok(plan.plan.entries > 5);
  assert.equal(await confirmPlannedStage(plan.plan), true);
  assert.equal(await exists(w.stage), true);
  const seen: string[] = [];
  assert.deepEqual(await removePlannedStage(plan.plan, async path => { seen.push(path); await rm(path, { recursive: true }); }), { removed: true });
  assert.deepEqual(seen, [w.stage]);
}));

test("tolerated shapes: a __MACOSX folder beside the bundle and an activation folder holding the backend", () => withStage(async w => {
  await mkdir(join(w.stage, "app", "__MACOSX"), { mode: 0o700 });
  await mkdir(join(w.stage, `activate-${randomUUID()}`, `harness-gateway-0.2.0-macos-arm64`), { recursive: true, mode: 0o700 });
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending), { removed: true });
}));

test("a stage that is nested, the root, current, releases or not named app-update-UUID is refused", () => withStage(async w => {
  const name = w.archiveName, base = w.stage.split("/").pop()!;
  const check = async (installRoot: string, backendArchive: string, reason: string) =>
    assert.deepEqual(await cleanupUpdateStage(installRoot, { ...w.pending, backendArchive }), { removed: false, reason });
  await check(w.root, join(w.root, "sub", base, name), "not_a_stage");
  await check(w.root, join(w.root, name), "not_a_stage");
  await check(w.root, join(w.root, "releases", name), "not_a_stage");
  await check(w.root, join(w.root, "current", name), "not_a_stage");
  await check(w.root, join(w.root, "app-update-not-a-uuid", name), "not_a_stage");
  await check(w.root, join(w.directory, `app-update-${randomUUID()}`, name), "not_a_stage");
  await check(w.root, join(w.stage, "harness-gateway-9.9.9-macos-arm64.tar.gz"), "not_a_stage");
  await check("relative/root", join(w.root, name), "invalid_request");
  assert.deepEqual(await w.survivors(), [true, true, true]);
  assert.equal(await exists(w.file), true);
}));

test("anything the caller protects, inside or around the stage, blocks removal", () => withStage(async w => {
  for (const protect of [w.stage, join(w.stage, "app"), w.appBundle, w.directory]) await refused(w, "protected", { protect: [protect] });
}));

test("a current, app-runtime or other link that resolves into or around the stage blocks removal", () => withStage(async w => {
  await symlink(w.backendRoot, join(w.root, "current"));
  await refused(w, "protected");
  await unlink(join(w.root, "current"));
  await symlink(join(w.stage, "backend"), join(w.root, "app-runtime"));
  await refused(w, "protected");
  await unlink(join(w.root, "app-runtime"));
  await symlink(w.stage, join(w.root, "previous-release"));
  await refused(w, "protected");
}));

test("a stage still named by a pending record, an unreadable state file or a journal is refused", () => withStage(async w => {
  const state = join(w.root, "app-update.json");
  const pending = { version: "0.2.0", source, backendSha256: w.pending.backendSha256, appStage: w.retained, backendArchive: w.pending.backendArchive, requestedAt: new Date().toISOString() };
  await writeFile(state, JSON.stringify({ schemaVersion: 1, automatic: true, pending }), { mode: 0o600 });
  await refused(w, "protected");
  for (const text of ["{broken", "[]", JSON.stringify({ schemaVersion: 1, pending: 5 })]) { await writeFile(state, text, { mode: 0o600 }); await refused(w, "unsafe_path"); }
  await writeFile(state, "{}", { mode: 0o600 });
  await writeFile(join(w.root, "app-update-transaction.json"), "{}", { mode: 0o600 });
  await refused(w, "protected");
  await unlink(join(w.root, "app-update-transaction.json"));
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending), { removed: true });
}));

test("links, shared files, unexpected entries and a linked stage are refused untouched", () => withStage(async w => {
  const outside = join(w.directory, "outside"); await mkdir(outside); await writeFile(join(outside, "precious"), "keep");
  await symlink(outside, join(w.backendRoot, "escape")); await refused(w, "unexpected_entry"); await unlink(join(w.backendRoot, "escape"));
  await link(join(outside, "precious"), join(w.backendRoot, "shared")); await refused(w, "unexpected_entry"); await unlink(join(w.backendRoot, "shared"));
  await writeFile(join(w.stage, "notes.txt"), "extra", { mode: 0o600 }); await refused(w, "unexpected_entry"); await unlink(join(w.stage, "notes.txt"));
  await symlink(outside, join(w.stage, "app-link")); await refused(w, "unexpected_entry"); await unlink(join(w.stage, "app-link"));
  await writeFile(join(w.stage, "app", "extra"), "x", { mode: 0o600 }); await refused(w, "unexpected_entry"); await unlink(join(w.stage, "app", "extra"));
  await mkdir(join(w.stage, "backend", "other"), { mode: 0o700 }); await refused(w, "unexpected_entry"); await rm(join(w.stage, "backend", "other"), { recursive: true });
  await mkdir(join(w.stage, "unknown"), { mode: 0o700 }); await refused(w, "unexpected_entry"); await rm(join(w.stage, "unknown"), { recursive: true });
  assert.equal(await readFile(join(outside, "precious"), "utf8"), "keep");
  const real = join(w.directory, "real-stage"); await rename(w.stage, real); await symlink(real, w.stage);
  assert.equal((await cleanupUpdateStage(w.root, w.pending)).removed, false);
  assert.equal(await exists(join(real, "app-update.json")), true, "the link's target is never followed");
}));

test("group or world writable descendants and read-only directories are refused instead of changed", () => withStage(async w => {
  await chmod(w.file, 0o666); await refused(w, "unexpected_entry"); await chmod(w.file, 0o644);
  await chmod(w.deep, 0o777); await refused(w, "unexpected_entry");
  await chmod(w.deep, 0o500); await refused(w, "unexpected_entry");
  assert.equal((await lstat(w.deep)).mode & 0o777, 0o500, "no permission was changed");
  await chmod(w.deep, 0o700);
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending), { removed: true });
}));

test("a manifest or archive that disagrees with the recorded update is refused", () => withStage(async w => {
  for (const change of [{ version: "0.2.1" }, { source: "d".repeat(40) }, { backendSha256: "e".repeat(64) }, { branch: "beta" }, { schemaVersion: 2 }, { backendAsset: "other.tar.gz" }, { appAsset: "other.zip" }]) {
    await w.writeManifest(change); await refused(w, "manifest_mismatch");
  }
  await w.writeManifest({});
  await writeFile(w.pending.backendArchive, "backend-bytez", { mode: 0o600 });
  await refused(w, "manifest_mismatch");
  await writeFile(w.pending.backendArchive, "backend-bytes", { mode: 0o600 });
  await writeFile(join(w.stage, "app-update.json"), "{broken", { mode: 0o600 }); assert.equal((await cleanupUpdateStage(w.root, w.pending)).removed, false);
  await w.writeManifest({}); await chmod(join(w.stage, "app-update.json"), 0o644);
  assert.equal((await cleanupUpdateStage(w.root, w.pending)).removed, false, "a manifest others can read is not trusted");
  await unlink(join(w.stage, "app-update.json")); await refused(w, "unexpected_entry");
}));

test("a failing or lying deletion reports a fixed reason and never throws", () => withStage(async w => {
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending, { remove: async () => { throw new Error("secret-token-xyz"); } }), { removed: false, reason: "remove_failed" });
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending, { remove: async () => undefined }), { removed: false, reason: "remove_failed" });
  assert.equal(await exists(w.stage), true);
}));

const afterPlan: Array<[string, (w: World) => Promise<void>]> = [
  ["an unexpected file added at the top", async w => { await writeFile(join(w.stage, "extra.txt"), "x", { mode: 0o600 }); }],
  ["a file added deep inside", async w => { await writeFile(join(w.deep, "new.js"), "x", { mode: 0o644 }); }],
  ["a file edited to the same size", async w => { await writeFile(w.file, "y"); const later = new Date(Date.now() + 5000); await utimes(w.file, later, later); }],
  ["a file deleted", async w => { await unlink(w.file); }],
  ["the archive replaced", async w => { await unlink(w.pending.backendArchive); await writeFile(w.pending.backendArchive, "backend-bytes", { mode: 0o600 }); }],
];
for (const [what, mutate] of afterPlan) {
  test(`removal after planning refuses ${what}`, () => withStage(async w => {
    const plan = await planUpdateStageCleanup(w.root, w.pending); assert.ok(plan.ok); if (!plan.ok) return;
    await mutate(w);
    let called = 0;
    assert.deepEqual(await removePlannedStage(plan.plan, async () => { called++; }), { removed: false, reason: "changed" });
    assert.equal(called, 0);
    assert.equal(await exists(w.stage), true);
  }));
}

test("a nested directory swapped for a link after planning is never followed and the victim is unchanged", () => withStage(async w => {
  const plan = await planUpdateStageCleanup(w.root, w.pending); assert.ok(plan.ok); if (!plan.ok) return;
  const victim = join(w.directory, "victim"); await mkdir(victim, { mode: 0o700 }); await writeFile(join(victim, "precious"), "keep", { mode: 0o600 });
  const before = await lstat(join(victim, "precious"));
  await rename(join(w.backendRoot, "pkg"), join(w.directory, "moved-pkg")); await symlink(victim, join(w.backendRoot, "pkg"));
  let called = 0;
  assert.deepEqual(await removePlannedStage(plan.plan, async () => { called++; }), { removed: false, reason: "changed" });
  assert.deepEqual(await cleanupUpdateStage(w.root, w.pending, { remove: async () => { called++; } }), { removed: false, reason: "unexpected_entry" });
  assert.equal(called, 0);
  assert.equal(await readFile(join(victim, "precious"), "utf8"), "keep");
  assert.equal((await lstat(join(victim, "precious"))).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readdir(victim), ["precious"]);
}));

test("the stage itself swapped for a link after planning is refused and its target is left alone", () => withStage(async w => {
  const plan = await planUpdateStageCleanup(w.root, w.pending); assert.ok(plan.ok); if (!plan.ok) return;
  const moved = join(w.directory, "moved-stage"); await rename(w.stage, moved); await symlink(moved, w.stage);
  assert.equal(await confirmPlannedStage(plan.plan), false);
  assert.deepEqual(await removePlannedStage(plan.plan), { removed: false, reason: "changed" });
  assert.equal(await exists(join(moved, "app-update.json")), true);
}));

/** The real hook: a committed update driven through `installPending`, with the transaction layer and tar doing real work. */
async function updateWorld() {
  const version = "0.2.0", team = "ABCDE12345";
  const directory = await mkdtemp(join(tmpdir(), "gateway-app-cleanup-"));
  const prefix = join(directory, "prefix"), root = join(prefix, "share", "subscription-gateway"), bin = join(prefix, "bin");
  const app = join(directory, "Harness Gateway.app"), retained = join(directory, ".Harness-Gateway-Update-keep.app");
  await mkdir(join(root, "releases", "0.1.0"), { recursive: true, mode: 0o700 }); await mkdir(bin, { recursive: true }); await chmod(root, 0o700);
  await writeFile(join(root, "releases", "0.1.0", ".gateway-release"), "0.1.0\n"); await symlink("releases/0.1.0", join(root, "current"));
  await writeFile(join(root, "releases", "0.1.0", "marker"), "release");
  for (const name of ["gateway", "harness-gateway", "subscription-gateway"]) await writeFile(join(bin, name), `#!/bin/sh\n# Managed by subscription-gateway installer\nold ${name}\n`, { mode: 0o700 });
  for (const [path, value] of [[app, "old"], [retained, "new"]] as const) {
    await mkdir(join(path, "Contents", "MacOS"), { recursive: true }); await mkdir(join(path, "Contents", "Resources"), { recursive: true });
    await writeFile(join(path, "Contents", "Info.plist"), value);
    await writeFile(join(path, "Contents", "MacOS", "GatewayUpdateInstaller"), "fixture", { mode: 0o700 });
  }
  const archiveName = `harness-gateway-${version}-macos-arm64.tar.gz`, zipName = `Harness-Gateway-${version}-macos-arm64.zip`;
  const input = join(directory, "input"), backendRoot = join(input, `harness-gateway-${version}-macos-arm64`);
  await mkdir(join(backendRoot, "package"), { recursive: true });
  await writeFile(join(backendRoot, "install"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(backendRoot, "package", "release.json"), JSON.stringify({ version, source }));
  const sums = await Promise.all(["install", "package/release.json"].map(async path => `${sha(await readFile(join(backendRoot, path)))}  ${path}`));
  await writeFile(join(backendRoot, "checksums.txt"), sums.join("\n") + "\n");
  const stage = join(root, `app-update-${randomUUID()}`); await mkdir(stage, { mode: 0o700 });
  await exec("/usr/bin/tar", ["-czf", join(stage, archiveName), "-C", input, `harness-gateway-${version}-macos-arm64`]);
  await chmod(join(stage, archiveName), 0o600);
  // The stage as the updater leaves it: the backend extracted, and `app` empty because the bundle was moved out of it.
  await mkdir(join(stage, "backend"), { mode: 0o700 }); await mkdir(join(stage, "app"), { mode: 0o700 });
  await exec("/usr/bin/tar", ["-xzf", join(stage, archiveName), "-C", join(stage, "backend"), "--no-same-owner"]);
  const backendSha256 = sha(await readFile(join(stage, archiveName)));
  await writeFile(join(stage, "app-update.json"), JSON.stringify({ schemaVersion: 1, version, source, branch: "production", appAsset: zipName, appSha256: "c".repeat(64), backendAsset: archiveName, backendSha256 }), { mode: 0o600 });
  await writeFile(join(retained, "Contents", "Resources", "app-build.json"), JSON.stringify({ appVersion: version, backendVersion: version, source, sourceBranch: "production", sourceModified: false, production: true, backendSha256 }));
  await writeFile(join(retained, "Contents", "Resources", "update-policy.json"), JSON.stringify({ schemaVersion: 1, version, source, branch: "production", backendAsset: archiveName, backendSha256 }));

  const receipt = async (key: string, path: string) => {
    const journal = JSON.parse(await readFile(join(root, "app-update-transaction.json"), "utf8"));
    const info = await lstat(path); const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path);
    journal.installer ??= { outputs: {} }; journal.installer.outputs[key] = { dev: info.dev, ino: info.ino, mode: info.mode & 0o777, size: info.size, digest: sha(bytes) };
    await writeFile(join(root, "app-update-transaction.json"), JSON.stringify(journal), { mode: 0o600 });
  };
  const install = async () => {
    await mkdir(join(root, "releases", version), { recursive: true }); await writeFile(join(root, "releases", version, ".gateway-release"), `${version}\n`);
    const current = join(root, "current"); await unlink(current); await symlink(`releases/${version}`, current); await receipt("current", current);
    for (const name of ["gateway", "harness-gateway"]) {
      await writeFile(join(bin, name), `# Managed by subscription-gateway installer\nnew ${name}\n`, { mode: 0o700 }); await receipt(name, join(bin, name));
    }
  };
  const swap: TransactionCommand = async () => {
    const temporary = join(directory, ".old.app"); await rename(app, temporary); await rename(retained, app); await rename(temporary, retained);
  };
  const command: Command = async (program, args) => {
    if (program === "/bin/sh") await install();
    else if (program === join(retained, "Contents", "MacOS", "GatewayUpdateInstaller")) await swap(program, args);
    else await exec(program, args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const pending = { version, source, backendSha256, appStage: retained, backendArchive: join(stage, archiveName), requestedAt: new Date().toISOString() };
  const statePath = join(root, "app-update.json");
  const ctx = () => ({ snapshot: {}, installation: { prefix, root, commandPath: join(bin, "harness-gateway") }, app, version: "0.1.0", installedVersion: "0.1.0",
    production: true, team, statePath, state: { schemaVersion: 1 as const, automatic: true, pending: { ...pending } } }) as unknown as Parameters<typeof installPending>[0];
  const deps = (extra: Parameters<typeof installPending>[1] = {}) => ({ appRunning: async () => false, verifyApp: async () => team, command, ...extra });
  const survivors = async () => ({ retained: await readFile(join(retained, "Contents", "Info.plist"), "utf8"), releases: await exists(join(root, "releases", "0.1.0", "marker")),
    current: await exists(join(root, "current")) });
  return { directory, prefix, root, bin, app, retained, stage, pending, statePath, ctx, deps, install, swap, survivors, tx: () => beginInstallationTransaction({ installation: { root, prefix }, app, version, team }),
    stateText: () => readFile(statePath, "utf8").catch(() => ""), done: () => rm(directory, { recursive: true, force: true }) };
}
async function withUpdate(run: (w: Awaited<ReturnType<typeof updateWorld>>) => Promise<void>): Promise<void> {
  const w = await updateWorld(); try { await run(w); } finally { await w.done(); }
}
const darwin = { skip: process.platform !== "darwin" };

test("a normal successful install removes its download stage and keeps the retained bundle and releases", darwin, () => withUpdate(async w => {
  assert.equal(await exists(join(w.stage, "backend")), true);
  const result = await installPending(w.ctx(), w.deps());
  assert.ok(result.ok, JSON.stringify(result)); if (result.ok) assert.equal(result.result.phase, "installed");
  assert.equal(await exists(w.stage), false, "the stage is gone");
  assert.equal(await exists(join(w.root, "app-update-transaction.json")), false, "the journal was finalized");
  assert.equal(JSON.parse(await w.stateText()).pending, undefined);
  assert.equal(await readFile(join(w.app, "Contents", "Info.plist"), "utf8"), "new");
  assert.deepEqual(await w.survivors(), { retained: "old", releases: true, current: true });
  assert.equal(await readlink(join(w.root, "current")), "releases/0.2.0");
  assert.deepEqual((await readdir(w.root)).filter(name => /^app-update-[0-9a-f]{8}-/.test(name)), []);
}));

test("a committed update recovered after a crash also removes its stage", darwin, () => withUpdate(async w => {
  const tx = await w.tx();
  await runCanonicalInstall(tx, { installer: async () => w.install(), command: noop });
  await swapAndCommitInstallationTransaction(tx, { helper: join(w.retained, "Contents", "MacOS", "GatewayUpdateInstaller"), stage: w.retained, command: w.swap, verifyTarget: async () => {} });
  assert.equal(await exists(w.stage), true);
  const result = await installPending(w.ctx(), w.deps({ command: async () => { throw new Error("no command may run"); } }));
  assert.ok(result.ok, JSON.stringify(result)); if (result.ok) assert.equal(result.result.phase, "installed");
  assert.equal(await exists(w.stage), false);
  assert.equal(await exists(join(w.root, "app-update-transaction.json")), false);
  assert.deepEqual(await w.survivors(), { retained: "old", releases: true, current: true });
}));

test("a cleanup that fails or is refused never turns a completed install into a failure", darwin, () => withUpdate(async w => {
  const result = await installPending(w.ctx(), w.deps({ removeStage: async () => { throw new Error("secret-token-xyz"); } }));
  assert.ok(result.ok, JSON.stringify(result)); if (result.ok) assert.equal(result.result.phase, "installed");
  assert.equal(await exists(w.stage), true, "left for a later sweep");
  assert.equal(JSON.parse(await w.stateText()).pending, undefined, "the install is recorded as done");
  assert.equal(await readFile(join(w.app, "Contents", "Info.plist"), "utf8"), "new");
}));

test("a failed install leaves its stage, archive and pending state alone", darwin, () => withUpdate(async w => {
  await writeFile(w.pending.backendArchive, "tampered", { mode: 0o600 });
  await assert.rejects(installPending(w.ctx(), w.deps()), /pending/);
  assert.equal(await exists(w.stage), true);
  assert.equal(await exists(w.pending.backendArchive), true);
  assert.equal(await exists(w.statePath), false, "no state was written");
  assert.deepEqual(await w.survivors(), { retained: "new", releases: true, current: true });
  assert.equal(await readFile(join(w.app, "Contents", "Info.plist"), "utf8"), "old");
}));
