import type { ProviderConfig } from "../config.js";
import type { ConfigSnapshot } from "../app-management/storage.js";
import { loadAliases, rememberCurrentAliases, rememberProviderAliases, reservedAliases, saveAliases } from "../app-management/aliases.js";
import { validateRaw } from "../app-management/drafts.js";
import { ManagementError } from "../app-management/errors.js";
import { aliasFor } from "../app-management/mutations.js";
import { isManagementUnavailable } from "../app-management/runtime.js";
import { foldBaseline, pickLatest, pickerEntries, visibleModels, withReleaseDates } from "./planner.js";
import { strictUnion, validateAutoLatestSettings } from "./settings.js";
import type { AutoLatestScope, AutoLatestSettings, CatalogRow } from "./types.js";

export interface ApplyOutput { raw: Record<string, unknown>; activated: number; nativeUpdated: boolean; folded: boolean; blocked: boolean; dirty: boolean; touched: Set<string> }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Metadata for a newly activated alias: the catalog's own, never a hidden flag a vendor row might carry. */
function freshMetadata(row: CatalogRow, minimal: boolean): Record<string, unknown> {
  const { pickerHidden: _ignored, ...rest } = row.metadata ?? {};
  const displayName = typeof rest.displayName === "string" && rest.displayName ? rest.displayName : row.label;
  if (!minimal) return { ...rest, displayName };
  return { displayName, ...(typeof rest.releasedAt === "number" ? { releasedAt: rest.releasedAt } : {}) };
}

type Ledger = Awaited<ReturnType<typeof loadAliases>>;

/**
 * Computes the next raw configuration. Retirement only sets `pickerHidden` on the old alias; its route, alias and
 * upstream model stay exactly as saved. The new version gets a new alias from the private ledger. A baseline that would
 * overflow its bound blocks the activation instead of dropping an entry.
 */
function plan(snapshot: ConfigSnapshot, ledger: Ledger, catalogs: ReadonlyMap<string, CatalogRow[]>, native: CatalogRow[] | undefined, nowSeconds: number, minimal: boolean): ApplyOutput {
  const raw = structuredClone(snapshot.raw);
  const out: ApplyOutput = { raw, activated: 0, nativeUpdated: false, folded: false, blocked: false, dirty: false, touched: new Set() };
  const settings: AutoLatestSettings = validateAutoLatestSettings(raw.autoLatestModels);
  if (!settings.enabled) return out;
  const before = JSON.stringify(settings);
  const rawProviders = Array.isArray(raw.providers) ? raw.providers.filter(isRecord) : [];
  const aliases = reservedAliases(snapshot.config, ledger);
  for (const provider of snapshot.config.providers) {
    const scope = settings.providers[provider.id]; const rows = catalogs.get(provider.id); const target = rawProviders.find(item => item.id === provider.id);
    if (!scope || !rows?.length || !target || !isRecord(target.models)) continue;
    const models = target.models as Record<string, string>;
    if (scope.baselineBlocked) continue;
    if (scope.baselinePending) {
      // A fold that cannot hold every known ID blocks the scope for good: dropping any would let it reappear as "new".
      const baseline = foldBaseline(scope, Object.values(models), rows);
      if (baseline) { settings.providers[provider.id] = { families: scope.families, baselineModels: baseline }; out.folded = true; }
      else { settings.providers[provider.id] = { families: scope.families, baselineModels: scope.baselineModels, baselineBlocked: true }; out.blocked = true; }
      continue;
    }
    const metadata = (isRecord(target.modelMetadata) ? target.modelMetadata : undefined) as Record<string, { pickerHidden?: boolean; releasedAt?: number }> | undefined;
    const picks = pickLatest(scope, withReleaseDates(visibleModels({ models, modelMetadata: metadata }), rows), rows, new Set(Object.values(models)), nowSeconds);
    let baseline = scope.baselineModels; let changed = false;
    for (const pick of picks) {
      const next = strictUnion(baseline, [pick.model]);
      if (!next) continue;
      baseline = next; changed = true;
      const claimed = new Set(Object.keys(models));
      const alias = aliasFor(provider, pick.model, aliases, claimed, ledger.aliases);
      const table = (isRecord(target.modelMetadata) ? target.modelMetadata : (target.modelMetadata = {})) as Record<string, Record<string, unknown>>;
      models[alias] = pick.model; table[alias] = freshMetadata(pick.row, minimal);
      for (const retired of pick.retired) for (const [other, id] of Object.entries(models)) if (id === retired && other !== alias) table[other] = { ...(table[other] ?? {}), pickerHidden: true };
      out.activated++; out.touched.add(provider.id);
    }
    if (changed) settings.providers[provider.id] = { families: scope.families, baselineModels: baseline };
  }
  nativeStep(raw, settings, native, nowSeconds, out);
  if (JSON.stringify(settings) !== before) { raw.autoLatestModels = settings; out.dirty = true; }
  return out;
}

/** Only the gateway's own `nativeModelPicker` allowlist changes; unknown selected IDs keep their places. */
function nativeStep(raw: Record<string, unknown>, settings: AutoLatestSettings, native: CatalogRow[] | undefined, nowSeconds: number, out: ApplyOutput): void {
  const scope: AutoLatestScope | undefined = settings.native;
  // An empty native catalog is unavailable, not a complete one: it never folds a baseline and never activates.
  if (!scope || !native?.length || scope.baselineBlocked || !Array.isArray(raw.nativeModelPicker)) return;
  let picker = (raw.nativeModelPicker as unknown[]).filter((item): item is string => typeof item === "string");
  if (scope.baselinePending) {
    const baseline = foldBaseline(scope, picker, native);
    if (baseline) { settings.native = { families: scope.families, baselineModels: baseline }; out.folded = true; }
    else { settings.native = { families: scope.families, baselineModels: scope.baselineModels, baselineBlocked: true }; out.blocked = true; }
    return;
  }
  let baseline = scope.baselineModels; let changed = false;
  for (const pick of pickLatest(scope, pickerEntries(picker, native), native, new Set(picker), nowSeconds)) {
    const next = strictUnion(baseline, [pick.model]);
    if (!next) continue;
    baseline = next; changed = true;
    const retired = new Set(pick.retired); const result: string[] = []; let placed = false;
    for (const id of picker) {
      if (!retired.has(id)) { result.push(id); continue; }
      if (!placed) { result.push(pick.model); placed = true; }
    }
    if (!placed) result.push(pick.model);
    picker = result; out.nativeUpdated = true;
  }
  if (changed) { raw.nativeModelPicker = picker; settings.native = { families: scope.families, baselineModels: baseline }; }
}

/** The next raw configuration for one reconcile pass, validated; the alias ledger is saved only after validation passes. */
export async function applyAutoLatest(configPath: string, snapshot: ConfigSnapshot, catalogs: ReadonlyMap<string, CatalogRow[]>, native: CatalogRow[] | undefined, nowSeconds: number): Promise<ApplyOutput> {
  const ledger = await loadAliases(configPath); rememberCurrentAliases(ledger, snapshot.config);
  let out = plan(snapshot, ledger, catalogs, native, nowSeconds, false);
  const changed = (value: ApplyOutput) => value.dirty;
  if (changed(out)) {
    try { await validateRaw(out.raw, configPath); }
    catch (error) {
      // A plain validation failure (odd vendor metadata) is retried once with only the display name and release time.
      if (error instanceof ManagementError || isManagementUnavailable(error) || !out.activated) throw error;
      out = plan(snapshot, ledger, catalogs, native, nowSeconds, true);
      await validateRaw(out.raw, configPath);
    }
  }
  if (out.touched.size) {
    const providers = Array.isArray(out.raw.providers) ? out.raw.providers.filter(isRecord) : [];
    for (const id of out.touched) {
      const provider = snapshot.config.providers.find(item => item.id === id); const target = providers.find(item => item.id === id);
      if (provider && target) rememberProviderAliases(ledger, { ...provider, models: target.models as ProviderConfig["models"] });
    }
    await saveAliases(configPath, ledger);
  }
  return out;
}
