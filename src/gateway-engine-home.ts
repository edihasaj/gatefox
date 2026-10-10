import { mkdir, readlink, symlink, lstat, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Message } from "./app-server-connection.js";

function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.filter(entry => entry !== null).map(toml).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(", ")} }`;
  throw new Error("Native settings contain an unsupported value");
}

/** Share chat storage; isolate every automatic config write and all provider auth. */
export async function gatewayEngineHome(state: string, settings: Message): Promise<string> {
  const nativeHome = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const home = resolve(state, "desktop-engine");
  if (home === nativeHome) throw new Error("The gateway executor home must be separate from native Codex");
  await mkdir(home, { recursive: true, mode: 0o700 });
  for (const name of ["sessions", "archived_sessions"]) {
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
  // Keep one source of user instructions and installed skills. Never link auth or config.
  for (const name of ["AGENTS.md", "skills", "plugins"]) {
    const target = join(nativeHome, name); const path = join(home, name);
    try { await lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    try {
      if (!(await lstat(path)).isSymbolicLink() || resolve(home, await readlink(path)) !== target) throw new Error("Gateway instructions point to a different native home");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await symlink(target, path); }
  }
  const excluded = new Set(["model_providers", "forced_login_method", "forced_chatgpt_workspace_id", "openai_api_key", "model_provider", "model_catalog_json"]);
  const copied = Object.fromEntries(Object.entries(settings).filter(([key, value]) => !excluded.has(key) && value !== null && value !== undefined));
  copied.sqlite_home = typeof settings.sqlite_home === "string" ? settings.sqlite_home : nativeHome;
  const content = Object.entries(copied).map(([key, value]) => `${JSON.stringify(key)} = ${toml(value)}\n`).join("");
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Native settings snapshot exceeds 1 MiB");
  const path = join(home, "config.toml"); const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(temporary, path);
  return home;
}

export function gatewayEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: home };
  // Inference must use the gateway helper, never an inherited platform credential.
  for (const key of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[key];
  return env;
}
