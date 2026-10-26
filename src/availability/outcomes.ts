/**
 * The availability classes of recent request outcomes, per provider, in memory only. A request's failure keeps only its fixed
 * class, code and time: never a message, a body, a model name or a credential.
 */
export type FailureClass = "quota" | "throttle" | "authentication" | "connection";
export interface ProviderFailureFact { class: FailureClass; code: string; at: number; retryAt?: number }
export interface ProviderOutcome { lastSuccessAt?: number; lastFailure?: ProviderFailureFact }

const quotaCodes = new Set(["usage_limit", "insufficient_quota", "usage_limit_reached", "credit_balance_exhausted", "billing_hard_limit_reached",
  "billing_not_active", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "subscription_sharing_usage_limit_exceeded", "billing_error"]);
const throttleCodes = new Set(["rate_limit_exceeded", "rate_limit", "slow_down"]);
const authenticationCodes = new Set(["authentication", "authentication_failed", "invalid_api_key", "token_expired", "unauthorized", "authentication_error"]);
const connectionCodes = new Set(["upstream_unavailable", "provider_unreachable"]);

/** The availability class of a failure, from the gateway code and the allowlisted upstream code; undefined when it says nothing about availability. */
export function failureClass(code: string, upstreamCode?: string): FailureClass | undefined {
  for (const value of [upstreamCode, code]) {
    if (value === undefined) continue;
    if (quotaCodes.has(value)) return "quota";
    if (authenticationCodes.has(value)) return "authentication";
    if (throttleCodes.has(value)) return "throttle";
  }
  return connectionCodes.has(code) ? "connection" : undefined;
}

export class ProviderOutcomes {
  private readonly rows = new Map<string, ProviderOutcome>();
  constructor(private readonly now = () => Date.now()) {}
  success(providerId: string): void { this.row(providerId).lastSuccessAt = this.now(); }
  /** Keeps a failure only when its class tells something about availability. A gateway shutdown or a caller's cancellation is not one. */
  failure(providerId: string, code: string, upstreamCode?: string, retryAfterMs?: number, abortCause?: string): void {
    if (abortCause) return;
    const kind = failureClass(code, upstreamCode); if (!kind) return;
    const at = this.now();
    this.row(providerId).lastFailure = { class: kind, code: upstreamCode && failureClass(upstreamCode) ? upstreamCode : code, at,
      ...(retryAfterMs !== undefined && Number.isInteger(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= 86400000 ? { retryAt: at + retryAfterMs } : {}) };
  }
  get(providerId: string): ProviderOutcome { return { ...this.rows.get(providerId) }; }
  /** Drops what was observed for a provider whose account, credential or endpoint changed under the same id. */
  forget(providerId: string): void { this.rows.delete(providerId); }
  private row(providerId: string): ProviderOutcome {
    let row = this.rows.get(providerId);
    if (!row) { if (this.rows.size >= 256) this.rows.delete(this.rows.keys().next().value!); row = {}; this.rows.set(providerId, row); }
    return row;
  }
}
