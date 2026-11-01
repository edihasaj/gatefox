import { createHash } from "node:crypto";
import { ProviderError } from "./providers/provider.js";
import { telemetry } from "./telemetry.js";

export interface CacheCounts { read?: number; uncached?: number; input?: number; complete?: boolean }
interface Rewrite { count: number; bytes: number; cacheTokens?: number; unknown: boolean }
const symbol = Symbol.for("harness-gateway/context-cache-budget/v1");
const state = globalThis as unknown as Record<symbol, Map<string, Rewrite> | undefined>;
const histories = state[symbol] ??= new Map<string, Rewrite>();
const largeInputTokens = 65536;
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export class ContextCacheBlocked extends ProviderError {
  constructor(unknown = false) {
    super("invalid_request", (unknown
      ? "The provider did not report cache reuse for repeated large-context requests."
      : "Provider cache reuse failed repeatedly on this large chat.")
      + " Gateway stopped before more inference. Compact the chat or start a fresh chat to continue on the same model.", 400);
  }
}
export interface ContextCacheBudget {
  beforeRequest(mode: "seed" | "oneshot" | "continued" | "provider"): void;
  record(counts?: CacheCounts): void;
}

/** Count-only, bounded process state shared by every provider and preserved across hot upgrades. */
export function contextCacheBudget(scope: string, identity: string | undefined, model: string, bytes: number): ContextCacheBudget {
  const key = createHash("sha256").update(JSON.stringify([scope, identity ?? null, model])).digest("hex");
  return {
    beforeRequest(mode) {
      const prior = histories.get(key);
      if (!prior || prior.count < 2) return;
      if (bytes <= prior.bytes / 2) { histories.delete(key); return; }
      telemetry("context_cache_guard", { outcome: "blocked", mode, threadKey: key.slice(0, 8),
        reason: prior.unknown ? "cache_usage_unknown" : "cache_reuse_failed", rewrites: prior.count });
      throw new ContextCacheBlocked(prior.unknown);
    },
    record(counts) {
      const read = counts?.read, uncached = counts?.uncached, input = counts?.input;
      const measured = counts?.complete !== false && valid(read) && valid(uncached);
      const largeUnknown = !measured && ((valid(input) && input >= largeInputTokens) || (valid(uncached) && uncached >= largeInputTokens));
      if (!measured && !largeUnknown) return;
      const prior = histories.get(key);
      const reused = measured && valid(prior?.cacheTokens) && prior.cacheTokens > 0 && read >= prior.cacheTokens * 0.75;
      const cold = largeUnknown || measured && uncached >= largeInputTokens && uncached > read && !reused;
      histories.delete(key);
      histories.set(key, { count: cold ? (prior?.count ?? 0) + 1 : 0, unknown: largeUnknown,
        bytes: cold && prior?.count ? Math.min(prior.bytes, bytes) : bytes,
        cacheTokens: measured ? read + uncached : undefined });
      while (histories.size > 4096) histories.delete(histories.keys().next().value!);
    },
  };
}
