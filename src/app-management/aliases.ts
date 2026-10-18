import { dirname, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { readOwnedJson, writeOwnedJson } from "./storage.js";

export interface AliasIdentity { route: string; model: string }
interface AliasLedger { version: 1; aliases: Record<string, AliasIdentity> }

const ledgerPath = (configPath: string): string => resolve(dirname(configPath), "app-aliases.json");
const own = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

export function providerRoute(provider: ProviderConfig): string {
  return JSON.stringify({ type: provider.type, id: provider.id,
    credentialFile: provider.credentialFile ? resolve(provider.credentialFile) : undefined,
    authDirectory: provider.authDirectory ? resolve(provider.authDirectory) : undefined,
    baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv });
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
      if (typeof value?.route === "string" && typeof value.model === "string") aliases[alias] = { route: value.route, model: value.model };
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
    for (const [alias, model] of Object.entries(provider.models)) ledger.aliases[alias] = { route, model };
  }
}

export function rememberProviderAliases(ledger: AliasLedger, provider: ProviderConfig): void {
  const route = providerRoute(provider);
  for (const [alias, model] of Object.entries(provider.models)) ledger.aliases[alias] = { route, model };
}

export function reservedAliases(config: GatewayConfig, ledger: AliasLedger): Set<string> {
  return new Set([...Object.keys(ledger.aliases), ...config.providers.flatMap(provider => Object.keys(provider.models))]);
}

/** Only an exact retired route/model identity can reclaim its former public alias. */
export function retiredAlias(provider: ProviderConfig, model: string, reservedNow: Set<string>, ledger: AliasLedger): string | undefined {
  const route = providerRoute(provider);
  return Object.entries(ledger.aliases).find(([alias, identity]) => !reservedNow.has(alias) && identity.route === route && identity.model === model)?.[0];
}
