import { stat } from "node:fs/promises";
import { pushUrlPath } from "./health-push.js";

/**
 * The in-process heartbeat for `gateway health --push`.
 *
 * The watchdog has to answer within minutes of an app update, and nothing that needs a
 * person to notice does. So the service runs the same checks on a timer, in its own
 * process: one tick per interval, the first tick a full interval in so a start is never
 * a burst, and never two at a time — a compatibility run takes minutes and a second one
 * beside it would only say the same thing later. The timer is unref'd, so a service that
 * is otherwise idle exits at once, and the whole thing stands down while there is no
 * monitor URL to send to.
 */
export interface HealthScheduleOptions {
  stateDirectory: string;
  /** What a tick runs. Defaults to the health checks and their push, in this process. */
  run?: () => Promise<void>;
  /** How long between ticks. Defaults to ten minutes, well inside a 15-minute monitor. */
  intervalMs?: number;
  /** Whether this Mac was given a monitor URL at all. */
  exists?: (path: string) => Promise<boolean>;
  /** The timer the repeats ride on; tests hand in one they drive themselves. */
  timers?: { set: (tick: () => void, ms: number) => () => void };
}

export const healthIntervalMs = 10 * 60_000;

/** Starts the heartbeat and returns the function that stops it for good. */
export function startHealthSchedule(options: HealthScheduleOptions): () => void {
  const intervalMs = options.intervalMs ?? healthIntervalMs;
  const exists = options.exists ?? (path => stat(path).then(() => true, () => false));
  const urlPath = pushUrlPath(options.stateDirectory);
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    // An unfinished tick is not a skipped tick: the next one waits for this answer.
    running = (async () => {
      if (!await exists(urlPath).catch(() => false)) return;
      await (options.run ?? defaultRun(options.stateDirectory))();
    })().catch(() => undefined).then(() => { running = undefined; });
  };
  const cancel = (options.timers ?? { set: repeat }).set(tick, intervalMs);
  return () => { stopped = true; cancel(); };
}

/** The default tick: the same checks the command runs, with the push, and no printing. */
function defaultRun(stateDirectory: string): () => Promise<void> {
  return async () => {
    const { loadConfig } = await import("./config.js");
    const { configPath } = await import("./paths.js");
    const { runHealth } = await import("./health.js");
    const config = await loadConfig(await configPath());
    await runHealth({ stateDirectory: config.stateDirectory, port: config.port, clientOnly: config.clientOnly, push: true });
  };
}

/** A repeating timer that never holds the process open on its own. */
function repeat(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref();
  return () => clearInterval(timer);
}
