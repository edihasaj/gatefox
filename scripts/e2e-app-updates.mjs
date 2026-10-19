#!/usr/bin/env node
// Offline evidence for the signed app updater. It operates only in --root.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";

const usage = `Usage: node scripts/e2e-app-updates.mjs --app-archive ABS --backend-archive ABS --legacy-app ABS --installed-release ABS --root ABS [--keep]`;
const { values } = parseArgs({
  options: {
    "app-archive": { type: "string" }, "backend-archive": { type: "string" },
    "legacy-app": { type: "string" }, "installed-release": { type: "string" },
    root: { type: "string" }, keep: { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
  }, strict: true,
});
if (values.help) { process.stdout.write(`${usage}\n`); process.exit(0); }

const required = ["app-archive", "backend-archive", "legacy-app", "installed-release", "root"];
for (const name of required) {
  if (!values[name] || !isAbsolute(values[name])) throw new Error(usage);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repo, "dist");
const requested = Object.fromEntries(required.map(name => [name, resolve(values[name])]));
let root = requested.root;
let input;
let passed = false;
const priorHome = process.env.HOME;
const progress = { phase: "prepare" };

try {
  progress.phase = "validate_inputs";
  input = await canonicalInputs(requested);
  root = await evidenceRoot(requested.root, input);
  progress.phase = "create_root";
  await assertFreshPrivateRoot(root);
  const api = await import(pathToFileURL(join(dist, "app-updates.js")).href);
  const runtime = await import(pathToFileURL(join(dist, "app-runtime.js")).href);
  const archive = await import(pathToFileURL(join(dist, "app-updates/archive.js")).href);
  const github = await import(pathToFileURL(join(dist, "app-updates/github.js")).href);
  assert.equal(typeof api.handleAppUpdate, "function");
  assert.equal(typeof api.processPendingAppUpdate, "function");
  assert.equal(typeof runtime.renderInstalledLauncher, "function");

  progress.phase = "inspect_candidate";
  const candidate = await inspectCandidate(input, root, archive, github.runCommand);
  progress.phase = "copy_fixture";
  const main = await makeFixture({ root, input, candidate, runtime, archive, command: github.runCommand, progress });
  progress.phase = "version_order";
  assert.ok(compareVersion(candidate.version, main.baseline.appVersion) > 0, "candidate app version is not newer");
  assert.ok(compareVersion(candidate.version, main.baseline.installedVersion) >= 0, "candidate would downgrade CLI");
  process.env.HOME = main.home;
  const first = await exercise(main, api, candidate, progress);

  const tamperRoot = join(root, "tamper");
  progress.phase = "copy_tamper_fixture";
  const tamper = await makeFixture({ root: tamperRoot, input, candidate, runtime, archive, command: github.runCommand, progress });
  process.env.HOME = tamper.home;
  const tampered = await exerciseTamper(tamper, api, candidate, progress);
  process.env.HOME = main.home;

  passed = true;
  process.stdout.write(`${JSON.stringify({
    status: "passed", version: candidate.version, source: candidate.source,
    previousAppVersion: main.baseline.appVersion, previousBackendVersion: main.baseline.backendVersion,
    installedReleaseVersion: main.baseline.installedVersion, installedReleaseSource: main.baseline.installedSource,
    stagedWhileRunning: first.stagedWhileRunning, installed: first.installed,
    retainedLegacyApp: first.retainedLegacyApp, sameVersionRejected: first.sameVersionRejected,
    tamperRejected: tampered.tamperRejected, evidence: values.keep ? "kept" : "cleaned",
  })}\n`);
} catch {
  process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ status: "failed", phase: progress.phase, evidence: "retained", check: "app_update_fixture_failed" })}\n`);
} finally {
  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;
  if (passed && !values.keep) await rm(root, { recursive: true, force: true });
}

async function assertFreshPrivateRoot(path) {
  await lstat(path).then(() => { throw new Error("root exists"); }, error => {
    if (error?.code !== "ENOENT") throw error;
  });
  await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700);
}
async function canonicalInputs(paths) {
  const [appArchive, backendArchive, legacyApp, installedRelease] = await Promise.all([
    canonicalExisting(paths["app-archive"], "file"), canonicalExisting(paths["backend-archive"], "file"),
    canonicalExisting(paths["legacy-app"], "directory"), canonicalExisting(paths["installed-release"], "directory"),
  ]);
  if (!legacyApp.endsWith(".app")) throw new Error("invalid input");
  return { "app-archive": appArchive, "backend-archive": backendArchive, "legacy-app": legacyApp, "installed-release": installedRelease };
}
async function canonicalExisting(path, kind) {
  const target = await realpath(path), info = await lstat(target);
  if (info.isSymbolicLink() || kind === "file" && !info.isFile() || kind === "directory" && !info.isDirectory()) throw new Error("invalid input");
  return target;
}
function inside(parent, path) {
  return path === parent || path.startsWith(`${parent}/`);
}
async function evidenceRoot(requestedRoot, inputs) {
  if (requestedRoot === "/" || requestedRoot === "/tmp") throw new Error("invalid root");
  const parent = await unsymlinkedParent(requestedRoot);
  const candidate = join(parent, requestedRoot.slice(dirname(requestedRoot).length + 1));
  const home = priorHome && isAbsolute(priorHome) ? await realpath(priorHome) : "";
  if (!home || !inside(home, candidate) || candidate === home) throw new Error("unsafe root");
  for (const path of Object.values(inputs)) if (inside(candidate, path) || inside(path, candidate)) throw new Error("unsafe root");
  const owner = process.getuid?.();
  const relative = candidate.slice(home.length + 1).split("/");
  let current = home;
  for (const part of relative.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner || info.mode & 0o022) throw new Error("unsafe root");
  }
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== owner || parentInfo.mode & 0o022) throw new Error("unsafe root");
  return candidate;
}
async function unsymlinkedParent(path) {
  const target = dirname(path), parts = target.split("/").filter(Boolean);
  let current = "/";
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe root");
  }
  return realpath(target);
}

async function inspectCandidate(paths, evidence, archive, runCommand) {
  await regular(paths["app-archive"]); await regular(paths["backend-archive"]);
  const inspect = join(evidence, "inspect");
  await mkdir(inspect, { mode: 0o700 });
  const app = await archive.extractArchive("zip", paths["app-archive"], join(inspect, "app"), "Harness Gateway.app", runCommand);
  const receipt = await json(join(app, "Contents", "Resources", "app-build.json"));
  const policy = await json(join(app, "Contents", "Resources", "update-policy.json"));
  assert.equal(receipt.production, true); assert.equal(receipt.sourceBranch, "production");
  assert.equal(receipt.sourceModified, false); assert.equal(typeof receipt.appVersion, "string");
  assert.match(receipt.appVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(receipt.backendVersion, receipt.appVersion);
  assert.match(receipt.source, /^[a-f0-9]{40}$/);
  const version = receipt.appVersion, source = receipt.source;
  const backendAsset = `harness-gateway-${version}-macos-arm64.tar.gz`;
  const backendSha256 = await digest(paths["backend-archive"]);
  assert.deepEqual(policy, { schemaVersion: 1, version, source, branch: "production", backendAsset, backendSha256 });
  assert.equal(receipt.backendSha256, backendSha256);
  const backend = await archive.extractArchive("tar", paths["backend-archive"], join(inspect, "backend"),
    `harness-gateway-${version}-macos-arm64`, runCommand);
  await archive.verifyChecksummedTree(backend);
  const release = await json(join(backend, "package", "release.json"));
  assert.equal(release.version, version); assert.equal(release.source, source);
  return { version, source, backendAsset, backendSha256 };
}

async function makeFixture({ root: fixtureRoot, input: paths, candidate, runtime, archive, command: runCommand, progress }) {
  if (fixtureRoot !== root) await assertFreshPrivateRoot(fixtureRoot);
  const home = join(fixtureRoot, "home");
  const prefix = join(home, ".local"), install = join(prefix, "share", "subscription-gateway");
  const bin = join(prefix, "bin"), applications = join(home, "Applications");
  const app = join(applications, "Harness Gateway.app"), state = join(home, "state");
  const config = join(home, "gateway.json"), plan = join(home, "service-plan.json");
  const plist = join(home, "Library", "LaunchAgents", "com.edihasaj.subscription-gateway.fixture.plist");
  for (const path of [home, bin, install, applications, state, dirname(plist)]) {
    await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700);
  }
  progress.phase = "copy_signed_legacy_app";
  const copied = await runCommand("/usr/bin/ditto", [paths["legacy-app"], app], { timeoutMs: 120_000 });
  assert.equal(copied.code, 0);
  progress.phase = "read_legacy_receipt";
  const legacy = await json(join(app, "Contents", "Resources", "app-build.json"));
  assert.match(legacy.appVersion, /^\d+\.\d+\.\d+$/);
  assert.match(legacy.backendVersion, /^\d+\.\d+\.\d+$/);
  assert.match(legacy.source, /^[a-f0-9]{40}$/);
  const legacyRoot = join(app, "Contents", "Resources", "backend");
  const legacyBackend = await json(join(legacyRoot, "package", "release.json"));
  assert.equal(legacyBackend.version, legacy.backendVersion);
  await archive.verifyChecksummedTree(legacyRoot);

  progress.phase = "copy_installed_release";
  const installedInput = await releaseInput(paths["installed-release"], archive);
  const installedVersion = installedInput.version;
  const installed = join(install, "releases", installedVersion);
  await copyRelease(installedInput.path, installed, installedVersion, installedInput.source, archive);
  await symlink(`releases/${installedVersion}`, join(install, "current"));
  await writeFile(join(install, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 });
  const command = join(bin, "harness-gateway");
  for (const name of ["gateway", "harness-gateway", "subscription-gateway"]) {
    const launcher = join(bin, name);
    await writeFile(launcher, runtime.renderInstalledLauncher(install, command), { mode: 0o700 });
    await chmod(launcher, 0o700);
  }
  await symlink(join(app, "Contents", "Resources", "backend", "runtime"), join(install, "app-runtime"));

  progress.phase = "fixture_configuration";
  const configValue = { stateDirectory: state, providers: [] };
  await writeFile(config, `${JSON.stringify(configValue)}\n`, { mode: 0o600 });
  await writeFile(plan, `${JSON.stringify({ version: 1, config, components: [] })}\n`, { mode: 0o600 });
  await writeFile(plist, `<plist><string>${config}</string><string>${command}</string></plist>\n`, { mode: 0o600 });
  const sentinels = [config, join(home, ".codex-sentinel")];
  await writeFile(sentinels[1], "fixture sentinel\n", { mode: 0o600 });
  const assets = join(fixtureRoot, "release-assets"); await mkdir(assets, { mode: 0o700 });
  const appAsset = `Harness-Gateway-${candidate.version}-macos-arm64.zip`;
  const backendAsset = candidate.backendAsset;
  await copyFile(paths["app-archive"], join(assets, appAsset)); await chmod(join(assets, appAsset), 0o600);
  await copyFile(paths["backend-archive"], join(assets, backendAsset)); await chmod(join(assets, backendAsset), 0o600);
  const manifest = { schemaVersion: 1, version: candidate.version, source: candidate.source, branch: "production",
    appAsset, appSha256: await digest(join(assets, appAsset)), backendAsset, backendSha256: await digest(join(assets, backendAsset)) };
  assert.equal(manifest.backendSha256, candidate.backendSha256);
  await writeFile(join(assets, "app-update.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  const assetSizes = Object.fromEntries(await Promise.all(["app-update.json", appAsset, backendAsset].map(async name => [name, (await stat(join(assets, name))).size])));
  return { fixtureRoot, home, install, app, config, plan, plist, state, sentinels, assets, command, candidate, manifest,
    assetSizes, baseline: { appVersion: legacy.appVersion, backendVersion: legacy.backendVersion,
      installedVersion, installedSource: installedInput.source, source: legacy.source } };
}

async function copyRelease(source, destination, expectedVersion, expectedSource, archive) {
  const input = await lstat(source); assert.ok(input.isDirectory() && !input.isSymbolicLink());
  await cp(source, destination, { recursive: true, force: false, preserveTimestamps: true });
  const marker = join(destination, ".gateway-release");
  assert.equal((await readFile(marker, "utf8")).trim(), expectedVersion);
  await rm(marker);
  try { await archive.verifyChecksummedTree(destination); }
  finally { await writeFile(marker, `${expectedVersion}\n`, { flag: "wx", mode: 0o600 }); }
  const release = await json(join(destination, "package", "release.json"));
  assert.equal(release.version, expectedVersion); assert.equal(release.source, expectedSource);
}
async function releaseInput(source, archive) {
  const path = await realpath(source), input = await lstat(path); assert.ok(input.isDirectory() && !input.isSymbolicLink());
  const marker = (await readFile(join(path, ".gateway-release"), "utf8")).trim();
  const release = await json(join(path, "package", "release.json"));
  assert.match(marker, /^\d+\.\d+\.\d+$/); assert.equal(release.version, marker); assert.match(release.source, /^[a-f0-9]{40}$/);
  return { path, version: marker, source: release.source };
}

function dependencies(fixture, running) {
  const release = { tag_name: `app-v${fixture.candidate.version}`, assets: [
    asset(1, "app-update.json"), asset(2, fixture.manifest.appAsset), asset(3, fixture.manifest.backendAsset),
  ] };
  const file = id => join(fixture.assets, release.assets.find(value => value.id === id).name);
  return {
    readSnapshot: async path => {
      assert.equal(path, fixture.config);
      const value = await json(path); assert.deepEqual(value.providers, []);
      return { raw: value, revision: "fixture", config: { stateDirectory: value.stateDirectory } };
    },
    installation: async command => {
      assert.equal(command, fixture.command);
      return { prefix: join(fixture.home, ".local"), root: fixture.install, commandPath: fixture.command };
    },
    servicePlan: async state => {
      assert.equal(state, fixture.state);
      return json(fixture.plan);
    },
    serviceBinding: async (config, app, command) => {
      assert.equal(config, fixture.config); assert.equal(app, fixture.app); assert.equal(command, fixture.command);
      const plist = await readFile(fixture.plist, "utf8");
      return plist.includes(config) && plist.includes(command);
    },
    releases: async () => [release],
    download: async (item, destination) => {
      await copyFile(file(item.id), destination); await chmod(destination, 0o600);
    },
    appRunning: async () => running.value,
  };
  function asset(id, name) { return { id, name, size: fixture.assetSizes[name] }; }
}

async function exercise(fixture, api, candidate, progress) {
  const running = { value: true }, deps = dependencies(fixture, running);
  progress.phase = "status";
  const before = await stateProof(fixture);
  const status = await api.handleAppUpdate({ operation: "status", configPath: fixture.config }, deps);
  assert.ok(status.ok && status.result.currentVersion === fixture.baseline.appVersion);
  progress.phase = "check";
  const check = await api.handleAppUpdate({ operation: "check", configPath: fixture.config }, deps);
  assert.ok(check.ok && check.result.phase === "available" && check.result.latestVersion === candidate.version);
  progress.phase = "stage";
  const staged = await api.handleAppUpdate({ operation: "install", configPath: fixture.config }, deps);
  assert.ok(staged.ok && staged.result.phase === "waiting_for_app_exit");
  const pending = (await json(join(fixture.install, "app-update.json"))).pending;
  assert.ok(pending && pending.version === candidate.version);
  await assertProofUnchanged(fixture, before);
  assert.equal(await currentVersion(fixture.install), fixture.baseline.installedVersion);
  assert.equal((await json(join(fixture.app, "Contents", "Resources", "app-build.json"))).appVersion, fixture.baseline.appVersion);

  running.value = false;
  progress.phase = "apply";
  assert.equal(await api.processPendingAppUpdate(fixture.config, deps), true);
  assert.equal(await currentVersion(fixture.install), candidate.version);
  const receipt = await json(join(fixture.app, "Contents", "Resources", "app-build.json"));
  const policy = await json(join(fixture.app, "Contents", "Resources", "update-policy.json"));
  assert.equal(receipt.appVersion, candidate.version); assert.equal(receipt.source, candidate.source);
  assert.equal(policy.backendSha256, candidate.backendSha256);
  assert.equal((await json(join(fixture.install, "current", "package", "release.json"))).source, candidate.source);
  const version = spawnSync(fixture.command, ["--version"], { encoding: "utf8", env: { ...process.env, HOME: fixture.home, PATH: "/usr/bin:/bin" } });
  assert.equal(version.status, 0); assert.match(version.stdout, new RegExp(candidate.version.replaceAll(".", "\\.")));
  await assertProofUnchanged(fixture, before);
  const retained = (await readdir(dirname(fixture.app))).filter(name => /^\.Harness-Gateway-Update-[a-f0-9-]+\.app$/.test(name));
  assert.equal(retained.length, 1);
  assert.equal((await json(join(dirname(fixture.app), retained[0], "Contents", "Resources", "app-build.json"))).appVersion, fixture.baseline.appVersion);
  progress.phase = "same_version";
  const repeated = await api.handleAppUpdate({ operation: "install", configPath: fixture.config }, deps);
  assert.ok(repeated.ok && repeated.result.available === false && repeated.result.phase === "checked");
  return { stagedWhileRunning: true, installed: true, retainedLegacyApp: true, sameVersionRejected: true };
}

async function exerciseTamper(fixture, api, candidate, progress) {
  const running = { value: true }, deps = dependencies(fixture, running);
  progress.phase = "tamper_stage";
  const staged = await api.handleAppUpdate({ operation: "install", configPath: fixture.config }, deps);
  assert.ok(staged.ok && staged.result.phase === "waiting_for_app_exit");
  const pending = (await json(join(fixture.install, "app-update.json"))).pending;
  const before = await stateProof(fixture);
  progress.phase = "tamper_reject";
  await writeFile(pending.backendArchive, "tampered\n", { mode: 0o600 });
  running.value = false;
  assert.equal(await api.processPendingAppUpdate(fixture.config, deps), false);
  assert.equal(await currentVersion(fixture.install), fixture.baseline.installedVersion);
  await assertProofUnchanged(fixture, before);
  progress.phase = "tamper_restore_apply";
  await copyFile(join(fixture.assets, fixture.manifest.backendAsset), pending.backendArchive); await chmod(pending.backendArchive, 0o600);
  assert.equal(await api.processPendingAppUpdate(fixture.config, deps), true);
  progress.phase = "tamper_same_version";
  const repeated = await api.handleAppUpdate({ operation: "check", configPath: fixture.config }, deps);
  assert.ok(repeated.ok && repeated.result.available === false && repeated.result.latestVersion === candidate.version);
  return { tamperRejected: true };
}

async function stateProof(fixture) {
  return { files: await Promise.all(fixture.sentinels.map(digest)), plist: await digest(fixture.plist), plistCount: await plistCount(fixture.home) };
}
async function assertProofUnchanged(fixture, before) {
  assert.deepEqual(await Promise.all(fixture.sentinels.map(digest)), before.files);
  assert.equal(await digest(fixture.plist), before.plist); assert.equal(await plistCount(fixture.home), before.plistCount);
}
async function plistCount(home) { return (await readdir(join(home, "Library", "LaunchAgents"))).filter(name => name.endsWith(".plist")).length; }
async function currentVersion(install) { return (await readlink(join(install, "current"))).replace(/^releases\//, ""); }
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
async function digest(path) { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function regular(path) { const value = await stat(path); assert.ok(value.isFile()); }
function compareVersion(left, right) {
  const a = left.split(".").map(Number), b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
