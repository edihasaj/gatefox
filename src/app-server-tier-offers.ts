import { readPublicServiceTierMetadata } from "./model-service-tiers.js";

type ModelRow = Record<string, unknown>;
const tierId = (value: string): string => value === "fast" ? "priority" : value;

/**
 * The gateway's view of the SDK's session-start check. Standard is always offered, and so is Flex: the SDK sends
 * Flex for every model and native Codex never refuses it. Any other tier is offered only if the row lists it.
 */
export function offersServiceTier(models: ModelRow[], model: string, tier: string): boolean {
  if (tier === "default" || tier === "flex") return true;
  const metadata = models.find(entry => entry.slug === model);
  if (!metadata) return false;
  try { return !!readPublicServiceTierMetadata(metadata).serviceTiers?.some(entry => entry.id === tierId(tier)); } catch { return false; }
}

/** Tier ids safe to log: the catalog's own plus the SDK's fixed names. Anything else is reported as "other". */
export function loggableTier(models: ModelRow[], tier: string): string {
  const known = new Set(["priority", "fast"]);
  for (const metadata of models) {
    try { for (const entry of readPublicServiceTierMetadata(metadata).serviceTiers ?? []) known.add(entry.id); } catch { /* an invalid row advertises nothing */ }
  }
  return known.has(tier) ? tier : "other";
}
