import { dirname, relative, resolve } from "node:path";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { mutateConfig, readOwnedJson, writeOwnedJson, type ConfigSnapshot } from "./storage.js";
import { ManagementError, throwIfCancelled } from "./errors.js";
import { catalogEntry, isManagedCredential, validateRaw, writeCredential } from "./drafts.js";
import { isApiKind, validModelId } from "./providers.js";
import type { CatalogEntry, DraftRecord } from "./types.js";
import { loadAliases, providerRoute, rememberCurrentAliases, rememberProviderAliases, reservedAliases, retiredAlias, retiredAliases, saveAliases, type AliasIdentity } from "./aliases.js";
import { chooseLoopbackPort } from "./ports.js";
import { pickerHidden } from "../model-auto-latest/metadata.js";
import { dropRawProvider, reseedRawProvider } from "../model-auto-latest/scopes.js";

/** Only automatic upkeep may set pickerHidden, so it never travels through a catalog or a re-added alias. */
function stripHidden<T extends object | undefined>(metadata: T): T {
  if (!metadata || !Object.hasOwn(metadata, "pickerHidden")) return metadata;
  const { pickerHidden: _hidden, ...rest } = metadata as Record<string, unknown>; return rest as T;
}

const stringArray = (value: unknown): string[] => Array.isArray(value) && value.every(validModelId) && new Set(value).size === value.length ? value : (() => { throw new ManagementError("invalid_request"); })();
const cachePath = (configPath: string, id: string): string => resolve(dirname(configPath), "app-catalog", `${id}.json`);

/** A Grok catalog is only valid for the private Grok home it was recorded under; other kinds are not route-bound. */
const routeBound = (provider?: ProviderConfig): provider is ProviderConfig => provider?.type === "grok-subscription";

export async function loadCachedCatalog(configPath: string, id: string, provider?: ProviderConfig): Promise<CatalogEntry[]> {
  try {
    const value = await readOwnedJson<{ version: 1; models: CatalogEntry[]; route?: string }>(cachePath(configPath, id));
    if (routeBound(provider) && value?.route !== providerRoute(provider)) return [];
    return Array.isArray(value?.models) ? value.models.filter(entry => entry && validModelId(entry.id)).map(entry => catalogEntry(entry.id, entry.label, entry.metadata)) : [];
  } catch { return []; }
}
export async function saveCachedCatalog(configPath: string, id: string, models: CatalogEntry[], signal?: AbortSignal, provider?: ProviderConfig): Promise<void> {
  await writeOwnedJson(cachePath(configPath, id), { version: 1, models, ...(routeBound(provider) ? { route: providerRoute(provider) } : {}) }, false, signal);
}

export function mergeCatalog(configured: ProviderConfig, fresh: CatalogEntry[], manual: string[] = []): CatalogEntry[] {
  const result = new Map<string, CatalogEntry>();
  for (const item of fresh) if (validModelId(item.id)) result.set(item.id, item);
  // Manual values are a fallback for unavailable listings, never a way to erase verified metadata.
  for (const id of manual) if (!result.has(id)) result.set(id, catalogEntry(id));
  // A configured route keeps its saved display name and metadata, so deselecting and re-enabling it restores the original.
  for (const [alias, id] of Object.entries(configured.models)) {
    const metadata = configured.modelMetadata?.[alias] as Record<string, unknown> | undefined; const current = result.get(id);
    if (current && (current.metadata || !metadata)) continue;
    const named = (metadata as { displayName?: unknown } | undefined)?.displayName;
    result.set(id, catalogEntry(id, typeof named === "string" && named ? named : current?.label ?? id, metadata));
  }
  return [...result.values()].map(entry => entry.metadata ? { ...entry, metadata: stripHidden(entry.metadata) } : entry);
}

/**
 * Grok has no discovery, so its saved configuration is the newest truth about every model it lists. Configured metadata
 * replaces a stale cached copy; models only the same-route cache still knows (disabled earlier) are kept as they were.
 */
export function withConfiguredCatalog(provider: ProviderConfig, cached: CatalogEntry[]): CatalogEntry[] {
  if (!routeBound(provider)) return cached;
  const result = new Map(cached.map(entry => [entry.id, entry])); const done = new Set<string>();
  for (const [alias, id] of Object.entries(provider.models)) {
    const metadata = provider.modelMetadata?.[alias] as Record<string, unknown> | undefined;
    if (done.has(id) || !validModelId(id)) continue;
    done.add(id); const named = (metadata as { displayName?: unknown } | undefined)?.displayName;
    result.set(id, catalogEntry(id, typeof named === "string" && named ? named : id, metadata));
  }
  return [...result.values()];
}

export function allowedSelection(provider: ProviderConfig, catalog: CatalogEntry[], selected: unknown, manual: unknown): { selected: string[]; catalog: CatalogEntry[] } {
  const choices = stringArray(selected); if (!choices.length) throw new ManagementError("invalid_request");
  const manualIds = manual === undefined ? [] : stringArray(manual);
  if (manualIds.length && !isApiKind(provider.type)) throw new ManagementError("invalid_request");
  const available = new Set([...catalog.map(item => item.id), ...Object.values(provider.models), ...manualIds]);
  if (choices.some(id => !available.has(id))) throw new ManagementError("invalid_request");
  return { selected: choices, catalog: mergeCatalog(provider, catalog, manualIds) };
}

export function aliasFor(provider: ProviderConfig, model: string, aliases: Set<string>, claimed: Set<string>, ledger: Record<string, AliasIdentity>): string {
  const resumed = retiredAlias(provider, model, claimed, { version: 1, aliases: ledger });
  if (resumed) { aliases.add(resumed); return resumed; }
  const providerId = provider.id;
  const base = `${providerId}/${model}`; let value = base; let number = 2;
  while (aliases.has(value)) value = `${base}-${number++}`;
  aliases.add(value); return value;
}

function modelsFor(provider: ProviderConfig, selected: string[], catalog: CatalogEntry[], aliases: Set<string>, ledger: Record<string, AliasIdentity>): Pick<ProviderConfig, "models" | "modelMetadata"> {
  const selectedIds = new Set(selected); const metadata = new Map(catalog.map(item => [item.id, item.metadata]));
  const models: Record<string, string> = Object.create(null); const modelMetadata: Record<string, unknown> = Object.create(null);
  // Keep every existing alias for each retained upstream model, in its exact existing order.
  // A route automatic upkeep hid stays configured for saved chats even when unchecked; checking its model again unhides it.
  const hiddenOf = (alias: string): boolean => pickerHidden(provider.modelMetadata?.[alias]);
  const visibleIds = new Set<string>();
  for (const [alias, model] of Object.entries(provider.models)) if (!hiddenOf(alias)) visibleIds.add(model);
  for (const [alias, model] of Object.entries(provider.models)) {
    const hidden = hiddenOf(alias);
    if (!selectedIds.has(model) && !hidden) continue;
    models[alias] = model; aliases.add(alias);
    if (Object.hasOwn(provider.modelMetadata || {}, alias)) {
      const saved = provider.modelMetadata![alias]!;
      modelMetadata[alias] = hidden && selectedIds.has(model) && !visibleIds.has(model) ? stripHidden(saved) : saved;
    }
  }
  for (const id of selected) {
    if (Object.values(models).includes(id)) continue;
    if (routeBound(provider)) {
      // Grok restores every exact-route retired alias with its own recorded metadata; an unknown route falls through to a new alias.
      const retired = retiredAliases(provider, id, new Set(Object.keys(models)), { version: 1, aliases: ledger });
      if (retired.length) {
        for (const [alias, entry] of retired) { models[alias] = id; aliases.add(alias); if (entry.metadata) modelMetadata[alias] = entry.metadata; }
        continue;
      }
    }
    const alias = aliasFor(provider, id, aliases, new Set(Object.keys(models)), ledger); models[alias] = id;
    const fresh = metadata.get(id); if (fresh) modelMetadata[alias] = stripHidden(fresh);
  }
  return { models, ...(Object.keys(modelMetadata).length ? { modelMetadata: modelMetadata as ProviderConfig["modelMetadata"] } : {}) };
}
function rawProviders(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(raw.providers) || raw.providers.some(value => !value || typeof value !== "object" || Array.isArray(value))) throw new ManagementError("invalid_configuration");
  return raw.providers as Record<string, unknown>[];
}
function rawConfigWithProvider(raw: Record<string, unknown>, provider: ProviderConfig, models: Pick<ProviderConfig, "models" | "modelMetadata">): Record<string, unknown> {
  const source = structuredClone(raw); const providers = rawProviders(source); const existing = providers.some(item => item.id === provider.id);
  if (existing) throw new ManagementError("invalid_provider");
  providers.push({ ...structuredClone(provider), ...models }); return source;
}

export async function commitDraft(configPath: string, draft: DraftRecord, selected: unknown, manual: unknown, signal?: AbortSignal): Promise<ConfigSnapshot> {
  const choice = allowedSelection(draft.provider, draft.catalog || [], selected, manual);
  return mutateConfig(configPath, draft.revision, async snapshot => {
    throwIfCancelled(signal);
    if (Boolean(snapshot) === draft.isNewConfiguration) throw new ManagementError("configuration_changed");
    if (snapshot?.config.clientOnly) throw new ManagementError("invalid_configuration");
    const raw = snapshot ? structuredClone(snapshot.raw) : { version: 1, port: await chooseLoopbackPort(), stateDirectory: resolve(dirname(configPath), "state"), providers: [] };
    const ledger = await loadAliases(configPath); if (snapshot) rememberCurrentAliases(ledger, snapshot.config);
    const aliases = snapshot ? reservedAliases(snapshot.config, ledger) : new Set(Object.keys(ledger.aliases));
    const models = modelsFor(draft.provider, choice.selected, choice.catalog, aliases, ledger.aliases);
    const committed = { ...draft.provider, ...models }; rememberProviderAliases(ledger, committed);
    const next = rawConfigWithProvider(raw, draft.provider, models); reseedRawProvider(next, committed, choice.catalog.map(entry => entry.id), !draft.catalog?.length); await validateRaw(next, configPath); await saveAliases(configPath, ledger); return next;
  }, signal);
}

export async function updateModels(configPath: string, providerId: string, revision: unknown, selected: unknown, manual: unknown, signal?: AbortSignal): Promise<{ snapshot: ConfigSnapshot; changed: boolean }> {
  if (typeof revision !== "string" || !revision) throw new ManagementError("invalid_request");
  let changed = false;
  const snapshot = await mutateConfig(configPath, revision, async current => {
    throwIfCancelled(signal);
    if (!current) throw new ManagementError("not_found"); const provider = current.config.providers.find(item => item.id === providerId); if (!provider) throw new ManagementError("not_found");
    const choice = allowedSelection(provider, withConfiguredCatalog(provider, await loadCachedCatalog(configPath, providerId, provider)), selected, manual);
    const ledger = await loadAliases(configPath); rememberCurrentAliases(ledger, current.config);
    const aliases = reservedAliases(current.config, ledger); const models = modelsFor(provider, choice.selected, choice.catalog, aliases, ledger.aliases);
    if (JSON.stringify(provider.models) === JSON.stringify(models.models) && JSON.stringify(provider.modelMetadata || {}) === JSON.stringify(models.modelMetadata || {})) return current.raw;
    changed = true; const raw = structuredClone(current.raw); const target = rawProviders(raw).find(item => item.id === providerId); if (!target) throw new ManagementError("not_found");
    target.models = models.models; if (models.modelMetadata) target.modelMetadata = models.modelMetadata; else delete target.modelMetadata;
    reseedRawProvider(raw, { id: provider.id, type: provider.type, models: models.models, ...(models.modelMetadata ? { modelMetadata: models.modelMetadata } : {}) }, choice.catalog.map(entry => entry.id));
    await validateRaw(raw, configPath); rememberProviderAliases(ledger, { ...provider, ...models }); await saveAliases(configPath, ledger);
    // Cache the catalog with the original configured entries before any are removed, so they can be re-enabled exactly.
    await saveCachedCatalog(configPath, providerId, choice.catalog, signal, provider); return raw;
  }, signal);
  return { snapshot, changed };
}

export async function renameProvider(configPath: string, providerId: string, revision: unknown, label: unknown, signal?: AbortSignal): Promise<{ snapshot: ConfigSnapshot; changed: boolean }> {
  if (typeof revision !== "string" || !revision || typeof label !== "string" || !label.trim() || label.length > 96 || /[\p{C}]/u.test(label)) throw new ManagementError("invalid_request");
  let changed = false; const cleaned = label.trim();
  const snapshot = await mutateConfig(configPath, revision, async current => {
    throwIfCancelled(signal);
    if (!current) throw new ManagementError("not_found"); const target = rawProviders(current.raw).find(item => item.id === providerId); if (!target) throw new ManagementError("not_found");
    if (target.label === cleaned) return current.raw; changed = true; const raw = structuredClone(current.raw); rawProviders(raw).find(item => item.id === providerId)!.label = cleaned; await validateRaw(raw, configPath); return raw;
  }, signal); return { snapshot, changed };
}

/** Reorders raw provider objects only; ids must be an exact permutation of the local providers. */
export async function reorderProviders(configPath: string, providerIds: unknown, revision: unknown, signal?: AbortSignal): Promise<{ snapshot: ConfigSnapshot; changed: boolean }> {
  if (typeof revision !== "string" || !revision || !Array.isArray(providerIds) || providerIds.some(item => typeof item !== "string" || !item)) throw new ManagementError("invalid_request");
  const wanted = providerIds as string[]; if (new Set(wanted).size !== wanted.length) throw new ManagementError("invalid_request");
  let changed = false;
  const snapshot = await mutateConfig(configPath, revision, async current => {
    throwIfCancelled(signal);
    if (!current) throw new ManagementError("not_found"); if (current.config.clientOnly) throw new ManagementError("invalid_configuration");
    const providers = rawProviders(current.raw); const byId = new Map(providers.map(item => [item.id, item]));
    if (byId.size !== providers.length || wanted.length !== providers.length || wanted.some(id => !byId.has(id))) throw new ManagementError("invalid_request");
    if (wanted.every((id, index) => providers[index]!.id === id)) return current.raw;
    changed = true; const raw = structuredClone(current.raw); const copies = new Map(rawProviders(raw).map(item => [item.id, item]));
    raw.providers = wanted.map(id => copies.get(id)!); await validateRaw(raw, configPath); return raw;
  }, signal);
  return { snapshot, changed };
}

export async function removeProvider(configPath: string, providerId: string, revision: unknown, signal?: AbortSignal): Promise<ConfigSnapshot> {
  if (typeof revision !== "string" || !revision) throw new ManagementError("invalid_request");
  return mutateConfig(configPath, revision, async current => {
    throwIfCancelled(signal);
    if (!current) throw new ManagementError("not_found"); const providers = rawProviders(current.raw); if (!providers.some(item => item.id === providerId)) throw new ManagementError("not_found");
    if (providers.length < 2) throw new ManagementError("invalid_configuration"); const ledger = await loadAliases(configPath); rememberCurrentAliases(ledger, current.config);
    const raw = structuredClone(current.raw); raw.providers = rawProviders(raw).filter(item => item.id !== providerId); dropRawProvider(raw, providerId); await validateRaw(raw, configPath); await saveAliases(configPath, ledger); return raw;
  }, signal);
}

export async function gatewayOwnedCredential(config: GatewayConfig, provider: ProviderConfig): Promise<boolean> {
  return Boolean(provider.credentialFile) && await isManagedCredential(config.stateDirectory, provider.credentialFile!);
}

/** The config lock also serializes API-key replacement with route and revision validation. */
export async function replaceGatewayCredential(configPath: string, providerId: string, requestedRevision: string | undefined, key: string, signal?: AbortSignal): Promise<ConfigSnapshot> {
  throwIfCancelled(signal);
  const before = await (await import("./storage.js")).readSnapshot(configPath);
  if (!before) throw new ManagementError("not_found");
  if (requestedRevision !== undefined && requestedRevision !== before.revision) throw new ManagementError("configuration_changed");
  return mutateConfig(configPath, before.revision, async current => {
    throwIfCancelled(signal);
    if (!current) throw new ManagementError("not_found"); const provider = current.config.providers.find(item => item.id === providerId);
    if (!provider || !isApiKind(provider.type) || !provider.credentialFile || !await gatewayOwnedCredential(current.config, provider)) throw new ManagementError("external_credential");
    await writeCredential(provider.credentialFile, key, true, signal); return current.raw;
  }, signal);
}
