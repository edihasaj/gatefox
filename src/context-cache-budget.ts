import { createHash } from "node:crypto";
import { ProviderError } from "./providers/provider.js";
import { telemetry } from "./telemetry.js";

export interface CacheCounts { read?: number; uncached?: number; input?: number; complete?: boolean }
interface Rewrite { count: number; bytes: number; cacheTokens?: number; unknown: boolean; lastActivityAt?: number }
const symbol = Symbol.for("harness-gateway/context-cache-budget/v1");
const state = globalThis as unknown as Record<symbol, Map<string, Rewrite> | undefined>;
const histories = state[symbol] ??= new Map<string, Rewrite>();
const activitySymbol = Symbol.for("harness-gateway/context-cache-inflight/v1");
const activity = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
const inFlight = activity[activitySymbol] ??= new Map<string, number>();
// Earlier guards could combine misses from separate days and had no reliable
// activity clock. Grant their inactive histories one bounded warm-up at this
// policy handoff. The process-wide marker survives every later module adoption;
// reloading a module cannot repeatedly clear an active safety stop.
const adoptionSymbol = Symbol.for("harness-gateway/context-cache-idle-adoption/v1");
const adoption = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!adoption[adoptionSymbol]) {
  adoption[adoptionSymbol] = true;
  for (const key of histories.keys()) if (!inFlight.has(key)) histories.delete(key);
}
const largeInputTokens = 65536;
// A quiet conversation can legitimately lose its provider cache. Count request
// attempts and completions, so neither long inference nor blocked retry loops
// manufacture an idle interval. Late legacy writes start conservatively.
const idleResetMs = 5 * 60_000;
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
  track(): () => void;
  record(counts?: CacheCounts): void;
}

/** Count-only, bounded process state shared by every provider and preserved across hot upgrades. */
export function contextCacheBudget(scope: string, identity: string | undefined, model: string, bytes: number): ContextCacheBudget {
  const key = createHash("sha256").update(JSON.stringify([scope, identity ?? null, model])).digest("hex");
  const activeHistory = (): Rewrite | undefined => {
    const prior = histories.get(key);
    if (!prior) return;
    const now = Date.now();
    if (!inFlight.has(key) && prior.lastActivityAt !== undefined && now - prior.lastActivityAt >= idleResetMs) {
      histories.delete(key); return;
    }
    prior.lastActivityAt = Math.max(prior.lastActivityAt ?? now, now);
    return prior;
  };
  return {
    track() {
      activeHistory();
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const remaining = (inFlight.get(key) ?? 1) - 1;
        if (remaining) inFlight.set(key, remaining); else inFlight.delete(key);
        const prior = histories.get(key);
        if (prior) prior.lastActivityAt = Math.max(prior.lastActivityAt ?? 0, Date.now());
      };
    },
    beforeRequest(mode) {
      const prior = activeHistory();
      if (!prior || prior.count < 2) return;
      if (bytes <= prior.bytes / 2) { histories.delete(key); return; }
      telemetry("context_cache_guard", { outcome: "blocked", mode, threadKey: key.slice(0, 8),
        reason: prior.unknown ? "cache_usage_unknown" : "cache_reuse_failed", rewrites: prior.count });
      throw new ContextCacheBlocked(prior.unknown);
    },
    record(counts) {
      // beforeRequest already judged the idle gap. Completion only refreshes
      // activity: a slow request must not erase the preceding measured miss.
      const prior = histories.get(key);
      const now = Date.now();
      const lastActivityAt = Math.max(prior?.lastActivityAt ?? now, now);
      if (prior) prior.lastActivityAt = lastActivityAt;
      const read = counts?.read, uncached = counts?.uncached, input = counts?.input;
      const measured = counts?.complete !== false && valid(read) && valid(uncached);
      const largeUnknown = !measured && ((valid(input) && input >= largeInputTokens) || (valid(uncached) && uncached >= largeInputTokens));
      if (!measured && !largeUnknown) return;
      const reused = measured && valid(prior?.cacheTokens) && prior.cacheTokens > 0 && read >= prior.cacheTokens * 0.75;
      const cold = largeUnknown || measured && uncached >= largeInputTokens && uncached > read && !reused;
      histories.delete(key);
      histories.set(key, { count: cold ? (prior?.count ?? 0) + 1 : 0, unknown: largeUnknown,
        bytes: cold && prior?.count ? Math.min(prior.bytes, bytes) : bytes,
        cacheTokens: measured ? read + uncached : undefined, lastActivityAt });
      while (histories.size > 4096) histories.delete(histories.keys().next().value!);
    },
  };
}
