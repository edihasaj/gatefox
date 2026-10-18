import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { handleAppUpdate, processPendingAppUpdate } from "../app-updates.js";
import type { AppUpdateDependencies } from "../app-updates.js";
import type { ConfigSnapshot } from "../app-management/storage.js";
import { updateLockName, type Command, type Release } from "../app-updates/types.js";
import { withPrivateFileLock } from "../private-file-lock.js";

const source = "a".repeat(40);
const digest = "b".repeat(64);
const exec = promisify(execFile);
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

class Fixture {
  root = ""; install = ""; app = ""; config = ""; state = "";
  async create(): Promise<this> {
    this.root = await mkdtemp(join(tmpdir(), "gateway-app-updates-"));
    this.install = join(this.root, "install"); this.app = join(this.root, "Applications", "Harness Gateway.app");
    this.config = join(this.root, "gateway.json"); this.state = join(this.root, "state");
    await mkdir(join(this.app, "Contents", "Resources"), { recursive: true, mode: 0o700 });
    await writeFile(join(this.app, "Contents", "Info.plist"), "current", { mode: 0o600 });
    await mkdir(this.install, { recursive: true, mode: 0o700 }); await mkdir(this.state, { recursive: true, mode: 0o700 });
    await writeFile(join(this.app, "Contents", "Resources", "app-build.json"), JSON.stringify({
      appVersion: "1.2.3", backendVersion: "1.2.3", source, sourceBranch: "production",
      sourceModified: false, production: true, backendSha256: digest,
    }), { mode: 0o600 });
    return this;
  }
  dependencies(releases: Release[] = []): AppUpdateDependencies {
    const snapshot = { raw: {}, revision: "fixture", config: { stateDirectory: this.state } } as ConfigSnapshot;
    return {
      readSnapshot: async () => snapshot,
      installation: async () => ({ prefix: this.root, root: this.install, commandPath: join(this.root, "bin", "harness-gateway") }),
      appPath: async () => this.app,
      verifyApp: async () => "T8J48M4QVY",
      serviceBinding: async () => true,
      servicePlan: async () => ({ version: 1, config: this.config, components: [{ id: "inference", kind: "inference", command: "/usr/bin/true", args: [], log: join(this.root, "service.log") }] }),
      releases: async () => releases,
    };
  }
  async remove(): Promise<void> { await rm(this.root, { recursive: true, force: true }); }
}
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await new Fixture().create();
  try { await run(fixture); } finally { await fixture.remove(); }
}
function release(tag: string): Release {
  return { tag_name: tag, assets: [{ id: 1, name: "app-update.json", size: 8 }] };
}

test("the app update protocol rejects an oversized or malformed request before touching state", async () => withFixture(async fixture => {
  assert.deepEqual(await handleAppUpdate({ operation: "status", configPath: "relative.json" }, fixture.dependencies()),
    { ok: false, error: { code: "invalid_request", message: "The update request is invalid." } });
}));

test("a private-release authentication failure is explicit and does not expose child diagnostics", async () => withFixture(async fixture => {
  const deps = fixture.dependencies();
  deps.releases = async () => { throw Object.assign(new Error("sensitive stderr"), { code: "auth_required" }); };
  assert.deepEqual(await handleAppUpdate({ operation: "check", configPath: fixture.config }, deps),
    { ok: false, error: { code: "auth_required", message: "Sign in to GitHub once to receive private updates." } });
}));

test("stable releases sort numerically and never offer a downgrade", async () => withFixture(async fixture => {
  const result = await handleAppUpdate({ operation: "check", configPath: fixture.config }, fixture.dependencies([
    release("app-v1.10.0"), release("app-v1.9.9"), release("app-v1.2.2"), { ...release("app-v9.9.9"), prerelease: true },
  ]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.result.latestVersion, "1.10.0");
    assert.equal(result.result.available, true);
  }
  const old = await handleAppUpdate({ operation: "check", configPath: fixture.config }, fixture.dependencies([release("app-v1.2.2")]));
  assert.ok(old.ok, JSON.stringify(old));
  if (old.ok) assert.equal(old.result.available, false);
}));

test("automatic updates remain off until the signed production app explicitly enables them", async () => withFixture(async fixture => {
  const enabled = await handleAppUpdate({ operation: "preferences", configPath: fixture.config, automatic: true }, fixture.dependencies());
  assert.equal(enabled.ok, true);
  if (enabled.ok) assert.equal(enabled.result.automatic, true);
  const status = await handleAppUpdate({ operation: "status", configPath: fixture.config }, fixture.dependencies());
  assert.ok(status.ok, JSON.stringify(status));
  if (status.ok) assert.equal(status.result.automatic, true);
}));

test("a configuration with no matching managed service binding cannot update an app", async () => withFixture(async fixture => {
  const deps = fixture.dependencies(); deps.servicePlan = async () => undefined;
  assert.deepEqual(await handleAppUpdate({ operation: "status", configPath: fixture.config }, deps),
    { ok: false, error: { code: "unsafe_installation", message: "Updates are unavailable for this installation." } });
}));

test("an open GUI leaves a pending update waiting without a signature scan", async () => withFixture(async fixture => {
  await writeFile(join(fixture.install, "app-update.json"), JSON.stringify({ schemaVersion: 1, automatic: true, pending: {
    version: "1.2.4", source, backendSha256: digest, appStage: join(fixture.root, ".Harness-Gateway-Update.app"),
    backendArchive: join(fixture.install, "app-update.tar.gz"), requestedAt: new Date().toISOString(),
  } }), { mode: 0o600 });
  const deps = fixture.dependencies(); let verifications = 0;
  deps.verifyApp = async () => { verifications++; return "T8J48M4QVY"; };
  deps.appRunning = async () => true;
  assert.equal(await processPendingAppUpdate(fixture.config, deps), true);
  assert.equal(verifications, 0);
}));

test("a waiting check refreshes state after the update lock and preserves an earlier preference", async () => withFixture(async fixture => {
  const deps = fixture.dependencies(); let seen = 0; let bothSeen!: () => void;
  const both = new Promise<void>(resolve => { bothSeen = resolve; });
  const snapshot = { raw: {}, revision: "fixture", config: { stateDirectory: fixture.state } } as ConfigSnapshot;
  deps.readSnapshot = async () => { if (++seen === 2) bothSeen(); return snapshot; };
  deps.releases = async () => [];
  let unlock!: () => void; let lockReady!: () => void;
  const ready = new Promise<void>(resolve => { lockReady = resolve; });
  const held = withPrivateFileLock(join(fixture.install, updateLockName), async () => {
    lockReady(); await new Promise<void>(resolve => { unlock = resolve; });
  });
  await ready;
  const preference = handleAppUpdate({ operation: "preferences", configPath: fixture.config, automatic: false }, deps);
  const check = handleAppUpdate({ operation: "check", configPath: fixture.config }, deps);
  await both; unlock(); await held;
  assert.equal((await preference).ok, true); assert.equal((await check).ok, true);
  assert.equal((JSON.parse(await readFile(join(fixture.install, "app-update.json"), "utf8")) as { automatic: boolean }).automatic, false);
}));

test("a real ZIP and canonical TAR stage a signed-policy update, then tampering stops activation before execution", { skip: process.platform !== "darwin" }, async () => withFixture(async fixture => {
  const current = join(fixture.install, "releases", "1.2.3");
  await mkdir(join(current, "package"), { recursive: true, mode: 0o700 });
  await writeFile(join(current, ".gateway-release"), "1.2.3\n", { mode: 0o600 });
  await writeFile(join(current, "package", "release.json"), JSON.stringify({ version: "1.2.3", source }), { mode: 0o600 });
  await symlink("releases/1.2.3", join(fixture.install, "current"));

  const version = "1.2.4", stage = join(fixture.root, "release-input"), app = join(stage, "Harness Gateway.app");
  const appAsset = `Harness-Gateway-${version}-macos-arm64.zip`, backendAsset = `harness-gateway-${version}-macos-arm64.tar.gz`;
  const backendRoot = join(stage, `harness-gateway-${version}-macos-arm64`);
  await mkdir(join(app, "Contents", "Resources"), { recursive: true, mode: 0o700 });
  await writeFile(join(app, "Contents", "Info.plist"), "candidate");
  await mkdir(join(app, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await writeFile(join(app, "Contents", "MacOS", "GatewayUpdateInstaller"), "fixture", { mode: 0o700 });
  const policy = { schemaVersion: 1, version, source, branch: "production", backendAsset, backendSha256: "" };
  await mkdir(join(backendRoot, "package"), { recursive: true, mode: 0o700 });
  await writeFile(join(backendRoot, "install"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(backendRoot, "package", "release.json"), JSON.stringify({ version, source }));
  const checked = ["install", "package/release.json"];
  const sums = await Promise.all(checked.map(async path => `${sha256(await readFile(join(backendRoot, path)))}  ${path}`));
  await writeFile(join(backendRoot, "checksums.txt"), sums.join("\n") + "\n");
  await exec("/usr/bin/tar", ["-czf", join(stage, backendAsset), "-C", stage, `harness-gateway-${version}-macos-arm64`]);
  policy.backendSha256 = sha256(await readFile(join(stage, backendAsset)));
  await writeFile(join(app, "Contents", "Resources", "app-build.json"), JSON.stringify({
    appVersion: version, backendVersion: version, source, sourceBranch: "production",
    sourceModified: false, production: true, backendSha256: policy.backendSha256,
  }));
  await writeFile(join(app, "Contents", "Resources", "update-policy.json"), JSON.stringify(policy));
  await exec("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, join(stage, appAsset)]);
  const manifest = { schemaVersion: 1, version, source, branch: "production", appAsset,
    appSha256: sha256(await readFile(join(stage, appAsset))), backendAsset, backendSha256: policy.backendSha256 };
  await writeFile(join(stage, "app-update.json"), JSON.stringify(manifest));

  const files = new Map([[1, join(stage, "app-update.json")], [2, join(stage, appAsset)], [3, join(stage, backendAsset)]]);
  let running = true; const calls: string[] = [];
  const command: Command = async (program, args) => {
    calls.push(program);
    await exec(program, args);
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps = fixture.dependencies([{ tag_name: `app-v${version}`, assets: [
    { id: 1, name: "app-update.json", size: (await stat(files.get(1)!)).size },
    { id: 2, name: appAsset, size: (await stat(files.get(2)!)).size },
    { id: 3, name: backendAsset, size: (await stat(files.get(3)!)).size },
  ] }]);
  deps.command = command; deps.appRunning = async () => running;
  deps.download = async (asset, destination) => { await copyFile(files.get(asset.id)!, destination); await chmod(destination, 0o600); };
  const staged = await handleAppUpdate({ operation: "install", configPath: fixture.config }, deps);
  assert.ok(staged.ok, JSON.stringify(staged));
  if (!staged.ok) return;
  assert.equal(staged.result.phase, "waiting_for_app_exit");
  const saved = JSON.parse(await readFile(join(fixture.install, "app-update.json"), "utf8")) as { pending: { appStage: string; backendArchive: string } };
  assert.match(saved.pending.appStage, /\/\.Harness-Gateway-Update-[0-9a-f-]+\.app$/);
  assert.equal(await sha256(await readFile(saved.pending.backendArchive)), policy.backendSha256);

  await writeFile(join(saved.pending.appStage, "Contents", "Resources", "app-build.json"), "{}");
  running = false; calls.length = 0;
  assert.equal(await processPendingAppUpdate(fixture.config, deps), false);
  assert.equal(calls.includes("/bin/sh"), false, "tampered stage never reaches the canonical installer");
}));
