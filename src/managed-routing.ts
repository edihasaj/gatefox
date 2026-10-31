import { createHash } from "node:crypto";
import type { GatewayConfig, ProviderConfig } from "./config.js";
import type { ResponsesRequest } from "./protocol/types.js";
import { ProviderError, type InferenceContext } from "./providers/provider.js";
import { managedCandidateKind, type ManagedRoutePolicy } from "./managed-routing-config.js";
import { ManagedRoutePins, managedWorkerKey, type ManagedRoutePin } from "./managed-route-pins.js";
import { freshFor } from "./availability/report.js";

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const failure = (code: string, message: string, status = 503): never => { throw new ProviderError(code, message, status); };
const fresh = (v: Row, age: number, now: number) => {
  const at = typeof v.observedAt === "string" ? Date.parse(v.observedAt) : NaN;
  return v.fresh === true && Number.isFinite(at) && at <= now && now - at <= age;
};
function binding(provider: ProviderConfig, upstream: string): string {
  return hash([provider.id, provider.type, provider.credentialFile ?? "", provider.authDirectory ?? "", provider.baseUrl ?? "", provider.apiKeyEnv ?? "", provider.tailnet === true, upstream]);
}
function usable(row: Row, pinned: boolean): boolean {
  return row.status === "available" || (pinned && row.status === "busy");
}
function supported(provider: ProviderConfig, alias: string, request: ResponsesRequest): boolean {
  const metadata = provider.modelMetadata?.[alias];
  const effort = object(request.reasoning).effort;
  if (typeof effort === "string" && !metadata?.reasoningEfforts?.includes(effort)) return false;
  for (const tool of request.tools ?? []) {
    const type = object(tool).type;
    if (type === "tool_search" && (provider.type !== "codex-subscription" || provider.toolSearch !== "bridge")) return false;
    if ((type === "web_search" || type === "web_search_preview") && provider.type !== "codex-subscription") return false;
  }
  const containsImage = JSON.stringify(request.input).includes('"type":"input_image"');
  return !containsImage || metadata?.inputModalities?.includes("image") === true;
}
function eligible(provider: ProviderConfig, alias: string, row: Row, policy: ManagedRoutePolicy, request: ResponsesRequest, now: number, pinned: boolean): boolean {
  if (!usable(row, pinned) || !supported(provider, alias, request)) return false;
  const kind = managedCandidateKind(provider, provider.models[alias]!);
  if (kind === "local") {
    const health = object(row.health);
    return fresh(health, freshFor.health, now) && (health.status === "healthy" || health.status === "degraded")
      && Array.isArray(health.servedModels) && health.servedModels.includes(provider.models[alias]);
  }
  if (kind === "subscription") {
    const quota = object(row.quota);
    return fresh(quota, freshFor.quota, now) && typeof quota.remainingPercent === "number" && Number.isFinite(quota.remainingPercent)
      && quota.remainingPercent > policy.minRemainingPercent && quota.remainingPercent <= 100;
  }
  const balance = object(row.balance);
  return kind === "paid-flash" && policy.allowPaid && fresh(balance, freshFor.balance, now)
    && typeof balance.remainingUsd === "number" && Number.isFinite(balance.remainingUsd) && balance.remainingUsd > 0;
}
/** Unknown quota or a queue alone never proves that subscription capacity is unavailable. */
function confirmedBlocked(row: Row, policy: ManagedRoutePolicy, now: number): boolean {
  const reasons = Array.isArray(row.reasons) ? row.reasons : [];
  if ((row.status === "unavailable" || row.status === "limited") && reasons.some(v => ["authentication", "connection_failed", "unhealthy", "quota_exhausted", "rate_limited"].includes(String(v)))) return true;
  const quota = object(row.quota);
  return fresh(quota, freshFor.quota, now) && typeof quota.remainingPercent === "number" && Number.isFinite(quota.remainingPercent)
    && quota.remainingPercent >= 0 && quota.remainingPercent <= policy.minRemainingPercent;
}
export interface ManagedRouteDecision { alias: string; providerId: string; reused: boolean; contextBytes: number }

/** Opt-in provider selection before inference. It never rewrites or truncates caller context. */
export class ManagedRouter {
  private readonly pins: ManagedRoutePins;
  constructor(stateDirectory: string, private readonly now: () => number = Date.now) { this.pins = new ManagedRoutePins(stateDirectory); }
  async resolve(config: GatewayConfig, request: ResponsesRequest, context: InferenceContext, report: Row): Promise<ManagedRouteDecision | undefined> {
    const routes = config.managedRouting?.routes;
    if (!routes || !Object.hasOwn(routes, request.model)) return;
    const policy = routes[request.model]!;
    const identity = context.threadId ?? context.sessionId;
    if (!identity) return failure("managed_route_identity_required", "Managed routing requires a stable worker thread or session identifier", 400);
    const contextBytes = Buffer.byteLength(JSON.stringify(request), "utf8");
    // Summarizing accumulated history needs more room than an ordinary turn. This
    // allowance never creates a binding or moves an existing worker to another provider.
    const compacting = context.requestKind === "compaction";
    const byteLimit = compacting ? Math.min(4 * policy.maxContextBytes, 4194304) : policy.maxContextBytes;
    if (contextBytes > byteLimit) failure("context_length_exceeded", compacting
      ? "Managed compaction exceeds its recovery byte budget; start a fresh bounded worker with an explicit handoff"
      : "Managed worker context exceeds its byte budget; compact it in the client or start a fresh bounded worker", 400);
    const candidates = policy.candidates.map(alias => ({ alias, provider: config.providers.find(p => Object.hasOwn(p.models, alias)) }));
    if (candidates.some(c => !c.provider)) failure("managed_route_unavailable", "A managed route candidate was removed; a fresh configuration is required");
    const rows = new Map((Array.isArray(report.providers) ? report.providers : []).map(v => { const row = object(v); return [row.id, row] as const; }));
    const now = this.now();
    const subscriptions = candidates.filter(c => managedCandidateKind(c.provider!, c.provider!.models[c.alias]!) === "subscription");
    const paidAllowed = policy.allowPaid && subscriptions.length > 0 && subscriptions.every(c => confirmedBlocked(rows.get(c.provider!.id) ?? {}, policy, now));
    const allowed = (alias: string, provider: ProviderConfig, pinned: boolean) =>
      eligible(provider, alias, rows.get(provider.id) ?? {}, policy, request, now, pinned)
      && (managedCandidateKind(provider, provider.models[alias]!) !== "paid-flash" || paidAllowed);
    try {
      return await this.pins.withPin(managedWorkerKey(request.model, identity), async (pin, save) => {
        const fingerprint = hash(policy);
        if (pin) {
          const candidate = candidates.find(c => c.alias === pin.alias);
          if (pin.policyFingerprint !== fingerprint || !candidate?.provider || pin.providerId !== candidate.provider.id
            || pin.upstreamModel !== candidate.provider.models[candidate.alias] || pin.bindingFingerprint !== binding(candidate.provider, pin.upstreamModel))
            return failure("managed_route_changed", "The managed worker binding changed; start a fresh worker with an explicit handoff", 400);
          if (!allowed(candidate.alias, candidate.provider, true)) return failure("managed_route_unavailable", "The pinned worker route is unavailable; retry it or start a fresh worker with a bounded handoff");
          return { alias: candidate.alias, providerId: candidate.provider.id, reused: true, contextBytes };
        }
        if (compacting) return failure("managed_route_state_unbound", "Managed compaction needs an existing worker binding; start a fresh worker with a plaintext handoff", 400);
        // Opaque provider state cannot be assigned a new account without an existing pin.
        if (request.previous_response_id || /"encrypted_content"|"encryptedFunctionArgs"/.test(JSON.stringify(request.input)))
          return failure("managed_route_state_unbound", "Provider-specific continuation needs its original managed pin; start a fresh worker with a plaintext handoff", 400);
        const selected = candidates.find(c => allowed(c.alias, c.provider!, false));
        if (!selected?.provider) return failure("managed_route_unavailable", "No eligible managed provider has confirmed capacity; unknown quota and busy queues do not authorize paid escalation");
        const value: ManagedRoutePin = { schema: "managed-route-pin.v1", alias: selected.alias, providerId: selected.provider.id,
          upstreamModel: selected.provider.models[selected.alias]!, bindingFingerprint: binding(selected.provider, selected.provider.models[selected.alias]!), policyFingerprint: fingerprint };
        await save(value);
        return { alias: selected.alias, providerId: selected.provider.id, reused: false, contextBytes };
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      return failure("managed_route_state_unavailable", "Managed routing state cannot be verified; no provider was invoked");
    }
  }
}
