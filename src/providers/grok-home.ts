import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "./provider.js";

/**
 * The gateway owns a private Grok home (GROK_HOME). Its config.toml keeps the CLI an inference
 * backend: no personal skills, rules, hooks or MCP servers, no memory, no telemetry, no xAI-side
 * tools, no auto-update, and exactly one MCP server, the gateway's caller-tool catalog. The server
 * command is resolved from environment variables the gateway sets per request, so one config works
 * across gateway releases and concurrent requests with different catalogs.
 */
const marker = "# Managed by Harness Gateway: inference backend only. Sections below are rewritten.";
export const grokManagedConfig = `${marker}
[cli]
auto_update = false

[features]
telemetry = "off"
backend_tools = false
session_search = false

[memory]
enabled = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false

[compat.codex]
sessions = false

[mcp_servers.gateway]
command = "/bin/sh"
args = ["-c", "exec \\"$GATEWAY_GROK_NODE\\" \\"$GATEWAY_GROK_TOOLS\\""]
startup_timeout_sec = 30
`;
const managedRoots = ["cli", "features", "memory", "compat", "mcp_servers"];
const managed = (section: string) => managedRoots.some(root => section === root || section.startsWith(`${root}.`));

/** Keeps every section the CLI wrote itself (marketplace, UI, ...) and replaces the managed ones. */
export function mergeGrokConfig(existing: string): string {
  const kept: string[] = []; let skip = false;
  for (const line of existing.split("\n")) {
    const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) skip = managed(header[1]);
    if (!skip && line !== marker) kept.push(line);
  }
  const rest = kept.join("\n").trim();
  return rest ? `${rest}\n\n${grokManagedConfig}` : grokManagedConfig;
}

/** Creates or repairs the private home; writes config.toml atomically and only when it changed. */
export async function ensureGrokHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) {
    throw new ProviderError("invalid_request", "The gateway's Grok home must be a private directory owned by this user", 400);
  }
  if (info.mode & 0o077) await chmod(home, 0o700);
  const path = join(home, "config.toml");
  const existing = await readFile(path, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; });
  const merged = mergeGrokConfig(existing);
  if (merged !== existing) {
    const temporary = join(home, `.config.toml.${randomBytes(6).toString("hex")}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(merged); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  }
  try { await access(join(home, "auth.json")); }
  catch {
    throw new ProviderError("authentication", "Grok is not signed in for the gateway. Run `grok login --device-auth` with GROK_HOME set to the gateway's Grok home.", 401,
      { code: "authentication_failed", event: "grok.result" });
  }
}
