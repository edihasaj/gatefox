import { readSnapshot, mutateConfig, type ConfigSnapshot } from "../app-management/storage.js";
import { ManagementError, throwIfCancelled } from "../app-management/errors.js";
import { discoverManagementModels } from "../app-management/runtime.js";
import { mergeCatalog, saveCachedCatalog } from "../app-management/mutations.js";
import { providerRoute } from "../app-management/aliases.js";
import { lockBusyCode, withPrivateFileLock } from "../private-file-lock.js";
import { applyAutoLatest } from "./apply.js";
import { discoverAll, discoverableKinds } from "./discovery.js";
import { readNativeCatalog } from "./native-cache.js";
import { rawAutoLatest } from "./settings.js";
import { statePath, writeState } from "./state.js";
import type { AutoLatestResult, CatalogRow, ReconcileOptions } from "./types.js";

const codeOf = (error: unknown): string | undefined => error && typeof error === "object" ? (error as { code?: string }).code : undefined;

/**
 * One pass of automatic upkeep. Another process running the same pass makes this one report `busy`. Provider failures
 * never throw: they leave the current selection alone and show up in the counts. It throws only for an unreadable or
 * unsafe configuration path, or when `expectedRevision` no longer matches.
 */
export async function reconcileAutoLatest(configPath: string, options: ReconcileOptions = {}): Promise<AutoLatestResult> {
  const now = options.now ?? Date.now;
  const base: AutoLatestResult = { outcome: "unchanged", changed: false, activated: 0, providersChecked: 0, providersFailed: 0, nativeUpdated: false, checkedAt: Math.floor(now() / 1000) };
  try { return await withPrivateFileLock(await statePath(configPath), () => run(configPath, options, base, now), options.lockTimeoutMs ?? 1500); }
  catch (error) {
    if (codeOf(error) === lockBusyCode) return { ...base, outcome: "busy" };
    throw error;
  }
}

async function run(configPath: string, options: ReconcileOptions, base: AutoLatestResult, now: () => number): Promise<AutoLatestResult> {
  const signal = options.signal;
  const snapshot = await readSnapshot(configPath);
  const settings = snapshot ? rawAutoLatest(snapshot.raw) : undefined;
  if (!snapshot || settings?.enabled !== true) return { ...base, outcome: "disabled" };
  if (options.expectedRevision !== undefined && options.expectedRevision !== snapshot.revision) throw new ManagementError("configuration_changed");
  const cancelled = (partial: Partial<AutoLatestResult> = {}): AutoLatestResult => ({ ...base, ...partial, outcome: "cancelled" });
  const finish = async (partial: Partial<AutoLatestResult>): Promise<AutoLatestResult> => {
    const result = { ...base, ...partial };
    await writeState(configPath, result.checkedAt, result.outcome);
    return result;
  };
  if (signal?.aborted) return cancelled();

  const providers = snapshot.config.providers.filter(provider => discoverableKinds.has(provider.type));
  const results = await discoverAll(providers, options.discoverModels ?? discoverManagementModels, options.refresh === true, signal,
    { ...(options.perProviderMs !== undefined ? { perProviderMs: options.perProviderMs } : {}), totalMs: options.totalMs ?? 120_000 });
  if (signal?.aborted) return cancelled();
  let checked = 0, failed = 0; const catalogs = new Map<string, CatalogRow[]>();
  for (const provider of providers) {
    const result = results.get(provider.id);
    if (!result || "deferred" in result) continue;
    checked++;
    if ("failed" in result) { failed++; continue; }
    if (!result.rows.length) continue;
    catalogs.set(provider.id, result.rows);
  }
  const native = settings.native ? await readNativeCatalog(options.nativeHome) : undefined;
  if (signal?.aborted) return cancelled({ providersChecked: checked, providersFailed: failed });

  let activated = 0, nativeUpdated = false, folded = false, blocked = false;
  let saved: ConfigSnapshot;
  try {
    saved = await mutateConfig(configPath, snapshot.revision, async current => {
      throwIfCancelled(signal);
      if (!current) throw new ManagementError("not_found");
      if (rawAutoLatest(current.raw)?.enabled !== true) return current.raw;
      const out = await applyAutoLatest(configPath, current, catalogs, native, Math.floor(now() / 1000));
      activated = out.activated; nativeUpdated = out.nativeUpdated; folded = out.folded; blocked = out.blocked;
      // Catalog caches are written only here, under the config lock, after the revision check and with the provider's
      // identity unchanged, so a removed or reconnected account never publishes its catalog under the same provider ID.
      for (const provider of providers) {
        const rows = catalogs.get(provider.id); const live = current.config.providers.find(item => item.id === provider.id);
        if (!rows || !live || providerRoute(live) !== providerRoute(provider)) continue;
        throwIfCancelled(signal);
        await saveCachedCatalog(configPath, live.id, mergeCatalog(live, rows), signal, live).catch(() => undefined);
      }
      return out.raw;
    }, signal);
  } catch (error) {
    const code = codeOf(error);
    if (code === lockBusyCode) throw error;
    const counts = { providersChecked: checked, providersFailed: failed };
    if (signal?.aborted || code === "cancelled") return cancelled(counts);
    if (code === "configuration_changed") return finish({ ...counts, outcome: "stale" });
    return finish({ ...counts, outcome: "failed" });
  }
  const outcome = activated > 0 || nativeUpdated ? "updated" : folded ? "baseline" : blocked ? "failed" : checked > 0 && failed === checked ? "failed" : failed > 0 ? "partial" : "unchanged";
  return finish({ outcome, changed: saved.revision !== snapshot.revision, activated, nativeUpdated, providersChecked: checked, providersFailed: failed });
}
