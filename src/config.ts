import { constants } from "node:fs";
import { readFile, mkdir, open, rename, chmod, link, unlink, utimes } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { totalmem } from "node:os";
import { readServiceTierMetadata, type ModelServiceTierMetadata } from "./model-service-tiers.js";

export type ProviderKind = "claude-subscription" | "codex-subscription" | "copilot-subscription" | "responses-api" | "anthropic-api" | "chat-completions-api" | "grok-subscription";
export interface ProviderConfig {
  id: string;
  type: ProviderKind;
  models: Record<string, string>;
  baseUrl?: string;
  /**
   * chat-completions-api only: allow a plain `http:` base URL when every address its host resolves to is a Tailscale address
   * (100.64.0.0/10 or fd7a:115c:a1e0::/48). The address is checked on each connection, before any byte is sent.
   */
  tailnet?: boolean;
  /**
   * chat-completions-api only: send the caller's thread ID (falling back to its session ID) as `session-id`, so a
   * self-hosted router that hashes by session keeps each conversation on the worker that holds its prefix cache.
   * Opt-in: the identifier never goes to a provider that has not asked for it.
   */
  sessionAffinity?: boolean;
  apiKeyEnv?: string;
  credentialFile?: string;
  agentName?: string;
  authDirectory?: string;
  /** Grok subscription only: the private Grok home the gateway signs in once (default <stateDirectory>/grok-home). */
  grokHome?: string;
  /**
   * Codex or Claude subscription only: the operator designates this account as the one that serves its vendor's bare model
   * names (a sub-agent's `gpt-5.6-terra` or `claude-opus-5-5`, and an unnamed reviewer). At most one provider per type may
   * set it true; `false` designates nothing. A bare name never falls back onto a non-designated account. This is an
   * operator-selected default, not an inherited parent account: the SDK sends no parent account with a sub-agent request.
   */
  defaultForBareModels?: boolean;
  /**
   * Codex subscription only: how a client-run `tool_search` travels upstream. `off` (the default) drops the tool and its
   * replayed items, because the ChatGPT backend refuses a forwarded `tool_search`; `bridge` sends the search as an ordinary
   * function tool inside the gateway namespace, which the client still executes. Capability metadata, so it applies live.
   */
  toolSearch?: "off" | "bridge";
  label?: string;
  /** Per-provider admission cap; falls back to top-level maxConcurrent, then 4. */
  maxConcurrent?: number;
  modelMetadata?: Record<string, ModelMetadata>;
  /** Claude subscription only: one-shot replay or a live CLI session per Codex thread. */
  claudeSessions?: ClaudeSessionConfig;
  /** Copilot subscription only: one-shot requests or a live CLI session per Codex thread. */
  copilotSessions?: CopilotSessionConfig;
}
export interface ClaudeSessionConfig { mode?: "replay" | "live"; max?: number; parkMinutes?: number; warmup?: number; replayFormat?: "text" | "json" }
export type ClaudeSessionSettings = Required<ClaudeSessionConfig>;
/** One parked live Claude session costs about 284 MB (CLI plus its MCP child); this leaves headroom. */
const sessionSlotBytes = 300 * 1024 * 1024;
/**
 * How many live sessions a machine can hold: a tenth of its RAM, one slot each, never below
 * the 6 that a busy laptop needs and never above the 32 where the cache stops paying for itself.
 */
export function claudeSessionMax(memoryBytes = totalmem()): number {
  return Math.min(32, Math.max(6, Math.floor((memoryBytes * 0.1) / sessionSlotBytes)));
}
export function claudeSessionSettings(provider: Pick<ProviderConfig, "claudeSessions">, memoryBytes = totalmem()): ClaudeSessionSettings {
  const value = provider.claudeSessions || {};
  return { mode: value.mode ?? "replay", max: value.max ?? claudeSessionMax(memoryBytes), parkMinutes: value.parkMinutes ?? 60, warmup: value.warmup ?? 1, replayFormat: value.replayFormat ?? "text" };
}
/** `live` is the default; `replay` is accepted as another name for `oneshot`, matching claudeSessions. */
export interface CopilotSessionConfig { mode?: "oneshot" | "replay" | "live"; max?: number; parkMinutes?: number; toolWaitMinutes?: number }
export interface CopilotSessionSettings { mode: "oneshot" | "live"; max: number; parkMinutes: number; toolWaitMinutes: number }
export function copilotSessionSettings(provider: Pick<ProviderConfig, "copilotSessions">): CopilotSessionSettings {
  const value = provider.copilotSessions || {};
  return { mode: value.mode === "oneshot" || value.mode === "replay" ? "oneshot" : "live", max: value.max ?? 4, parkMinutes: value.parkMinutes ?? 30, toolWaitMinutes: value.toolWaitMinutes ?? 25 };
}
/** Whether a provider bridges the client's `tool_search` instead of dropping it; `off` and any other value stay today's drop. */
export const bridgesToolSearch = (provider: Pick<ProviderConfig, "type" | "toolSearch">): boolean =>
  provider.type === "codex-subscription" && provider.toolSearch === "bridge";

export interface ModelMetadata extends ModelServiceTierMetadata {
  inputModalities?: Array<"text" | "image">;
  displayName?: string;
  contextWindow?: number;
  reasoningEfforts?: string[];
  /** The provider's own default effort; the catalog row uses it when the model supports it. */
  defaultReasoningEffort?: string;
  priority?: number;
  /** Codex delegation protocol and delegated-agent effort, as the model catalog reports them. */
  multiAgentVersion?: string;
  multiAgentReasoningEffort?: string;
  /** Responses lite: tools travel in input items and reasoning spans all turns. */
  useResponsesLite?: boolean;
  supportsReasoningEffortUpdates?: boolean;
  /** Codex catalog parity: tool-output truncation, usable window share and compaction limits. */
  truncationPolicy?: { mode: "tokens" | "bytes"; limit: number };
  effectiveContextWindowPercent?: number;
  autoCompactTokenLimit?: number;
  maxContextWindow?: number;
  /**
   * Operator ceiling for this alias's window. Discovery and the periodic refresh may report a larger server limit
   * (vLLM's max_model_len); the saved and advertised contextWindow and maxContextWindow never exceed this value.
   */
  contextWindowCap?: number;
}
/** A second Codex account served by its own signed engine; an ID may equal a codex-subscription provider ID. */
export interface AccountEngineConfig { id: string; label?: string; workspaceId?: string }
export interface GatewayConfig {
  version: 1;
  port: number;
  stateDirectory: string;
  providers: ProviderConfig[];
  maxConcurrent?: number;
  timeoutMs?: number;
  clientOnly?: boolean;
  accountEngines?: AccountEngineConfig[];
  /**
   * The provider id new gateway chats are recorded with: `legacy` (the default) for `subscription_gateway`, or `openai`, an
   * opt-in for a Mac whose native relay is verified, so a stock engine lists them too. Existing chats keep the id they were
   * saved with either way. See docs/harness-identity.md.
   */
  chatIdentity?: "openai" | "legacy";
}

const integerIn = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): boolean => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** Apply an operator `contextWindowCap` to the window fields; metadata without a cap is returned unchanged. */
export function capContextWindow<T extends ModelMetadata | undefined>(metadata: T): T {
  const cap = metadata?.contextWindowCap;
  if (!metadata || cap === undefined) return metadata;
  return {
    ...metadata,
    ...(metadata.contextWindow !== undefined && metadata.contextWindow > cap ? { contextWindow: cap } : {}),
    ...(metadata.maxContextWindow !== undefined && metadata.maxContextWindow > cap ? { maxContextWindow: cap } : {}),
  };
}

export function validateConfig(value: unknown, directory = process.cwd()): GatewayConfig {
  if (!value || typeof value !== "object") throw new Error("Configuration must be an object");
  const config = value as GatewayConfig;
  if (config.version !== 1) throw new Error("Unsupported configuration version; expected 1");
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("port must be 0 through 65535");
  if (config.clientOnly !== undefined && typeof config.clientOnly !== "boolean") throw new Error("clientOnly must be boolean");
  if (!Array.isArray(config.providers) || (!config.clientOnly && !config.providers.length)) throw new Error("At least one provider is required");
  if (config.clientOnly && (config.providers.length || !config.port)) throw new Error("Remote clients require a fixed forwarded port and no local providers");
  if (config.maxConcurrent !== undefined && (!Number.isInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 16)) throw new Error("maxConcurrent must be 1 through 16");
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 600000)) throw new Error("timeoutMs must be 1000 through 600000");
  if (config.chatIdentity !== undefined && config.chatIdentity !== "openai" && config.chatIdentity !== "legacy") throw new Error("chatIdentity must be openai or legacy");
  const ids = new Set<string>(); const aliases = new Set<string>();
  const stateDirectory = resolve(directory, config.stateDirectory || ".state");
  const providers = config.providers.map(provider => {
    if (!provider || !/^[a-z][a-z0-9_-]*$/.test(provider.id)) throw new Error("Provider IDs must use lowercase letters, digits, _ or -");
    if (ids.has(provider.id)) throw new Error(`Duplicate provider ID: ${provider.id}`);
    ids.add(provider.id);
    if (!["claude-subscription", "codex-subscription", "copilot-subscription", "responses-api", "anthropic-api", "chat-completions-api", "grok-subscription"].includes(provider.type)) throw new Error(`Unsupported provider type: ${provider.type}`);
    if (provider.maxConcurrent !== undefined && (!Number.isInteger(provider.maxConcurrent) || provider.maxConcurrent < 1 || provider.maxConcurrent > 16)) throw new Error(`${provider.id}: maxConcurrent must be 1 through 16`);
    if (!provider.models || typeof provider.models !== "object" || Array.isArray(provider.models) || !Object.keys(provider.models).length) throw new Error(`${provider.id}: models must be a non-empty alias map`);
    for (const [alias, model] of Object.entries(provider.models)) {
      if (!alias || typeof model !== "string" || !model) throw new Error(`${provider.id}: model aliases and IDs must be non-empty strings`);
      if (aliases.has(alias)) throw new Error(`Duplicate model alias: ${alias}`);
      aliases.add(alias);
    }
    for (const [alias, metadata] of Object.entries(provider.modelMetadata || {})) {
      if (!Object.hasOwn(provider.models, alias) || !metadata || typeof metadata !== "object") throw new Error("Model metadata must refer to a configured alias");
      if (metadata.contextWindow !== undefined && (!Number.isInteger(metadata.contextWindow) || metadata.contextWindow < 1024)) throw new Error("contextWindow must be at least 1024 tokens");
      if (metadata.contextWindowCap !== undefined && !integerIn(metadata.contextWindowCap, 1024)) throw new Error("contextWindowCap must be an integer of at least 1024 tokens");
      if (metadata.reasoningEfforts?.some(effort => !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort))) throw new Error("Unsupported reasoning effort in model metadata");
      if (metadata.defaultReasoningEffort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(metadata.defaultReasoningEffort)) throw new Error("Unsupported default reasoning effort in model metadata");
      if (metadata.priority !== undefined && !Number.isInteger(metadata.priority)) throw new Error("Model priority must be an integer");
      if (metadata.multiAgentVersion !== undefined && (typeof metadata.multiAgentVersion !== "string" || !/^v[0-9]{1,3}$/.test(metadata.multiAgentVersion))) throw new Error("multiAgentVersion must look like v2");
      if ((metadata.useResponsesLite !== undefined && typeof metadata.useResponsesLite !== "boolean") || (metadata.supportsReasoningEffortUpdates !== undefined && typeof metadata.supportsReasoningEffortUpdates !== "boolean")) throw new Error("Responses lite metadata must be boolean");
      if (metadata.multiAgentReasoningEffort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(metadata.multiAgentReasoningEffort)) throw new Error("Unsupported multi-agent reasoning effort in model metadata");
      if (metadata.inputModalities !== undefined && (!Array.isArray(metadata.inputModalities) || !metadata.inputModalities.includes("text") || metadata.inputModalities.some(modality => !["text", "image"].includes(modality)) || new Set(metadata.inputModalities).size !== metadata.inputModalities.length)) throw new Error("Input modalities must contain text and optionally image");
      const truncation = metadata.truncationPolicy;
      if (truncation !== undefined && (!truncation || typeof truncation !== "object" || !["tokens", "bytes"].includes(truncation.mode) || !integerIn(truncation.limit, 1000, 1000000))) throw new Error("truncationPolicy needs mode tokens or bytes and an integer limit from 1000 through 1000000");
      if (metadata.effectiveContextWindowPercent !== undefined && !integerIn(metadata.effectiveContextWindowPercent, 50, 100)) throw new Error("effectiveContextWindowPercent must be an integer from 50 through 100");
      if ((metadata.autoCompactTokenLimit !== undefined && !integerIn(metadata.autoCompactTokenLimit, 1024)) || (metadata.maxContextWindow !== undefined && !integerIn(metadata.maxContextWindow, 1024))) throw new Error("autoCompactTokenLimit and maxContextWindow must be at least 1024 tokens");
      readServiceTierMetadata(metadata);
    }
    // Only the chat adapter (and its discovery) connects through the address check; another adapter would send its key over plain HTTP unchecked.
    if (provider.tailnet !== undefined && provider.type !== "chat-completions-api") throw new Error(`${provider.id}: tailnet is only valid for chat-completions-api providers`);
    if (provider.sessionAffinity !== undefined) {
      if (provider.type !== "chat-completions-api") throw new Error(`${provider.id}: sessionAffinity is only valid for chat-completions-api providers`);
      if (typeof provider.sessionAffinity !== "boolean") throw new Error(`${provider.id}: sessionAffinity must be boolean`);
    }
    if (["responses-api", "anthropic-api", "chat-completions-api"].includes(provider.type)) {
      if (!provider.baseUrl || (!provider.apiKeyEnv && !provider.credentialFile) || (provider.apiKeyEnv && !/^[A-Z][A-Z0-9_]*$/.test(provider.apiKeyEnv)) || (provider.apiKeyEnv && provider.credentialFile)) throw new Error(`${provider.id}: baseUrl and exactly one of apiKeyEnv or credentialFile are required`);
      const url = new URL(provider.baseUrl);
      if (url.username || url.password || url.search || url.hash) throw new Error("baseUrl must not contain credentials, a query, or a fragment");
      if (provider.tailnet !== undefined && typeof provider.tailnet !== "boolean") throw new Error(`${provider.id}: tailnet must be boolean`);
      const tailnetHttp = provider.tailnet === true && url.protocol === "http:";
      if (url.protocol !== "https:" && !tailnetHttp && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("API providers require HTTPS except on loopback");
    }
    if (provider.grokHome !== undefined && (provider.type !== "grok-subscription" || typeof provider.grokHome !== "string" || !provider.grokHome)) throw new Error(`${provider.id}: grokHome is only valid for grok-subscription providers`);
    if (provider.defaultForBareModels !== undefined) {
      if (provider.type !== "codex-subscription" && provider.type !== "claude-subscription") throw new Error(`${provider.id}: defaultForBareModels is only valid for codex-subscription or claude-subscription providers`);
      if (typeof provider.defaultForBareModels !== "boolean") throw new Error(`${provider.id}: defaultForBareModels must be boolean`);
    }
    // An opt-in capability, not an account or a route: `bindings` leaves it out, so a change applies live, without a rebind.
    if (provider.toolSearch !== undefined) {
      if (provider.type !== "codex-subscription") throw new Error(`${provider.id}: toolSearch is only valid for codex-subscription providers`);
      if (provider.toolSearch !== "off" && provider.toolSearch !== "bridge") throw new Error(`${provider.id}: toolSearch must be off or bridge`);
    }
    if (provider.type === "codex-subscription" && !provider.credentialFile) throw new Error(`${provider.id}: credentialFile is required`);
    const sessions = provider.claudeSessions;
    if (sessions !== undefined) {
      if (provider.type !== "claude-subscription") throw new Error(`${provider.id}: claudeSessions is only valid for claude-subscription providers`);
      if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) throw new Error(`${provider.id}: claudeSessions must be an object`);
      if ((sessions.mode !== undefined && !["replay", "live"].includes(sessions.mode)) || (sessions.replayFormat !== undefined && !["text", "json"].includes(sessions.replayFormat))) throw new Error(`${provider.id}: claudeSessions mode must be replay or live and replayFormat text or json`);
      if (sessions.max !== undefined && !integerIn(sessions.max, 1, 32)) throw new Error(`${provider.id}: claudeSessions max must be 1 through 32`);
      if (sessions.parkMinutes !== undefined && !integerIn(sessions.parkMinutes, 5, 240)) throw new Error(`${provider.id}: claudeSessions parkMinutes must be 5 through 240`);
      if (sessions.warmup !== undefined && !integerIn(sessions.warmup, 0, 5)) throw new Error(`${provider.id}: claudeSessions warmup must be 0 through 5`);
    }
    const copilot = provider.copilotSessions;
    if (copilot !== undefined) {
      if (provider.type !== "copilot-subscription") throw new Error(`${provider.id}: copilotSessions is only valid for copilot-subscription providers`);
      if (!copilot || typeof copilot !== "object" || Array.isArray(copilot)) throw new Error(`${provider.id}: copilotSessions must be an object`);
      if (copilot.mode !== undefined && !["oneshot", "replay", "live"].includes(copilot.mode)) throw new Error(`${provider.id}: copilotSessions mode must be oneshot, replay or live`);
      if (copilot.max !== undefined && !integerIn(copilot.max, 1, 16)) throw new Error(`${provider.id}: copilotSessions max must be 1 through 16`);
      if (copilot.parkMinutes !== undefined && !integerIn(copilot.parkMinutes, 5, 240)) throw new Error(`${provider.id}: copilotSessions parkMinutes must be 5 through 240`);
      // Copilot fails a pending tool call after 30 minutes and then calls the model on its own; the gateway closes the session first.
      if (copilot.toolWaitMinutes !== undefined && !integerIn(copilot.toolWaitMinutes, 1, 25)) throw new Error(`${provider.id}: copilotSessions toolWaitMinutes must be 1 through 25`);
    }
    return { ...provider, models: { ...provider.models }, ...(sessions ? { claudeSessions: { ...sessions } } : {}), ...(copilot ? { copilotSessions: { ...copilot } } : {}), ...(provider.credentialFile ? { credentialFile: resolve(directory, provider.credentialFile) } : {}), ...(provider.authDirectory ? { authDirectory: resolve(directory, provider.authDirectory) } : {}),
      ...(provider.type === "grok-subscription" ? { grokHome: resolve(directory, provider.grokHome ?? join(stateDirectory, "grok-home")) } : {}) };
  });
  const accountEngines = config.accountEngines === undefined ? undefined : validateAccountEngines(config.accountEngines, providers);
  // Two defaults of the same type would make a bare name depend on configuration order, so one designation per vendor is the rule.
  for (const type of ["codex-subscription", "claude-subscription"] as const) {
    if (providers.filter(provider => provider.type === type && provider.defaultForBareModels === true).length > 1) throw new Error(`Only one ${type} provider may set defaultForBareModels`);
  }
  return { version: 1, port: config.port, stateDirectory, providers,
    maxConcurrent: config.maxConcurrent || 4, timeoutMs: config.timeoutMs || 600000, ...(config.clientOnly ? { clientOnly: true } : {}), ...(accountEngines ? { accountEngines } : {}),
    ...(config.chatIdentity ? { chatIdentity: config.chatIdentity } : {}) };
}

function validateAccountEngines(value: unknown, providers: ProviderConfig[]): AccountEngineConfig[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("accountEngines must be a list of at most 4 accounts");
  const ids = new Set<string>();
  return value.map((entry: Partial<AccountEngineConfig> | null) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(entry.id)) throw new Error("Account engine IDs must be 1 to 32 lowercase letters, digits, _ or -, starting with a letter");
    if (ids.has(entry.id)) throw new Error(`Duplicate account engine ID: ${entry.id}`);
    ids.add(entry.id);
    const provider = providers.find(candidate => candidate.id === entry.id);
    if (provider && provider.type !== "codex-subscription") throw new Error(`Account engine ${entry.id} may share an ID only with a codex-subscription provider`);
    if (entry.label !== undefined && (typeof entry.label !== "string" || !/^[^\p{C}\p{Zl}\p{Zp}]{1,64}$/u.test(entry.label))) throw new Error(`Account engine ${entry.id}: label must be 1 to 64 printable characters`);
    if (entry.workspaceId !== undefined && (typeof entry.workspaceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.workspaceId))) throw new Error(`Account engine ${entry.id}: workspaceId must be 1 to 128 letters, digits, _ or -`);
    return { id: entry.id, ...(entry.label !== undefined ? { label: entry.label } : {}), ...(entry.workspaceId !== undefined ? { workspaceId: entry.workspaceId } : {}) };
  });
}

/** Every alias the configuration routes, across providers. */
const configuredAliases = (config: Pick<GatewayConfig, "providers">): string[] => config.providers.flatMap(provider => Object.keys(provider.models));

/**
 * Once the native catalog is known, an alias that equals one of its slugs is refused: chat classification lets the native
 * slug win such a tie, so the alias could never start a gateway chat, and its chats would run on the native engine.
 */
export function validateAliasesAgainstNative(config: Pick<GatewayConfig, "providers">, nativeSlugs: ReadonlySet<string>): void {
  if (configuredAliases(config).some(alias => nativeSlugs.has(alias))) throw new Error("A gateway model alias collides with a native model ID; rename that alias");
}

/** Aliases without a `/` are valid but could collide with a native model added later; the adapter warns about them at load. */
export function unscopedAliasCount(config: Pick<GatewayConfig, "providers">): number {
  return configuredAliases(config).filter(alias => !alias.includes("/")).length;
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error("Configuration file is unreadable or invalid JSON"); }
  return validateConfig(parsed, dirname(resolve(path)));
}

/** `mtimeMs` gives the file that modification time before the rename, so no reader ever sees the new contents with another one. */
export async function writePrivateJson(path: string, value: unknown, options: { mtimeMs?: number } = {}): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    if (options.mtimeMs !== undefined) await utimes(temporary, new Date(), new Date(options.mtimeMs));
    await rename(temporary, path);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; } // A failed write or rename leaves no temp file behind.
  await chmod(path, 0o600);
}

export async function readClientToken(path: string): Promise<string> {
  const token = await readPrivateCredential(path);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("Invalid gateway client token");
  return token;
}

export async function readPrivateCredential(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096 || (process.platform !== "win32" && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error("Client token must be a private file owned by this user");
    const token = (await file.readFile("utf8")).trim();
    if (!token || /[\r\n]/.test(token)) throw new Error("Invalid private credential");
    return token;
  } finally { await file.close(); }
}

export async function apiCredential(provider: ProviderConfig): Promise<string | undefined> {
  return provider.credentialFile ? readPrivateCredential(provider.credentialFile) : process.env[provider.apiKeyEnv!];
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
