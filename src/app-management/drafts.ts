import { lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import type { ProviderConfig, ProviderKind } from "../config.js";
import { ensurePrivateDirectory, readSnapshot, readOwnedJson, writeOwnedJson, type ConfigSnapshot } from "./storage.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { ManagementError, throwIfCancelled } from "./errors.js";
import { validateManagementConfig } from "./runtime.js";
import { isApiKind, managedCredentialFile } from "./providers.js";
import type { CatalogEntry, DraftRecord, ManagementDependencies, ManagedDraft, ProviderInput } from "./types.js";
import { managedProvider } from "./providers.js";

const draftId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerId = /^[a-z][a-z0-9_-]*$/;
const allowedKinds = new Set<ProviderKind>(["claude-subscription", "codex-subscription", "copilot-subscription", "responses-api", "anthropic-api", "chat-completions-api"]);

export function checkedConfigPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || !value.endsWith(".json")) throw new ManagementError("unsafe_path");
  return resolve(value);
}
export function checkedDraftId(value: unknown): string {
  if (typeof value !== "string" || !draftId.test(value)) throw new ManagementError("invalid_request");
  return value;
}
export function draftDirectory(configPath: string, id: string): string { return join(dirname(configPath), "app-drafts", checkedDraftId(id)); }
export function draftPath(configPath: string, id: string): string { return join(draftDirectory(configPath, id), "draft.json"); }

function gatewayState(configPath: string, snapshot?: ConfigSnapshot): string {
  return snapshot?.config.stateDirectory || resolve(dirname(configPath), "state");
}
function nativeAuthRoot(path: string): boolean {
  const home = resolve(homedir()); const roots = [".codex", ".claude", ".copilot", ".config/gh"].map(name => resolve(home, name));
  return roots.some(root => path === root || path.startsWith(`${root}/`));
}
/** Connection credentials are gateway-owned only beneath the configured gateway state. */
export async function isManagedCredential(stateDirectory: string, credentialFile: string): Promise<boolean> {
  return managedCredentialFile(stateDirectory, credentialFile);
}

export async function loadDraft(configPath: string, id: string): Promise<DraftRecord> {
  const path = draftPath(configPath, id); let draft: DraftRecord;
  try { draft = await readOwnedJson<DraftRecord>(path); } catch { throw new ManagementError("not_found"); }
  if (!draft || draft.version !== 1 || draft.id !== id || draft.configPath !== configPath) throw new ManagementError("not_found");
  return draft;
}

export async function saveDraft(draft: DraftRecord, signal?: AbortSignal): Promise<void> { await writeOwnedJson(draftPath(draft.configPath, draft.id), draft, false, signal); }

function safeLabel(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 96 || /[\p{C}]/u.test(value)) throw new ManagementError("invalid_provider");
  return value.trim();
}
function safeBaseUrl(value: unknown, api: boolean): string | undefined {
  if (!api) { if (value !== undefined) throw new ManagementError("invalid_provider"); return undefined; }
  if (typeof value !== "string" || value.length > 2048) throw new ManagementError("invalid_provider");
  let url: URL; try { url = new URL(value); } catch { throw new ManagementError("invalid_provider"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) throw new ManagementError("invalid_provider");
  return url.toString().replace(/\/$/, "");
}
function generatedId(label: string, used: Set<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "provider-").slice(0, 48) || "provider";
  let id = base; let number = 2; while (used.has(id)) id = `${base}-${number++}`; return id;
}

export async function prepareDraft(configPath: string, input: ProviderInput, deps: ManagementDependencies): Promise<{ draft: DraftRecord; snapshot?: ConfigSnapshot }> {
  throwIfCancelled(deps.signal);
  if (!input || typeof input !== "object" || !allowedKinds.has(input.type)) throw new ManagementError("invalid_provider");
  const snapshot = await readSnapshot(configPath);
  if (snapshot?.config.clientOnly) throw new ManagementError("invalid_configuration");
  const label = safeLabel(input.label); const used = new Set<string>(snapshot?.config.providers.map(provider => provider.id) || []);
  const id = input.id === undefined ? generatedId(label, used) : input.id;
  if (typeof id !== "string" || !providerId.test(id) || used.has(id)) throw new ManagementError("invalid_provider");
  const api = isApiKind(input.type); const baseUrl = safeBaseUrl(input.baseUrl, api);
  if (input.useExistingLogin !== undefined && (typeof input.useExistingLogin !== "boolean" || api || input.type === "codex-subscription")) throw new ManagementError("invalid_provider");
  if (input.accountEmail !== undefined && (typeof input.accountEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.accountEmail))) throw new ManagementError("invalid_provider");
  if (input.apiKey !== undefined && (!api || typeof input.apiKey !== "string" || !input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw new ManagementError("invalid_provider");
  if (api && !input.apiKey && !isLoopback(baseUrl!)) throw new ManagementError("invalid_provider");
  const idValue = randomUUID(); const state = gatewayState(configPath, snapshot);
  if (nativeAuthRoot(state)) throw new ManagementError("unsafe_path");
  const directory = join(state, "connections", idValue); throwIfCancelled(deps.signal); await ensurePrivateDirectory(directory);
  const provider = { id, label, type: input.type, models: {}, ...(baseUrl ? { baseUrl } : {}), ...(input.useExistingLogin ? { useExistingLogin: true } : {}) } as ProviderConfig;
  if (input.type === "codex-subscription") provider.credentialFile = join(directory, "credentials.json");
  if ((input.type === "claude-subscription" || input.type === "copilot-subscription") && !input.useExistingLogin) provider.authDirectory = join(directory, "auth");
  if (api) { provider.credentialFile = join(directory, "api-key"); await writeCredential(provider.credentialFile, input.apiKey || "unused-local-credential", false, deps.signal); }
  const draft: DraftRecord = { version: 1, id: idValue, configPath, ...(snapshot ? { revision: snapshot.revision } : {}), isNewConfiguration: !snapshot, provider,
    ...(input.accountEmail ? { accountEmail: input.accountEmail.trim().toLowerCase() } : {}) };
  throwIfCancelled(deps.signal); await ensurePrivateDirectory(dirname(draftDirectory(configPath, idValue)));
  await writeOwnedJson(draftPath(configPath, idValue), draft, true, deps.signal); return { draft, snapshot };
}

export async function draftView(draft: DraftRecord, deps: ManagementDependencies): Promise<ManagedDraft> {
  return { id: draft.id, provider: await managedProvider(draft.provider, deps.lookupCli, draft.catalog || [], true), ...(draft.revision ? { revision: draft.revision } : {}), configPath: draft.configPath, isNewConfiguration: draft.isNewConfiguration };
}

export async function writeCredential(path: string, value: string, replace: boolean, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  await ensurePrivateDirectory(dirname(path));
  await withPrivateFileLock(path, async () => {
    throwIfCancelled(signal);
    const existing = await lstat(path).catch(error => (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : Promise.reject(error));
    if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== process.getuid?.() || (existing.mode & 0o777) !== 0o600)) throw new ManagementError("unsafe_path");
    if (replace && !existing) throw new ManagementError("external_credential");
    if (!replace) {
      throwIfCancelled(signal);
      const file = await open(path, "wx", 0o600); try { await file.writeFile(`${value}\n`); await file.sync(); } finally { await file.close(); } return;
    }
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`; const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(`${value}\n`); await file.sync(); } finally { await file.close(); }
    throwIfCancelled(signal);
    try { await rename(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
  });
}

export function isLoopback(baseUrl: string): boolean { try { return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(baseUrl).hostname); } catch { return false; } }
export function catalogEntry(id: string, label = id, metadata?: Record<string, unknown>): CatalogEntry {
  const safeLabel = typeof label === "string" && label.length <= 256 && !/[\p{C}]/u.test(label) ? label : id;
  return { id, label: safeLabel, ...(metadata && Object.keys(metadata).length ? { metadata } : {}) };
}

/** Config validation is deliberately called before a raw object can be published. */
export async function validateRaw(raw: Record<string, unknown>, configPath: string): Promise<void> {
  await validateManagementConfig(structuredClone(raw), dirname(configPath));
}
