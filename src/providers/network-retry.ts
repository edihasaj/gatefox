import { setTimeout as delay } from "node:timers/promises";

/**
 * The retry budget for a transient connection failure. A laptop that drops off the
 * network for a minute or two is normal, and a client that has its own small retry
 * count gives up inside the outage, so the gateway absorbs short ones itself. Only
 * the attempt count and the wait are the gateway's; the safety rule (nothing
 * published yet) belongs to the caller of this module.
 */
const backoffSteps = [1000, 2000, 4000, 8000] as const;
export interface NetworkRetryTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Source of jitter in [0, 1). */
  random: () => number;
  budgetMs: number;
}
const real: NetworkRetryTiming = {
  now: () => Date.now(),
  // The request's signal is what bounds the wait: cancellation, shutdown and the
  // gateway deadline all abort it, and `delay` rejects at once.
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  random: Math.random,
  budgetMs: 120000,
};
let timing: NetworkRetryTiming = real;

/** Tests replace the clock, the sleeper and the jitter source; production uses the defaults. */
export function configureNetworkRetryTiming(overrides: Partial<NetworkRetryTiming>): void { timing = { ...timing, ...overrides }; }
export function resetNetworkRetryTiming(): void { timing = real; }
export function networkRetryNow(): number { return timing.now(); }
/** Timers can resume late after sleep or an event-loop stall. */
export function networkRetryExpired(startedAt: number): boolean { return timing.now() - startedAt >= timing.budgetMs; }

/**
 * The wait before connection retry `retry`, or undefined once it would spend the budget. The wait is never
 * shortened to fit: an attempt started at or after the deadline would only re-run a request the caller has
 * already waited out, so the budget is spent on waits that keep the next attempt strictly inside it.
 */
export function networkRetryWaitMs(retry: number, elapsedMs: number): number | undefined {
  const step = backoffSteps[retry] ?? backoffSteps[backoffSteps.length - 1]!;
  const wait = Math.round(step * (0.8 + timing.random() * 0.4));
  return elapsedMs + wait < timing.budgetMs ? wait : undefined;
}

/** Waits out one connection retry; rejects with the abort as soon as the request is cancelled. */
export function networkRetrySleep(ms: number, signal: AbortSignal): Promise<void> { return timing.sleep(ms, signal); }
