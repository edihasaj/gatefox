import { loggableTier, offersServiceTier } from "./app-server-tier-offers.js";
import { object, tierSelection } from "./app-server-request-fields.js";
import { telemetry } from "./telemetry.js";

type ObjectValue = Record<string, unknown>;
/** A speed the gateway took off a session start because the chat's model does not offer it. */
export type TierDrop = { model: string; tier: string; method: string };

/**
 * Recorded only once the SDK accepted the request, so a rejected request leaves no event. A loaded chat
 * ignores a session-start override and answers with the tier it kept, so nothing was dropped then.
 */
export function recordTierDrops(models: ObjectValue[], drops: TierDrop[], result: ObjectValue): void {
  if (result.serviceTier !== undefined && result.serviceTier !== null && result.serviceTier !== "default") return;
  for (const drop of drops) telemetry("service_tier_dropped", { model: drop.model, tier: loggableTier(models, drop.tier), method: drop.method });
}

/**
 * At session start the SDK drops a tier the model lacks and starts Standard, so the gateway sends
 * serviceTier null. A tier that is not a string is left for the SDK to reject as invalid params.
 */
export function dropUnsupportedTier(models: ObjectValue[], params: ObjectValue, model: string, method: string, drops: TierDrop[]): ObjectValue {
  const tier = tierSelection(params);
  if (!tier || typeof tier.value !== "string" || offersServiceTier(models, model, tier.value)) return params;
  const { service_tier: _dropped, ...config } = object(params.config);
  drops.push({ model, tier: tier.value, method });
  return { ...params, serviceTier: null, ...(params.config === undefined ? {} : { config }) };
}

/** A resumed or forked chat starts with its own tier; one its row lacks starts Standard. A tier the gateway never read is left to the SDK. */
export function inheritedTier(models: ObjectValue[], params: ObjectValue, saved: string | null | undefined, model: string, method: string, drops: TierDrop[]): ObjectValue {
  if (tierSelection(params) || saved === undefined) return params;
  if (saved !== null && !offersServiceTier(models, model, saved)) {
    drops.push({ model, tier: saved, method });
    return { ...params, serviceTier: null };
  }
  return { ...params, serviceTier: saved };
}
