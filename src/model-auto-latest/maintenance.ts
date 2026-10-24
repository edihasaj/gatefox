import { randomUUID } from "node:crypto";
import { readSnapshot, writeOwnedJson } from "../app-management/storage.js";
import { withPrivateFileLock } from "../private-file-lock.js";
import { defaultIdentity, maintenanceHeartbeatMs, maintenanceProtocol, readHeartbeat, type MaintenanceHeartbeat, type MaintenanceIdentity, type MaintenanceOwner } from "./maintenance-status.js";
import { reconcileAutoLatest } from "./reconcile.js";
import { rawAutoLatest } from "./settings.js";
import { maintenancePath } from "./state.js";
import { autoLatestIntervalMinutes, type AutoLatestResult, type ReconcileOptions } from "./types.js";

/**
 * Metadata upkeep that lives inside the one existing gateway process tree (the signed app-owned background item), so
 * there is no second launchd job. One owner per process: the server when the plan serves inference, otherwise the service
 * supervisor. It never restarts anything and never touches a request: each pass is the same metadata-only reconcile that
 * `gateway auto-latest check` runs.
 *
 *   start ─ heartbeat (30 s, own timer) ─ publishes pid + OS start + instance + `progressAt` ─▶ readMaintenanceStatus
 *         └ poll (30 s): read policy (≤10 s) ─ off ─▶ idle, progress stamped
 *                                          └ on ─▶ due? (just enabled, or 300 s since last) ─▶ reconcile (≤150 s, one at a time, abortable)
 *   stop ─ abort, clear timers, wait (bounded) for the pass in flight, write the stopped record, drain the write queue
 *
 * The heartbeat does not depend on the loop, so a heartbeat alone proves nothing about upkeep. `progressAt` moves only when
 * the loop completes a policy read or a pass; a read or pass that never returns stops it, and the status reader then stops
 * claiming maintenance. The stuck work is not restarted on top of itself.
 */
export const maintenanceIntervalMs = autoLatestIntervalMinutes * 60_000;
export const maintenancePollMs = 30_000;
export const maintenanceInitialDelayMs = 1_000;
/** The metadata discovery budget of one pass. */
export const maintenanceDiscoveryMs = 120_000;
/** A pass is the discovery budget plus the configuration write; beyond this it is treated as stuck. */
export const maintenancePassMs = 150_000;
export const maintenanceReadMs = 10_000;
/** How long stop() waits for a pass that does not honor the abort before it gives up on it. */
export const maintenanceStopWaitMs = 5_000;
const publishLockMs = 1_000;

export interface MaintenanceTimers { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void }
export interface MaintenanceOptions {
  owner: MaintenanceOwner;
  intervalMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  initialDelayMs?: number;
  readMs?: number;
  passMs?: number;
  stopWaitMs?: number;
  /** Test seams. */
  timers?: MaintenanceTimers;
  identity?: MaintenanceIdentity;
  reconcile?: (configPath: string, options: { signal: AbortSignal }) => Promise<Pick<AutoLatestResult, "outcome">>;
  /** The policy as it is right now. A throw counts as off for this tick. */
  readEnabled?: (configPath: string, signal: AbortSignal) => Promise<boolean>;
  /** Merged into the default reconcile (discovery, native home, a shorter budget); the signal is always the owner's. */
  reconcileOptions?: Partial<ReconcileOptions>;
}
export interface MaintenanceHandle {
  /**
   * Stops the owner at once (no new work, no new active heartbeat) and resolves when the stop record is written and the
   * write queue is empty. Idempotent: every call returns the same promise. Callers may discard it, but a host that removes
   * its folders afterwards must await it.
   */
  stop(): Promise<void>;
}

const realTimers: MaintenanceTimers = {
  set: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; },
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** The production reconcile: metadata only, never refreshes a login, discovery capped at 120 seconds. */
export function maintenanceReconcileOptions(signal: AbortSignal, extra: Partial<ReconcileOptions> = {}): ReconcileOptions {
  return { refresh: false, totalMs: maintenanceDiscoveryMs, ...extra, signal };
}

/** The production policy reader: the real, private configuration, read fresh every tick. */
export async function policyEnabled(configPath: string): Promise<boolean> {
  const snapshot = await readSnapshot(configPath);
  return snapshot ? rawAutoLatest(snapshot.raw)?.enabled === true : false;
}

type Outcome<T> = { kind: "done"; value: T } | { kind: "error" } | { kind: "timeout" };

export function startAutoLatestMaintenance(configPath: string, options: MaintenanceOptions): MaintenanceHandle {
  const timers = options.timers ?? realTimers;
  const identity = options.identity ?? defaultIdentity;
  const intervalMs = options.intervalMs ?? maintenanceIntervalMs;
  const pollMs = options.pollMs ?? maintenancePollMs;
  const heartbeatMs = options.heartbeatMs ?? maintenanceHeartbeatMs;
  const readMs = options.readMs ?? maintenanceReadMs;
  const passMs = options.passMs ?? maintenancePassMs;
  const stopWaitMs = options.stopWaitMs ?? maintenanceStopWaitMs;
  const reconcile = options.reconcile ?? ((path, extra) => reconcileAutoLatest(path, maintenanceReconcileOptions(extra.signal, options.reconcileOptions)));
  const readEnabled = options.readEnabled ?? ((path: string) => policyEnabled(path));
  const instance = randomUUID();
  const controller = new AbortController();
  let stopped = false;
  let heartbeatTimer: unknown; let tickTimer: unknown;
  let queue: Promise<void> = Promise.resolve();
  /** The last time the loop completed a policy read or a pass. The heartbeat carries it; nothing else moves it. */
  let progressAt = identity.now();

  /** Serialized per owner; across owners the private lock plus the instance check keep an old owner from clobbering a new one. */
  const publish = (state: "active" | "stopped"): void => {
    queue = queue.then(async () => {
      if (state === "active" && stopped) return;
      const path = await maintenancePath(configPath);
      const pid = identity.pid();
      const started = await identity.start(pid).catch(() => undefined);
      const boot = await identity.boot().catch(() => undefined);
      await withPrivateFileLock(path, async () => {
        if (state === "stopped") {
          const current = await readHeartbeat(configPath).catch(() => undefined);
          if (!current || current.instance !== instance) return;
        } else if (stopped) return;
        // Without an operating-system start there is no identity to publish, so no claim is made.
        if (started === undefined) return;
        const beat: MaintenanceHeartbeat = { protocol: maintenanceProtocol, pid, startedAtMs: started, ...(boot ? { bootId: boot } : {}),
          owner: options.owner, instance, updatedAt: identity.now(), progressAt, state };
        await writeOwnedJson(path, beat);
      }, publishLockMs);
    // Best effort: a missing or old record makes the app report not scheduled, never a false yes.
    }).catch(() => undefined);
  };

  const beat = (): void => {
    if (stopped) return;
    publish("active");
    heartbeatTimer = timers.set(beat, heartbeatMs);
  };

  /**
   * Runs `run` with a deadline. The deadline aborts the attempt's own signal (so does stop) but cannot cancel work that
   * ignores it: the caller keeps its own busy flag until that work really settles, so nothing is started on top of it.
   */
  const attempt = <T>(run: (signal: AbortSignal) => Promise<T>, ms: number, stopImmediately = false): Promise<Outcome<T>> => new Promise(resolve => {
    const own = new AbortController();
    // Settling the wrapper is separate from cancelling underlying I/O: a policy
    // reader may ignore its signal, but must not keep service shutdown waiting.
    const onStop = (): void => { own.abort(); if (stopImmediately) finish({ kind: "timeout" }); };
    controller.signal.addEventListener("abort", onStop, { once: true });
    let done = false; let timer: unknown;
    const finish = (result: Outcome<T>): void => {
      if (done) return; done = true;
      if (timer !== undefined) timers.clear(timer);
      controller.signal.removeEventListener("abort", onStop);
      if (result.kind === "timeout") own.abort();
      resolve(result);
    };
    timer = timers.set(() => finish({ kind: "timeout" }), ms);
    (async () => run(own.signal))().then(value => finish({ kind: "done", value }), () => finish({ kind: "error" }));
  });

  let lastRunAt: number | undefined;
  let readBusy = false; let passBusy = false;
  let running: Promise<void> | undefined;
  const tick = async (): Promise<void> => {
    tickTimer = undefined;
    if (stopped) return;
    try {
      // Work from an earlier tick that never returned is still holding its slot: wait for it, and report no progress.
      if (!readBusy && !passBusy) {
        readBusy = true;
        const read = await attempt(async signal => { try { return await readEnabled(configPath, signal); } finally { readBusy = false; } }, readMs, true);
        if (stopped || read.kind === "timeout") return;
        progressAt = identity.now();
        const enabled = read.kind === "done" && read.value === true;
        if (!enabled) lastRunAt = undefined;
        else if (lastRunAt === undefined || identity.now() - lastRunAt >= intervalMs) {
          lastRunAt = identity.now(); passBusy = true;
          const pass = await attempt(async signal => { try { return await reconcile(configPath, { signal }); } finally { passBusy = false; } }, passMs);
          if (!stopped && pass.kind !== "timeout") progressAt = identity.now();
        }
      }
    } finally {
      if (!stopped) tickTimer = timers.set(startTick, pollMs);
    }
  };
  function startTick(): void {
    const current = tick().catch(() => undefined).then(() => { if (running === current) running = undefined; });
    running = current;
  }

  beat();
  tickTimer = timers.set(startTick, options.initialDelayMs ?? maintenanceInitialDelayMs);

  /** Resolves when `work` settles or `ms` pass, whichever is first. */
  const settleWithin = (work: Promise<unknown>, ms: number): Promise<void> => new Promise(resolve => {
    const timer = timers.set(() => resolve(), ms);
    const done = (): void => { timers.clear(timer); resolve(); };
    work.then(done, done);
  });

  let stopping: Promise<void> | undefined;
  return {
    stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      controller.abort();
      if (heartbeatTimer !== undefined) timers.clear(heartbeatTimer);
      if (tickTimer !== undefined) timers.clear(tickTimer);
      heartbeatTimer = undefined; tickTimer = undefined;
      stopping = (async () => {
        const inFlight = running;
        if (inFlight) await settleWithin(inFlight, stopWaitMs);
        publish("stopped");
        await queue;
      })();
      return stopping;
    },
  };
}
