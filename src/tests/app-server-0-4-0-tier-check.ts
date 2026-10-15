import { readPublicServiceTierMetadata } from "../model-service-tiers.js";

/**
 * The 0.4.0 build's service tier checks, copied from release commit 4a8bb9e (src/app-server-router.ts: offersServiceTier,
 * assertServiceTier, and the tier part of routedRequest for thread/resume, thread/fork, turn/start and the settings
 * updates). 0.4.0 adapters keep running beside this build on the same state files until the desktop restarts its CLI, and
 * after a rollback, so a tier this build saves must pass them. Do not change them to match new behavior; they are the old
 * build. Only the SDK-facing telemetry and reasoning restore are left out, because they neither check nor change a tier.
 */
type ObjectValue = Record<string, unknown>;
type ModelRow = ObjectValue;
export class OldRoutingError extends Error { constructor(message: string, readonly code: number = -32600) { super(message); } }
export type OldRoute = { provider: string; model?: string; serviceTier?: string | null };
const gatewayProvider = "subscription_gateway";
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const requestedModel = (params: ObjectValue): unknown => object(object(params.collaborationMode).settings).model ?? params.model ?? object(params.config).model;
const tierSelection = (params: ObjectValue): { value: unknown } | undefined => Object.hasOwn(params, "serviceTier") && params.serviceTier !== undefined
  ? { value: params.serviceTier } : Object.hasOwn(object(params.config), "service_tier") ? { value: object(params.config).service_tier } : undefined;
const tierId = (value: unknown): unknown => value === "fast" ? "priority" : value;

export class Build040 {
  constructor(private readonly extraModels: ModelRow[]) {}
  offersServiceTier(model: string, tier: string): boolean {
    try { this.assertServiceTier(model, tier); return true; } catch { return false; }
  }
  assertServiceTier(model: string, tier: unknown): void {
    if (tier === null || tier === "default") return;
    const metadata = this.extraModels.find(entry => entry.slug === model);
    if (typeof tier !== "string" || !metadata || !readPublicServiceTierMetadata(metadata).serviceTiers?.some(entry => entry.id === tierId(tier))) {
      throw new OldRoutingError("This gateway model does not support the selected service tier. Choose Standard or a model that offers that tier.", -32002);
    }
  }
  /** 0.4.0 checked a saved new-chat default with this call when it was written. */
  assertSavedDefault(model: string, tier: unknown): void { this.assertServiceTier(model, tier); }
  /** Throws exactly where 0.4.0's routedRequest threw for a gateway chat; returns the request it would forward. */
  routedTierCheck(method: string, params: ObjectValue, route: OldRoute): ObjectValue {
    let forwarded = params;
    const selectedModel = requestedModel(params) ?? route.model;
    if (route.provider === gatewayProvider && typeof selectedModel === "string") {
      const tier = tierSelection(params);
      const turnTier = typeof params.serviceTierForTurn === "string" ? params.serviceTierForTurn : undefined;
      if (route.serviceTier === undefined && selectedModel !== route.model && !tier && turnTier === undefined) throw new OldRoutingError("This chat's current service tier is unavailable. Resume the chat to read its settings or explicitly choose Standard before changing models.", -32002);
      if (tier) this.assertServiceTier(selectedModel, tier.value);
      else if (turnTier === undefined && typeof route.serviceTier === "string") {
        if (method === "thread/settings/update" && selectedModel !== route.model && !this.offersServiceTier(selectedModel, route.serviceTier)) {
          forwarded = { ...forwarded, serviceTier: null };
        } else this.assertServiceTier(selectedModel, route.serviceTier);
      }
      if (turnTier !== undefined) this.assertServiceTier(selectedModel, turnTier);
      if (turnTier === "fast") forwarded = { ...params, serviceTierForTurn: "priority" };
    }
    if (["thread/resume", "thread/fork"].includes(method) && route.provider === gatewayProvider) {
      if (method === "thread/fork" && !tierSelection(params) && route.serviceTier === undefined) throw new OldRoutingError("The parent chat's service tier is unavailable. Resume it to read its settings or explicitly choose a tier for the fork.", -32002);
    }
    return forwarded;
  }
}
