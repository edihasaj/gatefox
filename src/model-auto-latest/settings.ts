import { autoLatestFamilies, maximumScopeEntries, maximumScopedProviders, type AutoLatestScope, type AutoLatestSettings } from "./types.js";

const providerId = /^[a-z][a-z0-9_-]{0,63}$/;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const known: readonly string[] = autoLatestFamilies;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key));

function ids(value: unknown, valid: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > maximumScopeEntries) throw new Error("autoLatestModels lists are limited to 256 entries");
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !valid(item)) throw new Error("autoLatestModels contains an invalid entry");
    if (seen.has(item)) throw new Error("autoLatestModels lists must not repeat an entry");
    seen.add(item);
  }
  return [...seen];
}

export function validateAutoLatestScope(value: unknown): AutoLatestScope {
  if (!isRecord(value) || !exactKeys(value, ["families", "baselineModels", "baselinePending", "baselineBlocked"])) throw new Error("autoLatestModels scope is invalid");
  if (value.baselinePending !== undefined && typeof value.baselinePending !== "boolean") throw new Error("autoLatestModels baselinePending must be boolean");
  if (value.baselineBlocked !== undefined && typeof value.baselineBlocked !== "boolean") throw new Error("autoLatestModels baselineBlocked must be boolean");
  return { families: ids(value.families, item => known.includes(item)), baselineModels: ids(value.baselineModels, item => modelId.test(item)),
    ...(value.baselinePending === true && value.baselineBlocked !== true ? { baselinePending: true } : {}), ...(value.baselineBlocked === true ? { baselineBlocked: true } : {}) };
}

/** Strict runtime schema: unknown keys, unknown families, repeats and oversize lists are all refused. */
export function validateAutoLatestSettings(value: unknown): AutoLatestSettings {
  if (!isRecord(value) || !exactKeys(value, ["enabled", "providers", "native"])) throw new Error("autoLatestModels is invalid");
  if (typeof value.enabled !== "boolean") throw new Error("autoLatestModels.enabled must be boolean");
  if (!isRecord(value.providers)) throw new Error("autoLatestModels.providers must be an object");
  const keys = Object.keys(value.providers);
  if (keys.length > maximumScopedProviders) throw new Error("autoLatestModels is limited to 32 providers");
  const providers: Record<string, AutoLatestScope> = Object.create(null);
  for (const key of keys) {
    if (!providerId.test(key)) throw new Error("autoLatestModels provider IDs are invalid");
    providers[key] = validateAutoLatestScope(value.providers[key]);
  }
  const native = value.native === undefined ? undefined : validateAutoLatestScope(value.native);
  return { enabled: value.enabled, providers: { ...providers }, ...(native ? { native } : {}) };
}

/** The enabled-or-not settings in a raw configuration, or undefined when absent or invalid. Never throws. */
export function rawAutoLatest(raw: Record<string, unknown>): AutoLatestSettings | undefined {
  if (raw.autoLatestModels === undefined) return undefined;
  try { return validateAutoLatestSettings(raw.autoLatestModels); } catch { return undefined; }
}

/** Distinct valid IDs in order, or undefined when they exceed the 256-entry bound: a full list never silently drops one. */
export function strictUnion(...lists: Array<Iterable<string>>): string[] | undefined {
  const result = new Set<string>();
  for (const list of lists) for (const item of list) {
    if (!modelId.test(item)) continue;
    result.add(item);
    if (result.size > maximumScopeEntries) return undefined;
  }
  return [...result];
}
