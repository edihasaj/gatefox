import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writePrivateJson } from "../config.js";
import { servicePlanPath, readServicePlan, type ServicePlan } from "../service-plan.js";
import { claimHost, executionHostHome, executionHostMarker, publishOwner, type HostIdentity, type HostOwner } from "../execution-host-storage.js";
import { claimNativeHome, type NativeHomeLease } from "../native-execution-host-storage.js";
import { archiveStoppedExecutionReceipt, archiveStoppedNativeHomeReceipt } from "../service-execution-recovery.js";
import { type PlanSwapServices, type PlanSwapTiming } from "../mac-shared-plan-swap.js";
import type { SharingDisableDependencies } from "../mac-shared-disable.js";

/**
 * The execution host of a stand-in service. It uses the real receipt functions (claimHost, claimNativeHome, publishOwner), so a
 * receipt it leaves behind is exactly what the real host leaves: a stopped host publishes a stopped receipt, a started one claims
 * it, and a claim over a receipt that is still running fails.
 */
export class HostStandIn {
  readonly home: string; readonly errors: string[] = [];
  private owner?: HostOwner; private lease?: NativeHomeLease;
  constructor(readonly configPath: string, readonly nativeHome: string, readonly codex: string) { this.home = executionHostHome(configPath, nativeHome); }
  async start(plan: Pick<ServicePlan, "sharedExecutors" | "sharedNativeExecutor">): Promise<void> {
    const native = plan.sharedNativeExecutor === true;
    const capabilities = [...(native ? ["native" as const] : []), ...(plan.sharedExecutors ? ["gateway" as const] : [])];
    if (!capabilities.length) return;
    const identity: HostIdentity = { version: 1, managed: executionHostMarker, configPath: this.configPath, nativeHome: this.nativeHome, codex: this.codex, sdkSha256: "0".repeat(64),
      socketPath: resolve(this.home, "host.sock"), capabilities, ...(native ? { nativeRelayOwnsRegistration: true, nativeSdkExecutable: this.codex, nativeSdkSha256: "1".repeat(64) } : {}) };
    try {
      this.owner = await claimHost(this.home, identity);
      if (native) this.lease = await claimNativeHome(identity, this.home);
    } catch (error) { this.errors.push((error as Error).message); }
  }
  async stop(): Promise<void> {
    if (!this.owner) return;
    await this.lease?.publish(undefined, true, "stopped");
    await publishOwner(this.home, { ...this.owner, pid: 0, state: "stopped", generations: [] });
    this.owner = undefined; this.lease = undefined;
  }
}

export interface Relaunch { pid: number; sharedExecutors: boolean; sharedNativeExecutor: boolean }

/**
 * A stand-in for launchd with KeepAlive and a throttle gap. A restart makes the running service stop its host and exit after its
 * idle guard; launchd then starts it again from whatever plan is on disk when the relaunch happens, which is a few polls later:
 * until then the service has no pid. A relaunched service claims its host receipt (when its plan shares) and, like the real
 * supervisor, is current and healthy only some polls after it started.
 */
export class KeepAliveLaunchd {
  pid: number | undefined = 1000; relaunched: Relaunch[] = [];
  /** The idle guard refuses (a chat is loaded): the process keeps running. */
  refuseIdle = false;
  /** Polls without a pid after an exit: launchd's throttle gap. */
  gap = 0;
  /** Polls after a start before the service is current and answers /health. */
  startup = 0;
  /** The next restarts fail the way the service's own maintenance check does while it cannot answer (a refused /health fetch). */
  restartFailures = 0;
  /** The restart exits the service but reports a timeout before the relaunch is seen. */
  restartTimesOut = false;
  restartCalls = 0; installs = 0; private last = 1000; private gapLeft = 0; private startLeft = 0;
  constructor(private readonly state: string, private readonly host: HostStandIn) {}
  private async launch(): Promise<void> {
    const plan = JSON.parse(await readFile(servicePlanPath(this.state), "utf8")) as ServicePlan;
    this.pid = ++this.last; this.startLeft = this.startup;
    this.relaunched.push({ pid: this.pid, sharedExecutors: plan.sharedExecutors === true, sharedNativeExecutor: plan.sharedNativeExecutor === true });
    await this.host.start(plan);
  }
  private healthy(): boolean { return this.pid !== undefined && this.startLeft === 0; }
  async status(): Promise<Record<string, unknown>> {
    if (this.pid === undefined) { if (this.gapLeft > 0) this.gapLeft--; else await this.launch(); }
    else if (this.startLeft > 0) this.startLeft--;
    return { installed: true, pid: this.pid, statusCurrent: this.healthy() };
  }
  async health(): Promise<boolean> { return this.healthy(); }
  /** Like macService("restart"): it reads the plan, checks the maintenance window, signals the idle guard and waits for a new pid. */
  async restart(): Promise<void> {
    this.restartCalls++;
    await readServicePlan(this.state);
    if (this.pid === undefined) { await this.install(); return; }
    if (!this.healthy() || this.restartFailures > 0) { this.restartFailures = Math.max(0, this.restartFailures - 1); throw new Error("fetch failed"); }
    if (this.refuseIdle) throw new Error("The unified service could not restart while idle; inspect gateway service status");
    const old = this.pid; await this.host.stop(); this.pid = undefined; this.gapLeft = this.gap;
    if (this.restartTimesOut) throw new Error("The unified service could not restart while idle; inspect gateway service status");
    for (let attempt = 0; attempt < 100 && (this.pid === undefined || this.pid === old); attempt++) await this.status();
  }
  /** Like macService("install") on a registered service: kickstart a service that is down, leave a running one alone. */
  async install(): Promise<void> { this.installs++; if (this.pid === undefined) await this.launch(); }
  services(): PlanSwapServices { return { status: () => this.status(), health: () => this.health(), restart: () => this.restart(), install: () => this.install() }; }
}

export const fastTiming: PlanSwapTiming = { readyMs: 500, pollMs: 1, restartAttempts: 3, retryMs: 1 };

export interface PlanOptions { sharedExecutors?: boolean; sharedNativeExecutor?: boolean }
export interface StandInFixture {
  directory: string; config: string; planPath: string; nativeHome: string; host: HostStandIn; launchd: KeepAliveLaunchd; plan: ServicePlan;
  calls: string[]; deps: Partial<SharingDisableDependencies>; cleanup(): Promise<void>;
}
/** A running service on a plan, in a private HOME so no receipt or socket link reaches the real one. */
export async function standInFixture(options: PlanOptions): Promise<StandInFixture> {
  const directory = await mkdtemp(join(tmpdir(), "gateway-stand-in-")); const previousHome = process.env.HOME;
  process.env.HOME = join(directory, "home"); await mkdir(process.env.HOME, { recursive: true, mode: 0o700 });
  const nativeHome = join(directory, "native"); await mkdir(nativeHome, { mode: 0o700 });
  const config = join(directory, "gateway.json"); const planPath = servicePlanPath(directory); const codex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
  await writePrivateJson(config, { version: 1, port: 3457, stateDirectory: directory, clientOnly: true, providers: [] });
  const plan: ServicePlan = { version: 1, config, ...(options.sharedExecutors ? { sharedExecutors: true } : {}), ...(options.sharedNativeExecutor ? { sharedNativeExecutor: true } : {}), components: [
    { id: "native", kind: "native", command: "/usr/bin/true", args: ["--native-home", nativeHome, "--relay-home", join(directory, "relay"), "--codex", codex, "--daemon"], log: join(directory, "native.log") }] };
  await writePrivateJson(planPath, plan);
  const host = new HostStandIn(config, nativeHome, codex); await host.start(plan);
  const launchd = new KeepAliveLaunchd(directory, host); const calls: string[] = [];
  const deps: Partial<SharingDisableDependencies> = {
    registration: async () => true, maintenance: async () => {}, sdk: async path => ({ codex: path, sdkSha256: "0".repeat(64) }), timing: fastTiming,
    status: () => launchd.status(), health: () => launchd.health(), restart: async () => { calls.push("restart"); await launchd.restart(); }, install: async () => { calls.push("install"); await launchd.install(); },
    archive: async (identity, backup) => { calls.push("archive"); return archiveStoppedExecutionReceipt(identity, backup); },
    releaseNative: async (identity, backup) => { calls.push("release-native"); return archiveStoppedNativeHomeReceipt(identity, backup); },
  };
  return { directory, config, planPath, nativeHome, host, launchd, plan, calls, deps, cleanup: async () => {
    await host.stop().catch(() => {});
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  } };
}
