import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const { releaseComponentPlan, verifyReleaseComponents, copyReleaseComponents } = await import(new URL("../../scripts/release-components.mjs", import.meta.url).href);
const pins = await import(new URL("../../scripts/gateway-sdk-source.mjs", import.meta.url).href);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const root = "subscription-gateway-0.2.23-macos-arm64";
type Entry = { name: string; bytes?: Buffer; type?: string };

function tar(entries: Entry[]) {
  const parts: Buffer[] = [];
  for (const { name, bytes = Buffer.alloc(0), type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name); header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136);
    header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
async function fixture(t: { after(fn: () => Promise<void>): void }, options: { native?: boolean | Record<string, unknown> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-release-reuse-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = Buffer.from("isolated component executable");
  const metadata = { schemaVersion: 1, version: "0.2.23", profile: "release", platform: "darwin", arch: "arm64",
    codexVersion: pins.gatewaySdkCodexVersion, revision: pins.gatewaySdkRevision, archiveSha256: pins.gatewaySdkArchiveSha256,
    patchSha256: pins.gatewaySdkPatchDigest(), lockfileRepairSha256: pins.gatewaySdkLockRepairDigest(),
    lockfileSha256: pins.gatewaySdkLockSha256, sourceSha256: pins.gatewaySdkSourceDigest(),
    testRunnerSha256: pins.gatewaySdkTestRunnerDigest(), patchedSdkSha256: "a".repeat(64), binarySha256: hash(binary),
    capabilities: [pins.gatewaySdkCapability] };
  const files = new Map<string, Buffer>([
    ["package/release.json", Buffer.from(JSON.stringify({ version: "0.2.23", source: "b".repeat(40) }))],
    ["package/package.json", Buffer.from(JSON.stringify({ version: "0.2.23" }))],
    ["package/unselected-sample.json", Buffer.from("unselected payload must stay out of component stage")],
    ...["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "dependencies.json"].map(name =>
      [`package/gateway-sdk/${name}`, Buffer.from("fixture")] as [string, Buffer]),
    ["package/gateway-sdk/build.json", Buffer.from(JSON.stringify(metadata))],
    ["package/gateway-sdk/gateway-codex", binary],
  ]);
  if (options.native) {
    // A published relay whose source has changed since: its receipt no longer matches.
    const nativeMetadata = typeof options.native === "object" ? options.native : { version: "0.2.23", profile: "release", codexVersion: pins.gatewaySdkCodexVersion,
      revision: pins.gatewaySdkRevision, archiveSha256: pins.gatewaySdkArchiveSha256, sourceSha256: "e".repeat(64) };
    for (const name of ["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "dependencies.json"]) files.set(`package/native/${name}`, Buffer.from("fixture"));
    files.set("package/native/build.json", Buffer.from(JSON.stringify(nativeMetadata)));
    files.set("package/native/gateway-native-relay", Buffer.from("old relay executable"));
  }
  function entries(manifestFiles = files): Entry[] {
    const manifest = Buffer.from([...manifestFiles].map(([name, bytes]) => `${hash(bytes)}  ${name}`).join("\n") + "\n");
    return [{ name: `${root}/`, type: "5" }, { name: `${root}/package/`, type: "5" },
      { name: `${root}/package/gateway-sdk/`, type: "5" },
      ...(options.native ? [{ name: `${root}/package/native/`, type: "5" }] : []),
      { name: `${root}/checksums.txt`, bytes: manifest },
      ...[...files].map(([name, bytes]) => ({ name: `${root}/${name}`, bytes }))];
  }
  async function save(list = entries()) {
    const bytes = tar(list); const archive = join(directory, "previous.tar.gz"); await writeFile(archive, bytes);
    return { archive, digest: hash(bytes) };
  }
  return { directory, files, metadata, entries, save };
}

test("explicit reuse preserves earlier receipts and copies only verified component files", async t => {
  const f = await fixture(t); const a = await f.save();
  const verified = verifyReleaseComponents(a.archive, a.digest, { gatewaySdk: true });
  assert.equal(verified.provenance.bundleVersion, "0.2.23");
  assert.equal(verified.provenance.bundleSha256, a.digest);
  assert.equal(verified.provenance.components.gatewaySdk.files.length, 6);
  const stage = join(f.directory, "stage"); await mkdir(stage);
  copyReleaseComponents(verified, stage);
  assert.deepEqual(await readFile(join(stage, "gateway-sdk/build.json")), f.files.get("package/gateway-sdk/build.json"));
  assert.equal((await stat(join(stage, "gateway-sdk/gateway-codex"))).mode & 0o777, 0o755);
  await assert.rejects(stat(join(stage, "unselected-sample.json")), { code: "ENOENT" });
});

test("missing authorization, changed archive, changed payload and changed source fail closed", async t => {
  const f = await fixture(t); const a = await f.save();
  assert.throws(() => verifyReleaseComponents(a.archive, undefined, { gatewaySdk: true }), /exact SHA-256/);
  assert.throws(() => verifyReleaseComponents(a.archive, a.digest, {}), /select --with/);
  assert.throws(() => verifyReleaseComponents(a.archive, "c".repeat(64), { gatewaySdk: true }), /archive SHA-256 mismatch/);
  const oldManifest = new Map(f.files); f.files.set("package/gateway-sdk/gateway-codex", Buffer.from("changed"));
  const changedPayload = await f.save(f.entries(oldManifest));
  assert.throws(() => verifyReleaseComponents(changedPayload.archive, changedPayload.digest, { gatewaySdk: true }), /manifest entry/);
  f.files.set("package/gateway-sdk/build.json", Buffer.from(JSON.stringify({ ...f.metadata, sourceSha256: "d".repeat(64) })));
  const changedSource = await f.save();
  assert.throws(() => verifyReleaseComponents(changedSource.archive, changedSource.digest, { gatewaySdk: true }), /source or build receipt changed/);
  await assert.rejects(stat(join(f.directory, "stage")), { code: "ENOENT" });
});

test("links, traversal, duplicate files and unmanifested payload cannot enter a component release", async t => {
  const f = await fixture(t);
  for (const extra of [{ name: `${root}/package/link`, type: "2" }, { name: `${root}/../outside` },
    { name: `${root}/package/gateway-sdk/NOTICE`, bytes: Buffer.from("duplicate") },
    { name: `${root}/package/extra`, bytes: Buffer.from("not listed") }]) {
    const a = await f.save([...f.entries(), extra]);
    assert.throws(() => verifyReleaseComponents(a.archive, a.digest, { gatewaySdk: true }),
      /unsupported entry|unsafe archive path|duplicate archive entry|unmanifested payload/);
  }
});

test("validated macOS archive metadata is ignored while path overrides are refused", async t => {
  const f = await fixture(t); const apple = Buffer.alloc(26); Buffer.from("0005160700020000", "hex").copy(apple);
  const a = await f.save([{ name: `._${root}`, bytes: apple }, ...f.entries()]);
  assert.equal(verifyReleaseComponents(a.archive, a.digest, { gatewaySdk: true }).provenance.bundleVersion, "0.2.23");
  const record = Buffer.from("18 path=../escape\n");
  const unsafe = await f.save([{ name: "PaxHeader/unsafe", bytes: record, type: "x" }, ...f.entries()]);
  assert.throws(() => verifyReleaseComponents(unsafe.archive, unsafe.digest, { gatewaySdk: true }), /unsupported PAX metadata/);
});

test("fresh native reuses only the gateway SDK from a bundle whose relay source changed", async t => {
  const f = await fixture(t, { native: true }); const a = await f.save();
  const base = { withNative: true, withGatewaySdk: true, reuseFrom: a.archive, componentsSha256: a.digest };
  const plan = releaseComponentPlan({ ...base, freshNative: true });
  assert.deepEqual(plan, { reuse: { native: false, gatewaySdk: true }, freshNative: true, freshGatewaySdk: false });
  const verified = verifyReleaseComponents(a.archive, a.digest, plan.reuse);
  assert.deepEqual(Object.keys(verified.provenance.components), ["gatewaySdk"]);
  const stage = join(f.directory, "stage"); await mkdir(stage);
  copyReleaseComponents(verified, stage);
  assert.equal((await stat(join(stage, "gateway-sdk/gateway-codex"))).isFile(), true);
  await assert.rejects(stat(join(stage, "native")), { code: "ENOENT" });
  // Without the flag, today's reuse of both components is refused for the changed relay.
  const both = releaseComponentPlan(base);
  assert.deepEqual(both, { reuse: { native: true, gatewaySdk: true }, freshNative: false, freshGatewaySdk: false });
  assert.throws(() => verifyReleaseComponents(a.archive, a.digest, both.reuse), /native source or build receipt changed/);
});

test("a relay is reused only under its own SDK pins, never the gateway SDK's", async t => {
  const relay = await import(new URL("../../scripts/native-relay-sdk.mjs", import.meta.url).href);
  const { nativeSourceDigest } = await import(new URL("../../scripts/native-source.mjs", import.meta.url).href);
  const current = { version: "0.2.23", profile: "release", codexVersion: relay.sdkCodexVersion, revision: relay.sdkRevision,
    archiveSha256: relay.sdkArchiveSha256, sourceSha256: nativeSourceDigest() };
  const f = await fixture(t, { native: current }); const a = await f.save();
  const verified = verifyReleaseComponents(a.archive, a.digest, { native: true, gatewaySdk: true });
  assert.deepEqual(Object.keys(verified.provenance.components).sort(), ["gatewaySdk", "native"]);
  // The relay and the gateway SDK no longer share a pin: a relay receipt naming the gateway SDK's is refused.
  assert.notEqual(relay.sdkRevision, pins.gatewaySdkRevision);
  for (const changed of [{ codexVersion: pins.gatewaySdkCodexVersion }, { revision: pins.gatewaySdkRevision }, { archiveSha256: pins.gatewaySdkArchiveSha256 }]) {
    const old = await fixture(t, { native: { ...current, ...changed } }); const b = await old.save();
    assert.throws(() => verifyReleaseComponents(b.archive, b.digest, { native: true, gatewaySdk: true }), /native source or build receipt changed/);
  }
});

test("fresh native requires component reuse and both components", () => {
  const reuse = { reuseFrom: "/bundle.tar.gz", componentsSha256: "a".repeat(64) };
  for (const options of [{ withNative: true, withGatewaySdk: true }, { ...reuse, withGatewaySdk: true },
    { ...reuse, withNative: true }]) {
    assert.throws(() => releaseComponentPlan({ ...options, freshNative: true }), /--fresh-native requires/);
  }
  assert.throws(() => releaseComponentPlan({ withNative: true, reuseFrom: "/bundle.tar.gz" }), /requires both/);
  assert.deepEqual(releaseComponentPlan({ withNative: true, withGatewaySdk: true }),
    { reuse: undefined, freshNative: true, freshGatewaySdk: true });
});
