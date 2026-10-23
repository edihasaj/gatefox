import { dirname, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { readOwnedJson, writeOwnedJson } from "./storage.js";

/** `metadata` is recorded for Grok only: it has no discovery, so the ledger is what restores a re-enabled alias exactly. */
export interface AliasIdentity { route: string; model: string; metadata?: Record<string, unknown> }
interface AliasLedger { version: 1; aliases: Record<string, AliasIdentity> }

const ledgerPath = (configPath: string): string => resolve(dirname(configPath), "app-aliases.json");
const own = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const boundedMetadata = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? structuredClone(value) as Record<string, unknown> : undefined;
function identity(provider: ProviderConfig, alias: string, model: string, route: string): AliasIdentity {
  const metadata = provider.type === "grok-subscription" ? boundedMetadata(provider.modelMetadata?.[alias]) : undefined;
  return { route, model, ...(metadata ? { metadata } : {}) };
}

export function providerRoute(provider: ProviderConfig): string {
  return JSON.stringify({ type: provider.type, id: provider.id,
    credentialFile: provider.credentialFile ? resolve(provider.credentialFile) : undefined,
    authDirectory: provider.authDirectory ? resolve(provider.authDirectory) : undefined,
    baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv,
    // Grok identity is its private home; other kinds omit the key so their existing fingerprints stay valid.
    ...(provider.type === "grok-subscription" && provider.grokHome ? { grokHome: resolve(provider.grokHome) } : {}) });
}

export async function loadAliases(configPath: string): Promise<AliasLedger> {
  const path = ledgerPath(configPath);
  try { await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, aliases: own<AliasIdentity>() };
    throw error;
  }
  try {
    const stored = await readOwnedJson<AliasLedger>(path);
    if (stored?.version !== 1 || !stored.aliases || typeof stored.aliases !== "object" || Array.isArray(stored.aliases)) throw new Error("invalid");
    const aliases = own<AliasIdentity>();
    for (const [alias, value] of Object.entries(stored.aliases)) {
      if (typeof value?.route === "string" && typeof value.model === "string") {
        const metadata = boundedMetadata(value.metadata);
        aliases[alias] = { route: value.route, model: value.model, ...(metadata ? { metadata } : {}) };
      }
    }
    return { version: 1, aliases };
  } catch (error) { throw error; }
}

export async function saveAliases(configPath: string, ledger: AliasLedger): Promise<void> {
  await writeOwnedJson(ledgerPath(configPath), ledger);
}

/** Records every active alias before an edit so retired chat routes never become another route. */
export function rememberCurrentAliases(ledger: AliasLedger, config: GatewayConfig): void {
  for (const provider of config.providers) {
    const route = providerRoute(provider);
    for (const [alias, model] of Object.entries(provider.models)) ledger.aliases[alias] = identity(provider, alias, model, route);
  }
}

export function rememberProviderAliases(ledger: AliasLedger, provider: ProviderConfig): void {
  const route = providerRoute(provider);
  for (const [alias, model] of Object.entries(provider.models)) ledger.aliases[alias] = identity(provider, alias, model, route);
}

export function reservedAliases(config: GatewayConfig, ledger: AliasLedger): Set<string> {
  return new Set([...Object.keys(ledger.aliases), ...config.providers.flatMap(provider => Object.keys(provider.models))]);
}

/** Only an exact retired route/model identity can reclaim its former public alias. */
export function retiredAlias(provider: ProviderConfig, model: string, reservedNow: Set<string>, ledger: AliasLedger): string | undefined {
  return retiredAliases(provider, model, reservedNow, ledger)[0]?.[0];
}

/** Every retired alias of the exact route/model, in ledger order, so a model with several aliases returns whole. */
export function retiredAliases(provider: ProviderConfig, model: string, reservedNow: Set<string>, ledger: AliasLedger): Array<[string, AliasIdentity]> {
  const route = providerRoute(provider);
  return Object.entries(ledger.aliases).filter(([alias, entry]) => !reservedNow.has(alias) && entry.route === route && entry.model === model);
}
