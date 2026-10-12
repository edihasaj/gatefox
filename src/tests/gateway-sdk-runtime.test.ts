import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gatewaySdkPatchSha256, gatewaySdkRevision, gatewaySdkRuntime } from "../gateway-sdk-runtime.js";

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
    platform: process.platform, arch: process.arch, capabilities: ["selected-model-compaction-v1"] };
  const save = (change: Record<string, unknown> = {}) => writeFile(receipt, JSON.stringify({ ...metadata, ...change }), { mode: 0o600 });
  await save(); return { root, directory, executable, receipt, metadata, save };
}

test("legacy packages omit the separately built gateway SDK", async t => {
  const root = await mkdtemp(join(tmpdir(), "gateway-sdk-absent-")); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await gatewaySdkRuntime(root), undefined);
});

test("matching release receipt proves gateway compaction capability", async t => {
  const f = await fixture(t);
  assert.deepEqual(await gatewaySdkRuntime(f.root), { executable: f.executable, binarySha256: f.metadata.binarySha256, selectedModelCompaction: true });
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
    { capabilities: ["selected-model-compaction-v1", "other"] }, { sourceSha256: "invalid" }]) {
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
