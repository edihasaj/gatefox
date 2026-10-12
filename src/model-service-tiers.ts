export interface ModelServiceTier { id: string; name: string; description: string }
export interface ModelServiceTierMetadata {
  additionalSpeedTiers?: string[];
  serviceTiers?: ModelServiceTier[];
  defaultServiceTier?: string | null;
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,127}$/.test(value);
const validText = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !value.includes("\0");

/** Only declared public capabilities become picker options; standard routing is implicit. */
export function readServiceTierMetadata(value: unknown): ModelServiceTierMetadata {
  const metadata = object(value); const result: ModelServiceTierMetadata = {};
  if (metadata.additionalSpeedTiers !== undefined) {
    const tiers = metadata.additionalSpeedTiers;
    if (!Array.isArray(tiers) || tiers.length > 32 || tiers.some(tier => !validId(tier) || tier === "default") || new Set(tiers).size !== tiers.length) throw new Error("Invalid additional speed tiers in model metadata");
    result.additionalSpeedTiers = [...tiers];
  }
  if (metadata.serviceTiers !== undefined) {
    const tiers = metadata.serviceTiers;
    if (!Array.isArray(tiers) || tiers.length > 32) throw new Error("Invalid service tiers in model metadata");
    result.serviceTiers = tiers.map(value => {
      const tier = object(value);
      if (!validId(tier.id) || ["default", "fast"].includes(tier.id) || !validText(tier.name, 1024) || !tier.name || !validText(tier.description, 8192)) throw new Error("Invalid service tier in model metadata");
      return { id: tier.id, name: tier.name, description: tier.description };
    });
    if (new Set(result.serviceTiers.map(tier => tier.id)).size !== result.serviceTiers.length) throw new Error("Duplicate service tier in model metadata");
  }
  if (metadata.defaultServiceTier !== undefined) {
    const tier = metadata.defaultServiceTier;
    if (tier !== null && (!validId(tier) || !result.serviceTiers?.some(entry => entry.id === tier))) throw new Error("Default service tier must refer to an advertised service tier");
    result.defaultServiceTier = tier;
  }
  return result;
}

/** ModelInfo uses snake_case; model/list and gateway configuration use camelCase. */
export function readPublicServiceTierMetadata(value: Record<string, unknown>): ModelServiceTierMetadata {
  return readServiceTierMetadata({ additionalSpeedTiers: value.additional_speed_tiers, serviceTiers: value.service_tiers, defaultServiceTier: value.default_service_tier });
}

export function publicServiceTierFields(value: ModelServiceTierMetadata): Record<string, unknown> {
  return { additional_speed_tiers: value.additionalSpeedTiers || [], service_tiers: value.serviceTiers || [], default_service_tier: value.defaultServiceTier ?? null };
}
