import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readlink, realpath, rename, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Message } from "./app-server-connection.js";
import { normalizeCodexFeatureConfig } from "./codex-feature-compat.js";
import { gatewayEnvironment } from "./gateway-engine-home.js";

/** One private CODEX_HOME per named account. Login, status and engines all go through these checks. */
export const accountIdPattern = /^[a-z][a-z0-9_-]{0,31}$/;
export function assertAccountId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !accountIdPattern.test(id)) throw new Error("Account names must be 1 to 32 lowercase letters, digits, _ or -, starting with a letter");
}
export function accountDirectory(state: string, id: string): string { assertAccountId(id); return resolve(state, "accounts", id); }
export const accountHomePath = (state: string, id: string): string => join(accountDirectory(state, id), "home");
export const defaultNativeHome = (): string => resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));

// Native settings that select a provider, model, login or credential store never reach an account home.
const excluded = new Set(["desktop", "model", "model_provider", "model_providers", "model_catalog_json", "model_reasoning_effort", "model_reasoning_summary",
  "service_tier", "openai_api_key", "forced_login_method", "forced_chatgpt_workspace_id", "cli_auth_credentials_store", "sqlite_home", "profile"]);
const neverLinked = ["auth.json", "config.toml", "models_cache.json", "memories"];
// Inherited variables that inject or redirect credentials. Values are never read or logged.
const credentialVariables = ["CODEX_ACCESS_TOKEN", "CODEX_AUTH", "CODEX_AUTHAPI_BASE_URL", "CODEX_AGENT_IDENTITY_AUTHAPI_BASE_URL", "CODEX_AGENT_IDENTITY_JWKS_BASE_URL",
  "CODEX_REFRESH_TOKEN_URL_OVERRIDE", "CODEX_REVOKE_TOKEN_URL_OVERRIDE", "CODEX_APP_SERVER_LOGIN_CLIENT_ID", "CODEX_SQLITE_HOME"];

/** Keys pinned in every account home and passed again as -c on every spawn. */
export function accountPinned(workspaceId?: string): Record<string, string> {
  if (workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceId)) throw new Error("workspaceId must be 1 to 128 letters, digits, _ or -");
  return { cli_auth_credentials_store: "file", forced_login_method: "chatgpt", ...(workspaceId ? { forced_chatgpt_workspace_id: workspaceId } : {}) };
}
export const accountPinnedArgs = (workspaceId?: string): string[] => Object.entries(accountPinned(workspaceId)).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]);

/** gatewayEnvironment plus remote control off; credential variables never reach an account engine. */
export function accountEnvironment(home: string): NodeJS.ProcessEnv {
  const env = gatewayEnvironment(home);
  for (const key of Object.keys(env)) if (key.startsWith("OPENAI_") || credentialVariables.includes(key)) delete env[key];
  env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED = "1";
  return env;
}

const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
async function canonical(path: string): Promise<string> { try { return await realpath(path); } catch (error) { if (missing(error)) return resolve(path); throw error; } }

async function privateDirectory(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const info = await lstat(path).catch(error => { if (!create && missing(error)) return undefined; throw error; });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Account storage must be private directories owned by this user, without links");
  return true;
}

/** Refuse a home that is linked, shares the native home, or links auth, config, model cache or memories. */
async function checkHome(home: string, nativeHome: string): Promise<void> {
  if (await realpath(home) !== home) throw new Error("The account home path contains a symbolic link; use a state directory without links");
  for (const native of new Set([resolve(nativeHome), join(homedir(), ".codex")])) {
    const real = await canonical(native);
    if (within(home, real) || within(real, home) || within(home, resolve(native)) || within(resolve(native), home)) throw new Error("The account home must be separate from the native Codex home");
  }
  for (const name of neverLinked) {
    const info = await lstat(join(home, name)).catch(error => { if (missing(error)) return undefined; throw error; });
    if (info?.isSymbolicLink()) throw new Error(`The account home must not link ${name}; remove that link`);
  }
}

/** Creates or verifies <state>/accounts/<id>/home (0700, real, separate). Writes nothing else. */
export async function ensureAccountHome(state: string, id: string, nativeHome = defaultNativeHome()): Promise<string> {
  const directory = accountDirectory(state, id); const home = join(directory, "home");
  await mkdir(state, { recursive: true, mode: 0o700 });
  for (const path of [resolve(state, "accounts"), directory, home]) await privateDirectory(path, true);
  await checkHome(home, nativeHome);
  return home;
}

/** The account directory (lease and identity) without creating anything. */
export async function ensureAccountDirectory(state: string, id: string): Promise<string> {
  const directory = accountDirectory(state, id);
  await mkdir(state, { recursive: true, mode: 0o700 });
  for (const path of [resolve(state, "accounts"), directory]) await privateDirectory(path, true);
  return directory;
}

export interface AccountHomeReport { home: string; exists: boolean; problem?: string; authPresent: boolean }
/** Read-only inspection for status and doctor: never creates, links or spawns. auth.json is checked by type only. */
export async function inspectAccountHome(state: string, id: string, nativeHome = defaultNativeHome()): Promise<AccountHomeReport> {
  const home = accountHomePath(state, id);
  try {
    for (const path of [resolve(state, "accounts"), accountDirectory(state, id), home]) if (!await privateDirectory(path, false)) return { home, exists: false, authPresent: false };
    await checkHome(home, nativeHome);
    const auth = await lstat(join(home, "auth.json")).catch(error => { if (missing(error)) return undefined; throw error; });
    return { home, exists: true, authPresent: !!auth?.isFile() };
  } catch (error) { return { home, exists: true, problem: error instanceof Error ? error.message : "Account home is invalid", authPresent: false }; }
}

function toml(value: unknown): string {
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return `[${value.filter(entry => entry !== null).map(toml).join(", ")}]`;
  if (value && typeof value === "object") return `{ ${Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(", ")} }`;
  throw new Error("Native settings contain an unsupported value");
}
const lines = (values: Record<string, unknown>): string => Object.entries(values).map(([key, value]) => `${JSON.stringify(key)} = ${toml(value)}\n`).join("");

async function writeConfig(home: string, content: string): Promise<void> {
  if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Account settings snapshot exceeds 1 MiB");
  const path = join(home, "config.toml"); const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

/** Before and during login: the pinned keys only, so nothing points at native state before the identity is verified. */
export async function writeLoginConfig(home: string, workspaceId?: string): Promise<void> { await writeConfig(home, lines(accountPinned(workspaceId))); }

async function linkShared(home: string, target: string, name: string): Promise<void> {
  const path = join(home, name);
  const info = await lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
  if (!info) { await symlink(target, path); return; }
  if (!info.isSymbolicLink() || resolve(home, await readlink(path)) !== target) throw new Error("Account storage points to a different native home; use a separate state directory");
}

/** Engine home: shared chat storage and instructions, a native settings snapshot, then the pinned keys. */
export async function prepareAccountHome(state: string, id: string, settings: Message, nativeHome = defaultNativeHome(), workspaceId?: string): Promise<string> {
  const pinned = accountPinned(workspaceId); const home = await ensureAccountHome(state, id, nativeHome); const native = resolve(nativeHome);
  for (const name of ["sessions", "archived_sessions", "thread-writer-locks"]) { await mkdir(join(native, name), { recursive: true, mode: 0o700 }); await linkShared(home, join(native, name), name); }
  for (const name of ["AGENTS.md", "agents", "skills", "plugins"]) {
    // AGENTS.md is linked even before it exists, so a file created later is still followed.
    if (name !== "AGENTS.md" && !await lstat(join(native, name)).then(() => true, error => { if (missing(error)) return false; throw error; })) continue;
    await linkShared(home, join(native, name), name);
  }
  const copied: Record<string, unknown> = Object.fromEntries(Object.entries(normalizeCodexFeatureConfig(settings)).filter(([key, value]) => !excluded.has(key) && value !== null && value !== undefined));
  const features = copied.features;
  if (features !== undefined && (!features || typeof features !== "object" || Array.isArray(features))) throw new Error("Native feature settings are invalid");
  // Account engines share the native state DB, so a memory job must never run under this account.
  copied.features = { ...(features as Record<string, unknown> | undefined), memories: false };
  copied.sqlite_home = typeof settings.sqlite_home === "string" ? settings.sqlite_home : native;
  await writeConfig(home, lines(copied) + lines(pinned));
  return home;
}
