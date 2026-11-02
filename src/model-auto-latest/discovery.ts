import { ChatGPTRefreshDeferred } from "../auth/chatgpt.js";
import type { ProviderKind } from "../config.js";
import type { ProviderConfig } from "../config.js";
import { catalogEntry } from "../app-management/drafts.js";
import { ManagementError } from "../app-management/errors.js";
import { validModelId } from "../app-management/providers.js";
import type { AutoLatestDiscover, CatalogRow } from "./types.js";
import { modelLabel } from "../model-label.js";

export { ChatGPTRefreshDeferred };

/** Provider kinds with a verified metadata-only catalog route. Grok and the Anthropic API have none and are never probed. */
export const discoverableKinds: ReadonlySet<ProviderKind> = new Set<ProviderKind>(["codex-subscription", "claude-subscription", "copilot-subscription", "responses-api", "chat-completions-api"]);
export const discoveryTimeoutMs = 10_000;
const maximumCatalogRows = 4096;
const maximumParallel = 4;

/** Settles with the work, or rejects when the signal aborts or the deadline passes. The work itself cannot be cancelled; it drains later. */
export function bounded<T>(run: () => Promise<T>, signal?: AbortSignal, timeoutMs = discoveryTimeoutMs): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(new ManagementError("cancelled")); return; }
    let done = false;
    const finish = (action: () => void) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); action(); };
    const onAbort = () => finish(() => reject(new ManagementError("cancelled")));
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), timeoutMs); timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    run().then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

/** Vendor metadata the gateway never accepts: only automatic upkeep may hide a route. */
function publicMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { pickerHidden: _vendor, ...rest } = value as Record<string, unknown>;
  return rest;
}

/**
 * One provider's full catalog, metadata only. `refresh` lets a Codex login refresh its token; a scheduled check passes false.
 * A catalog over the row bound is refused whole, never truncated: a truncated catalog would make a baseline look complete.
 */
export async function discoverCatalog(provider: ProviderConfig, discover: AutoLatestDiscover, refresh: boolean, signal?: AbortSignal, timeoutMs?: number): Promise<CatalogRow[]> {
  const found = await bounded(() => discover(provider, { refresh }), signal, timeoutMs);
  if (!Array.isArray(found) || found.length > maximumCatalogRows) throw new Error("catalog_unusable");
  const rows = new Map<string, CatalogRow>();
  for (const item of found) {
    if (!item || !validModelId(item.model) || rows.has(item.model)) continue;
    const metadata = publicMetadata(item.metadata);
    rows.set(item.model, catalogEntry(item.model, typeof metadata?.displayName === "string" && metadata.displayName ? modelLabel(metadata.displayName) : item.model, metadata));
  }
  return [...rows.values()];
}

/** `rows` is a usable catalog (possibly empty); `deferred` means a stale login was not refreshed; `failed` is any other outcome. */
export type CatalogResult = { rows: CatalogRow[] } | { deferred: true } | { failed: true };
export interface DiscoveryBudget { perProviderMs?: number; totalMs: number }

/**
 * Discovers every provider with at most four calls at once under one overall deadline. A provider that did not finish by
 * the deadline, or after cancellation, is `failed`; no call starts after the deadline. Errors are reduced to a fixed word.
 */
export async function discoverAll(providers: readonly ProviderConfig[], discover: AutoLatestDiscover, refresh: boolean, signal: AbortSignal | undefined, budget: DiscoveryBudget): Promise<Map<string, CatalogResult>> {
  const results = new Map<string, CatalogResult>();
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), budget.totalMs); timer.unref?.();
  const onAbort = () => stop.abort(); signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) stop.abort();
  const queue = [...providers];
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stop.signal.aborted) return;
      const provider = queue.shift(); if (!provider) return;
      try { results.set(provider.id, { rows: await discoverCatalog(provider, discover, refresh, stop.signal, budget.perProviderMs) }); }
      catch (error) { if (!stop.signal.aborted || !results.has(provider.id)) results.set(provider.id, error instanceof ChatGPTRefreshDeferred ? { deferred: true } : { failed: true }); }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(maximumParallel, queue.length) }, worker)); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  for (const provider of providers) if (!results.has(provider.id)) results.set(provider.id, { failed: true });
  return results;
}
