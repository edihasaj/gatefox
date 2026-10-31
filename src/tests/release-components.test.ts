import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const { releaseComponentPlan, verifyReleaseComponents, verifyReleaseComponentSources, copyReleaseComponents } = await import(new URL("../../scripts/release-components.mjs", import.meta.url).href);
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
const hostBytes = Buffer.from("isolated gateway code-mode host executable");

async function fixture(t: { after(fn: () => Promise<void>): void }, options: { native?: boolean | Record<string, unknown>; host?: boolean } = {}) {
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
    ["package/gateway-sdk/build.json", Buffer.from(JSON.stringify(options.host ? { ...metadata, codeModeHostSha256: hash(hostBytes) } : metadata))],
    ["package/gateway-sdk/gateway-codex", binary],
    ...(options.host ? [["package/gateway-sdk/codex-code-mode-host", hostBytes] as [string, Buffer]] : []),
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

test("a reused gateway SDK may carry its code-mode host, and the component and its receipt must agree", async t => {
  const f = await fixture(t, { host: true }); const a = await f.save();
  const verified = verifyReleaseComponents(a.archive, a.digest, { gatewaySdk: true });
  assert.equal(verified.provenance.components.gatewaySdk.files.length, 7);
  const stage = join(f.directory, "stage"); await mkdir(stage);
  copyReleaseComponents(verified, stage);
  assert.deepEqual(await readFile(join(stage, "gateway-sdk/codex-code-mode-host")), hostBytes);
  assert.equal((await stat(join(stage, "gateway-sdk/codex-code-mode-host"))).mode & 0o777, 0o755, "the companion is staged as an executable");
  const unnamed = await fixture(t, { host: true });
  unnamed.files.set("package/gateway-sdk/build.json", Buffer.from(JSON.stringify(f.metadata)));
  const carried = await unnamed.save();
  assert.throws(() => verifyReleaseComponents(carried.archive, carried.digest, { gatewaySdk: true }), /code-mode host receipt and files disagree/, "a host no receipt names");
  const unfiled = await fixture(t);
  unfiled.files.set("package/gateway-sdk/build.json", Buffer.from(JSON.stringify({ ...f.metadata, codeModeHostSha256: hash(hostBytes) })));
  const named = await unfiled.save();
  assert.throws(() => verifyReleaseComponents(named.archive, named.digest, { gatewaySdk: true }), /code-mode host receipt and files disagree/, "a receipt naming a host the bundle never carried");
  const malformed = await fixture(t);
  malformed.files.set("package/gateway-sdk/build.json", Buffer.from(JSON.stringify({ ...f.metadata, codeModeHostSha256: "not-a-digest" })));
  const broken = await malformed.save();
  assert.throws(() => verifyReleaseComponents(broken.archive, broken.digest, { gatewaySdk: true }), /code-mode host receipt is invalid/, "a malformed digest names no file");
  const changed = await fixture(t, { host: true });
  changed.files.set("package/gateway-sdk/codex-code-mode-host", Buffer.from("another code-mode host build"));
  const stale = await changed.save();
  assert.throws(() => verifyReleaseComponents(stale.archive, stale.digest, { gatewaySdk: true }), /gateway SDK pins or capability changed/, "a host that changed since its receipt");
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
  assert.deepEqual(plan, { reuse: { native: false, gatewaySdk: true }, reuseNative: undefined, freshNative: true, freshGatewaySdk: false });
  const verified = verifyReleaseComponents(a.archive, a.digest, plan.reuse);
  assert.deepEqual(Object.keys(verified.provenance.components), ["gatewaySdk"]);
  const stage = join(f.directory, "stage"); await mkdir(stage);
  copyReleaseComponents(verified, stage);
  assert.equal((await stat(join(stage, "gateway-sdk/gateway-codex"))).isFile(), true);
  await assert.rejects(stat(join(stage, "native")), { code: "ENOENT" });
  // Without the flag, today's reuse of both components is refused for the changed relay.
  const both = releaseComponentPlan(base);
  assert.deepEqual(both, { reuse: { native: true, gatewaySdk: true }, reuseNative: undefined, freshNative: false, freshGatewaySdk: false });
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
    { reuse: undefined, reuseNative: undefined, freshNative: true, freshGatewaySdk: true });
  // A relay archive of its own needs its digest and both components, and excludes --fresh-native.
  const separate = { withNative: true, withGatewaySdk: true, reuseNativeFrom: "/relay.tar.gz", nativeSha256: "a".repeat(64) };
  assert.throws(() => releaseComponentPlan({ withNative: true, withGatewaySdk: true, reuseNativeFrom: "/relay.tar.gz" }), /requires both --reuse-native-from/);
  assert.throws(() => releaseComponentPlan({ withGatewaySdk: true, reuseNativeFrom: "/relay.tar.gz", nativeSha256: "a".repeat(64) }), /requires --with-native/);
  assert.deepEqual(releaseComponentPlan(separate), { reuse: undefined,
    reuseNative: { from: separate.reuseNativeFrom, sha256: separate.nativeSha256 }, freshNative: false, freshGatewaySdk: true });
  assert.throws(() => releaseComponentPlan({ ...separate, reuseFrom: "/bundle.tar.gz" }), /Component reuse requires both/);
  assert.throws(() => releaseComponentPlan({ ...separate, freshNative: true }), /cannot be combined/);
});

const relay = await import(new URL("../../scripts/native-relay-sdk.mjs", import.meta.url).href);
const { nativeSourceDigest } = await import(new URL("../../scripts/native-source.mjs", import.meta.url).href);

/** An original published bundle that built the named components for its own version, byte for byte. */
async function originalBundle(t: { after(fn: () => Promise<void>): void }, options: {
  version: string; native?: boolean; gatewaySdk?: boolean; changed?: Record<string, unknown>; reused?: string[];
}) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-release-original-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = `harness-gateway-${options.version}-macos-arm64`;
  const files = new Map<string, Buffer>();
  const release: Record<string, unknown> = { version: options.version, source: "b".repeat(40) };
  if (options.reused?.length) release.reusedComponents = { bundleVersion: "0.1.0", bundleSha256: "c".repeat(64),
    components: Object.fromEntries(options.reused.map(key => [key, { buildVersion: "0.1.0", sourceSha256: "d".repeat(64), files: [] }])) };
  files.set("package/release.json", Buffer.from(JSON.stringify(release)));
  files.set("package/package.json", Buffer.from(JSON.stringify({ version: options.version })));
  const entries: Entry[] = [{ name: `${root}/`, type: "5" }, { name: `${root}/package/`, type: "5" }];
  for (const [key, subdirectory, binary] of [["native", "native", "gateway-native-relay"], ["gatewaySdk", "gateway-sdk", "gateway-codex"]] as const) {
    if (!options[key]) continue;
    entries.push({ name: `${root}/package/${subdirectory}/`, type: "5" });
    for (const name of ["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "dependencies.json"]) {
      files.set(`package/${subdirectory}/${name}`, Buffer.from(`original ${subdirectory} ${name}`));
    }
    const metadata: Record<string, unknown> = key === "native"
      ? { version: options.version, profile: "release", codexVersion: relay.sdkCodexVersion, revision: relay.sdkRevision,
          archiveSha256: relay.sdkArchiveSha256, sourceSha256: nativeSourceDigest() }
      : { schemaVersion: 1, version: options.version, profile: "release", platform: "darwin", arch: "arm64",
          codexVersion: pins.gatewaySdkCodexVersion, revision: pins.gatewaySdkRevision, archiveSha256: pins.gatewaySdkArchiveSha256,
          patchSha256: pins.gatewaySdkPatchDigest(), lockfileRepairSha256: pins.gatewaySdkLockRepairDigest(),
          lockfileSha256: pins.gatewaySdkLockSha256, sourceSha256: pins.gatewaySdkSourceDigest(),
          testRunnerSha256: pins.gatewaySdkTestRunnerDigest(), patchedSdkSha256: "a".repeat(64), capabilities: [pins.gatewaySdkCapability] };
    const executable = Buffer.from(`original ${binary} executable bytes ${options.version}`);
    metadata.binarySha256 = hash(executable);
    if (options.changed && options[key]) Object.assign(metadata, options.changed);
    files.set(`package/${subdirectory}/build.json`, Buffer.from(JSON.stringify(metadata)));
    files.set(`package/${subdirectory}/${binary}`, executable);
  }
  const manifest = Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}`).join("\n") + "\n");
  const bytes = tar([...entries, { name: `${root}/checksums.txt`, bytes: manifest }, ...[...files].map(([name, buffer]) => ({ name: `${root}/${name}`, bytes: buffer }))]);
  const archive = join(directory, `${root}.tar.gz`); await writeFile(archive, bytes);
  return { archive, digest: hash(bytes), files, root, directory };
}

test("two separately authenticated originals combine, each keeping its own origin and bytes", async t => {
  const sdk = await originalBundle(t, { version: "0.4.7", gatewaySdk: true });
  const native = await originalBundle(t, { version: "0.5.0", native: true });
  const plan = releaseComponentPlan({ withNative: true, withGatewaySdk: true, reuseFrom: sdk.archive,
    componentsSha256: sdk.digest, reuseNativeFrom: native.archive, nativeSha256: native.digest });
  assert.deepEqual(plan, { reuse: { native: false, gatewaySdk: true }, reuseNative: { from: native.archive, sha256: native.digest },
    freshNative: false, freshGatewaySdk: false });
  const verified = verifyReleaseComponentSources({
    gatewaySdk: { archivePath: sdk.archive, expectedSha256: sdk.digest, flag: "--components-sha256" },
    native: { archivePath: native.archive, expectedSha256: native.digest, flag: "--native-sha256" },
  });
  // The parent receipt stays the SDK bundle's; each component names the archive it was really built in.
  assert.deepEqual({ bundleVersion: verified.provenance.bundleVersion, bundleSha256: verified.provenance.bundleSha256 },
    { bundleVersion: "0.4.7", bundleSha256: sdk.digest });
  assert.deepEqual(verified.provenance.components.native.origin, { bundleVersion: "0.5.0", bundleSha256: native.digest });
  assert.deepEqual(verified.provenance.components.gatewaySdk.origin, { bundleVersion: "0.4.7", bundleSha256: sdk.digest });
  assert.deepEqual(verified.provenance.components.native.buildVersion, "0.5.0");
  assert.equal(verified.provenance.components.native.files.length, 6);
  assert.equal(verified.provenance.components.gatewaySdk.files.length, 6);
  const stage = join(sdk.directory, "stage"); await mkdir(stage, { recursive: true });
  copyReleaseComponents(verified, stage);
  for (const [key, subdirectory, bundle] of [["native", "native", native], ["gatewaySdk", "gateway-sdk", sdk]] as const)
    for (const file of verified.provenance.components[key].files) {
      assert.deepEqual(await readFile(join(stage, subdirectory, file.name)), bundle.files.get(`package/${subdirectory}/${file.name}`));
    }
  assert.equal((await stat(join(stage, "native/gateway-native-relay"))).mode & 0o777, 0o755);
  assert.equal((await stat(join(stage, "gateway-sdk/gateway-codex"))).mode & 0o777, 0o755);
  assert.equal((await stat(join(stage, "native/build.json"))).mode & 0o777, 0o644);
});

test("an independently authenticated relay can accompany a fresh gateway SDK", async t => {
  const native = await originalBundle(t, { version: "0.5.0", native: true });
  const plan = releaseComponentPlan({ withNative: true, withGatewaySdk: true,
    reuseNativeFrom: native.archive, nativeSha256: native.digest });
  assert.deepEqual(plan, { reuse: undefined, reuseNative: { from: native.archive, sha256: native.digest },
    freshNative: false, freshGatewaySdk: true });
  const verified = verifyReleaseComponentSources({ native: { archivePath: plan.reuseNative!.from,
    expectedSha256: plan.reuseNative!.sha256, flag: "--native-sha256" } });
  assert.deepEqual(Object.keys(verified.provenance.components), ["native"]);
  assert.equal(verified.provenance.bundleVersion, "0.5.0");
  const stage = join(native.directory, "fresh-sdk-stage"); await mkdir(stage, { mode: 0o700 });
  copyReleaseComponents(verified, stage);
  assert.deepEqual(await readFile(join(stage, "native/gateway-native-relay")), native.files.get("package/native/gateway-native-relay"));
  await assert.rejects(stat(join(stage, "gateway-sdk")), { code: "ENOENT" });
  // With the complete pair the plan names both originals and builds nothing fresh.
  const sdk = await originalBundle(t, { version: "0.4.7", gatewaySdk: true });
  assert.deepEqual(releaseComponentPlan({ withNative: true, withGatewaySdk: true, reuseFrom: sdk.archive,
    componentsSha256: sdk.digest, reuseNativeFrom: native.archive, nativeSha256: native.digest }),
    { reuse: { native: false, gatewaySdk: true }, reuseNative: { from: native.archive, sha256: native.digest },
      freshNative: false, freshGatewaySdk: false });
});

test("a wrong digest, the wrong archive, or changed source in either original fails closed", async t => {
  const sdk = await originalBundle(t, { version: "0.4.7", gatewaySdk: true });
  const native = await originalBundle(t, { version: "0.5.0", native: true });
  const good = { gatewaySdk: { archivePath: sdk.archive, expectedSha256: sdk.digest, flag: "--components-sha256" },
    native: { archivePath: native.archive, expectedSha256: native.digest, flag: "--native-sha256" } };
  assert.throws(() => verifyReleaseComponentSources({ ...good, native: { ...good.native, expectedSha256: "f".repeat(64) } }), /archive SHA-256 mismatch/);
  assert.throws(() => verifyReleaseComponentSources({ ...good, gatewaySdk: { ...good.gatewaySdk, expectedSha256: "nonsense" } }), /exact SHA-256 digest/);
  // Pointing the relay selection at the SDK bundle's archive finds no relay component.
  assert.throws(() => verifyReleaseComponentSources({ ...good, native: { ...good.native, archivePath: sdk.archive, expectedSha256: sdk.digest } }),
    /unexpected native component files|select --with/);
  const wrongNativeSource = await originalBundle(t, { version: "0.5.0", native: true, changed: { sourceSha256: "e".repeat(64) } });
  assert.throws(() => verifyReleaseComponentSources({ ...good, native: { ...good.native, archivePath: wrongNativeSource.archive, expectedSha256: wrongNativeSource.digest } }),
    /native source or build receipt changed/);
  const wrongSdkSource = await originalBundle(t, { version: "0.4.7", gatewaySdk: true, changed: { sourceSha256: "d".repeat(64) } });
  assert.throws(() => verifyReleaseComponentSources({ ...good, gatewaySdk: { ...good.gatewaySdk, archivePath: wrongSdkSource.archive, expectedSha256: wrongSdkSource.digest } }),
    /gatewaySdk source or build receipt changed/);
  const stage = join(sdk.directory, "refused-stage"); await mkdir(stage, { recursive: true });
  assert.throws(() => verifyReleaseComponentSources({ ...good, native: { ...good.native, expectedSha256: "f".repeat(64) } }), /archive SHA-256 mismatch/);
  assert.deepEqual((await readdir(stage)), []);
});

test("a component that was itself reused is refused; reuse of the other component still passes", async t => {
  const chainedSdk = await originalBundle(t, { version: "0.4.7", gatewaySdk: true, native: true, reused: ["gatewaySdk"] });
  assert.throws(() => verifyReleaseComponents(chainedSdk.archive, chainedSdk.digest, { gatewaySdk: true }), /gatewaySdk component was itself reused/);
  assert.throws(() => verifyReleaseComponentSources({ native: { archivePath: chainedSdk.archive, expectedSha256: chainedSdk.digest, flag: "--native-sha256" },
    gatewaySdk: { archivePath: chainedSdk.archive, expectedSha256: chainedSdk.digest, flag: "--components-sha256" } }), /gatewaySdk component was itself reused/);
  // Its relay was built there, so only that one may be reused from it.
  const onlyNative = verifyReleaseComponentSources({ native: { archivePath: chainedSdk.archive, expectedSha256: chainedSdk.digest, flag: "--native-sha256" } });
  assert.deepEqual(onlyNative.provenance.components.native.origin, { bundleVersion: "0.4.7", bundleSha256: chainedSdk.digest });
  const chainedNative = await originalBundle(t, { version: "0.5.0", native: true, gatewaySdk: true, reused: ["native"] });
  assert.throws(() => verifyReleaseComponents(chainedNative.archive, chainedNative.digest, { native: true }), /native component was itself reused/);
});
