import type { ProviderConfig } from "../config.js";
import { seedScope, visibleModels } from "./planner.js";
import { discoverableKinds } from "./discovery.js";
import type { AutoLatestScope } from "./types.js";

/** Raw-configuration edits that keep the watch list in step with manual provider changes. They only touch an enabled setting. */
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function enabledProviders(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const settings = raw.autoLatestModels;
  if (!isRecord(settings) || settings.enabled !== true || !isRecord(settings.providers)) return undefined;
  return settings.providers;
}

/**
 * Re-derives one provider's families and baseline from its routes as they now stand, so an explicit choice is never undone
 * later. The baseline only grows. `pendingForNew` applies when the provider had no scope yet.
 */
export function reseedRawProvider(raw: Record<string, unknown>, provider: Pick<ProviderConfig, "id" | "type" | "models" | "modelMetadata">, catalogIds: Iterable<string>, pendingForNew = false): void {
  const settings = raw.autoLatestModels;
  const providers = enabledProviders(raw);
  if (!providers || !isRecord(settings) || !discoverableKinds.has(provider.type)) return;
  const previous = isRecord(providers[provider.id]) ? providers[provider.id] as unknown as AutoLatestScope : undefined;
  const scope = seedScope(visibleModels(provider), Object.values(provider.models), catalogIds, previous, previous ? previous.baselinePending === true || previous.baselineBlocked === true : pendingForNew);
  const next = { ...providers };
  if (scope) next[provider.id] = scope; else delete next[provider.id];
  settings.providers = next;
}

export function dropRawProvider(raw: Record<string, unknown>, providerId: string): void {
  const settings = raw.autoLatestModels; const providers = isRecord(settings) ? settings.providers : undefined;
  if (!isRecord(settings) || !isRecord(providers) || !Object.hasOwn(providers, providerId)) return;
  const next = { ...providers }; delete next[providerId]; settings.providers = next;
}
