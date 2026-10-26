import { setTimeout as delay } from "node:timers/promises";

/**
 * The retry budget for a provider throttle (HTTP 429 or a stream error naming a temporary rate
 * limit). The ChatGPT backend often throttles for minutes without a Retry-After header, and a
 * client with its own short retry schedule gives up long before the throttle clears, so the
 * gateway absorbs short throttles itself. Only the attempt count and the wait are decided here;
 * the safety rule (nothing published yet) belongs to the caller of this module.
 */
const backoffSteps = [1000, 2000, 4000, 8000] as const;
export interface ThrottleRetryTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Source of jitter in [0, 1). */
  random: () => number;
  budgetMs: number;
}
const real: ThrottleRetryTiming = {
  now: () => Date.now(),
  // The request's signal bounds the wait: cancellation, shutdown and the gateway deadline abort it.
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  random: Math.random,
  budgetMs: 120000,
};
let timing: ThrottleRetryTiming = real;

/** Tests replace the clock, the sleeper and the jitter source; production uses the defaults. */
export function configureThrottleRetryTiming(overrides: Partial<ThrottleRetryTiming>): void { timing = { ...timing, ...overrides }; }
export function resetThrottleRetryTiming(): void { timing = real; }
export function throttleRetryNow(): number { return timing.now(); }
/** Timers can resume late after sleep or an event-loop stall. */
export function throttleRetryExpired(startedAt: number): boolean { return timing.now() - startedAt >= timing.budgetMs; }

/**
 * The wait before throttle retry `retry`, or undefined once it would spend the budget. An upstream
 * Retry-After replaces the step (at least 1 s). The wait is never shortened to fit the budget.
 */
export function throttleRetryWaitMs(retry: number, elapsedMs: number, retryAfterMs?: number): number | undefined {
  const step = backoffSteps[retry] ?? backoffSteps[backoffSteps.length - 1]!;
  const wait = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? Math.max(1000, Math.round(retryAfterMs))
    : Math.round(step * (0.8 + timing.random() * 0.4));
  return elapsedMs + wait < timing.budgetMs ? wait : undefined;
}

/** Waits out one throttle retry; rejects with the abort as soon as the request is cancelled. */
export function throttleRetrySleep(ms: number, signal: AbortSignal): Promise<void> { return timing.sleep(ms, signal); }
