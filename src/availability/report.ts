import type { GatewayConfig, ProviderConfig } from "../config.js";
import { isCodexUsage, type ObservedProviderUsage } from "../provider-usage.js";
import type { ProviderOutcome } from "./outcomes.js";
import type { HealthFact } from "./probe.js";
import { liveWindows, remainingPercent, type BalanceFact, type QuotaFact, type QuotaWindow } from "./quota.js";

export type AvailabilityStatus = "available" | "busy" | "limited" | "unavailable" | "unknown";
export type AvailabilityReason = "unhealthy" | "degraded" | "health_unknown" | "authentication" | "connection_failed" | "quota_exhausted"
  | "rate_limited" | "no_credit" | "at_capacity" | "queued";
export interface ProviderFacts {
  provider: ProviderConfig; models: string[]; local: boolean;
  load: { running: number; queued: number; limit: number };
  health?: HealthFact; quota?: QuotaFact; balance?: BalanceFact; outcome: ProviderOutcome;
}

/** How long each kind of observation counts as current. */
export const freshFor = { health: 90_000, quota: 900_000, balance: 900_000 } as const;
const unavailableReasons = new Set<AvailabilityReason>(["unhealthy", "authentication", "connection_failed"]);
const limitedReasons = new Set<AvailabilityReason>(["quota_exhausted", "rate_limited", "no_credit"]);
const iso = (value: number | undefined) => value === undefined ? undefined : new Date(value).toISOString();

/** The gateway's own usage observations for one provider, as a quota fact; Claude rows only count when a window was refused. */
export function gatewayQuota(provider: ProviderConfig, rows: ObservedProviderUsage[], now: number): QuotaFact | undefined {
  const own = rows.filter(row => row.providerId === provider.id); if (!own.length) return;
  const windows: QuotaWindow[] = []; let observedAt = 0;
  for (const row of own) {
    // Only a row that contributes a window dates the fact: an allowed Claude row says nothing about the refused one.
    const before = windows.length;
    if (isCodexUsage(row)) {
      for (const entry of [row.primary, row.secondary]) if (entry) windows.push({ minutes: entry.windowMinutes, usedPercent: entry.usedPercent, resetsAt: entry.resetsAt * 1000 });
    } else if (row.status === "rejected") windows.push({ minutes: row.window === "five_hour" ? 300 : 10080, usedPercent: 100, resetsAt: row.resetsAt * 1000 });
    if (windows.length > before) observedAt = Math.max(observedAt, row.observedAt * 1000);
  }
  if (!windows.length) return;
  const remaining = remainingPercent(windows, now);
  return { source: "gateway", observedAt, windows, ...(remaining !== undefined ? { remainingPercent: remaining } : {}) };
}
/** The newer of two quota observations; the gateway's own refusal is newer than an earlier Spendwatch reading. */
export const newerQuota = (a: QuotaFact | undefined, b: QuotaFact | undefined) => !a ? b : !b ? a : b.observedAt > a.observedAt ? b : a;

export function reasonsFor(facts: ProviderFacts, now: number): AvailabilityReason[] {
  const reasons: AvailabilityReason[] = []; const { health, quota, balance, outcome, load } = facts;
  const healthFresh = health && now - health.observedAt <= freshFor.health;
  if (facts.local) {
    if (!healthFresh) reasons.push("health_unknown");
    else if (health.status === "unhealthy") reasons.push("unhealthy");
    else if (health.status === "degraded") reasons.push("degraded");
  }
  const failure = outcome.lastFailure;
  if (failure && (outcome.lastSuccessAt === undefined || failure.at > outcome.lastSuccessAt)) {
    const age = now - failure.at;
    if (failure.class === "authentication" && age < 86_400_000) reasons.push("authentication");
    // Only a newer reading with a live window clears a refusal; a reading without one says nothing about the limit. No reader
    // measures ChatGPT's subscription-sharing allowance (Spendwatch reads native usage), so only a success or time clears that one.
    const unmeasured = failure.code === "subscription_sharing_usage_limit_exceeded";
    if (failure.class === "quota" && age < 21_600_000 && (unmeasured || !(quota && quota.observedAt > failure.at && liveWindows(quota.windows, now).length))) reasons.push("quota_exhausted");
    if (failure.class === "throttle" && (failure.retryAt !== undefined ? failure.retryAt > now : age < 120_000)) reasons.push("rate_limited");
    if (failure.class === "connection" && age < 120_000 && !(healthFresh && health.status !== "unhealthy" && health.observedAt > failure.at)) reasons.push("connection_failed");
  }
  // A used-up window stays used up until it resets, however old the observation.
  if (quota && liveWindows(quota.windows, now).some(entry => entry.usedPercent >= 100) && !reasons.includes("quota_exhausted")) reasons.push("quota_exhausted");
  if (balance && now - balance.observedAt <= freshFor.balance && balance.remainingUsd <= 0) reasons.push("no_credit");
  if (load.running >= load.limit) reasons.push("at_capacity");
  if (load.queued > 0) reasons.push("queued");
  return reasons;
}
export function statusFor(reasons: AvailabilityReason[]): AvailabilityStatus {
  if (reasons.some(reason => unavailableReasons.has(reason))) return "unavailable";
  if (reasons.some(reason => limitedReasons.has(reason))) return "limited";
  // A local server nobody has probed yet is not known to be up.
  if (reasons.includes("health_unknown")) return "unknown";
  if (reasons.includes("at_capacity") || reasons.includes("queued")) return "busy";
  return "available";
}

/** One provider's public availability row. Times are ISO strings; every observation says whether it is still current. */
export function providerRow(facts: ProviderFacts, now: number): Record<string, unknown> {
  const { provider, health, quota, balance, outcome } = facts;
  const reasons = reasonsFor(facts, now);
  return {
    id: provider.id, type: provider.type, ...(provider.label ? { label: provider.label } : {}), local: facts.local, models: facts.models,
    status: statusFor(reasons), reasons, load: facts.load,
    ...(health ? { health: { ...health, observedAt: iso(health.observedAt), fresh: now - health.observedAt <= freshFor.health } } : {}),
    ...(quota ? { quota: { ...quota, observedAt: iso(quota.observedAt), fresh: now - quota.observedAt <= freshFor.quota,
      windows: quota.windows.map(entry => ({ ...entry, resetsAt: iso(entry.resetsAt) })), remainingPercent: remainingPercent(quota.windows, now) } } : {}),
    ...(balance ? { balance: { remainingUsd: balance.remainingUsd, totalUsd: balance.totalUsd, observedAt: iso(balance.observedAt), fresh: now - balance.observedAt <= freshFor.balance } } : {}),
    ...(outcome.lastSuccessAt !== undefined ? { lastSuccessAt: iso(outcome.lastSuccessAt) } : {}),
    ...(outcome.lastFailure ? { lastFailure: { class: outcome.lastFailure.class, code: outcome.lastFailure.code, at: iso(outcome.lastFailure.at),
      ...(outcome.lastFailure.retryAt !== undefined ? { retryAt: iso(outcome.lastFailure.retryAt) } : {}) } } : {}),
  };
}

export const configuredSpendwatch = (config: GatewayConfig) => config.availability?.spendwatch;
