import { compareModels, familyOf, parseModelId } from "./families.js";
import { strictUnion } from "./settings.js";
import { pickerHidden } from "./metadata.js";
import { ManagementError } from "../app-management/errors.js";
import { autoLatestFamilies, type AutoLatestScope, type CatalogRow } from "./types.js";

/**
 * Pure decisions for auto-latest: which families a provider is watched for, and which catalog row, if any, supersedes the
 * current head of a family. Nothing here reads files, the network or the clock.
 */
const known: readonly string[] = autoLatestFamilies;

export interface VisibleEntry { id: string; releasedAt?: number }
export interface LatestPick { family: string; model: string; retired: string[]; row: CatalogRow }
type RouteSource = { models: Record<string, string>; modelMetadata?: Record<string, { pickerHidden?: boolean; releasedAt?: number } | undefined> };

const stamped = (id: string, value: unknown): VisibleEntry => typeof value === "number" && Number.isFinite(value) ? { id, releasedAt: value } : { id };
const rowEntry = (row: CatalogRow): VisibleEntry => stamped(row.id, row.metadata?.releasedAt);
/** Dated in the future, by its release time or by the date its ID carries. Such a model is never activated yet. */
const isFuture = (row: CatalogRow, nowSeconds: number): boolean => {
  const stated = row.metadata?.releasedAt; const inId = parseModelId(row.id)?.date;
  return (typeof stated === "number" && stated > nowSeconds) || (inId !== undefined && inId > nowSeconds);
};

/** Picker IDs as visible entries, dated from the native cache rows when they are known. */
export function pickerEntries(ids: readonly string[], rows: readonly CatalogRow[] | undefined): VisibleEntry[] {
  const dated = new Map((rows ?? []).map(row => [row.id, row.metadata?.releasedAt]));
  return ids.map(id => stamped(id, dated.get(id)));
}

/** Entries with an absent release time filled from the fresh catalog row of the exact same ID; a saved time always wins. */
export function withReleaseDates(entries: readonly VisibleEntry[], rows: readonly CatalogRow[]): VisibleEntry[] {
  const dated = new Map(rows.map(row => [row.id, row.metadata?.releasedAt]));
  return entries.map(entry => entry.releasedAt !== undefined ? entry : stamped(entry.id, dated.get(entry.id)));
}

/** Upstream models with at least one alias the picker shows. A picker-hidden route is retired history, not a current choice. */
export function visibleModels(provider: RouteSource): VisibleEntry[] {
  const seen = new Map<string, VisibleEntry>();
  for (const [alias, id] of Object.entries(provider.models)) {
    const metadata = provider.modelMetadata?.[alias];
    if (pickerHidden(metadata)) continue;
    const entry = stamped(id, metadata?.releasedAt); const prior = seen.get(id);
    if (!prior) seen.set(id, entry); else if (prior.releasedAt === undefined && entry.releasedAt !== undefined) prior.releasedAt = entry.releasedAt;
  }
  return [...seen.values()];
}

/** The recognizable families among the entries, in first-seen order. */
export function visibleFamilies(entries: readonly VisibleEntry[]): string[] {
  const result: string[] = [];
  for (const entry of entries) {
    const family = familyOf(entry.id);
    if (family && known.includes(family) && !result.includes(family)) result.push(family);
  }
  return result;
}

const inFamilies = (families: readonly string[], ids: Iterable<string>): string[] => [...ids].filter(id => families.includes(familyOf(id) ?? ""));

/**
 * A scope for the entries' families, or undefined when none is recognizable. The baseline holds every watched-family ID
 * known right now (other families can never be candidates). A baseline that would exceed the 256-entry bound is refused
 * before anything is armed, so no partial baseline is ever saved and no ID is silently left out.
 */
export function seedScope(visible: readonly VisibleEntry[], configured: Iterable<string>, catalogIds: Iterable<string>, previous: AutoLatestScope | undefined, pending: boolean): AutoLatestScope | undefined {
  const families = visibleFamilies(visible);
  if (!families.length) return undefined;
  const baselineModels = strictUnion(inFamilies(families, configured), inFamilies(families, previous?.baselineModels ?? []), inFamilies(families, catalogIds));
  if (!baselineModels) throw new ManagementError("invalid_request");
  return { families, baselineModels, ...(pending ? { baselinePending: true } : {}) };
}

/** The baseline after folding a first successful catalog into a pending scope, or undefined when it would not fit. */
export function foldBaseline(scope: AutoLatestScope, configured: Iterable<string>, rows: readonly CatalogRow[]): string[] | undefined {
  return strictUnion(scope.baselineModels, inFamilies(scope.families, configured), inFamilies(scope.families, rows.map(row => row.id)));
}

/**
 * For each watched family that has a visible entry, the one catalog row that is new (not in the baseline, not already
 * configured), not dated in the future, and strictly newer than every visible entry and every other new row. Ties,
 * unranked IDs and missing data pick nothing, so the current choice stays.
 */
export function pickLatest(scope: AutoLatestScope, visible: readonly VisibleEntry[], rows: readonly CatalogRow[], exclude: ReadonlySet<string>, nowSeconds: number): LatestPick[] {
  if (scope.baselinePending || scope.baselineBlocked) return [];
  const baseline = new Set(scope.baselineModels); const unique = new Map<string, CatalogRow>();
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);
  const picks: LatestPick[] = [];
  for (const family of scope.families) {
    if (!known.includes(family)) continue;
    const current = visible.filter(entry => familyOf(entry.id) === family);
    if (!current.length) continue;
    const fresh = [...unique.values()].filter(row => familyOf(row.id) === family && !baseline.has(row.id) && !exclude.has(row.id) && !current.some(entry => entry.id === row.id)
      && !isFuture(row, nowSeconds));
    const newer = fresh.filter(row => current.every(entry => compareModels(rowEntry(row), entry) > 0));
    const winners = newer.filter(row => newer.every(other => other === row || compareModels(rowEntry(row), rowEntry(other)) > 0));
    if (winners.length === 1) picks.push({ family, model: winners[0]!.id, retired: current.map(entry => entry.id), row: winners[0]! });
  }
  return picks;
}
