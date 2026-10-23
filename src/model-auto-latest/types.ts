import type { AccessTokenOptions } from "../auth/chatgpt.js";
import type { DiscoveredModel } from "../catalog.js";
import type { ProviderConfig } from "../config.js";

/** The only model families auto-latest recognizes. A family is never matched by prefix or guess. */
export const autoLatestFamilies = ["gpt-astra", "gpt-sol", "gpt-terra", "gpt-luna", "gpt-daybreak-blue", "claude-fable", "claude-opus", "claude-sonnet", "claude-haiku"] as const;
export type AutoLatestFamily = (typeof autoLatestFamilies)[number];

export const autoLatestIntervalMinutes = 5;
export const maximumScopeEntries = 256;
export const maximumScopedProviders = 32;

/** What one provider (or the native picker) is watched for. `baselinePending` means the baseline lacks a fresh catalog. */
/**
 * `baselinePending`: the baseline lacks a fresh catalog; the first successful check folds it in without activating.
 * `baselineBlocked`: folding would have exceeded the 256-entry bound, so the baseline can never be complete; the scope
 * activates nothing until an explicit manual reseed or a new enable replaces it.
 */
export interface AutoLatestScope { families: string[]; baselineModels: string[]; baselinePending?: boolean; baselineBlocked?: boolean }
export interface AutoLatestSettings {
  enabled: boolean;
  providers: Record<string, AutoLatestScope>;
  native?: AutoLatestScope;
}

export type AutoLatestOutcome = "updated" | "unchanged" | "baseline" | "partial" | "failed" | "cancelled" | "stale" | "disabled" | "busy";
export const autoLatestOutcomes: readonly string[] = ["updated", "unchanged", "baseline", "partial", "failed", "cancelled", "stale", "disabled", "busy"];

export interface AutoLatestResult {
  outcome: AutoLatestOutcome;
  changed: boolean;
  activated: number;
  providersChecked: number;
  providersFailed: number;
  nativeUpdated: boolean;
  /** UTC seconds. */
  checkedAt: number;
}

/** One row of a provider catalog, as cached under app-catalog. */
export interface CatalogRow { id: string; label: string; metadata?: Record<string, unknown> }

export type AutoLatestDiscover = (provider: ProviderConfig, options?: AccessTokenOptions) => Promise<DiscoveredModel[]>;

export interface AutoLatestDependencies {
  discoverModels?: AutoLatestDiscover;
  signal?: AbortSignal;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** The native Codex home that holds models_cache.json. */
  nativeHome?: string;
  /** Per provider call deadline in milliseconds; tests shorten it. */
  perProviderMs?: number;
  /** Overall discovery deadline in milliseconds. */
  totalMs?: number;
}

export interface ReconcileOptions extends AutoLatestDependencies {
  /** Default false: a scheduled check never refreshes a login. */
  refresh?: boolean;
  expectedRevision?: string;
  /** How long to wait for another check holding the job lock before reporting busy. */
  lockTimeoutMs?: number;
}

/** The public, safe view the app shows. */
export interface AutoLatestStatus {
  enabled: boolean;
  intervalMinutes: number;
  families: Array<{ providerId: string; label: string; families: string[] }>;
  nativeFamilies: string[];
  lastCheckedAt?: number;
  lastOutcome?: AutoLatestOutcome;
  scheduled?: boolean;
  scheduleReason?: string;
}
