import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writePrivateJson } from "./config.js";
import { serviceStatusPath, readServicePlan, type ServiceComponent, type ServicePlan } from "./service-plan.js";
import { startExecutionHost, type QuietWait } from "./execution-host.js";
import { serviceTunnelArguments, staleForwardCleanup } from "./service-tunnel.js";
import { telemetry } from "./telemetry.js";
import { reportException } from "./error-report.js";
import { watchForUpgrade, releaseState, type PendingRelease, type UpgradeOutcome } from "./self-update.js";
import { componentStopMs, inferenceStopGraceMs } from "./runtime-activity.js";
import { chatGptAppRunning, nativeRegistrationClaimed, nativeRegistrationEnabled, relayFingerprint } from "./native-pause.js";
import { defaultHealing, exitReason, failingStreak, quickExitMs, statusFailureGapMs, statusWriteCode, upgradeGraceMs, upgradeQuietMs, type SupervisorHealing } from "./service-heal.js";
import { ServiceHostKeeper, type ExecutionHost } from "./service-host-keeper.js";
import { followCurrentRelease } from "./service-relay-path.js";
import { startAppUpdateScheduler, type AppUpdateSchedule } from "./app-updates/scheduler.js";
import { hostAutoLatestMaintenance } from "./model-auto-latest/hosting.js";
import { installedSupervisorRuntime, supervisorRuntimeVersion } from "./service-supervisor-runtime.js";
import { retainRunningRelease, type ReleaseLease } from "./release-retention.js";
import { isClaudeComponent } from "./service-claude-activity.js";
import { rememberOwnedForward, clearOwnedForward } from "./service-owned-forward.js";
export type { SupervisorHealing } from "./service-heal.js";

/** Why a quiet upgrade waited: the host's reason, inference that refused its idle guard, or Claude sockets that were still established. */
type UpgradeWait = QuietWait | "inference_busy" | "claude_busy";
/** A restart that stopped the service (with the host's loaded-chat count), or one that was refused, with why when known. */
type RestartResult = { loadedChats: number } | { wait?: UpgradeWait };
interface ComponentState { id: string; kind: string; state: "starting" | "running" | "waiting" | "complete" | "stopped" | "paused"; pid?: number; restarts: number; nextRestartAt?: string; pausedReason?: PauseReason; pausedAt?: string; startedAt?: string; lastConnectedAt?: string }
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
/** Pause a repeatedly failing optional relay; a resumed relay gets one attempt before its next quiet retry. */
const nativeQuickFailureMs = 60000; const nativeQuickFailureLimit = 3; const nativeRecheckMs = 300000; const nativeBlindRetryMs = 1800000;
/**
 * A paused relay notices a new registration this soon. `gateway native install` registers the relay while ChatGPT is closed;
 * waiting for the five-minute re-check would leave the machine's one remote-control slot free for any engine that starts meanwhile.
 */
const nativeRegistrationPollMs = 2000;
const canonicalRelease = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/;
const execFileAsync = promisify(execFile);
type StaleForwardCleaner = (component: ServiceComponent, args: string[]) => Promise<number>;
const clearStaleForward: StaleForwardCleaner = async (component, args) =>
  await execFileAsync(component.command, serviceTunnelArguments(args), { timeout: 15000, env: { ...process.env, ...component.environment } })
    .then(result => Number(result.stdout.trim()) || 0, () => 0);
interface Slot { definition: ServiceComponent; state: ComponentState; child?: ChildProcess; exited?: Promise<void>; timer?: NodeJS.Timeout; starting?: boolean; failures: number; startedAt: number; quickFailures: number; quickExits: number; fingerprint?: string; pausedAt: number; resumedOnce: boolean }
/** Waits for `done` at most `ms`; the timer never outlives the wait, so a stopped service exits at once. */
function within(done: Promise<unknown> | undefined, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
}
export class ServiceSupervisor {
  private stopping = false;
  private retired = false;
  private controlInFlight = 0;
  private ownership: { current: ServiceSupervisor; leases: ReleaseLease[]; writes: Promise<void> } = { current: this, leases: [], writes: Promise.resolve() };
  private controllerRelease?: string;
  private controlLease?: ReleaseLease;
  private controlUpdate?: () => Promise<boolean>;
  private get inactive(): boolean { return this.stopping || this.retired; }
  current(): ServiceSupervisor { return this.ownership.current; }
  private track(operation: () => Promise<unknown>): void {
    if (this.inactive) return;
    this.controlInFlight++;
    void Promise.resolve().then(operation).catch(() => {}).finally(() => { this.controlInFlight--; });
  }
  private slots: Slot[];
  private get writes(): Promise<void> { return this.ownership.writes; }
  private set writes(value: Promise<void>) { this.ownership.writes = value; }
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
  /** The release this supervisor loaded. Capture once: `current` can move while it keeps serving. */
  private runningRelease?: string;
  /** The shared execution host's start, backoff, kick, probe and host-only restart (src/service-host-keeper.ts). */
  private host: ServiceHostKeeper;
  private stopHealth?: () => void;
  private appUpdates?: AppUpdateSchedule;
  private modelMaintenance?: { stop(): void | Promise<void> };
  private statusFailedAt = Number.NEGATIVE_INFINITY;
  /** `self_upgrade_waiting` already logged, per pending release and reason. */
  private readonly upgradeWaits = new Set<string>();
  /** Makes the upgrade watcher look now (an urgent move, when the host says one is waiting); set while the watcher runs. */
  private nudgeUpgrade?: () => void;
  private stoppedResolve: () => void = () => {};
  stopped = new Promise<void>(resolve => { this.stoppedResolve = resolve; });
  constructor(private plan: ServicePlan, private state: string, private retryBaseMs = 1000, startHost: typeof startExecutionHost = startExecutionHost,
    private readonly probes: NativeProbes = nativeProbes, private readonly recheckMs = nativeRecheckMs, private readonly blindRetryMs = nativeBlindRetryMs,
    healing: Partial<SupervisorHealing> = {}, private readonly registrationPollMs = nativeRegistrationPollMs,
    private readonly cleanStaleForward: StaleForwardCleaner = clearStaleForward) {
    this.heal = { ...defaultHealing, ...healing };
    const running = this.heal.releaseState()?.running;
    if (running && canonicalRelease.test(running)) this.runningRelease = this.controllerRelease = running;
    // A host that refused a newer adapter says when no turn runs, so the urgent move is tried in that gap (see skewIdle).
    const signalling: typeof startExecutionHost = options => startHost({ ...options, onSkewIdle: () => this.current().nudgeUpgrade?.() });
    this.host = new ServiceHostKeeper({ plan, state, retryBaseMs, startHost: signalling, heal: this.heal,
      registered: () => (this.probes.claimed ?? this.probes.registered)(this.state),
      stopping: () => this.current().inactive, restarting: () => this.current().restarting, publish: () => this.current().publish(),
      restartWhenIdle: () => this.current().restartWhenIdle() });
    this.slots = plan.components.map(component => followCurrentRelease(component)).map(definition => ({ definition, state: { id: definition.id, kind: definition.kind, state: "starting", restarts: 0 }, failures: 0, startedAt: 0, quickFailures: 0, quickExits: 0, pausedAt: 0, resumedOnce: false }));
  }
  /** One advisory status queue belongs to the shared ownership broker across all controllers. */
  private publish(): Promise<void> {
    if (this.retired) return this.writes;
    const snapshot = { version: 1, pid: process.pid, updatedAt: new Date().toISOString(), ...(this.runningRelease ? { runningRelease: this.runningRelease } : {}), ...(this.controllerRelease ? { controllerRelease: this.controllerRelease } : {}), stopping: this.inactive, components: this.slots.map(slot => ({ ...slot.state })), ...(this.host.executionState ? { executionHost: { ...this.host.executionState } } : {}) };
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
    if (this.inactive) return;
    if (this.plan.sharedExecutors || this.plan.sharedNativeExecutor) {
      await this.host.start();
      if (this.inactive) return;
    }
    for (const slot of this.slots) await this.startSlot(slot);
    if (this.inactive) return;
    await this.startControl();
  }
  private async startControl(): Promise<void> {
    if (this.inactive) return;
    for (const slot of this.slots) {
      const pid = slot.child?.pid;
      if (pid) this.track(() => rememberOwnedForward(slot.definition, pid, this.state));
    }
    this.heartbeat = setInterval(() => { void this.publish(); }, 5000);
    this.lastTick = Date.now(); this.wakeWatch = setInterval(() => this.checkWake(Date.now()), 5000);
    // The relay is optional, so a paused one is only tried again quietly, every five minutes.
    if (this.slots.some(slot => slot.definition.kind === "native")) {
      // A re-check that cannot be answered is handled inside resumePaused; it never stops the service. The same tick
      // retries a host restart a busy host refused (see restartHostWhenIdle).
      this.pauseWatch = setInterval(() => { this.track(() => this.resumePaused()); void this.host.restartHostWhenIdle(); }, this.recheckMs); this.pauseWatch.unref();
      // A relay set aside as unregistered starts the moment a registration appears, not at the next re-check, and a shared host
      // that started before the registration is asked to restart (when idle) so its native engine stands down too.
      this.registrationWatch = setInterval(() => { this.track(() => this.resumeOnRegistration()); void this.host.restartForRegistration().catch(() => undefined); this.track(() => this.observeRelay()); }, this.registrationPollMs); this.registrationWatch.unref();
    }
    // The service moves to a newly installed release when fully idle (no app connected and no chat loaded), or, once the
    // release has waited out the grace, when quiet (see upgrade); until then it keeps the previous one. A newer adapter that this
    // host has refused (release skew) makes the move urgent: no grace, and only a running turn or terminal holds it back.
    this.stopUpgradeWatch = watchForUpgrade("service", () => !this.inactive && !this.restarting && !this.host.hostRestarting, pending => this.upgrade(pending),
      { state: this.heal.releaseState, urgent: to => this.skewWaiting(to), bind: nudge => { this.nudgeUpgrade = nudge; } });
    // The watchdog heartbeat; it stands down while this Mac has no monitor URL.
    this.stopHealth = this.heal.healthSchedule(this.state, this.plan.config);
    // Updates share this existing service lifecycle; they never add another
    // LaunchAgent and the scheduler itself refuses checkout/test modules.
    this.appUpdates = await startAppUpdateScheduler(this.plan.config);
    // Inference servers own their hot-swappable timer. Client-only plans use this existing service instead.
    if (!this.inactive && !this.slots.some(slot => slot.definition.kind === "inference")) {
      this.modelMaintenance = hostAutoLatestMaintenance(this.plan.config, "service");
    }
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
    if (this.inactive || gap < 30000) return;
    telemetry("system_wake", { sleptSeconds: Math.round(gap / 1000) });
    for (const slot of this.slots) {
      // The adopted Claude forwards can carry a request even when the app is closed. Their pinned runtime has no
      // quiesce protocol, so wake healing must leave them intact; ordinary gateway tunnels still reconnect promptly.
      if (slot.definition.kind !== "tunnel" || isClaudeComponent(slot.definition)) continue;
      slot.failures = 0; slot.quickExits = 0;
      if (slot.child) slot.child.kill("SIGTERM");
      else if (slot.timer && !slot.starting) { clearTimeout(slot.timer); slot.timer = undefined; delete slot.state.nextRestartAt; void this.startSlot(slot).catch(() => { void this.stop(); }); }
    }
  }
  private async startSlot(slot: Slot): Promise<void> {
    // One start per slot at a time: a tunnel's stale-listener cleanup can take seconds, and a
    // wake during it must not spawn a second process for the same forwarded port.
    if (this.inactive || slot.starting || slot.child) return;
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
      if (slot.definition.kind !== "native" || this.inactive) throw error;
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
    if (this.retired) return this.current().pause(slot, reason);
    if (this.inactive || slot.child) return;
    if (slot.timer) { clearTimeout(slot.timer); slot.timer = undefined; }
    slot.state.state = "paused"; slot.state.pausedReason = reason; slot.state.pausedAt = new Date().toISOString(); slot.fingerprint = fingerprint; slot.pausedAt = Date.now(); slot.resumedOnce = false;
    delete slot.state.nextRestartAt;
    telemetry("component_paused", { component: slot.state.id, kind: slot.state.kind, reason });
    await this.publish();
  }
  /**
   * Notes the last time the running relay was connected, from its own status file, so a health check can tell a relay that has
   * been down for minutes from one that only flickered. The relay rewrites that file on every status change, so its age says
   * nothing about the connection; and a `connected` left by an earlier run does not count (the file must be newer than this start).
   */
  private async observeRelay(): Promise<void> {
    for (const slot of this.slots) {
      if (slot.definition.kind !== "native" || slot.state.state !== "running") continue;
      const flag = slot.definition.args.indexOf("--relay-home"); const home = flag >= 0 ? slot.definition.args[flag + 1] : undefined;
      if (typeof home !== "string") continue;
      try {
        const file = resolve(home, "status.json");
        if ((await stat(file)).mtimeMs < slot.startedAt - 1000) continue;
        if ((JSON.parse(await readFile(file, "utf8")) as { status?: unknown }).status === "connected") slot.state.lastConnectedAt = new Date().toISOString();
      } catch { /* No readable status is not connected. */ }
    }
  }
  private async resumeOnRegistration(): Promise<void> {
    const slot = this.slots.find(candidate => candidate.definition.kind === "native" && candidate.state.state === "paused");
    if (!slot || this.registrationChecking || this.inactive || this.restarting) return;
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
    if (this.inactive || this.restarting) return;
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
      if (this.inactive || this.restarting || slot.state.state !== "paused") return;
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
      if (this.inactive) return;
      const args = component.kind === "tunnel" && component.command === "/usr/bin/ssh" ? serviceTunnelArguments(component.args) : component.args;
      // The adopted `-R` Claude forward must not run the generic listener cleanup: it can kill any same-user sshd
      // listener on its port, without proving that listener belongs to this component.
      const cleanup = component.kind === "tunnel" && !isClaudeComponent(component) && component.command === "/usr/bin/ssh" ? staleForwardCleanup(component.args) : undefined;
      if (cleanup) {
        const freed = await this.cleanStaleForward(component, cleanup);
        if (freed) telemetry("tunnel_stale_listener_cleared", { component: component.id, processes: freed });
        if (this.inactive) return;
      }
      if (component.kind === "tunnel" && isClaudeComponent(component)) {
        const freed = await clearOwnedForward(component, this.state);
        if (freed) telemetry("tunnel_stale_listener_cleared", { component: component.id, processes: freed });
        if (this.inactive) return;
      }
      const child = spawn(component.command, args, { stdio: ["ignore", log.fd, log.fd], env: { ...process.env, ...component.environment }, ...(component.workingDirectory ? { cwd: component.workingDirectory } : {}) });
      slot.child = child; slot.startedAt = Date.now();
      slot.exited = new Promise(resolve => child.once("close", () => resolve()));
      const ownership = this.ownership;
      let handled = false;
      const ended = (code: number | null, signal?: NodeJS.Signals | null) => {
        if (handled) return; handled = true;
        ownership.current.childEnded(slot, component, code, signal);
      };
      child.once("error", () => ended(null)); child.once("close", (code, signal) => ended(code, signal));
      child.once("spawn", () => {
        slot.state.state = "running"; slot.state.pid = child.pid; slot.state.startedAt = new Date().toISOString(); void ownership.current.publish();
        if (child.pid) ownership.current.track(() => rememberOwnedForward(component, child.pid!, this.state));
      });
    } finally { await log.close(); }
  }
  private childEnded(slot: Slot, component: ServiceComponent, code: number | null, signal?: NodeJS.Signals | null): void {
    slot.child = undefined; delete slot.state.pid;
    if (!this.inactive && !(component.kind === "desktop" && code === 0)) telemetry("component_exit", { component: component.id, kind: component.kind, code, uptimeMs: Date.now() - slot.startedAt, restarts: slot.state.restarts });
    if (this.inactive) slot.state.state = "stopped";
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
        if (slot.quickFailures >= (slot.resumedOnce ? 1 : nativeQuickFailureLimit)) { this.track(() => this.pause(slot, "failing")); return; }
      }
      const retry = Math.min(30000, this.retryBaseMs * 2 ** Math.min(slot.failures - 1, 10));
      slot.state.state = "waiting"; slot.state.restarts++; slot.state.nextRestartAt = new Date(Date.now() + retry).toISOString();
      slot.timer = setTimeout(() => { slot.timer = undefined; delete slot.state.nextRestartAt; void this.current().startSlot(slot).catch(() => { void this.current().stop(); }); }, retry);
    }
    void this.publish();
  }
  /**
   * The strict idle restart: `gateway service restart` (SIGUSR2), a failed host close and the first try of every upgrade. The
   * host must have no adapter lease and no loaded chat, any running Claude component must hold no established TCP connection
   * (their pinned runtimes answer no idle signal of their own), then inference must accept its own idle guard.
   */
  async restartWhenIdle(): Promise<boolean> { return "loadedChats" in await this.restartAfter(async (host): Promise<RestartResult> => await host.prepareStop() ? { loadedChats: 0 } : {}); }
  /** Installed services swap compatible controllers. Legacy direct instances retain their old idle/quiet restart policy. */
  private async upgrade(pending: PendingRelease): Promise<UpgradeOutcome | false> {
    if (this.controlUpdate) return await this.controlUpdate() ? { mode: "live" } : false;
    // An urgent move (a newer adapter is refused by this host) is the quiet check without its waits: no grace, and a turn that
    // ended moments ago does not hold it back, because that adapter cannot run anything until the service has moved. The strict
    // idle check is a subset of it, so it is not tried first.
    if (!pending.urgent && await this.restartWhenIdle()) return { mode: "idle" };
    if (this.inactive || !pending.urgent && pending.pendingMs < upgradeGraceMs()) return false;
    const quietMs = pending.urgent ? 0 : upgradeQuietMs();
    const result = await this.restartAfter(async host => await host.prepareQuietStop?.(quietMs) ?? {});
    if ("loadedChats" in result) return { mode: pending.urgent ? "skew" : "quiet", loadedChats: result.loadedChats };
    const key = `${pending.to}\0${result.wait}`;
    if (result.wait && !this.inactive && !this.upgradeWaits.has(key)) {
      this.upgradeWaits.add(key); telemetry("self_upgrade_waiting", { component: "service", from: pending.from, to: pending.to, reason: result.wait });
    }
    return false;
  }
  /** Whether the running host has refused an adapter of the installed release `to` (release skew), which makes moving to it urgent. */
  private async skewWaiting(to: string): Promise<boolean> {
    if (this.inactive || this.host.hostCloseFailed) return false;
    const host: ExecutionHost | undefined = await this.host.executionStarting?.catch(() => undefined);
    return host?.skewRefused?.(to) === true;
  }
  /**
   * One restart at a time, never while stopping: `hostReady` closes the host's gate (an idle or quiet check, returning the
   * loaded-chat count, or why it refused), then inference must accept SIGUSR2 and exit, and the service stops for launchd
   * to start it again. A configured Claude component makes every automatic restart refuse before it quiesces the host: its
   * pinned runtime has no atomic admission close, so an idle socket snapshot cannot make this safe. An explicitly requested
   * stop never comes through here and remains available for an authorized cutover.
   */
  private async restartAfter(hostReady: (host: ExecutionHost) => Promise<RestartResult>): Promise<RestartResult> {
    // A host-only restart in progress is finished first; the service restart is asked again later.
    if (this.inactive || this.restarting || this.host.hostRestarting) return {};
    // This checks definitions rather than process state. A Claude child that is spawning, retrying, or has no pid can still
    // admit work before a later stop, and neither lsof nor a second pid check closes that race.
    if (this.slots.some(slot => isClaudeComponent(slot.definition))) return { wait: "claude_busy" };
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
  /** Enables the immutable installed-release loader only in the app-owned outer lifecycle. */
  enableLiveUpdates(): void {
    if (!this.controlLease) { this.controlLease = this.acquireCodeLease(); this.ownership.leases.push(this.controlLease); }
    this.controlUpdate = async () => {
      const selected = releaseState()?.installed;
      const plan = await readServicePlan(this.state);
      if (!plan || JSON.stringify(plan) !== JSON.stringify(this.plan)) return false;
      const candidate = await installedSupervisorRuntime();
      if (candidate?.supervisorRuntimeVersion !== supervisorRuntimeVersion) return false;
      try {
        const next = candidate.createSupervisor(plan, this.state);
        return await this.handover(next, async () => {
          const latest = await readServicePlan(this.state);
          return !!latest && JSON.stringify(latest) === JSON.stringify(plan) && releaseState()?.installed === selected;
        });
      } finally { candidate.release(); }

    };
  }
  private acquireCodeLease(): ReleaseLease { return retainRunningRelease(import.meta.url); }
  /** Version-one controller handover retains ownership, exit observers, queues, children and host verbatim. */
  async handover(next: ServiceSupervisor, unchanged: () => Promise<boolean> = async () => true): Promise<boolean> {
    if (next === this || next.inactive || next.heartbeat || next.slots.some(slot => slot.child || slot.starting || slot.timer)
      || this.inactive || this.restarting || this.controlInFlight || this.registrationChecking || !this.host.canHandover()
      || this.slots.some(slot => slot.starting) || JSON.stringify(this.plan) !== JSON.stringify(next.plan) || this.state !== next.state) return false;
    if (!await unchanged()) return false;
    await this.writes;
    if (!await unchanged()) return false;
    if (this.inactive || this.restarting || this.controlInFlight || this.registrationChecking || !this.host.canHandover() || this.slots.some(slot => slot.starting)) return false;
    const nextHostRuntime = next.host;
    next.slots = this.slots; next.host = this.host; next.ownership = this.ownership; next.writes = this.writes;
    next.runningRelease = this.runningRelease; next.stopped = this.stopped; next.stoppedResolve = this.stoppedResolve;
    next.registrationSeen = this.registrationSeen; next.lastTick = this.lastTick;
    const stagedLease = next.controlLease ??= next.acquireCodeLease();
    this.ownership.leases.push(stagedLease);
    this.retired = true; this.ownership.current = next;
    try {
      await this.stopControl();
      if (next.inactive) return true;
      if (this.controlUpdate) next.enableLiveUpdates();
      await next.startControl();
      if (!next.inactive) { next.host.adoptRuntime(nextHostRuntime); void next.host.restartHostWhenIdle(); }
      return true;
    } catch {
      await next.stopControl();
      if (next.stopping) return true;
      next.retired = true; this.retired = false; this.ownership.current = this;
      while (next.controlInFlight || this.slots.some(slot => slot.starting)) await delay(10);
      await this.writes;
      if (!this.inactive) {
        for (const slot of this.slots) if (!slot.child && !slot.timer && slot.state.state !== "paused" && slot.state.state !== "complete") await this.startSlot(slot);
        await this.startControl();
      }
      return false;
    }
  }
  private async stopControl(): Promise<void> {
    clearInterval(this.heartbeat); clearInterval(this.wakeWatch); clearInterval(this.pauseWatch); clearInterval(this.registrationWatch);
    this.stopUpgradeWatch?.(); this.stopHealth?.(); this.appUpdates?.stop();
    await this.modelMaintenance?.stop();

  }
  stop(): Promise<void> { return this.retired ? this.current().stop() : this.stopDone ||= this.stopAll(); }
  private async stopAll(): Promise<void> {
    this.stopping = true;
    await this.stopControl();
    this.host.stopWatching();
    // Inference lets running streams finish before it exits, so it gets its drain on top of the usual grace. The private Claude
    // inference gets the same longer wait before SIGKILL, but only as a wait: its own close aborts running requests, so the
    // larger grace guarantees nothing about them. No idle guard runs on this path; the sockets guard belongs to automatic
    // restarts. Shared executors are its local clients: the host closes only once inference has exited, or their running
    // streams would end as cancelled. Plans override only PATH and SSH_AUTH_SOCK, so inference inherits this drain setting.
    const grace = (slot: Slot) => slot.definition.kind === "inference" || slot.definition.kind === "claude-inference" ? inferenceStopGraceMs() : componentStopMs;
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
    } finally { for (const lease of this.ownership.leases) lease.release(); this.ownership.leases.length = 0; this.stoppedResolve(); }
  }
}

export { runServiceSupervisor } from "./service-supervisor-run.js";
