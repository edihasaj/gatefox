import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { configureTelemetry } from "./telemetry.js";
import { activateLoginConsolidation } from "./mac-login-consolidate.js";
import { runServiceSupervisor } from "./service-supervisor.js";

export interface ServiceDaemonDependencies {
  activate: typeof activateLoginConsolidation;
  run: typeof runServiceSupervisor;
  /** Holds the process until launchd stops it; see untilStopped. */
  standby: () => Promise<void>;
  notice: (line: string) => void;
}

/**
 * `gateway daemon`, the unified LaunchAgent's process. It promotes a staged next-login consolidation and runs the plan.
 * When activation had to roll an interrupted staging back instead, it put the original login jobs back and loaded all but
 * the primary one, whose label this job holds. This job then has no plan to run, so it stays up and idle, and so does every
 * relaunch of it in the same boot: exiting would only make launchd's KeepAlive start it again every ten seconds, each start
 * failing the same way. The original primary job starts at the next login (see docs/services.md for doing it sooner).
 */
export async function runServiceDaemon(configPath: string, overrides: Partial<ServiceDaemonDependencies> = {}): Promise<void> {
  const deps: ServiceDaemonDependencies = { activate: activateLoginConsolidation, run: runServiceSupervisor, standby: untilStopped,
    notice: line => { process.stderr.write(line + "\n"); }, ...overrides };
  const path = resolve(configPath); const config = await loadConfig(path);
  // A rollback below records its event before the supervisor configures telemetry for itself.
  configureTelemetry(config.stateDirectory, "service");
  const { plan, restored } = await deps.activate(path);
  if (plan && plan.config === path) { await deps.run(plan, config.stateDirectory); return; }
  if (!restored) throw new Error("Unified service plan is missing or uses another configuration");
  deps.notice("gateway: an interrupted next-login consolidation was rolled back; the original login jobs are back and loaded, except the primary one, which starts at the next login; this job stays idle until then");
  await deps.standby();
}

/**
 * Resolves on SIGTERM or SIGINT. An idle restart's SIGUSR2 is taken and dropped: a relaunch would only stand by again, and
 * the signal's default action would end the process. A long timer keeps the process alive meanwhile; it never wakes.
 * `signals` is the process; a test hands in an emitter of its own instead of raising signals in the test process.
 */
export function untilStopped(signals: Pick<NodeJS.EventEmitter, "on" | "once" | "off"> = process): Promise<void> {
  return new Promise(done => {
    const keep = setInterval(() => {}, 2 ** 30);
    const names: NodeJS.Signals[] = ["SIGTERM", "SIGINT"]; const held: NodeJS.Signals[] = process.platform === "win32" ? [] : ["SIGUSR2"];
    const ignore = () => {};
    const finish = () => { clearInterval(keep); for (const name of names) signals.off(name, finish); for (const name of held) signals.off(name, ignore); done(); };
    for (const name of names) signals.once(name, finish);
    for (const name of held) signals.on(name, ignore);
  });
}
