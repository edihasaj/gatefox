import { constants } from "node:os";
import { startHealthSchedule } from "./health-schedule.js";
import { watchHostKick } from "./execution-host-kick.js";
import type { HostFailureReason } from "./execution-host.js";
import { probeExecutionHost, type HostProbeReason, type HostProbeTarget, type SdkBaseline } from "./service-host-probe.js";

/**
 * The fixed numbers and vocabularies of the supervisor's self-heal. Nothing here reads an error's text, a path or an
 * environment value: every event field is a code from a closed set.
 */

/** Waits between execution host starts: 1, 2, 5, 10 and 30 s, then every 60 s. `baseMs` scales the steps for tests. */
const hostRetrySteps = [1, 2, 5, 10, 30, 60];
export function hostRetryDelayMs(failures: number, baseMs = 1000): number {
  return baseMs * hostRetrySteps[Math.min(Math.max(failures, 1), hostRetrySteps.length) - 1];
}

/** A failed status write is reported at most once a minute; the next heartbeat writes again either way. */
export const statusFailureGapMs = 60_000;

/** A status write's errno code (`ENOSPC`, `EACCES`, ...), or `other`; its path and message are never kept. */
export function statusWriteCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{1,15}$/.test(code) ? code : "other";
}

/** An inference or tunnel exit this soon after its start is a quick exit; five in a row are reported once. */
export const quickExitMs = 60_000;
export const failingStreak = 5;

/** How an owned child ended: `exit_<code>`, `signal_<NAME>` or `spawn_failed`. Never its output. */
export function exitReason(code: number | null, signal?: NodeJS.Signals | null): string {
  if (typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255) return `exit_${code}`;
  if (signal) return Object.hasOwn(constants.signals, signal) ? `signal_${signal}` : "signal_other";
  return "spawn_failed";
}

/**
 * The watchdog heartbeat the service runs in-process (see docs/health.md). It reads the configuration the service plan
 * names, not whichever one the working directory would pick, and it stands down while `<state>/alert-push-url` is absent.
 * The returned function stops the schedule and aborts a compatibility check that is still running.
 */
export function scheduleServiceHealth(stateDirectory: string, configPath: string): () => void {
  return startHealthSchedule({ stateDirectory, run: async signal => {
    const { loadConfig } = await import("./config.js");
    const { runHealth } = await import("./health.js");
    const config = await loadConfig(configPath);
    await runHealth({ stateDirectory: config.stateDirectory, port: config.port, clientOnly: config.clientOnly, push: true, signal });
  } });
}

/**
 * The self-heal's watchers and clocks; tests replace them. A running host is probed every `hostProbeMs`, an adapter's
 * kick is watched in the host folder (once a second), a kicked or probed start never follows another start inside
 * `kickGapMs`, and the watchdog heartbeat runs while the service does.
 */
export interface SupervisorHealing {
  probeHost: (target: HostProbeTarget, baseline: SdkBaseline) => Promise<HostProbeReason | undefined>;
  hostProbeMs: number;
  watchKick: (home: string, onKick: () => unknown) => () => void;
  kickGapMs: number;
  healthSchedule: (stateDirectory: string, configPath: string) => () => void;
}
export const defaultHealing: SupervisorHealing = { probeHost: probeExecutionHost, hostProbeMs: 60_000, watchKick: (home, onKick) => watchHostKick(home, onKick), kickGapMs: 5000, healthSchedule: scheduleServiceHealth };
/** Failed probes in a row before a running host counts as unhealthy: one slow answer can be a busy moment, not a hung host. */
export const hostProbeStrikes = 2;
/** Failures a retry cannot fix by itself: a kick buys at most one extra start for them between two backoff starts. */
export const deterministicFailures = new Set<HostFailureReason>(["identity_changed", "sdk_invalid", "receipt_invalid", "live_owner"]);
/** Why a running host is restarted: a failed probe, or a relay it owned the registration for that was set aside. */
export type HostRestartReason = HostProbeReason | "relay_paused";
