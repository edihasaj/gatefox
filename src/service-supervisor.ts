import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { serviceStatusPath, type ServiceComponent, type ServicePlan } from "./service-plan.js";
import { startExecutionHost, type QuietWait } from "./execution-host.js";
import { serviceTunnelArguments, staleForwardCleanup } from "./service-tunnel.js";
import { configureTelemetry, telemetry } from "./telemetry.js";
import { reportException, startErrorReports } from "./error-report.js";
import { watchForUpgrade, type PendingRelease, type UpgradeOutcome } from "./self-update.js";
import { componentStopMs, inferenceStopGraceMs } from "./runtime-activity.js";
import { chatGptAppRunning, nativeRegistrationClaimed, nativeRegistrationEnabled, relayFingerprint } from "./native-pause.js";
import { defaultHealing, exitReason, failingStreak, quickExitMs, statusFailureGapMs, statusWriteCode, upgradeGraceMs, upgradeQuietMs, type SupervisorHealing } from "./service-heal.js";
import { ServiceHostKeeper, type ExecutionHost } from "./service-host-keeper.js";
export type { SupervisorHealing } from "./service-heal.js";

/** Why a quiet upgrade waited: the host's reason, or inference that refused its idle guard. */
type UpgradeWait = QuietWait | "inference_busy";
/** A restart that stopped the service (with the host's loaded-chat count), or one that was refused, with why when known. */
type RestartResult = { loadedChats: number } | { wait?: UpgradeWait };
interface ComponentState { id: string; kind: string; state: "starting" | "running" | "waiting" | "complete" | "stopped" | "paused"; pid?: number; restarts: number; nextRestartAt?: string; pausedReason?: PauseReason; pausedAt?: string }
type PauseReason = "not_registered" | "failing";
/** How a slot decides whether the optional relay is worth starting; tests replace all three. */
export interface NativeProbes {
  registered: (state: string) => Promise<boolean>;
  /** Whether the relay owns remote control for engines that start now: registered, or an activation pending. Defaults to `registered`. */
  claimed?: (state: string) => Promise<boolean>;
  fingerprint: (component: ServiceComponent, state: string) => Promise<string>;
  appRunning: () => Promise<boolean>;
}
export const nativeProbes: NativeProbes = { registered: nativeRegistrationEnabled, claimed: nativeRegistrationClaimed, fingerprint: relayFingerprint, appRunning: chatGptAppRunning };
/**
 * A relay that dies within a minute three times in a row cannot run here; it is left paused.
 * A resumed relay is given a single start, not a fresh three-strike budget, and a relay paused
 * for failing is tried again every half hour even when nothing changed, so a brief start-up
 * problem never pauses it for good: a broken relay costs at most two starts an hour.
 */
const nativeQuickFailureMs = 60000; const nativeQuickFailureLimit = 3; const nativeRecheckMs = 300000; const nativeBlindRetryMs = 1800000;
/**
 * A paused relay notices a new registration this soon. `gateway native install` registers the relay while ChatGPT is closed;
 * waiting for the five-minute re-check would leave the machine's one remote-control slot free for any engine that starts meanwhile.
 */
const nativeRegistrationPollMs = 2000;
const execFileAsync = promisify(execFile);
interface Slot { definition: ServiceComponent; state: ComponentState; child?: ChildProcess; exited?: Promise<void>; timer?: NodeJS.Timeout; starting?: boolean; failures: number; startedAt: number; quickFailures: number; quickExits: number; fingerprint?: string; pausedAt: number; resumedOnce: boolean }
/** Waits for `done` at most `ms`; the timer never outlives the wait, so a stopped service exits at once. */
function within(done: Promise<unknown> | undefined, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}
export class ServiceSupervisor {
  private stopping = false;
  private slots: Slot[];
  private writes: Promise<void> = Promise.resolve();
  private heartbeat?: NodeJS.Timeout;
  private stopDone?: Promise<void>;
  private restarting = false;
  private wakeWatch?: NodeJS.Timeout;
  private stopUpgradeWatch?: () => void;
  private lastTick = Date.now();
  private pauseWatch?: NodeJS.Timeout;
  private registrationWatch?: NodeJS.Timeout;
  private registrationChecking = false;
  private registrationSeen?: string;
  private readonly heal: SupervisorHealing;
  /** The shared execution host's start, backoff, kick, probe and host-only restart (src/service-host-keeper.ts). */
  private readonly host: ServiceHostKeeper;
  private stopHealth?: () => void;
  private statusFailedAt = Number.NEGATIVE_INFINITY;
  /** `self_upgrade_waiting` already logged, per pending release and reason. */
  private readonly upgradeWaits = new Set<string>();
  private stoppedResolve: () => void = () => {};
  readonly stopped = new Promise<void>(resolve => { this.stoppedResolve = resolve; });
  constructor(private plan: ServicePlan, private state: string, private retryBaseMs = 1000, startHost: typeof startExecutionHost = startExecutionHost,
    private readonly probes: NativeProbes = nativeProbes, private readonly recheckMs = nativeRecheckMs, private readonly blindRetryMs = nativeBlindRetryMs,
    healing: Partial<SupervisorHealing> = {}, private readonly registrationPollMs = nativeRegistrationPollMs) {
    this.heal = { ...defaultHealing, ...healing };
    this.host = new ServiceHostKeeper({ plan, state, retryBaseMs, startHost, heal: this.heal,
      registered: () => (this.probes.claimed ?? this.probes.registered)(this.state),
      stopping: () => this.stopping, restarting: () => this.restarting, publish: () => this.publish(),
      restartWhenIdle: () => this.restartWhenIdle() });
    this.slots = plan.components.map(definition => ({ definition, state: { id: definition.id, kind: definition.kind, state: "starting", restarts: 0 }, failures: 0, startedAt: 0, quickFailures: 0, quickExits: 0, pausedAt: 0, resumedOnce: false }));
  }
  /**
   * Writes the status file. It is advisory: a write that fails (a full disk, a folder that turned read-only) never stops
   * the service, is reported at most once a minute, and the next heartbeat simply writes again. The promise never rejects.
   */
  private publish(): Promise<void> {
    const snapshot = { version: 1, pid: process.pid, updatedAt: new Date().toISOString(), stopping: this.stopping, components: this.slots.map(slot => ({ ...slot.state })), ...(this.host.executionState ? { executionHost: { ...this.host.executionState } } : {}) };
    this.writes = this.writes.then(() => writePrivateJson(serviceStatusPath(this.state), snapshot)).catch(error => this.statusWriteFailed(error));
    return this.writes;
  }
  private statusWriteFailed(error: unknown): void {
    const now = performance.now();
    if (now - this.statusFailedAt < statusFailureGapMs) return;
    this.statusFailedAt = now;
    telemetry("status_write_failed", { code: statusWriteCode(error) });
  }
  async start(): Promise<void> {
    if (this.stopping) return;
    if (this.plan.sharedExecutors || this.plan.sharedNativeExecutor) {
      await this.host.start();
      if (this.stopping) return;
    }
    for (const slot of this.slots) await this.startSlot(slot);
    if (this.stopping) return;
    this.heartbeat = setInterval(() => { void this.publish(); }, 5000);
    this.lastTick = Date.now(); this.wakeWatch = setInterval(() => this.checkWake(Date.now()), 5000);
    // The relay is optional, so a paused one is only tried again quietly, every five minutes.
    if (this.slots.some(slot => slot.definition.kind === "native")) {
      // A re-check that cannot be answered is handled inside resumePaused; it never stops the service. The same tick
      // retries a host restart a busy host refused (see restartHostWhenIdle).
      this.pauseWatch = setInterval(() => { void this.resumePaused().catch(() => undefined); void this.host.restartHostWhenIdle(); }, this.recheckMs); this.pauseWatch.unref();
      // A relay set aside as unregistered starts the moment a registration appears, not at the next re-check, and a shared host
      // that started before the registration is asked to restart (when idle) so its native engine stands down too.
      this.registrationWatch = setInterval(() => { void this.resumeOnRegistration(); void this.host.restartForRegistration().catch(() => undefined); }, this.registrationPollMs); this.registrationWatch.unref();
    }
    // The service moves to a newly installed release when fully idle (no app connected and no chat loaded), or, once the
    // release has waited out the grace, when quiet (see upgrade); until then it keeps the previous one.
    this.stopUpgradeWatch = watchForUpgrade("service", () => !this.stopping && !this.restarting && !this.host.hostRestarting, pending => this.upgrade(pending),
      { state: this.heal.releaseState });
    // The watchdog heartbeat; it stands down while this Mac has no monitor URL.
    this.stopHealth = this.heal.healthSchedule(this.state, this.plan.config);
    await this.publish();
  }
  /** Probes the running host now; the service's own probe tick does the same (see ServiceHostKeeper.checkHost). */
  checkHost(): Promise<void> { return this.host.checkHost(); }
  private nativePaused(): boolean { return this.slots.some(slot => slot.definition.kind === "native" && slot.state.state === "paused"); }
  /**
   * The service never keeps the Mac awake. When a timer tick arrives far later than
   * scheduled, the system slept; SSH tunnels then restart at once instead of waiting
   * for their keepalives to time out, so the other Macs reconnect within seconds.
   */
  checkWake(now: number): void {
    const gap = now - this.lastTick; this.lastTick = now;
    if (this.stopping || gap < 30000) return;
    telemetry("system_wake", { sleptSeconds: Math.round(gap / 1000) });
    for (const slot of this.slots) {
      if (slot.definition.kind !== "tunnel") continue;
      slot.failures = 0; slot.quickExits = 0;
      if (slot.child) slot.child.kill("SIGTERM");
      else if (slot.timer && !slot.starting) { clearTimeout(slot.timer); slot.timer = undefined; delete slot.state.nextRestartAt; void this.startSlot(slot).catch(() => { void this.stop(); }); }
    }
  }
  private async startSlot(slot: Slot): Promise<void> {
    // One start per slot at a time: a tunnel's stale-listener cleanup can take seconds, and a
    // wake during it must not spawn a second process for the same forwarded port.
    if (this.stopping || slot.starting || slot.child) return;
    slot.starting = true;
    try {
      // An unregistered relay is never started: ChatGPT keeps its own remote control. An unreadable
      // receipt reads as unregistered, and only a probe that throws is the failed question that
      // leaves today's start untouched.
      if (slot.definition.kind === "native" && !await this.probes.registered(this.state).catch(() => true)) { await this.pause(slot, "not_registered"); return; }
      await this.spawnSlot(slot);
    } catch (error) {
      // A relay whose log cannot even be opened is a relay that cannot run: it is set aside with
      // the other broken ones. Nothing here may take inference, tunnels or the app down.
      if (slot.definition.kind !== "native" || this.stopping) throw error;
      reportException(error, "service_native_spawn");
      await this.pause(slot, "failing");
    } finally { slot.starting = false; }
  }
  /** Leaves a slot paused, once per reason, with no child, no timer and no further log lines. */
  private async pause(slot: Slot, reason: PauseReason): Promise<void> {
    if (slot.state.state === "paused" && slot.state.pausedReason === reason) return;
    // What is installed right now is what a later restart has to differ from, so it is read
    // before the slot is ever visible as paused.
    const fingerprint = await this.probes.fingerprint(slot.definition, this.state).catch(() => undefined);
    if (this.stopping || slot.child) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = undefined; }
    slot.state.state = "paused"; slot.state.pausedReason = reason; slot.state.pausedAt = new Date().toISOString(); slot.fingerprint = fingerprint; slot.pausedAt = Date.now(); slot.resumedOnce = false;
    delete slot.state.nextRestartAt;
    telemetry("component_paused", { component: slot.state.id, kind: slot.state.kind, reason });
    await this.publish();
  }
  /**
   * Re-checks the relay slots a timer put aside. It starts one again only when the relay is
   * registered, either its binaries or receipt changed since the pause or the half-hourly blind
   * retry is due, and no ChatGPT app is open to compete with it; a relay that connects later is
   * picked up by the next adapter or listener. Nothing here stops the service: an answer that never
   * arrives leaves the slot paused with reason `failing`, announced once.
   */
  private async resumeOnRegistration(): Promise<void> {
    const slot = this.slots.find(candidate => candidate.definition.kind === "native" && candidate.state.state === "paused");
    if (!slot || this.registrationChecking || this.stopping || this.restarting) return;
    this.registrationChecking = true;
    try {
      // Only a change to what the relay would restart into (its binaries or the registration record) is worth a re-check now;
      // an unchanged answer is left to the five-minute tick, so an open ChatGPT app is not asked about every two seconds.
      const seen = await this.probes.fingerprint(slot.definition, this.state);
      const baseline = this.registrationSeen ?? slot.fingerprint; this.registrationSeen = seen;
      if (seen !== baseline && await this.probes.registered(this.state)) await this.resumePaused();
    } catch { /* A poll that fails is retried by the next poll and the five-minute tick. */ }
    finally { this.registrationChecking = false; }
  }
  async resumePaused(): Promise<void> {
    if (this.stopping || this.restarting) return;
    for (const slot of this.slots) {
      if (slot.state.state !== "paused" || slot.definition.kind !== "native") continue;
      try {
        let registered = false;
        try { registered = await this.probes.registered(this.state); } catch { registered = false; }
        // The pause baseline is kept: an unregistered stretch is not a change to restart into.
        if (!registered) continue;
        // Only what was installed when the slot was set aside is the baseline, so a change made
        // while the app was open is still a reason to restart once the app is closed.
        const changed = slot.fingerprint === undefined || slot.fingerprint !== await this.probes.fingerprint(slot.definition, this.state);
        // A relay that was well enough to register but died at once deserves another try once the
        // binaries or the receipt differ, or once every half hour regardless: a start-up problem
        // must not set the relay aside for good.
        if (slot.state.pausedReason === "failing" && !changed && Date.now() - slot.pausedAt < this.blindRetryMs) continue;
        if (await this.probes.appRunning()) continue;
      } catch (error) {
        // The relay's own question went unanswered. Leave it paused and serve everything else.
        reportException(error, "service_relay_recheck");
        await this.pause(slot, "failing");
        continue;
      }
      // Stop or a restart may have happened while one of the probes above was in the air.
      if (this.stopping || this.restarting || slot.state.state !== "paused") return;
      slot.failures = 0; slot.quickFailures = 0; slot.resumedOnce = true; delete slot.state.pausedReason; delete slot.state.pausedAt; delete slot.state.nextRestartAt;
      slot.state.state = "starting";
      telemetry("component_resumed", { component: slot.state.id, kind: slot.state.kind });
      await this.startSlot(slot);
      await this.publish();
    }
  }
  private async spawnSlot(slot: Slot): Promise<void> {
    const component = slot.definition;
    await mkdir(dirname(component.log), { recursive: true, mode: 0o700 });
    const log = await open(component.log, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await log.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Service component log must be private");
      if (this.stopping) return;
      const args = component.kind === "tunnel" && component.command === "/usr/bin/ssh" ? serviceTunnelArguments(component.args) : component.args;
      const cleanup = component.kind === "tunnel" && component.command === "/usr/bin/ssh" ? staleForwardCleanup(component.args) : undefined;
      if (cleanup) {
        const freed = await execFileAsync(component.command, serviceTunnelArguments(cleanup), { timeout: 15000, env: { ...process.env, ...component.environment } }).then(result => Number(result.stdout.trim()) || 0, () => 0);
        if (freed) telemetry("tunnel_stale_listener_cleared", { component: component.id, processes: freed });
        if (this.stopping) return;
      }
      const child = spawn(component.command, args, { stdio: ["ignore", log.fd, log.fd], env: { ...process.env, ...component.environment } });
      slot.child = child; slot.startedAt = Date.now();
      slot.exited = new Promise(resolve => child.once("close", () => resolve()));
      let handled = false;
      const ended = (code: number | null, signal?: NodeJS.Signals | null) => {
        if (handled) return; handled = true; slot.child = undefined; delete slot.state.pid;
        if (!this.stopping && !(component.kind === "desktop" && code === 0)) telemetry("component_exit", { component: component.id, kind: component.kind, code, uptimeMs: Date.now() - slot.startedAt, restarts: slot.state.restarts });
        if (this.stopping) slot.state.state = "stopped";
        else if (component.kind === "desktop" && code === 0) slot.state.state = "complete";
        else if (!this.restarting || component.kind !== "inference") {
          const uptime = Date.now() - slot.startedAt;
          slot.failures = uptime >= 60000 ? 1 : slot.failures + 1;
          // Five quick exits in a row are reported once per streak; the component keeps its backoff, so a passing fault
          // (a port still held, a network that is not up yet) heals on its own.
          if (component.kind === "inference" || component.kind === "tunnel") {
            slot.quickExits = uptime < quickExitMs ? slot.quickExits + 1 : 0;
            if (slot.quickExits === failingStreak) telemetry("component_failing", { component: component.id, kind: component.kind, failures: slot.quickExits, reason: exitReason(code, signal) });
          }
          if (component.kind === "native") {
            // A relay the app's new engine rejects exits at once; retrying it every 30 s only fills
            // the log. A death by signal, or one that never spawned at all (code null), counts too,
            // so a missing binary is set aside instead of retried once a minute forever.
            const quick = code !== 0 && Date.now() - slot.startedAt < nativeQuickFailureMs;
            slot.quickFailures = quick ? slot.quickFailures + 1 : 0;
            // A relay that ran past its first minute earned a fresh three-strike budget, resumed or not.
            if (!quick) slot.resumedOnce = false;
            // A resumed relay is out of retries: one more quick failure sets it aside again at once.
            if (slot.quickFailures >= (slot.resumedOnce ? 1 : nativeQuickFailureLimit)) { void this.pause(slot, "failing"); return; }
          }
          const retry = Math.min(30000, this.retryBaseMs * 2 ** Math.min(slot.failures - 1, 10));
          slot.state.state = "waiting"; slot.state.restarts++; slot.state.nextRestartAt = new Date(Date.now() + retry).toISOString();
          slot.timer = setTimeout(() => { slot.timer = undefined; delete slot.state.nextRestartAt; void this.startSlot(slot).catch(() => { void this.stop(); }); }, retry);
        }
        void this.publish();
      };
      child.once("error", () => ended(null)); child.once("close", (code, signal) => ended(code, signal));
      child.once("spawn", () => { slot.state.state = "running"; slot.state.pid = child.pid; void this.publish(); });
    } finally { await log.close(); }
  }
  /**
   * The strict idle restart: `gateway service restart` (SIGUSR2), a failed host close and the first try of every upgrade. The
   * host must have no adapter lease and no loaded chat, then inference must accept its own idle guard.
   */
  async restartWhenIdle(): Promise<boolean> { return "loadedChats" in await this.restartAfter(async (host): Promise<RestartResult> => await host.prepareStop() ? { loadedChats: 0 } : {}); }
  /**
   * The move to a newer release. The strict idle restart is tried first. Once the release has been installed for
   * `upgradeGraceMs` (15 min of awake time) and that still refuses (a remote app that stays connected for days keeps a lease
   * and its chats loaded), the service restarts when quiet instead: the host's quiet check (no turn running in any engine, no
   * background terminal, none ended in the last `upgradeQuietMs`, 5 min), then the same inference guard, so inference with
   * requests running still refuses. The host then closes like a restarted host: adapters kick, wait for the new one and
   * resume their chats. Each reason a quiet attempt waited is logged once per pending release as `self_upgrade_waiting`.
   */
  private async upgrade(pending: PendingRelease): Promise<UpgradeOutcome | false> {
    if (await this.restartWhenIdle()) return { mode: "idle" };
    if (this.stopping || pending.pendingMs < upgradeGraceMs()) return false;
    const quietMs = upgradeQuietMs();
    const result = await this.restartAfter(async host => await host.prepareQuietStop?.(quietMs) ?? {});
    if ("loadedChats" in result) return { mode: "quiet", loadedChats: result.loadedChats };
    const key = `${pending.to}\0${result.wait}`;
    if (result.wait && !this.stopping && !this.upgradeWaits.has(key)) {
      this.upgradeWaits.add(key); telemetry("self_upgrade_waiting", { component: "service", from: pending.from, to: pending.to, reason: result.wait });
    }
    return false;
  }
  /**
   * One restart at a time, never while stopping: `hostReady` closes the host's gate (an idle or quiet check, returning the
   * loaded-chat count, or why it refused), then inference must accept SIGUSR2 and exit, and the service stops for launchd to
   * start it again. Any refusal reopens the host and leaves everything running.
   */
  private async restartAfter(hostReady: (host: ExecutionHost) => Promise<RestartResult>): Promise<RestartResult> {
    // A host-only restart in progress is finished first; the service restart is asked again later.
    if (this.stopping || this.restarting || this.host.hostRestarting) return {};
    const inference = this.slots.find(slot => slot.definition.kind === "inference");
    if (inference && !inference.child) return {};
    this.restarting = true;
    let executionHost: ExecutionHost | undefined; let loadedChats = 0;
    try {
      // A host whose close failed has already dropped every adapter and refuses any idle check, so it is not asked.
      executionHost = this.host.hostCloseFailed ? undefined : await this.host.executionStarting;
      if (executionHost) {
        const ready = await hostReady(executionHost);
        if (!("loadedChats" in ready)) { this.restarting = false; return ready; }
        loadedChats = ready.loadedChats;
      }
    } catch { executionHost?.resume(); this.restarting = false; return {}; }
    if (!inference) { await this.stop(); return { loadedChats }; }
    if (!inference.child) { executionHost?.resume(); this.restarting = false; return {}; }
    inference.child.kill("SIGUSR2");
    let exited = false;
    await Promise.race([inference.exited!.then(() => { exited = true; }), delay(3000)]);
    if (exited) { await this.stop(); return { loadedChats }; }
    executionHost?.resume(); this.restarting = false; return { wait: "inference_busy" };
  }
  stop(): Promise<void> { return this.stopDone ||= this.stopAll(); }
  private async stopAll(): Promise<void> {
    this.stopping = true; clearInterval(this.heartbeat); clearInterval(this.wakeWatch); clearInterval(this.pauseWatch); clearInterval(this.registrationWatch); this.stopUpgradeWatch?.();
    this.host.stopWatching();
    // Stops the watchdog heartbeat and aborts a compatibility check it is still running.
    this.stopHealth?.();
    // Inference lets running streams finish before it exits, so it gets its drain on top
    // of the usual grace. Shared executors are its local clients: the host closes only
    // once inference has exited, or their running streams would end as cancelled. Plans
    // override only PATH and SSH_AUTH_SOCK, so inference inherits this drain setting.
    const grace = (slot: Slot) => slot.definition.kind === "inference" ? inferenceStopGraceMs() : componentStopMs;
    const inference = this.slots.filter(slot => slot.definition.kind === "inference" && slot.child);
    for (const slot of this.slots) { clearTimeout(slot.timer); slot.child?.kill("SIGTERM"); }
    // A start still in the air is waited for (it sees `stopping` and starts nothing, or its host is closed here).
    const executionClose = (this.host.executionStarting || this.host.hostAttempt) && Promise.all(inference.map(slot => within(slot.exited, grace(slot))))
      .then(() => this.host.hostAttempt).then(() => this.host.executionStarting).then(host => host?.close());
    // Observe rejection immediately while owned component processes shut down.
    const executionStopped = executionClose?.then(() => undefined, error => error as Error);
    const exited = Promise.all(this.slots.map(slot => slot.exited));
    await Promise.all(this.slots.map(async slot => {
      const child = slot.child; if (!child) return;
      await within(slot.exited, grace(slot)); child.kill("SIGKILL");
    }));
    // A paused slot is stopped like any other: there is no child to kill and no promise to wait for.
    for (const slot of this.slots) { slot.state.state = "stopped"; delete slot.state.pid; delete slot.state.nextRestartAt; delete slot.state.pausedReason; }
    await within(exited, 1000);
    try {
      const failure = await executionStopped;
      if (this.host.executionState) this.host.executionState.state = failure ? "failed" : "stopped";
      await this.publish(); if (failure) throw failure;
    } finally { this.stoppedResolve(); }
  }
}

export async function runServiceSupervisor(plan: ServicePlan, state: string): Promise<void> {
  await mkdir(state, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "service"); startErrorReports(state, "service");
  await withPrivateFileLock(serviceStatusPath(state), async () => {
    const supervisor = new ServiceSupervisor(plan, state);
    const stop = () => { void supervisor.stop(); };
    const restart = () => { void supervisor.restartWhenIdle(); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    if (process.platform !== "win32") process.on("SIGUSR2", restart);
    try { await supervisor.start(); await supervisor.stopped; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGUSR2", restart); await supervisor.stop(); }
  });
}
