import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { telemetry } from "./telemetry.js";

/**
 * Installing a release only switches the `current` link. Each long-running process
 * then notices that a newer release is installed and restarts itself once it is idle,
 * so an update never requires quitting the app. Processes run from a checkout (not an
 * installed release) never restart themselves.
 */
export interface ReleaseState { running: string; installed?: string }

/** Release names an ownership lease may record. Writers omit anything else, and readers
 * accept only this shape, so a listener's release is never silently judged differently. */
export const releasePattern = /^[0-9A-Za-z._-]{1,64}$/;

/** The release this process runs and the one `current` points to now. */
export function releaseState(moduleUrl = import.meta.url): ReleaseState | undefined {
  let release: string;
  try { release = realpathSync(resolve(dirname(fileURLToPath(moduleUrl)), "../..")); } catch { return; }
  if (basename(dirname(release)) !== "releases") return;
  let installed: string | undefined;
  try { installed = basename(realpathSync(resolve(dirname(dirname(release)), "current"))); } catch { installed = undefined; }
  return { running: basename(release), installed };
}

export function newerReleaseInstalled(state = releaseState()): boolean {
  return !!state?.installed && state.installed !== state.running;
}

/** How a process moved to a newer release: `idle` (nothing connected or loaded), or the service's `quiet` rule. */
export type UpgradeMode = "idle" | "quiet";
/** What an accepted upgrade reports for `self_upgrade`; `loadedChats` (a count) only for a quiet one. Plain `true` means idle. */
export interface UpgradeOutcome { mode: UpgradeMode; loadedChats?: number }

/**
 * Checks once a minute. When a different release is installed and `isIdle` stays true
 * for two checks in a row, it calls `upgrade` with how long (ms) this watcher has seen a
 * newer release installed. An upgrade that reports false (work arrived meanwhile) is
 * retried at a later idle moment.
 */
export function watchForUpgrade(component: string, isIdle: () => boolean | Promise<boolean>,
  upgrade: (pending: { pendingMs: number }) => boolean | UpgradeOutcome | Promise<boolean | UpgradeOutcome>,
  options: { intervalMs?: number; state?: () => ReleaseState | undefined } = {}): () => void {
  const read = options.state ?? (() => releaseState()); let idleChecks = 0; let done = false; let cancelled = false; let pendingSince: number | undefined;
  const timer = setInterval(() => {
    if (done || cancelled) return;
    const state = read();
    if (!newerReleaseInstalled(state)) { idleChecks = 0; pendingSince = undefined; return; }
    pendingSince ??= performance.now();
    void Promise.resolve(isIdle()).then(idle => {
      if (done || cancelled) return;
      idleChecks = idle ? idleChecks + 1 : 0;
      if (idleChecks < 2) return;
      done = true;
      return Promise.resolve(upgrade({ pendingMs: performance.now() - (pendingSince ?? performance.now()) })).then(started => {
        if (started) {
          clearInterval(timer);
          const outcome: UpgradeOutcome = started === true ? { mode: "idle" } : started;
          telemetry("self_upgrade", { component, from: state!.running, to: state!.installed, mode: outcome.mode,
            ...(outcome.mode === "quiet" ? { loadedChats: outcome.loadedChats ?? 0 } : {}) });
        }
        else { done = false; idleChecks = 0; }
      });
    }).catch(() => { done = false; idleChecks = 0; });
  }, options.intervalMs ?? (Number(process.env.GATEWAY_UPGRADE_CHECK_MS) || 60000));
  timer.unref();
  return () => { cancelled = true; clearInterval(timer); };
}
