import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const gatewaySdkRevision = "740e5af33c71225640e0c1c1555c514c2c93ab74";
export const gatewaySdkPatchSha256 = "9b59500683b66fab9dd0ecc2384d3046fb2fe8d506278ac767c81bf1c6061f36";
const archiveSha256 = "25747823ea4ec852a146cbbe75d805b8df19190ca5b3fb21052d8e1cb75f2f83";
const lockfileSha256 = "49575eeb44a747925fd1acef51bff88316f728b77d7f63d989835c8623c344cb";
const lockfileRepairSha256 = "a810a345d59038b785e4be8cb3fc979ce3e49e28f3888aaebb8b689dce3ca2b8";
const invalid = () => new Error("Gateway executor artifact does not match this release. Reinstall the gateway before loading another gateway chat.");
export interface GatewaySdkRuntime { executable: string; binarySha256: string; selectedModelCompaction: true }

/** Only gateway executors use this artifact. Native authentication and SDK stay in their original home. */
export async function gatewaySdkRuntime(packageDirectory = fileURLToPath(new URL("..", import.meta.url))): Promise<GatewaySdkRuntime | undefined> {
  const directory = resolve(packageDirectory, "gateway-sdk");
  const present = await lstat(directory).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!present) return undefined;
  if (!present.isDirectory() || present.isSymbolicLink() || (present.mode & 0o022)) throw invalid();
  const receipt = resolve(directory, "build.json"); const executable = resolve(directory, "gateway-codex");
  const info = await lstat(receipt);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) || info.size > 16384) throw invalid();
  let metadata: Record<string, unknown>; let version: unknown;
  try {
    metadata = JSON.parse(await readFile(receipt, "utf8"));
    version = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")).version;
  } catch { throw invalid(); }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || !metadata || metadata.schemaVersion !== 1 || metadata.version !== version || metadata.codexVersion !== "0.162.0-alpha.17.2" ||
    metadata.revision !== gatewaySdkRevision || metadata.archiveSha256 !== archiveSha256 || metadata.patchSha256 !== gatewaySdkPatchSha256 ||
    metadata.lockfileSha256 !== lockfileSha256 || metadata.lockfileRepairSha256 !== lockfileRepairSha256 ||
    metadata.profile !== "release" || metadata.platform !== process.platform || metadata.arch !== process.arch ||
    typeof metadata.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sourceSha256) ||
    typeof metadata.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.binarySha256) ||
    !Array.isArray(metadata.capabilities) || metadata.capabilities.length !== 1 || metadata.capabilities[0] !== "selected-model-compaction-v1") throw invalid();
  const binary = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await binary.stat();
    if (!stat.isFile() || (stat.mode & 0o022) || !(stat.mode & 0o100)) throw invalid();
    const hash = createHash("sha256");
    for await (const buffer of binary.createReadStream({ autoClose: false })) hash.update(buffer);
    if (hash.digest("hex") !== metadata.binarySha256) throw invalid();
  } finally { await binary.close(); }
  return { executable, binarySha256: metadata.binarySha256, selectedModelCompaction: true };
}
