import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const gatewaySdkRevision = "740e5af33c71225640e0c1c1555c514c2c93ab74";
export const gatewaySdkPatchSha256 = "9b59500683b66fab9dd0ecc2384d3046fb2fe8d506278ac767c81bf1c6061f36";
const archiveSha256 = "25747823ea4ec852a146cbbe75d805b8df19190ca5b3fb21052d8e1cb75f2f83";
const lockfileSha256 = "49575eeb44a747925fd1acef51bff88316f728b77d7f63d989835c8623c344cb";
const lockfileRepairSha256 = "a810a345d59038b785e4be8cb3fc979ce3e49e28f3888aaebb8b689dce3ca2b8";
const sourceSha256 = "66c1dec57d10efb9f18bd480786b88f4fba0f9922263b1bc34c341f5a6c720a9";
const componentFiles = ["CODEX-LICENSE", "CODEX-NOTICE", "NOTICE", "build.json", "dependencies.json", "gateway-codex"];
const invalid = () => new Error("Gateway executor artifact does not match this release. Reinstall the gateway before loading another gateway chat.");
export interface GatewaySdkRuntime { executable: string; binarySha256: string; selectedModelCompaction: true }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const owned = (uid: number): boolean => !process.getuid || uid === process.getuid();

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

/** A different build version needs an explicit, byte-verified reused component receipt. */
async function reusedBinaryHash(packageDirectory: string, directory: string, version: string, metadata: Record<string, unknown>, receiptBytes: Buffer): Promise<string> {
  const receipt = resolve(packageDirectory, "release.json"); const info = await lstat(receipt);
  if (!info.isFile() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o022) || info.size > 16384) throw invalid();
  let release: Record<string, unknown>;
  try { release = record(JSON.parse(await readFile(receipt, "utf8"))); } catch { throw invalid(); }
  const reuse = record(release.reusedComponents); const component = record(record(reuse.components).gatewaySdk);
  if (release.version !== version || reuse.bundleVersion !== metadata.version || !digest(reuse.bundleSha256)
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
export async function gatewaySdkRuntime(packageDirectory = fileURLToPath(new URL("..", import.meta.url))): Promise<GatewaySdkRuntime | undefined> {
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
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || !metadata || metadata.schemaVersion !== 1 || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version) || metadata.codexVersion !== "0.162.0-alpha.17.2" ||
    metadata.revision !== gatewaySdkRevision || metadata.archiveSha256 !== archiveSha256 || metadata.patchSha256 !== gatewaySdkPatchSha256 ||
    metadata.lockfileSha256 !== lockfileSha256 || metadata.lockfileRepairSha256 !== lockfileRepairSha256 ||
    metadata.profile !== "release" || metadata.platform !== process.platform || metadata.arch !== process.arch ||
    typeof metadata.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sourceSha256) ||
    typeof metadata.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.binarySha256) ||
    !Array.isArray(metadata.capabilities) || metadata.capabilities.length !== 1 || metadata.capabilities[0] !== "selected-model-compaction-v1") throw invalid();
  const binarySha256 = metadata.version === version
    ? (await componentHash(executable, 512 * 1024 * 1024, true)).sha256
    : await reusedBinaryHash(packageDirectory, directory, version, metadata, receiptBytes).catch(() => { throw invalid(); });
  if (binarySha256 !== metadata.binarySha256) throw invalid();
  return { executable, binarySha256: metadata.binarySha256, selectedModelCompaction: true };
}
