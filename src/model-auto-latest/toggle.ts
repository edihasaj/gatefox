import { ManagementError, throwIfCancelled } from "../app-management/errors.js";
import { validateRaw } from "../app-management/drafts.js";
import { loadCachedCatalog, mergeCatalog, saveCachedCatalog } from "../app-management/mutations.js";
import { discoverManagementModels } from "../app-management/runtime.js";
import { mutateConfig, readSnapshot, type ConfigSnapshot } from "../app-management/storage.js";
import { discoverAll, discoverableKinds } from "./discovery.js";
import { readNativeCatalog } from "./native-cache.js";
import { pickerEntries, seedScope, visibleFamilies, visibleModels } from "./planner.js";
import { rawAutoLatest } from "./settings.js";
import { providerRoute } from "../app-management/aliases.js";
import type { AutoLatestDependencies, AutoLatestScope, CatalogRow } from "./types.js";

/** Turning the setting on must finish inside the app's thirty-second deadline, so discovery is capped well below it. */
const enableBudgetMs = 18_000;

/**
 * Turns automatic upkeep on or off. Neither direction changes any current selection. Enabling captures the families the
 * visible routes already use and a baseline of every model known right now; a provider whose fresh catalog could not be
 * read is seeded from what is cached and configured and stays pending, so its first successful check never upgrades.
 * Disabling only stops future updates.
 */
export async function setAutoLatest(configPath: string, enabled: boolean, revision: string, deps: AutoLatestDependencies = {}): Promise<{ snapshot: ConfigSnapshot; changed: boolean }> {
  if (typeof enabled !== "boolean" || typeof revision !== "string" || !revision) throw new ManagementError("invalid_request");
  const signal = deps.signal;
  throwIfCancelled(signal);
  const snapshot = await readSnapshot(configPath);
  if (!snapshot) throw new ManagementError("not_found");
  if (snapshot.revision !== revision) throw new ManagementError("configuration_changed");
  const current = rawAutoLatest(snapshot.raw);
  if (!enabled) {
    if (!current?.enabled) return { snapshot, changed: false };
    const saved = await mutateConfig(configPath, revision, latest => {
      throwIfCancelled(signal);
      if (!latest) throw new ManagementError("not_found");
      const raw = structuredClone(latest.raw); const settings = raw.autoLatestModels as Record<string, unknown>;
      settings.enabled = false; return raw;
    }, signal);
    return { snapshot: saved, changed: true };
  }
  if (current?.enabled) return { snapshot, changed: false };

  const watched = snapshot.config.providers.filter(provider => discoverableKinds.has(provider.type) && visibleFamilies(visibleModels(provider)).length > 0);
  const results = await discoverAll(watched, deps.discoverModels ?? discoverManagementModels, true, signal,
    { ...(deps.perProviderMs !== undefined ? { perProviderMs: deps.perProviderMs } : {}), totalMs: deps.totalMs ?? enableBudgetMs });
  throwIfCancelled(signal);
  const providers: Record<string, AutoLatestScope> = {}; const fresh = new Map<string, CatalogRow[]>();
  for (const provider of watched) {
    const result = results.get(provider.id); const rows = result && "rows" in result ? result.rows : [];
    const cached = (await loadCachedCatalog(configPath, provider.id, provider)).map(entry => entry.id);
    const scope = seedScope(visibleModels(provider), Object.values(provider.models), [...rows.map(row => row.id), ...cached], undefined, rows.length === 0);
    if (scope) providers[provider.id] = scope;
    if (rows.length) fresh.set(provider.id, rows);
  }
  const picker = Array.isArray(snapshot.raw.nativeModelPicker) ? (snapshot.raw.nativeModelPicker as unknown[]).filter((item): item is string => typeof item === "string") : undefined;
  let native: AutoLatestScope | undefined;
  if (picker?.length) {
    const rows = await readNativeCatalog(deps.nativeHome);
    native = seedScope(pickerEntries(picker, rows), picker, rows?.map(row => row.id) ?? [], undefined, !rows?.length);
  }
  throwIfCancelled(signal);
  const saved = await mutateConfig(configPath, revision, async latest => {
    throwIfCancelled(signal);
    if (!latest) throw new ManagementError("not_found");
    const raw = structuredClone(latest.raw);
    raw.autoLatestModels = { enabled: true, providers, ...(native ? { native } : {}) };
    await validateRaw(raw, configPath);
    // Fresh catalogs are cached only here, under the config lock after the revision check and with the same provider identity.
    for (const provider of watched) {
      const rows = fresh.get(provider.id); const live = latest.config.providers.find(item => item.id === provider.id);
      if (!rows || !live || providerRoute(live) !== providerRoute(provider)) continue;
      await saveCachedCatalog(configPath, live.id, mergeCatalog(live, rows), signal, live).catch(() => undefined);
    }
    return raw;
  }, signal);
  return { snapshot: saved, changed: true };
}
