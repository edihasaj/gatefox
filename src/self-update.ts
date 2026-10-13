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

/**
 * Checks once a minute. When a different release is installed and `isIdle` stays true
 * for two checks in a row, it calls `upgrade`. An upgrade that reports false (work
 * arrived meanwhile) is retried at a later idle moment.
 */
export function watchForUpgrade(component: string, isIdle: () => boolean | Promise<boolean>, upgrade: () => boolean | Promise<boolean>,
  options: { intervalMs?: number; state?: () => ReleaseState | undefined } = {}): () => void {
  const read = options.state ?? (() => releaseState()); let idleChecks = 0; let done = false; let cancelled = false;
  const timer = setInterval(() => {
    if (done || cancelled) return;
    const state = read();
    if (!newerReleaseInstalled(state)) { idleChecks = 0; return; }
    void Promise.resolve(isIdle()).then(idle => {
      if (done || cancelled) return;
      idleChecks = idle ? idleChecks + 1 : 0;
      if (idleChecks < 2) return;
      done = true;
      return Promise.resolve(upgrade()).then(started => {
        if (started) { clearInterval(timer); telemetry("self_upgrade", { component, from: state!.running, to: state!.installed }); }
        else { done = false; idleChecks = 0; }
      });
    }).catch(() => { done = false; idleChecks = 0; });
  }, options.intervalMs ?? 60000);
  timer.unref();
  return () => { cancelled = true; clearInterval(timer); };
}
