import { mkdir, readlink, symlink, lstat, open, rename, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Message } from "./app-server-connection.js";
import { normalizeCodexFeatureConfig } from "./codex-feature-compat.js";
import { testSafeRoot } from "./test-root-guard.js";
import { trimGatewayFeatureConfig, trimmedGatewayFeatures } from "./gateway-feature-schema.js";
import { gatewayExecutorMarker } from "./executor-identity.js";
import { keyText, parseKey } from "./gateway-feature-toml.js";

function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.filter(entry => entry !== null).map(toml).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined).map(([key, entry]) => `${keyText(key)} = ${toml(entry)}`).join(", ")} }`;
  throw new Error("Native settings contain an unsupported value");
}

/**
 * Drop the earlier of two root-level assignments to the same key. Tools such as the Computer Use installer look for a
 * bare `notify =` line and append one when they miss a quoted `"notify" =`, which leaves the engine unable to load its
 * config. The later line is the newer intent. Only single-line root assignments before the first table are considered.
 */
export function dropDuplicateRootKeys(text: string): string {
  const lines = text.split("\n"); const seen = new Map<string, number>(); const drop = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) break;
    if (/^\s/.test(line)) continue;
    const path = parseKey(line, true); if (!path) continue;
    const id = JSON.stringify(path.segments);
    const earlier = seen.get(id);
    if (earlier !== undefined && singleLine(lines[earlier])) drop.add(earlier);
    seen.set(id, index);
  }
  return drop.size ? lines.filter((_, index) => !drop.has(index)).join("\n") : text;
}

/** A value that opens and closes on its own line; strings are skipped so brackets inside them do not count. */
function singleLine(line: string): boolean {
  const value = line.slice(line.indexOf("=") + 1).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "\"\"");
  if (/"""|'''/.test(line)) return false;
  let depth = 0;
  for (const char of value) { if (char === "[" || char === "{") depth++; else if (char === "]" || char === "}") depth--; }
  return depth === 0;
}

export interface GatewayHomeOptions { nativeHome?: string; sharedWriterLocks?: boolean; preserveConfig?: boolean }

/** Share chat storage; isolate every automatic config write and all provider auth. */
export async function gatewayEngineHome(state: string, settings: Message, options: GatewayHomeOptions = {}): Promise<string> {
  // A test that linked the real native home would write its fixture chats into the real `sessions` folder.
  const nativeHome = testSafeRoot(resolve(options.nativeHome || process.env.CODEX_HOME || join(homedir(), ".codex")), "native Codex home");
  const home = resolve(state, "desktop-engine");
  if (home === nativeHome) throw new Error("The gateway executor home must be separate from native Codex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const name of ["sessions", "archived_sessions", ...(options.sharedWriterLocks ? ["thread-writer-locks"] : [])]) {
    const target = join(nativeHome, name); const path = join(home, name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(path);
      if (!info.isSymbolicLink() || resolve(home, await readlink(path)) !== target) throw new Error("Gateway chat storage points to a different native home; use a separate gateway state directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await symlink(target, path, "dir");
    }
  }
  // Keep client instructions, roles, and installed skills at their original source.
  // Never link authentication or configuration.
  // Hooks and saved prompts are client configuration too, so gateway chats run the same hooks.
  for (const name of ["AGENTS.md", "agents", "skills", "plugins", "hooks.json", "prompts"]) {
    const target = join(nativeHome, name); const path = join(home, name);
    if (name !== "AGENTS.md") try { await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    try {
      if (!(await lstat(path)).isSymbolicLink() || resolve(home, await readlink(path)) !== target) throw new Error("Gateway instructions point to a different native home");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await symlink(target, path); }
  }
  const excluded = new Set(["model_providers", "forced_login_method", "forced_chatgpt_workspace_id", "openai_api_key", "model_provider", "model_catalog_json"]);
  const copied = Object.fromEntries(Object.entries(trimmedGatewayFeatures("home", stats => trimGatewayFeatureConfig(normalizeCodexFeatureConfig(settings), stats))).filter(([key, value]) => !excluded.has(key) && value !== null && value !== undefined));
  copied.sqlite_home = typeof settings.sqlite_home === "string" ? settings.sqlite_home : nativeHome;
  // Bare keys where TOML allows them, so tools that edit config.toml by line recognise the keys the gateway already set.
  const content = Object.entries(copied).map(([key, value]) => `${keyText(key)} = ${toml(value)}\n`).join("");
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Native settings snapshot exceeds 1 MiB");
  const path = join(home, "config.toml"); const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  if (options.preserveConfig) {
    const existing = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; });
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== process.getuid?.() || (existing.mode & 0o077) || existing.size > 1024 * 1024) throw new Error("Gateway configuration snapshot is not a private owned file");
      const saved = await readFile(path, "utf8"); const repaired = dropDuplicateRootKeys(saved);
      if (repaired !== saved) {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(repaired); await file.sync(); } finally { await file.close(); }
        await rename(temporary, path);
      }
      return home;
    }
  }
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  return home;
}

export function gatewayEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  // Inference must use the gateway helper, never an inherited platform credential.
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
  // Gateway engines run headless on the gateway's pinned SDK, so remote control has nothing to pair with.
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  // The gateway SDK serves `openai` as the gateway's own loopback provider only in a process marked as a gateway executor.
  env[gatewayExecutorMarker] = "1";
  return env;
}
