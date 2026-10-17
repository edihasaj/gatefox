import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, writePrivateJson } from "./config.js";
import { readServicePlan, type ServicePlan } from "./service-plan.js";
import { livePid } from "./execution-host-storage.js";
import { nativeHomeOwnerPath, readNativeHomeOwner } from "./native-execution-host-storage.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { consolidatedStatus } from "./mac-consolidate.js";
import { macService } from "./mac-service.js";
import { safeErrorMessage } from "./error-message.js";

/**
 * The plan swap. launchd's KeepAlive relaunches the service within milliseconds (at most launchd's ThrottleInterval of 10 s
 * later) from whatever plan file is on disk at that moment, so the plan file is the only thing a stop-and-wait could never win
 * against. Every sharing change therefore writes the plan the service must run first, restarts the service through its own idle
 * guard, and lets the relaunch read that plan. This module holds the parts a rollback needs after a relaunch already happened.
 */
export interface PlanSwapTiming {
  /** How long a relaunched service may take to answer /health before the restart is tried anyway. */
  readyMs: number;
  pollMs: number;
  /** How often the idle-guarded restart is tried. */
  restartAttempts: number;
  /** Pause between two restart attempts. */
  retryMs: number;
}
export const planSwapTiming: PlanSwapTiming = { readyMs: 30000, pollMs: 500, restartAttempts: 3, retryMs: 2000 };

/** The service operations a plan swap uses; tests replace them to stand in for launchd. */
export interface PlanSwapServices {
  status(state: string): Promise<Record<string, unknown>>;
  /** Whether the service answers /health. A service without local inference has nothing to ask and answers true. */
  health(config: string): Promise<boolean>;
  /** Idle-guarded restart: the service exits and launchd's KeepAlive starts it again from the plan on disk. */
  restart(config: string): Promise<unknown>;
  install(config: string): Promise<unknown>;
}

export async function serviceHealthy(configPath: string): Promise<boolean> {
  const config = await loadConfig(configPath); const plan = await readServicePlan(config.stateDirectory);
  if (config.clientOnly || (plan && !plan.components.some(component => component.kind === "inference"))) return true;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.json() as { status?: string }).status === "ok";
  } catch { return false; }
}

export const defaultPlanSwapServices: PlanSwapServices = {
  status: consolidatedStatus, health: serviceHealthy, restart: config => macService("restart", config), install: config => macService("install", config),
};

/** Replaces the plan file with exactly this text. A relaunch may read the file at any moment, so it is renamed into place. */
export async function writePlanText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(text); await file.sync(); } catch (error) { await file.close(); await unlink(temporary).catch(() => {}); throw error; }
  await file.close();
  try { await rename(temporary, path); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  await chmod(path, 0o600);
}

/**
 * What a service restart onto the plan file achieved.
 * - started: the service was down and is started from the plan file.
 * - restarted: a relaunched service was restarted again and now reads the plan file.
 * - kept: the service never left the plan it was running when the file was written.
 * - stuck: a relaunched service still runs its earlier plan; the idle restart kept failing.
 * - down: the service was down and could not be started.
 * - unknown: the service state could not be read.
 */
export type RelaunchOutcome = "started" | "restarted" | "kept" | "stuck" | "down" | "unknown";

async function awaitCurrent(services: PlanSwapServices, configPath: string, state: string, timing: PlanSwapTiming): Promise<boolean> {
  const end = Date.now() + timing.readyMs;
  for (;;) {
    try {
      const status = await services.status(state);
      if (status.statusCurrent === true && typeof status.pid === "number" && await services.health(configPath)) return true;
    } catch { /* The service is still starting. */ }
    if (Date.now() >= end) return false;
    await delay(timing.pollMs);
  }
}

/**
 * Brings the service onto the plan file after it was rewritten. `runningPid` is the process that ran the plan the file held
 * before the swap: still alive means the service never left it. Any other process was relaunched from the plan written before
 * this rewrite and must restart once more. That relaunch starts its host before inference (service-supervisor), so a restart
 * issued at once finds /health refused and the idle guard refusing: wait for the service to be current and healthy, then retry.
 */
export async function relaunchOntoPlan(services: PlanSwapServices, configPath: string, state: string, runningPid: number | undefined, timing: PlanSwapTiming = planSwapTiming): Promise<RelaunchOutcome> {
  let now: Record<string, unknown>;
  try { now = await services.status(state); } catch { return "unknown"; }
  if (typeof now.pid !== "number") { try { await services.install(configPath); return "started"; } catch { return "down"; } }
  if (now.pid === runningPid) return "kept";
  const relaunched = now.pid;
  await awaitCurrent(services, configPath, state, timing);
  for (let attempt = 0; attempt < timing.restartAttempts; attempt++) {
    try { await services.restart(configPath); return "restarted"; } catch { /* Retried below. */ }
    // A refused restart can still have taken effect: a different process, or none, means launchd relaunched from the file.
    try {
      const after = await services.status(state);
      if (typeof after.pid !== "number") { await services.install(configPath); return "started"; }
      if (after.pid !== relaunched) return "restarted";
    } catch { /* Retried below. */ }
    if (attempt + 1 < timing.restartAttempts) { await delay(timing.retryMs); await awaitCurrent(services, configPath, state, timing); }
  }
  return "stuck";
}

/** Whether a service started from this plan starts an execution host that claims the host receipt. */
export const planSharesExecutors = (plan: ServicePlan): boolean => plan.sharedExecutors === true || plan.sharedNativeExecutor === true;

/**
 * Releases only the native-home receipt of a stopped host, never the host's own owner.json. Used after a relaunch that keeps
 * gateway executors: the new host claimed owner.json already, but it does not claim the native home, so the stopped native
 * receipt would stay behind. It checks that the receipt names this configuration and native home and that its state and pids
 * say stopped (no live pid); it does not check socketPath, the Codex executable, the SDK identity or the revision.
 */
export async function archiveStoppedNativeHomeReceipt(identity: { configPath: string; nativeHome: string }, backup: string): Promise<string | undefined> {
  const receipt = nativeHomeOwnerPath(identity.nativeHome);
  if (!await lstat(receipt).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) return;
  return withPrivateFileLock(receipt, async () => {
    const owner = await readNativeHomeOwner(identity.nativeHome); if (!owner) return;
    if (owner.configPath !== resolve(identity.configPath) || owner.nativeHome !== resolve(identity.nativeHome)) throw new Error("The native execution receipt belongs to another configuration; it was preserved");
    if (livePid(owner.hostPid) || livePid(owner.pid) || owner.state !== "stopped" || owner.sdkState !== "stopped" || owner.hostPid !== 0 || owner.pid !== 0) {
      throw new Error("Native execution ownership is not fully stopped; its receipt was preserved");
    }
    await mkdir(backup, { recursive: true, mode: 0o700 }); const target = resolve(backup, "native-execution-owner.json");
    if (await lstat(target).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("Native ownership backup already exists; its receipt was preserved");
    await rename(receipt, target); return target;
  });
}

/** Which plan a service runs while the plan file names another one. */
export type RunningPlan = "previous" | "replacement" | "down" | "unknown";

export type EnableRollbackOutcome =
  /** The plan file holds the previous plan and the service runs it. */
  "restored"
  /** The replacement could not be restarted: it keeps running, and the plan file holds the plan it runs. */
  | "preserved"
  /** The service could not be read before anything was undone: the plan file holds the replacement plan, the running plan is unknown. */
  | "unchecked"
  /** The plan file holds the previous plan, but the service still runs the replacement. */
  | "stuck"
  /** The plan file holds the previous plan, but the service is down and could not be started. */
  | "down"
  /** The plan file holds the previous plan, but the service could not be read afterwards. */
  | "unknown"
  /** The service runs the previous plan, which the plan file holds; only the stopped host receipt could not be archived. */
  | "archive_failed"
  /** The previous plan could not be written back: the plan file still holds the replacement plan. `running` says what runs. */
  | "not_restored";

export interface EnableRollback { outcome: EnableRollbackOutcome; running?: RunningPlan }

/**
 * Undoes a failed enable by the plan swap. The previous plan is written first and the replacement is restarted through its own
 * idle guard, so launchd's KeepAlive cannot relaunch it on the plan being undone. Once the service runs the previous plan its
 * stopped host receipt is archived, unless that plan shares executors itself: its new host then takes the receipt over.
 * A replacement that cannot be restarted (loaded chats refuse the idle guard) keeps running its own plan, so the plan file is
 * put back to match it: the file never names a plan the service is not running, unless the outcome says otherwise.
 */
export async function rollBackEnable(options: { configPath: string; state: string; path: string; original: string; previous: ServicePlan; next: ServicePlan;
  beforePid: number | undefined; archive(): Promise<unknown>; services: PlanSwapServices; timing?: PlanSwapTiming }): Promise<EnableRollback> {
  const { configPath, state, path, original, next, services } = options; const timing = options.timing ?? planSwapTiming;
  let replacement: unknown;
  try { replacement = (await services.status(state)).pid; } catch { return { outcome: "unchecked" }; }
  // A refused idle restart leaves the original process running the plan being restored; it needs no restart.
  const originalRuns = !!options.beforePid && replacement === options.beforePid;
  try { await writePlanText(path, original); } catch {
    return { outcome: "not_restored", running: originalRuns ? "previous" : typeof replacement === "number" ? "replacement" : "down" };
  }
  if (originalRuns) return { outcome: "restored" };
  const outcome = await relaunchOntoPlan(services, configPath, state, options.beforePid, timing);
  if (outcome === "down" || outcome === "unknown") return { outcome };
  if (outcome === "stuck") {
    // The replacement still runs `next`, unless a late relaunch happened after all.
    let pid: unknown;
    try { pid = (await services.status(state)).pid; } catch { return { outcome: "unknown" }; }
    if (typeof pid !== "number") return { outcome: "down" };
    if (pid === replacement) {
      try { await writePrivateJson(path, next); return { outcome: "preserved" }; } catch { return { outcome: "stuck" }; }
    }
    // A late relaunch read the previous plan from the file: the service runs it, so the receipt is archived below.
  }
  if (planSharesExecutors(options.previous)) return { outcome: "restored" };
  try { await options.archive(); } catch { return { outcome: "archive_failed" }; }
  return { outcome: "restored" };
}

/** What a rollback that could not write the previous plan back says about the plan that runs and how to fix it. */
export function planNotWrittenBackMessage(reason: string, backup: string, path: string, running: RunningPlan, names: { previous: string; replacement: string }): string {
  const saved = `${backup}/service-plan.json`;
  const head = `${reason} The previous plan could not be written back, so the plan file still holds ${names.replacement} (${path}). The previous plan is saved in ${saved}.`;
  switch (running) {
    case "previous": return `${head} The service still runs ${names.previous}; to make the file match it, copy ${saved} over ${path}. No restart is needed.`;
    case "replacement": return `${head} The service runs ${names.replacement}; to go back, copy ${saved} over ${path}, then run \`gateway service restart\` when idle.`;
    case "down": return `${head} The service is down; copy ${saved} over ${path}, then run \`gateway service install\`.`;
    case "unknown": return `${head} The service could not be checked; run \`gateway service status\`, copy ${saved} over ${path}, then run \`gateway service restart\` when idle.`;
  }
}

/** The message of a failed enable whose rollback did not end clean, or undefined when it did (the original error then stands). */
export function enableRollbackMessage(mode: string, error: unknown, backup: string, path: string, result: EnableRollback): string | undefined {
  const reason = `Enabling ${mode} failed (${safeErrorMessage(error, "Unknown failure")}).`; const withMode = `the plan with ${mode}`; const without = `the plan without ${mode}`;
  switch (result.outcome) {
    case "restored": return undefined;
    case "preserved": return `${reason} The replacement could not be restarted and keeps running ${withMode}; the plan file holds that plan, so the file and the service match, and its active writers were preserved. The previous plan is saved in ${backup}/service-plan.json. To go back, run \`gateway service ${mode} --disable --apply\` when idle.`;
    case "unchecked": return `${reason} The service could not be checked, so which plan it runs is unknown; the plan file holds ${withMode}. Run \`gateway service status\`, then \`gateway service ${mode} --disable --apply\` when idle to go back to the previous plan saved in ${backup}/service-plan.json.`;
    case "stuck": return `${reason} The plan file is restored from ${backup}, but the service still runs ${withMode}; run \`gateway service restart\` when idle.`;
    case "down": return `${reason} The plan file is restored from ${backup}, but the service is down and could not be started; run \`gateway service install\`.`;
    case "unknown": return `${reason} The plan file is restored from ${backup}, but the service could not be checked; run \`gateway service status\`, then \`gateway service restart\` when idle.`;
    case "archive_failed": return `${reason} The previous plan is restored from ${backup} and the service runs it, so the plan file and the service match. The stopped host receipt could not be archived and stays in place for the next host to take over.`;
    case "not_restored": return planNotWrittenBackMessage(reason, backup, path, result.running ?? "unknown", { previous: without, replacement: withMode });
  }
}
