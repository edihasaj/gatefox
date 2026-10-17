import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gatewaySdkCapability, gatewaySdkPatchSha256, gatewaySdkRevision, gatewaySdkRuntime } from "../gateway-sdk-runtime.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "gateway-sdk-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.2.21" }));
  const directory = join(root, "gateway-sdk"); await mkdir(directory, { mode: 0o700 });
  const executable = join(directory, "gateway-codex"); const bytes = "isolated gateway SDK fixture";
  await writeFile(executable, bytes, { mode: 0o700 });
  const receipt = join(directory, "build.json");
  const metadata = { schemaVersion: 1, version: "0.2.21", codexVersion: "0.162.0-alpha.17.2", revision: gatewaySdkRevision,
    archiveSha256: "25747823ea4ec852a146cbbe75d805b8df19190ca5b3fb21052d8e1cb75f2f83", patchSha256: gatewaySdkPatchSha256,
    lockfileSha256: "49575eeb44a747925fd1acef51bff88316f728b77d7f63d989835c8623c344cb",
    lockfileRepairSha256: "a810a345d59038b785e4be8cb3fc979ce3e49e28f3888aaebb8b689dce3ca2b8",
    sourceSha256: "a".repeat(64), binarySha256: createHash("sha256").update(bytes).digest("hex"), profile: "release",
    platform: process.platform, arch: process.arch, capabilities: [gatewaySdkCapability] };
  const save = (change: Record<string, unknown> = {}) => writeFile(receipt, JSON.stringify({ ...metadata, ...change }), { mode: 0o600 });
  await save(); return { root, directory, executable, receipt, metadata, save };
}

async function reusedFixture(t: { after(fn: () => Promise<void>): void }) {
  const f = await fixture(t); const sourceSha256 = "e068c16e07773892d27c6a4afd118191a3f7cc85102fc627a7f01e7e5a92844e";
  await writeFile(join(f.root, "package.json"), JSON.stringify({ version: "0.2.24" })); await f.save({ sourceSha256 });
  for (const name of ["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "dependencies.json"]) await writeFile(join(f.directory, name), `fixture ${name}`, { mode: 0o600 });
  const files = await Promise.all(["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "build.json", "dependencies.json", "gateway-codex"].map(async name => {
    const bytes = await readFile(join(f.directory, name)); return { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const release = { version: "0.2.24", reusedComponents: { bundleVersion: f.metadata.version, bundleSha256: "b".repeat(64),
    components: { gatewaySdk: { buildVersion: f.metadata.version, sourceSha256, files } } } };
  const releasePath = join(f.root, "release.json"); const saveRelease = (value = release) => writeFile(releasePath, JSON.stringify(value), { mode: 0o600 });
  await saveRelease(); return { ...f, release, releasePath, saveRelease };
}

test("legacy packages omit the separately built gateway SDK", async t => {
  const root = await mkdtemp(join(tmpdir(), "gateway-sdk-absent-")); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await gatewaySdkRuntime(root), undefined);
});

test("matching release receipt proves the gateway executor capability: selected-model compaction and the openai alias", async t => {
  const f = await fixture(t);
  assert.equal(gatewaySdkCapability, "gateway-executor-v2");
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
    { capabilities: ["selected-model-compaction-v1"] }]) {
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
