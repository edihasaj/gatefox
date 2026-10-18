import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewaySdkRuntime } from "./gateway-sdk-runtime.js";
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

/** The gateway SDK of an installed release that this process is not running yet, and the release it belongs to. */
export interface PendingGatewaySdk { release: string; gatewaySdkSha256: string }
/**
 * The installed (newer) release's gateway SDK checksum, from that release's own verified build receipt, or undefined when no
 * newer release is installed, this is a checkout, or that release carries no readable SDK. Never throws. A release's answer is
 * kept: its files do not change, and hashing the SDK binary is not free.
 */
export function pendingGatewaySdkReader(moduleUrl = import.meta.url, state: () => ReleaseState | undefined = () => releaseState(moduleUrl)): () => Promise<PendingGatewaySdk | undefined> {
  const known = new Map<string, Promise<string | undefined>>();
  return async () => {
    try {
      const current = state();
      if (!current?.installed || current.installed === current.running) return;
      const release = realpathSync(resolve(dirname(fileURLToPath(moduleUrl)), "../.."));
      const directory = resolve(dirname(release), current.installed, "package");
      let sha = known.get(current.installed);
      if (!sha) { sha = gatewaySdkRuntime(directory).then(runtime => runtime?.binarySha256, () => undefined); known.set(current.installed, sha); }
      const gatewaySdkSha256 = await sha;
      if (!gatewaySdkSha256) known.delete(current.installed); // Unreadable now (still being written, say): ask again next time.
      return gatewaySdkSha256 ? { release: current.installed, gatewaySdkSha256 } : undefined;
    } catch { return; }
  };
}

/**
 * How a process moved to a newer release: `idle` (nothing connected or loaded), the service's `quiet` rule, or the service's
 * `skew` rule (an adapter of the installed release was refused by this older host, so the move was urgent).
 */
export type UpgradeMode = "idle" | "quiet" | "skew";
/** What an accepted upgrade reports for `self_upgrade`; `loadedChats` (a count) only for a quiet or skew one. Plain `true` means idle. */
export interface UpgradeOutcome { mode: UpgradeMode; loadedChats?: number }

/** A newer release waiting: the running and installed release names, and how long (ms) this watcher has seen it installed. `urgent`: see `WatchOptions.urgent`. */
export interface PendingRelease { from: string; to: string; pendingMs: number; urgent?: boolean }
/** How often an urgent pending release is tried (ms); `GATEWAY_UPGRADE_URGENT_MS` shortens it for tests. */
export function urgentUpgradeIntervalMs(): number { return Number(process.env.GATEWAY_UPGRADE_URGENT_MS) || 10_000; }
export interface WatchOptions {
  intervalMs?: number; state?: () => ReleaseState | undefined;
  /**
   * Whether the installed release `to` is waiting urgently (a newer adapter is being refused beside this older host). While it
   * is, the upgrade is attempted without the two idle checks every `urgentUpgradeIntervalMs()`, and receives `urgent: true`.
   */
  urgent?: (to: string) => boolean | Promise<boolean>;
}

/**
 * Checks once a minute. When a different release is installed and `isIdle` stays true
 * for two checks in a row, it calls `upgrade` with the pending release. The wait is
 * measured with the monotonic clock, which does not advance while the Mac sleeps, so
 * it counts awake time only. An upgrade that reports false (work arrived meanwhile) is
 * retried at a later idle moment. While `options.urgent` says the pending release is urgent, it is tried
 * at once (one idle check is enough) and again every `urgentUpgradeIntervalMs()`, with `urgent: true`.
 */
export function watchForUpgrade(component: string, isIdle: () => boolean | Promise<boolean>,
  upgrade: (pending: PendingRelease) => boolean | UpgradeOutcome | Promise<boolean | UpgradeOutcome>,
  options: WatchOptions = {}): () => void {
  const read = options.state ?? (() => releaseState()); let idleChecks = 0; let done = false; let cancelled = false; let pendingSince: number | undefined;
  const check = (urgentTick: boolean) => {
    if (done || cancelled) return;
    const state = read();
    if (!newerReleaseInstalled(state)) { if (!urgentTick) { idleChecks = 0; pendingSince = undefined; } return; }
    pendingSince ??= performance.now();
    let claimed = false; // Only the attempt that took `done` gives it back: a failed check must not release another one's.
    void Promise.all([isIdle(), options.urgent ? options.urgent(state!.installed!) : false]).then(([idle, urgent]) => {
      if (done || cancelled) return;
      if (urgentTick && !urgent) return; // The urgent tick acts on nothing else: the minute tick keeps the usual rule.
      idleChecks = idle ? idleChecks + 1 : 0;
      if (idleChecks < 2 && !(urgent && idle)) return;
      done = true; claimed = true;
      return Promise.resolve(upgrade({ from: state!.running, to: state!.installed!, pendingMs: performance.now() - (pendingSince ?? performance.now()), ...(urgent ? { urgent: true } : {}) })).then(started => {
        if (started) {
          clearInterval(timer); clearInterval(urgentTimer);
          const outcome: UpgradeOutcome = started === true ? { mode: "idle" } : started;
          telemetry("self_upgrade", { component, from: state!.running, to: state!.installed, mode: outcome.mode,
            ...(outcome.mode !== "idle" ? { loadedChats: outcome.loadedChats ?? 0 } : {}) });
        }
        else { done = false; idleChecks = 0; }
      });
    }).catch(() => { if (claimed) { done = false; idleChecks = 0; } });
  };
  const timer = setInterval(() => check(false), options.intervalMs ?? (Number(process.env.GATEWAY_UPGRADE_CHECK_MS) || 60000));
  const urgentTimer = options.urgent ? setInterval(() => check(true), urgentUpgradeIntervalMs()) : undefined;
  timer.unref(); urgentTimer?.unref();
  return () => { cancelled = true; clearInterval(timer); clearInterval(urgentTimer); };
}
