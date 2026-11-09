import { randomBytes } from "node:crypto";
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { ProviderError } from "./provider.js";

async function executable(path: string): Promise<boolean> { try { await access(path, constants.X_OK); return true; } catch { return false; } }
/** PATH first, then the Grok Build installer's location, which a launchd PATH usually lacks. */
export async function grokCommand(): Promise<string> {
  for (const directory of (process.env.PATH || "").split(delimiter)) if (directory && await executable(join(directory, "grok"))) return join(directory, "grok");
  const fallback = join(homedir(), ".local/bin/grok");
  if (await executable(fallback)) return fallback;
  throw new ProviderError("cli_failed", "The Grok CLI is not installed; install Grok Build and sign in for the gateway", 502);
}

/**
 * The gateway owns a private Grok home (GROK_HOME). Its config.toml keeps the CLI an inference
 * backend: no personal skills, rules, hooks or MCP servers, no memory, no telemetry, no xAI-side
 * tools, no auto-update, and exactly one MCP server, the gateway's caller-tool catalog. The server
 * command is resolved from environment variables the gateway sets per request, so one config works
 * across gateway releases and concurrent requests with different catalogs.
 */
const marker = "# Managed by GateFox: inference backend only. Sections below are rewritten.";
/** The same line as written before 1.8.1; a merge drops it so the config never carries two markers. */
const legacyMarker = "# Managed by Harness Gateway: inference backend only. Sections below are rewritten.";
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
    if (!skip && line !== marker && line !== legacyMarker) kept.push(line);
  }
  const rest = kept.join("\n").trim();
  return rest ? `${rest}\n\n${grokManagedConfig}` : grokManagedConfig;
}

/**
 * Creates or repairs the private home; writes config.toml atomically and only when it changed.
 * `requireLogin: false` prepares a home for `grok login` itself, which runs before `auth.json` exists.
 */
export async function ensureGrokHome(home: string, options: { requireLogin?: boolean } = {}): Promise<void> {
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
  if (options.requireLogin === false) return;
  try { await access(join(home, "auth.json")); }
  catch {
    throw new ProviderError("authentication", "Grok is not signed in for the gateway. Run `grok login --device-auth` with GROK_HOME set to the gateway's Grok home.", 401,
      { code: "authentication_failed", event: "grok.result" });
  }
}

/** Whether the gateway's private home holds a Grok credential file. Presence only; the CLI validates it. */
export async function hasGrokLogin(home: string | undefined): Promise<boolean> {
  if (!home) return false;
  try { await access(join(home, "auth.json")); return true; } catch { return false; }
}

/**
 * The Grok CLI keeps its own login in `GROK_HOME/auth.json`. Sign-in uses the device-code flow
 * because it works without a browser round trip and can be read from a terminal or the desktop app.
 * The child writes the credential itself; the gateway only prepares the home and checks the result.
 */
export async function grokLoginEnvironment(home: string): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
  const command = await grokCommand();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("XAI_") || name.startsWith("GROK_")) delete env[name];
  // The CLI writes its profile beside the credential; the parent must already exist and be private.
  await ensureGrokHome(home, { requireLogin: false });
  return { command, args: ["login", "--device-auth"], env: { ...env, GROK_HOME: home, GROK_DISABLE_AUTOUPDATER: "1", GROK_TELEMETRY_ENABLED: "false" } };
}
