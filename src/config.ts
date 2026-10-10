import { constants } from "node:fs";
import { readFile, mkdir, open, rename, chmod, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type ProviderKind = "claude-subscription" | "codex-subscription" | "responses-api" | "anthropic-api";
export interface ProviderConfig {
  id: string;
  type: ProviderKind;
  models: Record<string, string>;
  baseUrl?: string;
  apiKeyEnv?: string;
  credentialFile?: string;
  agentName?: string;
  authDirectory?: string;
  label?: string;
  modelMetadata?: Record<string, ModelMetadata>;
}
export interface ModelMetadata {
  displayName?: string;
  contextWindow?: number;
  reasoningEfforts?: string[];
  priority?: number;
}
export interface GatewayConfig {
  version: 1;
  port: number;
  stateDirectory: string;
  providers: ProviderConfig[];
  maxConcurrent?: number;
  timeoutMs?: number;
}

export function validateConfig(value: unknown, directory = process.cwd()): GatewayConfig {
  if (!value || typeof value !== "object") throw new Error("Configuration must be an object");
  const config = value as GatewayConfig;
  if (config.version !== 1) throw new Error("Unsupported configuration version; expected 1");
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("port must be 0 through 65535");
  if (!Array.isArray(config.providers) || !config.providers.length) throw new Error("At least one provider is required");
  if (config.maxConcurrent !== undefined && (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 16)) throw new Error("maxConcurrent must be 1 through 16");
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600000)) throw new Error("timeoutMs must be 1000 through 600000");
  const ids = new Set<string>(); const aliases = new Set<string>();
  const providers = config.providers.map(provider => {
    if (!provider || !/^[a-z][a-z0-9_-]*$/.test(provider.id)) throw new Error("Provider IDs must use lowercase letters, digits, _ or -");
    if (ids.has(provider.id)) throw new Error(`Duplicate provider ID: ${provider.id}`);
    ids.add(provider.id);
    if (!["claude-subscription", "codex-subscription", "responses-api", "anthropic-api"].includes(provider.type)) throw new Error(`Unsupported provider type: ${provider.type}`);
    if (!provider.models || typeof provider.models !== "object" || Array.isArray(provider.models) || !Object.keys(provider.models).length) throw new Error(`${provider.id}: models must be a non-empty alias map`);
    for (const [alias, model] of Object.entries(provider.models)) {
      if (!alias || typeof model !== "string" || !model) throw new Error(`${provider.id}: model aliases and IDs must be non-empty strings`);
      if (aliases.has(alias)) throw new Error(`Duplicate model alias: ${alias}`);
      aliases.add(alias);
    }
    for (const [alias, metadata] of Object.entries(provider.modelMetadata || {})) {
      if (!Object.hasOwn(provider.models, alias) || !metadata || typeof metadata !== "object") throw new Error("Model metadata must refer to a configured alias");
      if (metadata.contextWindow !== undefined && (!Number.isInteger(metadata.contextWindow) || metadata.contextWindow < 1024)) throw new Error("contextWindow must be at least 1024 tokens");
      if (metadata.reasoningEfforts?.some(effort => !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))) throw new Error("Unsupported reasoning effort in model metadata");
      if (metadata.priority !== undefined && !Number.isInteger(metadata.priority)) throw new Error("Model priority must be an integer");
    }
    if (provider.type === "responses-api" || provider.type === "anthropic-api") {
      if (!provider.baseUrl || !provider.apiKeyEnv || !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv)) throw new Error(`${provider.id}: baseUrl and apiKeyEnv are required`);
      const url = new URL(provider.baseUrl);
      if (url.username || url.password || url.search || url.hash) throw new Error("baseUrl must not contain credentials, a query, or a fragment");
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("API providers require HTTPS except on loopback");
    }
    if (provider.type === "codex-subscription" && !provider.credentialFile) throw new Error(`${provider.id}: credentialFile is required`);
    return { ...provider, models: { ...provider.models }, ...(provider.credentialFile ? { credentialFile: resolve(directory, provider.credentialFile) } : {}), ...(provider.authDirectory ? { authDirectory: resolve(directory, provider.authDirectory) } : {}) };
  });
  return { version: 1, port: config.port, stateDirectory: resolve(directory, config.stateDirectory || ".state"), providers,
    maxConcurrent: config.maxConcurrent || 4, timeoutMs: config.timeoutMs || 120000 };
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Configuration file is unreadable or invalid JSON"); }
  return validateConfig(parsed, dirname(resolve(path)));
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path); await chmod(path, 0o600);
}

export async function readClientToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error("Client token must be a private file owned by this user");
    const token = (await file.readFile("utf8")).trim();
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid gateway client token");
    return token;
  } finally { await file.close(); }
}


export async function gatewayToken(stateDirectory: string): Promise<string> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const path = resolve(stateDirectory, "client-token");
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(randomBytes(32).toString("base64url") + "\n"); await file.sync(); }
    finally { await file.close(); }
    try { await link(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
  return readClientToken(path);
}

export function validBearer(header: string | undefined, token: string): boolean {
  const supplied = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
