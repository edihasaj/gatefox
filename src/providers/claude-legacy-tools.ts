import { lstat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { retainRunningRelease } from "../release-retention.js";
import type { OpenAITool } from "../protocol/types.js";

export type ToolNamePin = (tools: OpenAITool[]) => void;
let previous: Promise<ToolNamePin | undefined> | undefined;
/** 2.0.3 used a module-private WeakSet. Its adopted legacy instances still need that exact marker function. */
export function previousClaudeToolPin(moduleUrl = import.meta.url): Promise<ToolNamePin | undefined> {
  if (moduleUrl !== import.meta.url) return load(moduleUrl);
  return previous ??= load(moduleUrl);
}
async function load(moduleUrl: string): Promise<ToolNamePin | undefined> {
  const releases = resolve(dirname(fileURLToPath(moduleUrl)), "../../../..");
  if (basename(releases) !== "releases") return;
  const pkg = resolve(releases, "2.0.3/package");
  const lease = retainRunningRelease(pathToFileURL(resolve(pkg, "dist/cli.js")).href);
  if (lease.releaseName !== "2.0.3") { lease.release(); return; }
  try {
    const path = resolve(pkg, "dist/providers/claude-tool-names.js"), info = await lstat(path), parent = await lstat(dirname(path));
    if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o022 ||
      !parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o022) throw Error("unsafe");
    const module = await import(pathToFileURL(path).href) as { keepLegacyClaudeToolNames?: ToolNamePin };
    if (typeof module.keepLegacyClaudeToolNames !== "function") throw Error("missing");
    return module.keepLegacyClaudeToolNames;
  } catch { return; }
  finally { lease.release(); }
}
