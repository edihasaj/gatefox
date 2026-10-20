import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { gatewaySdkCapability, gatewaySdkPatchSha256, gatewaySdkRevision, gatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import pin from "../gateway-sdk-pin.json" with { type: "json" };
import { gatewaySdkLockRepairSha256, gatewaySdkSourceSha256 } from "../gateway-sdk-build-pins.js";

/** A release receipt: the parent bundle is the legacy origin, each component may name its own. */
type ComponentReceipt = { bundleVersion: string; bundleSha256: string;
  components: { gatewaySdk: { buildVersion: string; sourceSha256: string; files: { name: string; size: number; sha256: string }[]; origin?: { bundleVersion: string; bundleSha256: string } } } };

async function fixture(t: { after(fn: () => Promise<void>): void }, root?: string, source = "a".repeat(64)) {
  root ??= await mkdtemp(join(tmpdir(), "gateway-sdk-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.21" }));
  const directory = join(root, "gateway-sdk"); await mkdir(directory, { mode: 0o700 });
  const executable = join(directory, "gateway-codex"); const bytes = "isolated gateway SDK fixture";
  await writeFile(executable, bytes, { mode: 0o700 });
  const receipt = join(directory, "build.json");
  const metadata = { schemaVersion: 1, version: "0.2.21", codexVersion: pin.version, revision: gatewaySdkRevision,
    archiveSha256: pin.archiveSha256, patchSha256: gatewaySdkPatchSha256,
    lockfileSha256: pin.lockSha256,
    lockfileRepairSha256: gatewaySdkLockRepairSha256,
    sourceSha256: source, binarySha256: createHash("sha256").update(bytes).digest("hex"), profile: "release",
    platform: process.platform, arch: process.arch, capabilities: [gatewaySdkCapability] };
  const save = (change: Record<string, unknown> = {}) => writeFile(receipt, JSON.stringify({ ...metadata, ...change }), { mode: 0o600 });
  await save(); return { root, directory, executable, receipt, metadata, save };
}

async function managedRecoveryFixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "gateway-sdk-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = join(root, "releases", "0.2.20", "package");
  const current = join(root, "releases", "0.2.21", "package");
  await mkdir(previous, { recursive: true, mode: 0o700 });
  await mkdir(current, { recursive: true, mode: 0o700 });
  const candidate = await fixture(t, current, gatewaySdkSourceSha256);
  await rm(previous, { recursive: true, force: true });
  await writeFile(join(root, ".gateway-installation"), "subscription-gateway\n", { mode: 0o600 });
  await writeFile(join(root, "releases", "0.2.21", ".gateway-release"), "0.2.21\n", { mode: 0o600 });
  await symlink("releases/0.2.21", join(root, "current"));
  return { root, previous, current, candidate };
}

async function reusedFixture(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(t); const sourceSha256 = gatewaySdkSourceSha256;
  await writeFile(join(f.root, "package.json"), JSON.stringify({ version: "0.2.24" })); await f.save({ sourceSha256 });
  for (const name of ["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "dependencies.json"]) await writeFile(join(f.directory, name), `fixture ${name}`, { mode: 0o600 });
  const files = await Promise.all(["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "build.json", "dependencies.json", "gateway-codex"].map(async name => {
    const bytes = await readFile(join(f.directory, name)); return { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const release: { version: string; reusedComponents: ComponentReceipt } = { version: "0.2.24",
    reusedComponents: { bundleVersion: f.metadata.version, bundleSha256: "b".repeat(64),
      components: { gatewaySdk: { buildVersion: f.metadata.version, sourceSha256, files } } } };
  const releasePath = join(f.root, "release.json"); const saveRelease = (value = release) => writeFile(releasePath, JSON.stringify(value), { mode: 0o600 });
  await saveRelease(); return { ...f, release, releasePath, saveRelease };
}

test("legacy packages omit the separately built gateway SDK", async t => {
  const root = await mkdtemp(join(tmpdir(), "gateway-sdk-absent-")); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await gatewaySdkRuntime(root), undefined);
});

test("a listener whose whole managed release was pruned recovers only the verified current SDK", async t => {
  const f = await managedRecoveryFixture(t);
  const runtime = await gatewaySdkRuntime(f.previous);
  assert.deepEqual(runtime, { executable: f.candidate.executable, binarySha256: f.candidate.metadata.binarySha256, selectedModelCompaction: true, executorIdentity: true });
});

test("recovery never substitutes a current SDK for a present old package, a checkout, or an unpinned source", async t => {
  const f = await managedRecoveryFixture(t);
  await mkdir(f.previous, { recursive: true, mode: 0o700 });
  await writeFile(join(f.previous, "package.json"), JSON.stringify({ version: "0.2.20" }));
  assert.equal(await gatewaySdkRuntime(f.previous), undefined, "a present old package that lacks its SDK stays legacy");
  await rm(f.previous, { recursive: true, force: true });
  await mkdir(join(f.root, "checkout"), { mode: 0o700 });
  assert.equal(await gatewaySdkRuntime(join(f.root, "checkout")), undefined, "an arbitrary missing checkout never falls back");
  await f.candidate.save({ sourceSha256: "b".repeat(64) });
  await assert.rejects(gatewaySdkRuntime(f.previous), /does not match this release/);
});

test("managed recovery rejects a malformed installation link instead of escaping to another package", async t => {
  const f = await managedRecoveryFixture(t);
  await unlink(join(f.root, "current"));
  await symlink("../elsewhere", join(f.root, "current"));
  await assert.rejects(gatewaySdkRuntime(f.previous), /does not match this release/);
});

test("managed recovery requires the current release marker and package version", async t => {
  const f = await managedRecoveryFixture(t);
  const marker = join(f.root, "releases", "0.2.21", ".gateway-release");
  await unlink(marker);
  await assert.rejects(gatewaySdkRuntime(f.previous), /does not match this release/);
  await writeFile(marker, "0.2.20\n", { mode: 0o600 });
  await assert.rejects(gatewaySdkRuntime(f.previous), /does not match this release/);
  await unlink(marker);
  await symlink(join(f.root, ".gateway-installation"), marker);
  await assert.rejects(gatewaySdkRuntime(f.previous), /does not match this release/);
});

test("a loaded module can recover after its own managed release directory is pruned", async t => {
  const f = await managedRecoveryFixture(t);
  const old = join(f.root, "releases", "0.2.20", "package");
  const oldDist = join(old, "dist"); await mkdir(oldDist, { recursive: true, mode: 0o700 });
  await writeFile(join(old, "package.json"), JSON.stringify({ version: "0.2.20", type: "module" }), { mode: 0o600 });
  await writeFile(join(f.root, "releases", "0.2.20", ".gateway-release"), "0.2.20\n", { mode: 0o600 });
  for (const name of ["gateway-sdk-runtime.js", "gateway-sdk-build-pins.js", "gateway-sdk-pin.json"]) {
    await writeFile(join(oldDist, name), await readFile(new URL(`../${name}`, import.meta.url)));
  }
  const loaded = await import(`${pathToFileURL(join(oldDist, "gateway-sdk-runtime.js")).href}?managed-recovery`);
  await rm(join(f.root, "releases", "0.2.20"), { recursive: true, force: true });
  const runtime = await loaded.gatewaySdkRuntime();
  assert.deepEqual({ binarySha256: runtime?.binarySha256, selectedModelCompaction: runtime?.selectedModelCompaction, executorIdentity: runtime?.executorIdentity },
    { binarySha256: f.candidate.metadata.binarySha256, selectedModelCompaction: true, executorIdentity: true });
  assert.match(runtime?.executable || "", /releases\/0\.2\.21\/package\/gateway-sdk\/gateway-codex$/);
});

test("matching release receipt proves the gateway executor capability: selected-model compaction and the openai alias", async t => {
  const f = await fixture(t);
  assert.equal(gatewaySdkCapability, "gateway-executor-v3");
  assert.deepEqual(await gatewaySdkRuntime(f.root), { executable: f.executable, binarySha256: f.metadata.binarySha256, selectedModelCompaction: true, executorIdentity: true });
});

test("present but incomplete or changed binaries fail closed", async t => {
  const f = await fixture(t);
  await writeFile(f.executable, "different bytes");
  await assert.rejects(gatewaySdkRuntime(f.root), /does not match this release/);
  await rm(f.receipt);
  await assert.rejects(gatewaySdkRuntime(f.root));
});

test("foreign revision, patch, release, platform and capabilities are refused", async t => {
  const f = await fixture(t);
  for (const change of [{ revision: "b".repeat(40) }, { patchSha256: "b".repeat(64) }, { version: "0.2.19" },
    { lockfileSha256: "b".repeat(64) }, { lockfileRepairSha256: "b".repeat(64) },
    { platform: "foreign" }, { arch: "foreign" }, { profile: "dev" }, { capabilities: [] },
    { capabilities: [gatewaySdkCapability, "other"] }, { sourceSha256: "invalid" },
    // An SDK built with patch v1 compacts on the selected model but cannot serve openai as the gateway.
    { capabilities: ["selected-model-compaction-v1"] },
    // A v2 SDK has the native identity but still drains queued messages after failure.
    { capabilities: ["gateway-executor-v2"] }]) {
    await f.save(change); await assert.rejects(gatewaySdkRuntime(f.root), /does not match this release/);
  }
});

test("writable receipts or executables and executable symlinks are refused", async t => {
  const f = await fixture(t);
  await chmod(f.receipt, 0o666); await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
  await chmod(f.receipt, 0o600); await chmod(f.executable, 0o777);
  await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
  await rm(f.executable); await symlink(join(f.root, "package.json"), f.executable);
  await assert.rejects(gatewaySdkRuntime(f.root));
});

test("an explicitly verified reused SDK accepts an unchanged foreign-version component", async t => {
  const f = await reusedFixture(t);
  assert.deepEqual(await gatewaySdkRuntime(f.root), { executable: f.executable, binarySha256: f.metadata.binarySha256, selectedModelCompaction: true, executorIdentity: true });
  assert.equal(JSON.parse(await readFile(f.receipt, "utf8")).version, f.metadata.version);
});

test("reuse requires matching release, bundle, build, source and exact complete file provenance", async t => {
  const f = await reusedFixture(t);
  const changes: Array<(value: typeof f.release) => void> = [
    value => { value.version = "0.2.23"; },
    value => { value.reusedComponents.bundleVersion = "0.2.20"; },
    value => { value.reusedComponents.bundleSha256 = "invalid"; },
    value => { value.reusedComponents.components.gatewaySdk.buildVersion = "0.2.20"; },
    value => { value.reusedComponents.components.gatewaySdk.sourceSha256 = "b".repeat(64); },
    value => { value.reusedComponents.components.gatewaySdk.files.pop(); },
    value => { value.reusedComponents.components.gatewaySdk.files[0] = value.reusedComponents.components.gatewaySdk.files[1]!; },
    value => { value.reusedComponents.components.gatewaySdk.files[0]!.name = "../CODEX-LICENSE"; },
    value => { value.reusedComponents.components.gatewaySdk.files[0]!.sha256 = "b".repeat(64); },
    value => { value.reusedComponents.components.gatewaySdk.files[0]!.size++; },
  ];
  for (const change of changes) {
    const release = structuredClone(f.release); change(release); await f.saveRelease(release);
    await assert.rejects(gatewaySdkRuntime(f.root), /does not match this release/);
  }
  await f.saveRelease(); await writeFile(join(f.directory, "foreign.json"), "unexpected");
  await assert.rejects(gatewaySdkRuntime(f.root), /does not match this release/);
  await rm(join(f.directory, "foreign.json")); await rm(f.releasePath);
  await assert.rejects(gatewaySdkRuntime(f.root));
});

test("reused SDK components reject altered, missing, symlinked and writable files", async t => {
  const f = await reusedFixture(t); const license = join(f.directory, "CODEX-LICENSE"); const bytes = await readFile(license);
  await writeFile(license, "altered"); await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
  await writeFile(license, bytes); await chmod(license, 0o666); await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
  await chmod(license, 0o600); await rm(license); await assert.rejects(gatewaySdkRuntime(f.root));
  const target = join(f.root, "original-license"); await writeFile(target, bytes, { mode: 0o600 }); await symlink(target, license);
  await assert.rejects(gatewaySdkRuntime(f.root)); await rm(license); await writeFile(license, bytes, { mode: 0o600 });
  await chmod(f.releasePath, 0o666); await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
  await chmod(f.releasePath, 0o600); await writeFile(f.executable, "altered executable"); await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
});

test("reuse does not relax SDK revision, patch, platform, profile, capability or source checks", async t => {
  const f = await reusedFixture(t);
  for (const change of [{ revision: "b".repeat(40) }, { patchSha256: "b".repeat(64) }, { sourceSha256: "b".repeat(64) },
    { platform: "foreign" }, { arch: "foreign" }, { profile: "dev" }, { capabilities: [] }]) {
    await f.save(change); await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
  }
  await f.save({ sourceSha256: "b".repeat(64) }); const release = structuredClone(f.release);
  release.reusedComponents.components.gatewaySdk.sourceSha256 = "b".repeat(64);
  const receipt = await readFile(f.receipt); const file = release.reusedComponents.components.gatewaySdk.files.find(entry => entry.name === "build.json")!;
  file.size = receipt.length; file.sha256 = createHash("sha256").update(receipt).digest("hex"); await f.saveRelease(release);
  await assert.rejects(gatewaySdkRuntime(f.root), /does not match/);
});

test("a reused component origin wins over the parent bundle it was staged from", async t => {
  const f = await reusedFixture(t); const release = structuredClone(f.release);
  // The relay came from its own newer bundle, so the parent receipt no longer describes this component's origin.
  release.reusedComponents.bundleVersion = "0.2.19"; release.reusedComponents.bundleSha256 = "c".repeat(64);
  release.reusedComponents.components.gatewaySdk.origin = { bundleVersion: f.metadata.version, bundleSha256: "d".repeat(64) };
  await f.saveRelease(release);
  assert.deepEqual(await gatewaySdkRuntime(f.root), { executable: f.executable, binarySha256: f.metadata.binarySha256, selectedModelCompaction: true, executorIdentity: true });
  const malformed: unknown[] = [{ bundleVersion: f.metadata.version }, { bundleSha256: "d".repeat(64) }, { bundleVersion: "0.2.19", bundleSha256: "d".repeat(64) },
    { bundleVersion: f.metadata.version, bundleSha256: "not-a-digest" }, { bundleVersion: null, bundleSha256: "d".repeat(64) },
    null, "0.2.23", { bundleVersion: f.metadata.version, bundleSha256: "d".repeat(64), extra: 1 }];
  for (const origin of malformed) {
    const value = structuredClone(f.release);
    value.reusedComponents.components.gatewaySdk.origin = origin as never; await f.saveRelease(value);
    await assert.rejects(gatewaySdkRuntime(f.root), /does not match this release/, `origin ${JSON.stringify(origin)}`);
  }
  // No origin at all still resolves the parent receipt, so a release built before per-component origins keeps working.
  const legacy = structuredClone(f.release); delete legacy.reusedComponents.components.gatewaySdk.origin;
  await f.saveRelease(legacy);
  assert.equal((await gatewaySdkRuntime(f.root))?.binarySha256, f.metadata.binarySha256);
});
