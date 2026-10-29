import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { serviceExecutionPaths, serviceNativeExecutionPaths, type ServicePlan } from "./service-plan.js";
import { executionHostHome, hostFailureReason, startExecutionHost } from "./execution-host.js";
import { telemetry } from "./telemetry.js";
import { reportException } from "./error-report.js";
import type { HostProbeReason, SdkBaseline } from "./service-host-probe.js";
import { deterministicFailures, hostProbeStrikes, hostRetryDelayMs, type HostRestartReason, type SupervisorHealing } from "./service-heal.js";

export type ExecutionHost = Awaited<ReturnType<typeof startExecutionHost>>;
/** The `executionHost` block of the service status file. */
export interface ExecutionState { state: "starting" | "running" | "stopped" | "failed"; home: string; pid: number; sharedNativeExecutor: boolean; sharedGatewayExecutors: boolean }

/** What the keeper needs from the supervisor that owns it: its plan and clocks, its two flags, and three of its own steps. */
export interface HostKeeperContext {
  plan: ServicePlan;
  state: string;
  retryBaseMs: number;
  startHost: typeof startExecutionHost;
  heal: SupervisorHealing;
  /** Asks whether the relay owns remote control here (registered, or an activation is pending); it may reject. */
  registered: () => Promise<boolean>;
  stopping: () => boolean;
  restarting: () => boolean;
  /** Writes the status file; never rejects. */
  publish: () => Promise<void>;
  /** The whole-service idle restart. */
  restartWhenIdle: () => Promise<boolean>;
}

/**
 * The shared execution host's lifecycle inside the service: its start and backoff, an adapter's kick, the probe of a running
 * host and the idle restart of the host alone. The supervisor owns everything else (components, the whole-service restart and
 * stop) and reads the fields it needs to stop or restart the host with the service.
 */
export class ServiceHostKeeper {
  executionState?: ExecutionState;
  /** The last host start, in the air or settled; a restart and a stop close what it resolves to. */
  executionStarting?: ReturnType<typeof startExecutionHost>;
  /** A host start in flight, from its relay question to its settled start; stop() waits for it. */
  hostAttempt?: Promise<void>;
  hostRestarting = false;
  /** An idle restart could not close the old host, whose receipt names this process: no start here can pass, so none is tried. */
  hostCloseFailed = false;
  private hostRetry?: NodeJS.Timeout;
  private hostFailures = 0;
  private hostConfig?: Awaited<ReturnType<typeof loadConfig>>;
  private hostPaths?: ReturnType<typeof serviceExecutionPaths>;
  private hostRetryAt = 0;
  /** The last failed start cannot pass by retrying, and a kick already bought its one extra start in this backoff step. */
  private hostFailureDeterministic = false;
  private hostKickUsed = false;
  /** When the last host start began (performance.now()); a kicked or probed start waits for the kick gap after it. */
  private hostLastStart = Number.NEGATIVE_INFINITY;
  private hostOwnsRelay = false;
  private hostProbe?: NodeJS.Timeout;
  private hostChecking = false;
  private hostRestartTimer?: NodeJS.Timeout;
  private hostRestartReason?: HostRestartReason;
  private hostUnhealthy?: HostProbeReason;
  /** Failed probes in a row of the host running now; `hostProbeStrikes` of them mark it unhealthy. */
  private hostProbeFailures = 0;
  /** Counts the host starts that succeeded: a probe's verdict is dropped when another host started while it was out. */
  private hostGeneration = 0;
  private sdkBaseline: SdkBaseline = {};
  private stopKickWatch?: () => void;
  constructor(private context: HostKeeperContext) {}

  /** A controller switch never races a host start, probe, retry or restart. The host itself stays owned. */
  canHandover(): boolean { return !this.hostAttempt && !this.hostChecking && !this.hostRestarting && !this.registrationChecking; }
  private registrationChecking = 0;
  private pendingContext?: HostKeeperContext;
  private releaseUpdatePending = false;
  /** Stage new host policy until every old keeper operation has finished. Active engines remain untouched. */
  adoptRuntime(next: ServiceHostKeeper): void { this.pendingContext = next.context; this.applyPendingRuntime(); }
  private applyPendingRuntime(): void {
    if (!this.pendingContext || !this.canHandover()) return;
    this.context = this.pendingContext; this.pendingContext = undefined;
    this.releaseUpdatePending = true;
    if (this.executionState?.state === "running" && !this.hostRestartReason) this.hostRestartReason = "release_update";
  }
  /** Starts the host of a plan that shares executors or native chats, then its kick watcher and probe. Throws on a mismatched state. */
  async start(): Promise<void> {
    const { plan } = this.context;
    const config = await loadConfig(plan.config); const paths = plan.sharedNativeExecutor ? serviceNativeExecutionPaths(plan) : serviceExecutionPaths(plan);
    if (this.context.stopping()) return;
    if (resolve(config.stateDirectory) !== resolve(this.context.state)) throw new Error("Shared executor state does not match the service plan");
    this.executionState = { state: "starting", home: executionHostHome(plan.config, paths.nativeHome), pid: process.pid,
      sharedNativeExecutor: plan.sharedNativeExecutor === true, sharedGatewayExecutors: plan.sharedExecutors === true };
    this.hostConfig = config; this.hostPaths = paths;
    await this.context.publish();
    if (this.context.stopping()) return;
    // One watcher for this host folder, stopped in stopWatching. An adapter that finds the host down writes `<home>/kick`: a
    // failed host's backoff is shortened, a running one is probed. The handler never rejects into the watcher.
    this.stopKickWatch = this.context.heal.watchKick(this.executionState.home, () => { void Promise.resolve().then(() => this.onHostKick()).catch(() => {}); });
    // A failed host (for example after an app update changes its SDK) must not
    // take inference, tunnels, or the relay down with it. Adapters that need the
    // host fail closed until a retry succeeds.
    await this.startExecutionHost();
    if (this.context.stopping()) return;
    // The same tick asks again for a whole-service restart that a busy service refused after a failed host close.
    this.hostProbe = setInterval(() => { void (this.hostCloseFailed ? this.restartAfterFailedClose() : this.checkHost()); }, this.context.heal.hostProbeMs); this.hostProbe.unref();
  }
  /** Stops the retry, probe and restart timers and the kick watcher; the service's stop closes the host itself. */
  stopWatching(): void {
    clearTimeout(this.hostRetry); clearInterval(this.hostProbe); clearTimeout(this.hostRestartTimer); this.stopKickWatch?.();
  }
  /**
   * One host start at a time; a start that fails is retried after 1, 2, 5, 10 and 30 s, then every 60 s. A start that
   * is not a kick's begins a new backoff step, which gives kicks their one extra start back.
   */
  private async startExecutionHost(kicked = false): Promise<void> {
    this.applyPendingRuntime();
    if (this.context.stopping() || !this.executionState || !this.hostConfig || !this.hostPaths || this.hostAttempt || this.hostCloseFailed) return;
    clearTimeout(this.hostRetry); this.hostRetry = undefined;
    if (!kicked) this.hostKickUsed = false;
    this.hostLastStart = performance.now();
    const attempt = this.attemptHost(this.hostConfig, this.hostPaths); this.hostAttempt = attempt;
    try { await attempt; } finally { if (this.hostAttempt === attempt) this.hostAttempt = undefined; }
  }
  private async attemptHost(config: Awaited<ReturnType<typeof loadConfig>>, paths: ReturnType<typeof serviceExecutionPaths>): Promise<void> {
    const execution = this.executionState!; const { plan } = this.context;
    // Asked before the start and checked again after it: a stop during the question finds no host and must not get one.
    const owns = await this.relayOwnsRegistration();
    if (this.context.stopping()) return;
    const starting = this.context.startHost({ config, configPath: plan.config, ...paths,
      capabilities: [...(plan.sharedNativeExecutor ? ["native" as const] : []), ...(plan.sharedExecutors ? ["gateway" as const] : [])],
      nativeRelayOwnsRegistration: owns });
    this.executionStarting = starting;
    try {
      await starting;
      if (this.hostFailures) telemetry("execution_host_recovered", { failures: this.hostFailures });
      this.hostFailures = 0; this.hostFailureDeterministic = false; this.hostOwnsRelay = owns; this.hostUnhealthy = undefined; this.hostRestartReason = undefined; this.sdkBaseline = {};
      this.hostGeneration++; this.hostProbeFailures = 0; this.releaseUpdatePending = false;
      execution.state = "running"; await this.context.publish();
      // The relay was registered while this start was in the air without the host knowing: ask again now it is running.
      if (!owns) void this.restartForRegistration();
    } catch (error) {
      // A fixed reason, never the turn classifier: it read the uid in an SDK socket path as a 5xx status.
      const reason = hostFailureReason(error); this.hostFailureDeterministic = deterministicFailures.has(reason);
      telemetry("execution_host_failed", { failures: this.hostFailures + 1, reason });
      reportException(error, "execution_host_start");
      if (this.executionStarting === starting) this.executionStarting = undefined;
      this.hostFailures++; execution.state = "failed"; await this.context.publish();
      if (this.context.stopping()) return;
      this.scheduleHostRetry(hostRetryDelayMs(this.hostFailures, this.context.retryBaseMs));
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
    if (this.context.stopping() || this.context.restarting() || this.hostAttempt || this.hostRestarting || this.hostCloseFailed) return;
    if (this.executionState?.state === "running") return this.checkHost();
    if (this.executionState?.state !== "failed" || (this.hostFailureDeterministic && this.hostKickUsed)) return;
    this.hostKickUsed = true;
    this.scheduleHostRetry(Math.max(0, this.hostLastStart + this.context.heal.kickGapMs - performance.now()), true);
  }
  /**
   * Probes the running host: its receipt, its control socket and one `execution/status` answer within 5 s, and, when
   * native chats are shared, whether the app engine changed under it. Two failed probes in a row are reported once and
   * restart the host only while it is idle; a busy host is asked again at the next probe. A probe that passes clears it.
   * A verdict about a host that another start replaced while the probe was out is dropped: it says nothing about the new one.
   */
  async checkHost(): Promise<void> {
    this.applyPendingRuntime();
    const execution = this.executionState;
    if (!execution || this.context.stopping() || this.context.restarting() || this.hostChecking || this.hostAttempt || this.hostRestarting || execution.state !== "running") return;
    this.hostChecking = true; const generation = this.hostGeneration;
    try {
      const target = { home: execution.home, pid: process.pid, ...(this.context.plan.sharedNativeExecutor && this.hostPaths ? { codex: this.hostPaths.codex } : {}) };
      const reason = await this.context.heal.probeHost(target, this.sdkBaseline).catch(() => "status_failed" as const);
      if (generation === this.hostGeneration && !this.context.stopping() && !this.context.restarting() && !this.hostRestarting && execution.state === "running") this.probed(reason);
    } finally { this.hostChecking = false; }
    // Also picks up a restart that was asked for while the probe was out (a relay set aside), which waited for it.
    await this.restartHostWhenIdle();
  }
  private probed(reason: HostProbeReason | undefined): void {
    if (!reason) {
      this.hostProbeFailures = 0;
      if (this.hostUnhealthy && this.hostRestartReason === this.hostUnhealthy) this.hostRestartReason = this.releaseUpdatePending ? "release_update" : undefined;
      this.hostUnhealthy = undefined; return;
    }
    if (++this.hostProbeFailures < hostProbeStrikes) return;
    if (this.hostUnhealthy !== reason) telemetry("execution_host_unhealthy", { reason });
    this.hostUnhealthy = reason; if (this.hostRestartReason !== "relay_registered") this.hostRestartReason = reason;
  }
  /**
   * The relay became registered (or an activation is pending) after this host started its native engine without standing
   * down. That engine may hold the machine's one remote-control slot, so the host restarts, once idle, with the flag set.
   * Nothing here ever hands remote control back: a registered relay that is paused or down leaves the phone without this Mac
   * until it is back, rather than letting the host's engine take the slot.
   */
  async restartForRegistration(): Promise<void> {
    const execution = this.executionState;
    if (this.registrationChecking || this.context.plan.sharedNativeExecutor !== true || this.hostOwnsRelay || !execution || execution.state !== "running" || this.hostRestartReason === "relay_registered") return;
    if (await this.registrationEnabled(false)) this.requestHostRestart("relay_registered");
  }
  private async registrationEnabled(onFailure: boolean): Promise<boolean> {
    this.registrationChecking++;
    try { return await this.context.registered().catch(() => onFailure); }
    finally { this.registrationChecking--; }
  }
  private requestHostRestart(reason: HostRestartReason): void {
    if (this.hostRestartReason !== "relay_registered") this.hostRestartReason = reason;
    void this.restartHostWhenIdle();
  }
  /**
   * The one path that restarts only the execution host: idle check, close, start. It never stops inference, tunnels or
   * the relay, and it never runs inside the kick gap after another start (it waits for the gap instead) or while a probe
   * is out (the probe asks again when it ends). A host with a lease or a loaded chat refuses, and the next probe or relay
   * re-check asks again.
   */
  async restartHostWhenIdle(): Promise<void> {
    this.applyPendingRuntime();
    const reason = this.hostRestartReason; const execution = this.executionState;
    if (!reason || !execution || this.context.stopping() || this.context.restarting() || this.hostRestarting || this.hostAttempt || this.hostChecking || execution.state !== "running") return;
    // A host that already stands down needs no restart for the registration.
    // A registration that was withdrawn since (a refused activation removes its pending record) needs none either.
    if (reason === "relay_registered" && (this.hostOwnsRelay || !await this.registrationEnabled(false))) { this.hostRestartReason = this.releaseUpdatePending ? "release_update" : undefined; return; }
    const wait = this.hostLastStart + this.context.heal.kickGapMs - performance.now();
    if (wait > 0) {
      if (!this.hostRestartTimer) { this.hostRestartTimer = setTimeout(() => { this.hostRestartTimer = undefined; void this.restartHostWhenIdle(); }, wait); this.hostRestartTimer.unref(); }
      return;
    }
    const starting = this.executionStarting;
    this.hostRestarting = true; let closed = false;
    try {
      const host: ExecutionHost | undefined = await starting?.catch(() => undefined);
      if (!host || this.context.stopping() || !await host.prepareStop().catch(() => false)) return;
      // A stop that came during the idle check closes the host itself; this is no restart.
      if (this.context.stopping()) return;
      execution.state = "starting"; this.hostLastStart = performance.now(); await this.context.publish();
      try { await host.close(); closed = true; }
      catch (error) {
        // Its receipt was preserved and names this live process, so no start here can pass (see hostCloseFailed).
        telemetry("execution_host_failed", { failures: this.hostFailures + 1, reason: "close_failed" });
        reportException(error, "execution_host_restart");
        this.hostFailures++; this.hostCloseFailed = true; execution.state = "failed"; await this.context.publish();
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
  private async restartAfterFailedClose(): Promise<void> { await this.context.restartWhenIdle().catch(() => undefined); }
  /**
   * Whether the native relay, not the engine, owns this machine's remote-control registration: the registration (or an
   * activation in progress) decides, whether or not the relay is live or its slot is paused. OpenAI allows one remote-control
   * connection per Mac, so an engine that took it while the relay was down would lock the relay out until the engine exited.
   * The record is read once when the host starts; a registration made later restarts the host when idle
   * (`restartForRegistration`).
   */
  private async relayOwnsRegistration(): Promise<boolean> {
    if (this.context.plan.sharedNativeExecutor !== true) return false;
    // A question that cannot be answered is not an answer, so the start is left as it would have
    // been; only a record that really says otherwise takes ownership away from the relay.
    return await this.registrationEnabled(true);
  }
}
