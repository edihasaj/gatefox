import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, readlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pin from "./gateway-sdk-pin.json" with { type: "json" };
import { gatewaySdkPatchSha256, gatewaySdkLockRepairSha256, gatewaySdkSourceSha256 } from "./gateway-sdk-build-pins.js";

export const gatewaySdkRevision = pin.revision;
export { gatewaySdkPatchSha256 };
const archiveSha256 = pin.archiveSha256;
const lockfileSha256 = pin.lockSha256;
const lockfileRepairSha256 = gatewaySdkLockRepairSha256;
const sourceSha256 = gatewaySdkSourceSha256;
const componentFiles = ["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "build.json", "dependencies.json", "gateway-codex"];
const invalid = () => new Error("Gateway executor artifact does not match this release. Reinstall the gateway before loading another gateway chat.");
const releaseVersion = (value: string): boolean => /^\d+\.\d+\.\d+$/.test(value);
/**
 * A verified gateway SDK. `selectedModelCompaction`: the SDK compacts on the selected model inside the user's turn.
 * `executorIdentity`: inside a gateway executor (HARNESS_GATEWAY_EXECUTOR=1) the SDK resolves `openai` to the gateway's own
 * loopback provider, so new gateway chats can be recorded as `openai` (see docs/harness-identity.md).
 */
export interface GatewaySdkRuntime { executable: string; binarySha256: string; selectedModelCompaction: true; executorIdentity: true }
/** The gateway patch capability, independent of the upstream Codex version. */
export const gatewaySdkCapability = "gateway-executor-v3";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const owned = (uid: number): boolean => !process.getuid || uid === process.getuid();
const safeDirectory = (info: Awaited<ReturnType<typeof lstat>>): boolean => info.isDirectory() && !info.isSymbolicLink() && owned(Number(info.uid)) && !(Number(info.mode) & 0o022);

async function verifiedDirectory(path: string): Promise<void> {
  if (!safeDirectory(await lstat(path).catch(() => { throw invalid(); }))) throw invalid();
}

async function installationMarker(root: string): Promise<void> {
  const path = join(root, ".gateway-installation");
  const info = await lstat(path).catch(() => { throw invalid(); });
  if (!info.isFile() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o022) || info.size > 128) throw invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw invalid(); });
  try {
    const current = await file.stat();
    if (!current.isFile() || !owned(current.uid) || (current.mode & 0o022) || current.size !== info.size) throw invalid();
    const bytes = await file.readFile();
    if (!bytes.equals(Buffer.from("subscription-gateway")) && !bytes.equals(Buffer.from("subscription-gateway\n"))) throw invalid();
  } finally { await file.close(); }
}

async function releaseMarker(release: string): Promise<void> {
  const path = join(release, ".gateway-release"); const name = basename(release);
  const info = await lstat(path).catch(() => { throw invalid(); });
  if (!info.isFile() || info.isSymbolicLink() || !owned(Number(info.uid)) || (Number(info.mode) & 0o022) || info.size > 80) throw invalid();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw invalid(); });
  try {
    const current = await file.stat();
    if (!current.isFile() || !owned(Number(current.uid)) || (Number(current.mode) & 0o022) || current.size !== info.size
      || !(await file.readFile()).equals(Buffer.from(`${name}\n`))) throw invalid();
  } finally { await file.close(); }
}

interface ManagedPackageLayout { root: string; releases: string; release: string; packageDirectory: string }

/** A pruned module may only follow the installer's own `current` link, never an adjacent checkout. */
function managedPackageLayout(packageDirectory: string): ManagedPackageLayout | undefined {
  const checked = resolve(packageDirectory);
  const release = dirname(checked); const releases = dirname(release); const root = dirname(releases);
  if (basename(checked) !== "package" || basename(releases) !== "releases" || !releaseVersion(basename(release))
    || checked !== join(root, "releases", basename(release), "package")) return undefined;
  return { root, releases, release, packageDirectory: checked };
}

async function componentHash(path: string, maximumSize: number, executable = false): Promise<{ size: number; sha256: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !owned(stat.uid) || (stat.mode & 0o022) || stat.size > maximumSize || (executable && !(stat.mode & 0o100))) throw invalid();
    const hash = createHash("sha256");
    for await (const buffer of file.createReadStream({ autoClose: false })) hash.update(buffer);
    return { size: stat.size, sha256: hash.digest("hex") };
  } finally { await file.close(); }
}

/** A component names the bundle it was actually built in; a partial or malformed one is never replaced by the parent's. */
function componentOrigin(component: Record<string, unknown>, legacy: Record<string, unknown>): { bundleVersion: unknown; bundleSha256: unknown } {
  if (component.origin === undefined) return { bundleVersion: legacy.bundleVersion, bundleSha256: legacy.bundleSha256 };
  const origin = record(component.origin);
  if (Object.keys(origin).length !== 2 || !Object.hasOwn(origin, "bundleVersion") || !Object.hasOwn(origin, "bundleSha256")) throw invalid();
  return { bundleVersion: origin.bundleVersion, bundleSha256: origin.bundleSha256 };
}

/** A different build version needs an explicit, byte-verified reused component receipt. */
async function reusedBinaryHash(packageDirectory: string, directory: string, version: string, metadata: Record<string, unknown>, receiptBytes: Buffer): Promise<string> {
  const receipt = resolve(packageDirectory, "release.json"); const info = await lstat(receipt);
  if (!info.isFile() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o022) || info.size > 16384) throw invalid();
  let release: Record<string, unknown>;
  try { release = record(JSON.parse(await readFile(receipt, "utf8"))); } catch { throw invalid(); }
  const reuse = record(release.reusedComponents); const component = record(record(reuse.components).gatewaySdk);
  const origin = componentOrigin(component, reuse);
  if (release.version !== version || origin.bundleVersion !== metadata.version || !digest(origin.bundleSha256)
    || component.buildVersion !== metadata.version || component.sourceSha256 !== metadata.sourceSha256 || component.sourceSha256 !== sourceSha256
    || !Array.isArray(component.files) || component.files.length !== componentFiles.length
    || JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(componentFiles)) throw invalid();
  const files = new Map<string, { size: number; sha256: string }>();
  for (const entry of component.files) {
    const file = record(entry);
    if (typeof file.name !== "string" || !componentFiles.includes(file.name) || files.has(file.name)
      || typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || !digest(file.sha256)) throw invalid();
    files.set(file.name, { size: file.size, sha256: file.sha256 });
  }
  if (files.get("build.json")?.sha256 !== createHash("sha256").update(receiptBytes).digest("hex")) throw invalid();
  for (const name of componentFiles) {
    const limit = name === "gateway-codex" ? 512 * 1024 * 1024 : name === "dependencies.json" ? 16 * 1024 * 1024 : name === "build.json" ? 16384 : 2 * 1024 * 1024;
    const actual = await componentHash(resolve(directory, name), limit, name === "gateway-codex"); const expected = files.get(name)!;
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) throw invalid();
  }
  return files.get("gateway-codex")!.sha256;
}

/** Only gateway executors use this artifact. Native authentication and SDK stay in their original home. */
async function directGatewaySdkRuntime(packageDirectory: string): Promise<GatewaySdkRuntime | undefined> {
  const directory = resolve(packageDirectory, "gateway-sdk");
  const present = await lstat(directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!present) return undefined;
  if (!present.isDirectory() || present.isSymbolicLink() || !owned(present.uid) || (present.mode & 0o022)) throw invalid();
  const receipt = resolve(directory, "build.json"); const executable = resolve(directory, "gateway-codex");
  const info = await lstat(receipt);
  if (!info.isFile() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o022) || info.size > 16384) throw invalid();
  let metadata: Record<string, unknown>; let version: unknown; let receiptBytes: Buffer;
  try {
    receiptBytes = await readFile(receipt); metadata = JSON.parse(receiptBytes.toString("utf8"));
    version = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")).version;
  } catch { throw invalid(); }
  if (typeof version !== "string" || !releaseVersion(version) || !metadata || metadata.schemaVersion !== 1 || typeof metadata.version !== "string" || !releaseVersion(metadata.version) || metadata.codexVersion !== pin.version ||
    metadata.revision !== gatewaySdkRevision || metadata.archiveSha256 !== archiveSha256 || metadata.patchSha256 !== gatewaySdkPatchSha256 ||
    metadata.lockfileSha256 !== lockfileSha256 || metadata.lockfileRepairSha256 !== lockfileRepairSha256 ||
    metadata.profile !== "release" || metadata.platform !== process.platform || metadata.arch !== process.arch ||
    typeof metadata.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sourceSha256) ||
    typeof metadata.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.binarySha256) ||
    !Array.isArray(metadata.capabilities) || metadata.capabilities.length !== 1 || metadata.capabilities[0] !== gatewaySdkCapability) throw invalid();
  const binarySha256 = metadata.version === version
    ? (await componentHash(executable, 512 * 1024 * 1024, true)).sha256
    : await reusedBinaryHash(packageDirectory, directory, version, metadata, receiptBytes).catch(() => { throw invalid(); });
  if (binarySha256 !== metadata.binarySha256) throw invalid();
  return { executable, binarySha256: metadata.binarySha256, selectedModelCompaction: true, executorIdentity: true };
}

/** The candidate was validated as a component; recovery also binds its declared source to this loaded release's pin. */
async function recoverySourceMatches(packageDirectory: string): Promise<boolean> {
  try {
    const metadata = record(JSON.parse(await readFile(resolve(packageDirectory, "gateway-sdk", "build.json"), "utf8")));
    return metadata.sourceSha256 === sourceSha256;
  } catch { return false; }
}

async function recoveredManagedRuntime(layout: ManagedPackageLayout): Promise<GatewaySdkRuntime> {
  await verifiedDirectory(layout.root); await verifiedDirectory(layout.releases); await installationMarker(layout.root);
  const current = join(layout.root, "current");
  const link = await lstat(current).catch(() => { throw invalid(); });
  if (!link.isSymbolicLink() || !owned(link.uid)) throw invalid();
  const target = resolve(layout.root, await readlink(current).catch(() => { throw invalid(); }));
  if (dirname(target) !== layout.releases || !releaseVersion(basename(target))) throw invalid();
  // There are no links below `current`: the package that passed component verification is exactly the managed release target.
  await verifiedDirectory(target);
  await releaseMarker(target);
  const candidate = join(target, "package");
  await verifiedDirectory(candidate);
  let candidateVersion: unknown;
  try { candidateVersion = record(JSON.parse(await readFile(join(candidate, "package.json"), "utf8"))).version; }
  catch { throw invalid(); }
  if (candidateVersion !== basename(target)) throw invalid();
  const runtime = await directGatewaySdkRuntime(candidate);
  if (!runtime || !await recoverySourceMatches(candidate)) throw invalid();
  return runtime;
}

/**
 * A listener can outlive its release directory. Only when that whole original managed package was removed may it recover
 * the SDK from the verified current release; a present package with a missing or invalid SDK remains fail-closed.
 */
export async function gatewaySdkRuntime(packageDirectory = fileURLToPath(new URL("..", import.meta.url))): Promise<GatewaySdkRuntime | undefined> {
  const checked = resolve(packageDirectory);
  const source = await lstat(checked).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (source) return directGatewaySdkRuntime(checked);
  const layout = managedPackageLayout(checked);
  return layout ? recoveredManagedRuntime(layout) : undefined;
}
