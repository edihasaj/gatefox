import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { serviceExecutionPaths, serviceNativeExecutionPaths, serviceStatusPath, type ServiceComponent, type ServicePlan } from "./service-plan.js";
import { executionHostHome, hostFailureReason, startExecutionHost } from "./execution-host.js";
import { serviceTunnelArguments, staleForwardCleanup } from "./service-tunnel.js";
import { configureTelemetry, telemetry } from "./telemetry.js";
import { reportException, startErrorReports } from "./error-report.js";
import { watchForUpgrade } from "./self-update.js";
import { componentStopMs, inferenceStopGraceMs } from "./runtime-activity.js";
import { chatGptAppRunning, nativeRegistrationEnabled, relayFingerprint } from "./native-pause.js";
import type { HostProbeReason, SdkBaseline } from "./service-host-probe.js";
import { defaultHealing, deterministicFailures, exitReason, failingStreak, hostProbeStrikes, hostRetryDelayMs, quickExitMs, statusFailureGapMs, statusWriteCode, type HostRestartReason, type SupervisorHealing } from "./service-heal.js";
export type { SupervisorHealing } from "./service-heal.js";

interface ComponentState { id: string; kind: string; state: "starting" | "running" | "waiting" | "complete" | "stopped" | "paused"; pid?: number; restarts: number; nextRestartAt?: string; pausedReason?: PauseReason }
type PauseReason = "not_registered" | "failing";
/** How a slot decides whether the optional relay is worth starting; tests replace all three. */
export interface NativeProbes {
  registered: (state: string) => Promise<boolean>;
  fingerprint: (component: ServiceComponent, state: string) => Promise<string>;
  appRunning: () => Promise<boolean>;
}
export const nativeProbes: NativeProbes = { registered: nativeRegistrationEnabled, fingerprint: relayFingerprint, appRunning: chatGptAppRunning };
/**
 * A relay that dies within a minute three times in a row cannot run here; it is left paused.
 * A resumed relay is given a single start, not a fresh three-strike budget, and a relay paused
 * for failing is tried again every half hour even when nothing changed, so a brief start-up
 * problem never pauses it for good: a broken relay costs at most two starts an hour.
 */
const nativeQuickFailureMs = 60000; const nativeQuickFailureLimit = 3; const nativeRecheckMs = 300000; const nativeBlindRetryMs = 1800000;
const execFileAsync = promisify(execFile);
type ExecutionHost = Awaited<ReturnType<typeof startExecutionHost>>;
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
  private executionStarting?: ReturnType<typeof startExecutionHost>;
  private hostRetry?: NodeJS.Timeout;
  private wakeWatch?: NodeJS.Timeout;
  private stopUpgradeWatch?: () => void;
  private lastTick = Date.now();
  private pauseWatch?: NodeJS.Timeout;
  private hostFailures = 0;
  private readonly heal: SupervisorHealing;
  private hostConfig?: Awaited<ReturnType<typeof loadConfig>>;
  private hostPaths?: ReturnType<typeof serviceExecutionPaths>;
  /** A host start in flight, from its relay question to its settled start; stop() waits for it. */
  private hostAttempt?: Promise<void>;
  private hostRetryAt = 0;
  /** The last failed start cannot pass by retrying, and a kick already bought its one extra start in this backoff step. */
  private hostFailureDeterministic = false;
  private hostKickUsed = false;
  /** When the last host start began (performance.now()); a kicked or probed start waits for the kick gap after it. */
  private hostLastStart = Number.NEGATIVE_INFINITY;
  private hostOwnsRelay = false;
  private hostProbe?: NodeJS.Timeout;
  private hostChecking = false;
  private hostRestarting = false;
  private hostRestartTimer?: NodeJS.Timeout;
  private hostRestartReason?: HostRestartReason;
  private hostUnhealthy?: HostProbeReason;
  /** Failed probes in a row of the host running now; `hostProbeStrikes` of them mark it unhealthy. */
  private hostProbeFailures = 0;
  /** Counts the host starts that succeeded: a probe's verdict is dropped when another host started while it was out. */
  private hostGeneration = 0;
  /** An idle restart could not close the old host, whose receipt names this process: no start here can pass, so none is tried. */
  private hostCloseFailed = false;
  private sdkBaseline: SdkBaseline = {};
  private stopKickWatch?: () => void;
  private stopHealth?: () => void;
  private statusFailedAt = Number.NEGATIVE_INFINITY;
  private executionState?: { state: "starting" | "running" | "stopped" | "failed"; home: string; pid: number; sharedNativeExecutor: boolean; sharedGatewayExecutors: boolean };
  private stoppedResolve: () => void = () => {};
  readonly stopped = new Promise<void>(resolve => { this.stoppedResolve = resolve; });
  constructor(private plan: ServicePlan, private state: string, private retryBaseMs = 1000, private readonly startHost: typeof startExecutionHost = startExecutionHost,
    private readonly probes: NativeProbes = nativeProbes, private readonly recheckMs = nativeRecheckMs, private readonly blindRetryMs = nativeBlindRetryMs,
    healing: Partial<SupervisorHealing> = {}) {
    this.heal = { ...defaultHealing, ...healing };
    this.slots = plan.components.map(definition => ({ definition, state: { id: definition.id, kind: definition.kind, state: "starting", restarts: 0 }, failures: 0, startedAt: 0, quickFailures: 0, quickExits: 0, pausedAt: 0, resumedOnce: false }));
  }
  /**
   * Writes the status file. It is advisory: a write that fails (a full disk, a folder that turned read-only) never stops
   * the service, is reported at most once a minute, and the next heartbeat simply writes again. The promise never rejects.
   */
  private publish(): Promise<void> {
    const snapshot = { version: 1, pid: process.pid, updatedAt: new Date().toISOString(), stopping: this.stopping, components: this.slots.map(slot => ({ ...slot.state })), ...(this.executionState ? { executionHost: { ...this.executionState } } : {}) };
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
      const config = await loadConfig(this.plan.config); const paths = this.plan.sharedNativeExecutor ? serviceNativeExecutionPaths(this.plan) : serviceExecutionPaths(this.plan);
      if (this.stopping) return;
      if (resolve(config.stateDirectory) !== resolve(this.state)) throw new Error("Shared executor state does not match the service plan");
      this.executionState = { state: "starting", home: executionHostHome(this.plan.config, paths.nativeHome), pid: process.pid,
        sharedNativeExecutor: this.plan.sharedNativeExecutor === true, sharedGatewayExecutors: this.plan.sharedExecutors === true };
      this.hostConfig = config; this.hostPaths = paths;
      await this.publish();
      if (this.stopping) return;
      // One watcher for this host folder, stopped in stopAll. An adapter that finds the host down writes `<home>/kick`: a
      // failed host's backoff is shortened, a running one is probed. The handler never rejects into the watcher.
      this.stopKickWatch = this.heal.watchKick(this.executionState.home, () => { void Promise.resolve().then(() => this.onHostKick()).catch(() => {}); });
      // A failed host (for example after an app update changes its SDK) must not
      // take inference, tunnels, or the relay down with it. Adapters that need the
      // host fail closed until a retry succeeds.
      await this.startExecutionHost();
      if (this.stopping) return;
      // The same tick asks again for a whole-service restart that a busy service refused after a failed host close.
      this.hostProbe = setInterval(() => { void (this.hostCloseFailed ? this.restartAfterFailedClose() : this.checkHost()); }, this.heal.hostProbeMs); this.hostProbe.unref();
    }
    for (const slot of this.slots) await this.startSlot(slot);
    if (this.stopping) return;
    this.heartbeat = setInterval(() => { void this.publish(); }, 5000);
    this.lastTick = Date.now(); this.wakeWatch = setInterval(() => this.checkWake(Date.now()), 5000);
    // The relay is optional, so a paused one is only tried again quietly, every five minutes.
    if (this.slots.some(slot => slot.definition.kind === "native")) {
      // A re-check that cannot be answered is handled inside resumePaused; it never stops the service. The same tick
      // retries a host restart a busy host refused (see restartHostWhenIdle).
      this.pauseWatch = setInterval(() => { void this.resumePaused().catch(() => undefined); void this.restartHostWhenIdle(); }, this.recheckMs); this.pauseWatch.unref();
    }
    // The service itself moves to a newly installed release only when fully idle
    // (no app connected and no chat loaded); until then it keeps the previous one.
    this.stopUpgradeWatch = watchForUpgrade("service", () => !this.stopping && !this.restarting && !this.hostRestarting, () => this.restartWhenIdle());
    // The watchdog heartbeat; it stands down while this Mac has no monitor URL.
    this.stopHealth = this.heal.healthSchedule(this.state, this.plan.config);
    await this.publish();
  }
  /**
   * One host start at a time; a start that fails is retried after 1, 2, 5, 10 and 30 s, then every 60 s. A start that
   * is not a kick's begins a new backoff step, which gives kicks their one extra start back.
   */
  private async startExecutionHost(kicked = false): Promise<void> {
    if (this.stopping || !this.executionState || !this.hostConfig || !this.hostPaths || this.hostAttempt || this.hostCloseFailed) return;
    clearTimeout(this.hostRetry); this.hostRetry = undefined;
    if (!kicked) this.hostKickUsed = false;
    this.hostLastStart = performance.now();
    const attempt = this.attemptHost(this.hostConfig, this.hostPaths); this.hostAttempt = attempt;
    try { await attempt; } finally { if (this.hostAttempt === attempt) this.hostAttempt = undefined; }
  }
  private async attemptHost(config: Awaited<ReturnType<typeof loadConfig>>, paths: ReturnType<typeof serviceExecutionPaths>): Promise<void> {
    const execution = this.executionState!;
    // Asked before the start and checked again after it: a stop during the question finds no host and must not get one.
    const owns = await this.relayOwnsRegistration();
    if (this.stopping) return;
    const starting = this.startHost({ config, configPath: this.plan.config, ...paths,
      capabilities: [...(this.plan.sharedNativeExecutor ? ["native" as const] : []), ...(this.plan.sharedExecutors ? ["gateway" as const] : [])],
      nativeRelayOwnsRegistration: owns });
    this.executionStarting = starting;
    try {
      await starting;
      if (this.hostFailures) telemetry("execution_host_recovered", { failures: this.hostFailures });
      this.hostFailures = 0; this.hostFailureDeterministic = false; this.hostOwnsRelay = owns; this.hostUnhealthy = undefined; this.hostRestartReason = undefined; this.sdkBaseline = {};
      this.hostGeneration++; this.hostProbeFailures = 0;
      execution.state = "running"; await this.publish();
      // The relay paused while this start was in the air: the host must give the app its remote control back.
      if (owns && this.nativePaused()) this.requestHostRestart("relay_paused");
    } catch (error) {
      // A fixed reason, never the turn classifier: it read the uid in an SDK socket path as a 5xx status.
      const reason = hostFailureReason(error); this.hostFailureDeterministic = deterministicFailures.has(reason);
      telemetry("execution_host_failed", { failures: this.hostFailures + 1, reason });
      reportException(error, "execution_host_start");
      if (this.executionStarting === starting) this.executionStarting = undefined;
      this.hostFailures++; execution.state = "failed"; await this.publish();
      if (this.stopping) return;
      this.scheduleHostRetry(hostRetryDelayMs(this.hostFailures, this.retryBaseMs));
    }
  }
  /** Keeps the earliest due retry: a kick can bring a retry forward, never push one back. */
  private scheduleHostRetry(ms: number, kicked = false): void {
    const at = performance.now() + ms;
    if (this.hostRetry && this.hostRetryAt <= at) return;
    clearTimeout(this.hostRetry); this.hostRetryAt = at;
    this.hostRetry = setTimeout(() => { this.hostRetry = undefined; void this.startExecutionHost(kicked); }, ms);
  }
  /**
   * An adapter's kick. It only ever shortens the backoff of a failed host, never sooner than the kick gap after the last
   * start, and does nothing while a start or a restart is in the air. A failure that a retry cannot fix (another live
   * owner, a changed identity, an invalid SDK or receipt) gets one kicked start per backoff step, so kicks never turn the
   * 60 s cap into a loop. A kick never stops a running host: it is probed, and restarted only when unhealthy and idle.
   */
  private onHostKick(): Promise<void> | undefined {
    if (this.stopping || this.restarting || this.hostAttempt || this.hostRestarting || this.hostCloseFailed) return;
    if (this.executionState?.state === "running") return this.checkHost();
    if (this.executionState?.state !== "failed" || (this.hostFailureDeterministic && this.hostKickUsed)) return;
    this.hostKickUsed = true;
    this.scheduleHostRetry(Math.max(0, this.hostLastStart + this.heal.kickGapMs - performance.now()), true);
  }
  /**
   * Probes the running host: its receipt, its control socket and one `execution/status` answer within 5 s, and, when
   * native chats are shared, whether the app engine changed under it. Two failed probes in a row are reported once and
   * restart the host only while it is idle; a busy host is asked again at the next probe. A probe that passes clears it.
   * A verdict about a host that another start replaced while the probe was out is dropped: it says nothing about the new one.
   */
  async checkHost(): Promise<void> {
    const execution = this.executionState;
    if (!execution || this.stopping || this.restarting || this.hostChecking || this.hostAttempt || this.hostRestarting || execution.state !== "running") return;
    this.hostChecking = true; const generation = this.hostGeneration;
    try {
      const target = { home: execution.home, pid: process.pid, ...(this.plan.sharedNativeExecutor && this.hostPaths ? { codex: this.hostPaths.codex } : {}) };
      const reason = await this.heal.probeHost(target, this.sdkBaseline).catch(() => "status_failed" as const);
      if (generation === this.hostGeneration && !this.stopping && !this.restarting && !this.hostRestarting && execution.state === "running") this.probed(reason);
    } finally { this.hostChecking = false; }
    // Also picks up a restart that was asked for while the probe was out (a relay set aside), which waited for it.
    await this.restartHostWhenIdle();
  }
  private probed(reason: HostProbeReason | undefined): void {
    if (!reason) {
      this.hostProbeFailures = 0;
      if (this.hostUnhealthy && this.hostRestartReason === this.hostUnhealthy) this.hostRestartReason = undefined;
      this.hostUnhealthy = undefined; return;
    }
    if (++this.hostProbeFailures < hostProbeStrikes) return;
    if (this.hostUnhealthy !== reason) telemetry("execution_host_unhealthy", { reason });
    this.hostUnhealthy = reason; if (this.hostRestartReason !== "relay_paused") this.hostRestartReason = reason;
  }
  private nativePaused(): boolean { return this.slots.some(slot => slot.definition.kind === "native" && slot.state.state === "paused"); }
  private requestHostRestart(reason: HostRestartReason): void {
    if (this.hostRestartReason !== "relay_paused") this.hostRestartReason = reason;
    void this.restartHostWhenIdle();
  }
  /**
   * The one path that restarts only the execution host: idle check, close, start. It never stops inference, tunnels or
   * the relay, and it never runs inside the kick gap after another start (it waits for the gap instead) or while a probe
   * is out (the probe asks again when it ends). A host with a lease or a loaded chat refuses, and the next probe or relay
   * re-check asks again.
   */
  private async restartHostWhenIdle(): Promise<void> {
    const reason = this.hostRestartReason; const execution = this.executionState;
    if (!reason || !execution || this.stopping || this.restarting || this.hostRestarting || this.hostAttempt || this.hostChecking || execution.state !== "running") return;
    // A relay that came back, or a host that already gave the registration up, needs no restart.
    if (reason === "relay_paused" && (!this.hostOwnsRelay || !this.nativePaused())) { this.hostRestartReason = undefined; return; }
    const wait = this.hostLastStart + this.heal.kickGapMs - performance.now();
    if (wait > 0) {
      if (!this.hostRestartTimer) { this.hostRestartTimer = setTimeout(() => { this.hostRestartTimer = undefined; void this.restartHostWhenIdle(); }, wait); this.hostRestartTimer.unref(); }
      return;
    }
    const starting = this.executionStarting;
    this.hostRestarting = true; let closed = false;
    try {
      const host: ExecutionHost | undefined = await starting?.catch(() => undefined);
      if (!host || this.stopping || !await host.prepareStop().catch(() => false)) return;
      // A stop that came during the idle check closes the host itself; this is no restart.
      if (this.stopping) return;
      execution.state = "starting"; this.hostLastStart = performance.now(); await this.publish();
      try { await host.close(); closed = true; }
      catch (error) {
        // Its receipt was preserved and names this live process, so no start here can pass (see hostCloseFailed).
        telemetry("execution_host_failed", { failures: this.hostFailures + 1, reason: "close_failed" });
        reportException(error, "execution_host_restart");
        this.hostFailures++; this.hostCloseFailed = true; execution.state = "failed"; await this.publish();
      }
      if (closed) {
        if (this.executionStarting === starting) this.executionStarting = undefined;
        this.hostRestartReason = undefined; this.hostUnhealthy = undefined; telemetry("execution_host_restarted", { reason });
      }
    } finally { this.hostRestarting = false; }
    if (closed) await this.startExecutionHost();
    else if (this.hostCloseFailed) await this.restartAfterFailedClose();
  }
  /**
   * The whole-service restart a failed host close calls for, with the host still referenced so the stop closes it again and
   * rethrows its failure: the process exits and launchd starts a fresh one. A busy service refuses; the next probe tick asks again.
   */
  private async restartAfterFailedClose(): Promise<void> { await this.restartWhenIdle().catch(() => undefined); }
  /**
   * Whether the native relay, not the engine, owns this machine's remote-control registration:
   * only a registered relay whose slot is not paused counts. A paused or missing relay leaves the
   * app's own remote control alone. A relay that becomes live later takes effect at the next host
   * start, which an idle restart is, because the receipt is read once when the host starts.
   */
  private async relayOwnsRegistration(): Promise<boolean> {
    if (this.plan.sharedNativeExecutor !== true) return false;
    const native = this.slots.find(slot => slot.definition.kind === "native");
    if (native && native.state.state === "paused") return false;
    // A question that cannot be answered is not an answer, so the start is left as it would have
    // been; only a registration that really says otherwise takes ownership away from the relay.
    return await this.probes.registered(this.state).catch(() => true);
  }
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
    slot.state.state = "paused"; slot.state.pausedReason = reason; slot.fingerprint = fingerprint; slot.pausedAt = Date.now(); slot.resumedOnce = false;
    delete slot.state.nextRestartAt;
    telemetry("component_paused", { component: slot.state.id, kind: slot.state.kind, reason });
    await this.publish();
    // A host started while this relay looked usable took the remote-control registration from the app. Only the host is
    // restarted, when idle, so it starts again without it; the boot order of everything else is left alone.
    if (slot.definition.kind === "native" && this.hostOwnsRelay && this.executionState?.state === "running") this.requestHostRestart("relay_paused");
  }
  /**
   * Re-checks the relay slots a timer put aside. It starts one again only when the relay is
   * registered, either its binaries or receipt changed since the pause or the half-hourly blind
   * retry is due, and no ChatGPT app is open to compete with it; a relay that connects later is
   * picked up by the next adapter or listener. Nothing here stops the service: an answer that never
   * arrives leaves the slot paused with reason `failing`, announced once.
   */
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
      slot.failures = 0; slot.quickFailures = 0; slot.resumedOnce = true; delete slot.state.pausedReason; delete slot.state.nextRestartAt;
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
  async restartWhenIdle(): Promise<boolean> {
    // A host-only restart in progress is finished first; the service restart is asked again later.
    if (this.stopping || this.restarting || this.hostRestarting) return false;
    const inference = this.slots.find(slot => slot.definition.kind === "inference");
    if (inference && !inference.child) return false;
    this.restarting = true;
    let executionHost: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
    try {
      // A host whose close failed has already dropped every adapter and refuses any idle check, so it is not asked.
      executionHost = this.hostCloseFailed ? undefined : await this.executionStarting;
      if (executionHost && !await executionHost.prepareStop()) { this.restarting = false; return false; }
    } catch { executionHost?.resume(); this.restarting = false; return false; }
    if (!inference) { await this.stop(); return true; }
    if (!inference.child) { executionHost?.resume(); this.restarting = false; return false; }
    inference.child.kill("SIGUSR2");
    let exited = false;
    await Promise.race([inference.exited!.then(() => { exited = true; }), delay(3000)]);
    if (exited) { await this.stop(); return true; }
    executionHost?.resume(); this.restarting = false; return false;
  }
  stop(): Promise<void> { return this.stopDone ||= this.stopAll(); }
  private async stopAll(): Promise<void> {
    this.stopping = true; clearInterval(this.heartbeat); clearInterval(this.wakeWatch); clearInterval(this.pauseWatch); this.stopUpgradeWatch?.(); clearTimeout(this.hostRetry);
    clearInterval(this.hostProbe); clearTimeout(this.hostRestartTimer); this.stopKickWatch?.();
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
    const executionClose = (this.executionStarting || this.hostAttempt) && Promise.all(inference.map(slot => within(slot.exited, grace(slot))))
      .then(() => this.hostAttempt).then(() => this.executionStarting).then(host => host?.close());
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
      if (this.executionState) this.executionState.state = failure ? "failed" : "stopped";
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
