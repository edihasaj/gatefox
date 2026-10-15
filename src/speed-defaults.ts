/**
 * Speed rules for gateway chats. Pure: no I/O. Telemetry is the only side effect.
 *
 * The desktop applies a speed pick inside a chat with `thread/settings/update` and
 * then writes the same tier to `config/batchWrite service_tier`, which makes it the
 * default for every new chat. It also names its shared default speed on requests
 * that are not a speed choice (a reconnect resume, a notification reply, a fork's
 * config). Fast is chosen per gateway chat, so these rules keep each chat's own
 * speed and never let Fast become, or act as, a gateway new-chat default.
 */
import { telemetry } from "./telemetry.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
export type TierOption = { id: string; name: string };
export type Offers = (model: string, tier: string) => boolean;

export const tierPickWindowMs = 10_000;
/** Private preferences key: the desktop may still hold a Fast default it wrote, even after the default model changed. */
export const heldFastKey = "desktop_fast_default";

/** The tier a request names, from `serviceTier` or `config.service_tier`. */
export const tierSelection = (params: ObjectValue): { value: unknown } | undefined => Object.hasOwn(params, "serviceTier") && params.serviceTier !== undefined
  ? { value: params.serviceTier } : Object.hasOwn(object(params.config), "service_tier") ? { value: object(params.config).service_tier } : undefined;
export const tierId = (value: unknown): unknown => value === "fast" ? "priority" : value;
export const isStandard = (value: unknown): boolean => value === null || value === "default";
const sameTier = (left: unknown, right: unknown): boolean => isStandard(left) ? isStandard(right) : tierId(left) === tierId(right);
// Telemetry names only tiers the gateway knows; a caller-supplied id is never logged.
export const tierLabel = (value: unknown): string => value === null ? "default" : ["priority", "flex", "default", "ultrafast"].includes(String(tierId(value))) ? String(tierId(value)) : "other";

/** The public tier ids and names that catalog rows offer. */
export const tierOptions = (rows: ObjectValue[]): TierOption[] => rows.flatMap(row => Array.isArray(row.service_tiers) ? row.service_tiers.map(object) : [])
  .filter((option): option is TierOption => typeof option.id === "string" && typeof option.name === "string");
/** Mirrors the desktop's own speed classification: Fast or Ultrafast by id, or by the tier's displayed name. */
export function isSpeedTier(tier: unknown, options: TierOption[] = []): boolean {
  if (typeof tier !== "string") return false;
  if (["priority", "fast", "ultrafast"].includes(tier)) return true;
  return options.some(option => option.id === tier && ["fast", "ultrafast", "priority"].includes(option.name.trim().toLowerCase()));
}

/** The same request without any tier, so the receiver keeps the chat's current one. */
export function withoutTier(params: ObjectValue): ObjectValue {
  const { serviceTier: _tier, ...rest } = params;
  if (!Object.hasOwn(object(params.config), "service_tier")) return rest;
  const { service_tier: _configured, ...config } = object(params.config);
  return { ...rest, config };
}
export const standardTier = (params: ObjectValue): ObjectValue => ({ ...withoutTier(params), serviceTier: null });

/** A tier the row does not offer becomes Standard, as native core omits an unsupported tier. */
export function offeredTier(params: ObjectValue, model: string, method: string, offers: Offers): ObjectValue {
  const tier = tierSelection(params);
  if (!tier || typeof tier.value !== "string" || tier.value === "default" || offers(model, tier.value)) return params;
  telemetry("service_tier_reset", { from: tierLabel(tier.value), model, method, reason: "unoffered" });
  return standardTier(params);
}

/**
 * A gateway chat's speed changes only through a speed pick (`thread/settings/update`).
 * A turn that keeps the chat's model is sent without a tier, so the engine keeps the
 * chat's own; a resume or fork gets the chat's recorded tier. When that tier is unknown
 * or no longer offered, the request's own tier applies, normalized as above.
 */
export function chatTier(params: ObjectValue, method: string, model: string, own: string | null | undefined, offers: Offers): ObjectValue {
  const requested = tierSelection(params);
  if (!requested || (requested.value !== null && typeof requested.value !== "string")) return params;
  const known = own !== undefined && (own === null || offers(model, own));
  if (!known && !(method === "turn/start" && own === undefined)) return offeredTier(params, model, method, offers);
  if (known && !sameTier(requested.value, own)) telemetry("service_tier_kept", { requested: tierLabel(requested.value), kept: tierLabel(own), model, method });
  return method === "turn/start" ? withoutTier(params) : { ...withoutTier(params), serviceTier: own };
}

export type TierPick = { source: "gateway-chat" | "native-chat"; fast: boolean; atMs: number };

/** Remembers the latest explicit speed pick just long enough to link it to the desktop's follow-up default write. */
export class ChatTierPicks {
  private last?: TierPick;
  record(source: TierPick["source"], fast: boolean, atMs = Date.now()): void { this.last = { source, fast, atMs }; }
  clear(): void { this.last = undefined; }
  /** Returns the pick if it is recent, and always consumes it. */
  take(atMs = Date.now()): TierPick | undefined {
    const pick = this.last; this.last = undefined;
    return pick && atMs - pick.atMs <= tierPickWindowMs ? pick : undefined;
  }
}

/**
 * Only for Fast default writes; Standard writes always persist. While the default model
 * is a gateway model, a Fast default would start every later new chat in Fast (the
 * desktop keeps an accepted default in memory), so it is refused. A pick made inside a
 * gateway chat belongs to that chat and is refused as a default for any model.
 */
export function fastDefaultDecision(pick: TierPick | undefined, defaultIsGateway: boolean): "reject" | "save" {
  return defaultIsGateway || (pick?.fast && pick.source === "gateway-chat") ? "reject" : "save";
}
