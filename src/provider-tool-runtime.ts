import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { providerToolContract } from "./provider-tool-contract.js";

export type ProviderTool = "claude" | "copilot";
export { providerToolContract };
export const providerToolsRoot = (): string => join(homedir(), ".local/share/harness-gateway/provider-tools", providerToolContract);
const invalid = () => Error("Verified provider tool is unavailable or changed; rerun provider maintenance before starting a new session");
const owned = (uid: number): boolean => !process.getuid || uid === process.getuid();
const hashPattern = /^[a-f0-9]{64}$/;
const cache = new Map<string, { fingerprint: string; sha256: string }>();

async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o077)) throw invalid();
}

/** Hash all executable dependencies; repeated launches reuse a hash only while every entry's identity and timestamps agree. */
export async function providerToolTree(directory: string): Promise<string> {
  const root = await realpath(directory);
  const entries: { key: string; path: string; link?: string; size: bigint; stamp: string }[] = [];
  const visit = async (path: string, key = ""): Promise<void> => {
    const info = await lstat(path, { bigint: true });
    if (!owned(Number(info.uid)) || (!info.isSymbolicLink() && (Number(info.mode) & 0o022))) throw invalid();
    const stamp = `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    if (info.isSymbolicLink()) {
      const target = await readlink(path); const actual = await realpath(path);
      if (isAbsolute(target) || relative(root, actual).startsWith("..")) throw invalid();
      entries.push({ key, path, link: target, size: info.size, stamp });
    } else if (info.isDirectory()) {
      entries.push({ key: `${key}/`, path, size: 0n, stamp });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), key ? `${key}/${name}` : name);
    } else if (info.isFile()) entries.push({ key, path, size: info.size, stamp });
    else throw invalid();
  };
  await visit(root);
  const fingerprint = createHash("sha256").update(JSON.stringify(entries.map(({ key, link, stamp }) => [key, link, stamp]))).digest("hex");
  const previous = cache.get(root); if (previous?.fingerprint === fingerprint) return previous.sha256;
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.key).update("\0");
    if (entry.link !== undefined) hash.update("link\0").update(entry.link);
    else if (!entry.key.endsWith("/")) {
      const file = await open(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk); }
      finally { await file.close(); }
    }
    hash.update("\0");
  }
  const sha256 = hash.digest("hex");
  if (cache.size > 8) cache.clear();
  cache.set(root, { fingerprint, sha256 }); return sha256;
}

/** Resolve only a new process. A running live session keeps its original executable and immutable installation. */
export async function providerCommand(kind: ProviderTool, root = providerToolsRoot()): Promise<string> {
  return (await providerTool(kind, root)).command;
}

/** The command and, for a verified managed installation, its exact version; a CLI from PATH has no known version. */
export async function providerTool(kind: ProviderTool, root = providerToolsRoot()): Promise<{ command: string; version?: string }> {
  try {
    const current = join(root, "current.json");
    const info = await lstat(current).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return { command: kind };
    await privateDirectory(root); root = await realpath(root); await privateDirectory(join(root, "installs"));
    if (!info.isFile() || info.isSymbolicLink() || !owned(info.uid) || (info.mode & 0o077) || info.size > 16_384) throw invalid();
    const manifest = JSON.parse(await readFile(current, "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.contract !== providerToolContract || !manifest.providers || typeof manifest.providers !== "object") throw invalid();
    const tool = manifest.providers[kind];
    if (tool === undefined) return { command: kind };
    if (!/^\d+\.\d+\.\d+$/.test(tool.version) || !hashPattern.test(tool.treeSha256) ||
        typeof tool.installation !== "string" || !new RegExp(`^${kind}-[0-9.]+-[a-f0-9]{64}(?:-[a-f0-9-]{36})?$`).test(tool.installation) ||
        typeof tool.executable !== "string" || isAbsolute(tool.executable) || tool.executable.split(/[\\/]/).some((part: string) => part === "..")) throw invalid();
    const installation = join(root, "installs", tool.installation); await privateDirectory(installation);
    const modules = join(installation, "node_modules"); const path = resolve(installation, tool.executable);
    if (!path.startsWith(`${modules}/`) || await realpath(dirname(path)) !== dirname(path)) throw invalid();
    const binary = await lstat(path);
    if (!binary.isFile() || binary.isSymbolicLink() || !(binary.mode & 0o100)) throw invalid();
    if (await providerToolTree(modules) !== tool.treeSha256) throw invalid();
    return { command: path, version: tool.version };
  } catch { throw invalid(); }
}
