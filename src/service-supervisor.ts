import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, writePrivateJson } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { serviceExecutionPaths, serviceNativeExecutionPaths, serviceStatusPath, type ServiceComponent, type ServicePlan } from "./service-plan.js";
import { executionHostHome, startExecutionHost } from "./execution-host.js";
import { serviceTunnelArguments, staleForwardCleanup } from "./service-tunnel.js";
import { configureTelemetry, telemetry } from "./telemetry.js";
import { errorClass } from "./turn-telemetry.js";
import { reportException, startErrorReports } from "./error-report.js";
import { watchForUpgrade } from "./self-update.js";
import { componentStopMs, inferenceStopGraceMs } from "./runtime-activity.js";

interface ComponentState { id: string; kind: string; state: "starting" | "running" | "waiting" | "complete" | "stopped"; pid?: number; restarts: number; nextRestartAt?: string }
const execFileAsync = promisify(execFile);
interface Slot { definition: ServiceComponent; state: ComponentState; child?: ChildProcess; exited?: Promise<void>; timer?: NodeJS.Timeout; starting?: boolean; failures: number; startedAt: number }
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
  private hostFailures = 0;
  private executionState?: { state: "starting" | "running" | "stopped" | "failed"; home: string; pid: number; sharedNativeExecutor: boolean; sharedGatewayExecutors: boolean };
  private stoppedResolve: () => void = () => {};
  readonly stopped = new Promise<void>(resolve => { this.stoppedResolve = resolve; });
  constructor(private plan: ServicePlan, private state: string, private retryBaseMs = 1000, private readonly startHost: typeof startExecutionHost = startExecutionHost) {
    this.slots = plan.components.map(definition => ({ definition, state: { id: definition.id, kind: definition.kind, state: "starting", restarts: 0 }, failures: 0, startedAt: 0 }));
  }
  private publish(): Promise<void> {
    const snapshot = { version: 1, pid: process.pid, updatedAt: new Date().toISOString(), stopping: this.stopping, components: this.slots.map(slot => ({ ...slot.state })), ...(this.executionState ? { executionHost: { ...this.executionState } } : {}) };
    this.writes = this.writes.catch(() => undefined).then(() => writePrivateJson(serviceStatusPath(this.state), snapshot));
    return this.writes;
  }
  async start(): Promise<void> {
    if (this.stopping) return;
    if (this.plan.sharedExecutors || this.plan.sharedNativeExecutor) {
      const config = await loadConfig(this.plan.config); const paths = this.plan.sharedNativeExecutor ? serviceNativeExecutionPaths(this.plan) : serviceExecutionPaths(this.plan);
      if (this.stopping) return;
      if (resolve(config.stateDirectory) !== resolve(this.state)) throw new Error("Shared executor state does not match the service plan");
      this.executionState = { state: "starting", home: executionHostHome(this.plan.config, paths.nativeHome), pid: process.pid,
        sharedNativeExecutor: this.plan.sharedNativeExecutor === true, sharedGatewayExecutors: this.plan.sharedExecutors === true };
      await this.publish();
      if (this.stopping) return;
      // A failed host (for example after an app update changes its SDK) must not
      // take inference, tunnels, or the relay down with it. Adapters that need the
      // host fail closed until a retry succeeds.
      await this.startExecutionHost(config, paths);
      if (this.stopping) return;
    }
    for (const slot of this.slots) await this.startSlot(slot);
    if (this.stopping) return;
    this.heartbeat = setInterval(() => { void this.publish().catch(() => { void this.stop(); }); }, 5000);
    this.lastTick = Date.now(); this.wakeWatch = setInterval(() => this.checkWake(Date.now()), 5000);
    // The service itself moves to a newly installed release only when fully idle
    // (no app connected and no chat loaded); until then it keeps the previous one.
    this.stopUpgradeWatch = watchForUpgrade("service", () => !this.stopping && !this.restarting, () => this.restartWhenIdle());
    await this.publish();
  }
  private async startExecutionHost(config: Awaited<ReturnType<typeof loadConfig>>, paths: ReturnType<typeof serviceExecutionPaths>): Promise<void> {
    if (this.stopping || !this.executionState) return;
    const starting = this.startHost({ config, configPath: this.plan.config, ...paths,
      capabilities: [...(this.plan.sharedNativeExecutor ? ["native" as const] : []), ...(this.plan.sharedExecutors ? ["gateway" as const] : [])],
      nativeRelayOwnsRegistration: this.plan.sharedNativeExecutor === true });
    this.executionStarting = starting;
    try { await starting; if (this.hostFailures) telemetry("execution_host_recovered", { failures: this.hostFailures }); this.hostFailures = 0; this.executionState.state = "running"; await this.publish(); }
    catch (error) {
      telemetry("execution_host_failed", { failures: this.hostFailures + 1, errorClass: errorClass((error as Error)?.message) });
      reportException(error, "execution_host_start");
      if (this.executionStarting === starting) this.executionStarting = undefined;
      this.hostFailures++; this.executionState.state = "failed"; await this.publish().catch(() => {});
      if (this.stopping) return;
      const wait = Math.min(300000, this.retryBaseMs * 10 * 2 ** Math.min(this.hostFailures - 1, 5));
      this.hostRetry = setTimeout(() => { this.hostRetry = undefined; void this.startExecutionHost(config, paths); }, wait);
    }
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
      slot.failures = 0;
      if (slot.child) slot.child.kill("SIGTERM");
      else if (slot.timer && !slot.starting) { clearTimeout(slot.timer); slot.timer = undefined; delete slot.state.nextRestartAt; void this.startSlot(slot).catch(() => { void this.stop(); }); }
    }
  }
  private async startSlot(slot: Slot): Promise<void> {
    // One start per slot at a time: a tunnel's stale-listener cleanup can take seconds, and a
    // wake during it must not spawn a second process for the same forwarded port.
    if (this.stopping || slot.starting || slot.child) return;
    slot.starting = true;
    try { await this.spawnSlot(slot); } finally { slot.starting = false; }
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
      const ended = (code: number | null) => {
        if (handled) return; handled = true; slot.child = undefined; delete slot.state.pid;
        if (!this.stopping && !(component.kind === "desktop" && code === 0)) telemetry("component_exit", { component: component.id, kind: component.kind, code, uptimeMs: Date.now() - slot.startedAt, restarts: slot.state.restarts });
        if (this.stopping) slot.state.state = "stopped";
        else if (component.kind === "desktop" && code === 0) slot.state.state = "complete";
        else if (!this.restarting || component.kind !== "inference") {
          slot.failures = Date.now() - slot.startedAt >= 60000 ? 1 : slot.failures + 1;
          const retry = Math.min(30000, this.retryBaseMs * 2 ** Math.min(slot.failures - 1, 10));
          slot.state.state = "waiting"; slot.state.restarts++; slot.state.nextRestartAt = new Date(Date.now() + retry).toISOString();
          slot.timer = setTimeout(() => { slot.timer = undefined; delete slot.state.nextRestartAt; void this.startSlot(slot).catch(() => { void this.stop(); }); }, retry);
        }
        void this.publish().catch(() => { void this.stop(); });
      };
      child.once("error", () => ended(null)); child.once("close", ended);
      child.once("spawn", () => { slot.state.state = "running"; slot.state.pid = child.pid; void this.publish().catch(() => { void this.stop(); }); });
    } finally { await log.close(); }
  }
  async restartWhenIdle(): Promise<boolean> {
    if (this.stopping || this.restarting) return false;
    const inference = this.slots.find(slot => slot.definition.kind === "inference");
    if (inference && !inference.child) return false;
    this.restarting = true;
    let executionHost: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
    try {
      executionHost = await this.executionStarting;
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
    this.stopping = true; clearInterval(this.heartbeat); clearInterval(this.wakeWatch); this.stopUpgradeWatch?.(); clearTimeout(this.hostRetry);
    // Inference lets running streams finish before it exits, so it gets its drain on top
    // of the usual grace. Shared executors are its local clients: the host closes only
    // once inference has exited, or their running streams would end as cancelled. Plans
    // override only PATH and SSH_AUTH_SOCK, so inference inherits this drain setting.
    const grace = (slot: Slot) => slot.definition.kind === "inference" ? inferenceStopGraceMs() : componentStopMs;
    const inference = this.slots.filter(slot => slot.definition.kind === "inference" && slot.child);
    for (const slot of this.slots) { clearTimeout(slot.timer); slot.child?.kill("SIGTERM"); }
    const executionClose = this.executionStarting && Promise.all(inference.map(slot => within(slot.exited, grace(slot))))
      .then(() => this.executionStarting).then(host => host?.close());
    // Observe rejection immediately while owned component processes shut down.
    const executionStopped = executionClose?.then(() => undefined, error => error as Error);
    const exited = Promise.all(this.slots.map(slot => slot.exited));
    await Promise.all(this.slots.map(async slot => {
      const child = slot.child; if (!child) return;
      await within(slot.exited, grace(slot)); child.kill("SIGKILL");
    }));
    for (const slot of this.slots) { slot.state.state = "stopped"; delete slot.state.pid; delete slot.state.nextRestartAt; }
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
