import { readPublicServiceTierMetadata } from "./model-service-tiers.js";
import { storableServiceTier } from "./thread-service-tiers.js";

type ModelRow = Record<string, unknown>;
const tierId = (value: string): string => value === "fast" ? "priority" : value;

/**
 * The check the 0.4.0 build made everywhere: Standard is always declared, and any other tier only if the row's
 * catalog metadata lists it. There is no Flex exemption. A chat or saved default is kept in the private stores only
 * for a tier this accepts, so 0.4.0 never refuses what this build wrote.
 */
export function declaresServiceTier(models: ModelRow[], model: string, tier: string): boolean {
  if (tier === "default") return true;
  const metadata = models.find(entry => entry.slug === model);
  if (!metadata) return false;
  try { return !!readPublicServiceTierMetadata(metadata).serviceTiers?.some(entry => entry.id === tierId(tier)); } catch { return false; }
}

/**
 * The gateway's view of the SDK's session-start check. Standard is always offered, and so is Flex: the SDK sends
 * Flex for every model and native Codex never refuses it. Any other tier is offered only if the row lists it.
 */
export function offersServiceTier(models: ModelRow[], model: string, tier: string): boolean {
  return tier === "flex" || declaresServiceTier(models, model, tier);
}

/** Tier ids safe to log: the catalog's own plus the SDK's fixed names. Anything else is reported as "other". */
export function loggableTier(models: ModelRow[], tier: string): string {
  const known = new Set(["priority", "fast"]);
  for (const metadata of models) {
    try { for (const entry of readPublicServiceTierMetadata(metadata).serviceTiers ?? []) known.add(entry.id); } catch { /* an invalid row advertises nothing */ }
  }
  return known.has(tier) ? tier : "other";
}

/**
 * The tier the private thread tier store may hold for a chat on this row. A tier the row declares is kept; any other
 * tier the store can hold is Standard (null), because 0.4.0 refuses a saved tier its row does not declare. A tier the
 * store cannot hold at all is returned unchanged for the caller's unknown-tier path.
 */
export function recordableTier(models: ModelRow[], model: string, tier: string | null): string | null {
  return tier !== null && storableServiceTier(tier) && !declaresServiceTier(models, model, tier) ? null : tier;
}
