import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { EngineStopReason } from "./app-server-connection.js";
import { ExecutionHostClient, type NativeFallbackReason } from "./execution-host-client.js";
import { executionHostHome } from "./execution-host-storage.js";
import { claimPrivateNativeHome, nativeHomeOwnership, readNativeHomeOwner, type PrivateNativeLease } from "./native-execution-host-storage.js";
import { serviceNativeExecutionPaths, type ServicePlan } from "./service-plan.js";
import { telemetry } from "./telemetry.js";

/** Refusals that name their own cause, so the adapter reports them instead of the host's failure. */
const ownCause = new WeakSet<object>();
const refusal = (message: string): Error => { const error = new Error(message); ownCause.add(error); return error; };

/**
 * The host home is keyed by the native home as the plan spells it, so an adapter whose native home is another folder, or the
 * same folder through a link or another path, looked at a host home the service never runs: finding no receipt there proves
 * nothing, and a lease it took would name a configuration the host cannot recognize. Such an adapter never falls back.
 */
async function assertPlanNativeHome(nativeHome: string, plan: ServicePlan | undefined): Promise<void> {
  let same = false;
  try {
    const planned = plan ? serviceNativeExecutionPaths(plan).nativeHome : undefined;
    same = planned !== undefined && resolve(nativeHome) === planned && await realpath(nativeHome) === await realpath(planned);
  } catch { /* An unreadable plan or a native home that cannot be resolved is not the plan's. */ }
  if (!same) throw refusal("This connection's native home is not the one the gateway service shares (another folder, a link or another path to it), so it cannot run its own native engine; start Codex with the service's native home and reconnect. Its chats were preserved.");
}

/**
 * What a desktop adapter needs before it spawns its own native engine. Every private engine gets the verdict a host's claim
 * gets (a live or unconfirmed native owner keeps it out). An adapter that shares native chats but falls back (the host stayed
 * down, or it runs without native sharing) also takes a private native-home lease, before the spawn, and holds it until the
 * engine exits. Private leases share the home with each other, as the app's own engine and an SSH remote's do in stock
 * Codex, but never with the host's writer: a host that comes back meanwhile finds a live owner and does not become a second
 * kind of writer beside them. A fallback is recorded only once it is allowed, with how many private engines then hold the home.
 */
export async function privateNativeOwnership(configPath: string | undefined, nativeHome: string, codex: string, fallback?: NativeFallbackReason, plan?: ServicePlan): Promise<PrivateNativeLease | undefined> {
  if (fallback) await assertPlanNativeHome(nativeHome, plan);
  let lease: PrivateNativeLease | undefined;
  try {
    await ExecutionHostClient.assertNativeUnowned(configPath, nativeHome);
    if (fallback) {
      if (!configPath) throw new Error("A private native fallback requires this adapter's configuration path");
      lease = await claimPrivateNativeHome({ configPath: resolve(configPath), nativeHome, codex }, executionHostHome(configPath, nativeHome));
    }
  } catch (error) {
    // Private engines of this release share the home, so the private owner that keeps one out is an earlier release's engine,
    // which holds the home alone until its connection moves to this release (an idle one does after an install): say so plainly.
    const owner = fallback === "other" ? await readNativeHomeOwner(nativeHome).catch(() => undefined) : undefined;
    if (owner?.privateOwner && !owner.privateOwner.shared && ["live", "unconfirmed"].includes(await nativeHomeOwnership(nativeHome, configPath ? executionHostHome(configPath, nativeHome) : undefined).catch(() => "live"))) {
      const holder = owner.hostPid || owner.pid;
      throw refusal(`Another connection's native engine${holder ? ` (process ${holder})` : ""} was started by an earlier gateway release, which keeps this native home to itself while the gateway host cannot share native chats. That connection moves to this release once it is idle; or close it, then reconnect. Its chats were preserved.`);
    }
    throw error;
  }
  if (fallback) telemetry("native_sharing_fallback", { reason: fallback, holders: lease?.holders });
  return lease;
}

/** The error a refused fallback reports: the host's own failure when it stayed down, unless the refusal names its own cause. */
export function refusedFallback(fallback: NativeFallbackReason, hostError: unknown, failure: unknown): unknown {
  return fallback === "host_unavailable" && !(failure && typeof failure === "object" && ownCause.has(failure)) ? hostError : failure;
}

/**
 * Builds the adapter that runs the private native engine and, under a lease, names that engine in it. A lease is held only
 * while something it names can write: an adapter that cannot be built spawned nothing, so the lease goes straight back, and
 * an engine the lease cannot name is stopped, its exit releasing the lease.
 */
export async function underPrivateLease<T extends { stop(reason?: EngineStopReason): Promise<void> }>(lease: PrivateNativeLease | undefined, build: () => T, enginePid: (backend: T) => number): Promise<T> {
  let backend: T;
  try { backend = build(); } catch (error) { await lease?.release().catch(() => {}); throw error; }
  if (lease) await lease.engineStarted(enginePid(backend)).catch(async error => { await backend.stop("spawn_error"); throw error; });
  return backend;
}
