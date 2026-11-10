import { createHash } from "node:crypto";
import { ProviderError } from "./providers/provider.js";
import { telemetry } from "./telemetry.js";

export interface CacheCounts { read?: number; uncached?: number; input?: number; complete?: boolean }
/** `clientChange`: the provider rebuilt because the caller changed its cached prefix (tools, instructions, thinking, Fast). */
export interface CacheRecordOutcome { cancelled?: boolean; refused?: boolean; clientChange?: boolean }
interface Rewrite { count: number; bytes: number; cacheTokens?: number; unknown: boolean; lastActivityAt?: number; rebuildPass?: boolean; refusalPass?: boolean; forgiven?: number; strict?: boolean; blockedUntil?: number; probe?: symbol }
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
// A quiet conversation can legitimately lose its provider cache. Once stopped,
// use a fixed deadline instead; blocked attempts never restart that clock.
const idleResetMs = 5 * 60_000;
// A caller's cancellation can end the live session, so the next request has to rebuild. Those
// rebuilds are forgiven, but a client that disconnects and retries in a loop must still stop.
const maxForgivenRebuilds = 4;
const maxHistories = 4096;
// A refusal can arrive with no usage at all, so its size comes from the request itself.
const estimatedBytesPerToken = 4;
const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export class ContextCacheBlocked extends ProviderError {
  constructor(unknown = false, retryAfterMs = idleResetMs, pending = false) {
    super("invalid_request", (unknown
      ? "The provider did not report cache reuse for repeated large-context requests."
      : "Provider cache reuse failed repeatedly on this large chat.")
      + " Gateway paused to protect your quota. Your history is preserved. "
      + (pending ? "Wait for the current request to finish before trying again."
        : `Try one message again in ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds.`)
      + " Retries do not extend the cooldown.", 400);
  }
}
export interface ContextCacheBudget {
  beforeRequest(mode: "seed" | "oneshot" | "continued" | "provider"): void;
  track(): () => void;
  record(counts?: CacheCounts, outcome?: CacheRecordOutcome): void;
}

const trim = () => { while (histories.size > maxHistories) histories.delete(histories.keys().next().value!); };
const missLimit = (prior: Rewrite): number => prior.unknown || prior.strict ? 2 : 3;

/** Count-only, bounded process state shared by every provider and preserved across hot upgrades. `advisory` records without stopping. */
export function contextCacheBudget(scope: string, identity: string | undefined, model: string, bytes: number, options: { advisory?: boolean } = {}): ContextCacheBudget {
  const key = createHash("sha256").update(JSON.stringify([scope, identity ?? null, model])).digest("hex");
  let ownsProbe = false;
  let cooldownProbe = false;
  const probeToken = Symbol();
  let ownActivity = 0;
  const otherRequests = () => (inFlight.get(key) ?? 0) > ownActivity;
  const activeHistory = (): Rewrite | undefined => {
    const prior = histories.get(key);
    if (!prior) return;
    const now = Date.now();
    if (!prior.probe && prior.blockedUntil === undefined && prior.count < missLimit(prior)
      && !inFlight.has(key) && prior.lastActivityAt !== undefined && now - prior.lastActivityAt >= idleResetMs) {
      histories.delete(key); return;
    }
    return prior;
  };
  return {
    track() {
      const prior = activeHistory();
      if (prior) prior.lastActivityAt = Math.max(prior.lastActivityAt ?? 0, Date.now());
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      ownActivity++;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        ownActivity--;
        const remaining = (inFlight.get(key) ?? 1) - 1;
        if (remaining) inFlight.set(key, remaining); else inFlight.delete(key);
        const prior = histories.get(key);
        if (prior) prior.lastActivityAt = Math.max(prior.lastActivityAt ?? 0, Date.now());
        // Native transports may fail after admission but before record() runs.
        // Release their reservation while still bounding the spent probe.
        if (ownsProbe) {
          ownsProbe = false;
          cooldownProbe = false;
          if (prior?.probe === probeToken) { prior.probe = undefined; prior.blockedUntil ??= Date.now() + idleResetMs; }
        }
      };
    },
    beforeRequest(mode) {
      const prior = activeHistory();
      if (!prior) return;
      const now = Date.now();
      const limited = prior.blockedUntil !== undefined || prior.count >= missLimit(prior);
      if ((limited || prior.probe) && bytes <= prior.bytes / 2) { histories.delete(key); return; }
      const admit = () => { prior.lastActivityAt = Math.max(prior.lastActivityAt ?? now, now); };
      // Native session setup can check admission again before the same inference.
      if (ownsProbe && prior.probe === probeToken) { admit(); return; }
      // Reserve the extra attempt before inference so parallel requests cannot each
      // claim the same recovery allowance. Only its own completion releases it.
      const reserve = () => { prior.probe = probeToken; ownsProbe = true; admit(); };
      if (!limited && !prior.probe) {
        if (!options.advisory && prior.count === 2) reserve(); else admit();
        return;
      }
      if (limited && prior.blockedUntil === undefined) prior.blockedUntil = (prior.lastActivityAt ?? now) + idleResetMs;
      if (!options.advisory && !prior.probe && limited && now >= prior.blockedUntil! && !otherRequests()) {
        // One probe, rather than another full warm-up, after each cooldown.
        prior.count = missLimit(prior) - 1; prior.blockedUntil = undefined;
        cooldownProbe = true;
        reserve(); return;
      }
      telemetry("context_cache_guard", { outcome: options.advisory ? "observed" : "blocked", mode, threadKey: key.slice(0, 8),
        reason: prior.unknown ? "cache_usage_unknown" : "cache_reuse_failed", rewrites: prior.count });
      // A missed cache on a self-hosted model costs time, not quota or credit. Stopping that
      // worker would only move its task onto a metered fallback.
      if (options.advisory) return;
      throw new ContextCacheBlocked(prior.unknown, Math.max(0, (prior.blockedUntil ?? now) - now), !!prior.probe || now >= prior.blockedUntil! && otherRequests());
    },
    record(counts, outcome = {}) {
      // beforeRequest already judged the idle gap. Completion only refreshes
      // activity: a slow request must not erase the preceding measured miss.
      const prior = histories.get(key);
      const now = Date.now();
      const probe = ownsProbe && prior?.probe === probeToken; ownsProbe = false;
      const recovering = probe && cooldownProbe; cooldownProbe = false;
      if (prior && probe) prior.probe = undefined;
      const lastActivityAt = Math.max(prior?.lastActivityAt ?? now, now);
      if (prior) prior.lastActivityAt = lastActivityAt;
      const read = counts?.read, uncached = counts?.uncached, input = counts?.input;
      const measured = counts?.complete !== false && valid(read) && valid(uncached);
      const cancelled = outcome.cancelled === true, refused = outcome.refused === true, clientChange = outcome.clientChange === true;
      const largeUnknown = !measured && ((valid(input) && input >= largeInputTokens) || (valid(uncached) && uncached >= largeInputTokens)
        || refused && bytes >= largeInputTokens * estimatedBytesPerToken);
      if (!measured && !largeUnknown) {
        // An unmeasured recovery attempt still spent its admission. It cannot
        // reopen the budget indefinitely by failing before a usage frame arrives.
        if (probe && prior) prior.blockedUntil = now + idleResetMs;
        // A cancellation or refusal can close the session before any usage arrives.
        if ((cancelled || refused) && prior) { prior.rebuildPass = true; prior.refusalPass ||= refused; }
        else if (cancelled || refused) { histories.set(key, { count: 0, unknown: false, bytes, lastActivityAt, rebuildPass: true, refusalPass: refused }); trim(); }
        return;
      }
      const reused = measured && valid(prior?.cacheTokens) && prior.cacheTokens > 0 && read >= prior.cacheTokens * 0.75;
      const cold = largeUnknown || measured && uncached >= largeInputTokens && uncached > read && !reused;
      const forgiven = prior?.forgiven ?? 0;
      // Only a real cache hit on a large context renews the allowance. A tiny request proves nothing.
      const restored = measured && !cold && read >= largeInputTokens;
      // A cancelled request and the one rebuild after it say nothing about whether the cache works.
      // A refused request is never excused: it spent the resend, so repeated refusals reach the stop.
      // That also bounds the refusal's own pass, which does not need the rebuild allowance. A cancelled
      // rebuild leaves it for the rebuild that finishes, and spends the allowance instead.
      // A rebuild the caller forced by changing its tools or instructions is not a cache failure either:
      // the next request continues the new session. It spends the same allowance, so a flapping catalog still stops.
      const excused = cold && !refused && (!cancelled && prior?.refusalPass === true
        || forgiven < maxForgivenRebuilds && (cancelled || clientChange || prior?.rebuildPass === true));
      const next: Rewrite = { count: !cold ? 0 : excused ? prior?.count ?? 0 : (prior?.count ?? 0) + 1,
        unknown: cold && (prior?.unknown === true || largeUnknown),
        strict: cold && (prior?.strict === true || refused || largeUnknown),
        bytes: cold && prior?.count ? Math.min(prior.bytes, bytes) : bytes,
        cacheTokens: measured ? read + uncached : undefined, lastActivityAt,
        rebuildPass: cancelled || refused, refusalPass: refused || cancelled && prior?.refusalPass === true, forgiven: restored ? 0 : excused ? forgiven + 1 : forgiven,
        probe: prior?.probe };
      if (cold && (next.count >= missLimit(next) || recovering)) next.blockedUntil = prior?.blockedUntil ?? now + idleResetMs;
      histories.delete(key); histories.set(key, next);
      trim();
    },
  };
}
