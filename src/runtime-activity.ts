/**
 * Process-wide work that outlives a single request, such as live provider sessions.
 * An in-place upgrade loads a second copy of this module, so the registry lives on a
 * global symbol: every loaded release sees the same probes and shutdown hooks.
 * Bump the symbol version for any incompatible change to the registry shape.
 */
interface ActivityProbe { name: string; busy(): boolean }
interface ShutdownHook { name: string; run(): Promise<void> }
interface RuntimeActivity { probes: Set<ActivityProbe>; hooks: Set<ShutdownHook> }

const key = Symbol.for("harness-gateway/runtime-activity/v1");
const registry = (): RuntimeActivity => {
  const scope = globalThis as unknown as Record<symbol, RuntimeActivity | undefined>;
  return scope[key] ??= { probes: new Set(), hooks: new Set() };
};

/** Registers a busy check that keeps idle restarts away; returns its removal. */
export function registerActivityProbe(name: string, busy: () => boolean): () => void {
  const probe = { name, busy }; const { probes } = registry(); probes.add(probe);
  return () => { probes.delete(probe); };
}

const probeBusy = (probe: ActivityProbe): boolean => { try { return probe.busy() === true; } catch { return false; } };

/** True while any probe reports work. A probe that throws counts as idle. */
export function runtimeBusy(): boolean { return [...registry().probes].some(probeBusy); }

/** Names of the probes reporting work; names are code constants, safe for telemetry. */
export function busyActivities(): string[] { return [...registry().probes].filter(probeBusy).map(probe => probe.name); }

/** Registers work to finish before the process exits; hooks must tolerate running twice. */
export function registerShutdownHook(name: string, run: () => Promise<void>): () => void {
  const hook = { name, run }; const { hooks } = registry(); hooks.add(hook);
  return () => { hooks.delete(hook); };
}

/** Runs every shutdown hook at once and waits until they settle or `timeoutMs` passes. */
export async function runShutdownHooks(timeoutMs: number): Promise<void> {
  const hooks = [...registry().hooks]; if (!hooks.length) return;
  const settled = Promise.allSettled(hooks.map(hook => { try { return hook.run(); } catch (error) { return Promise.reject(error); } }));
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, timeoutMs)); });
  try { await Promise.race([settled, expired]); } finally { clearTimeout(timer); }
}

/** How long a stopping server lets running requests finish: GATEWAY_SHUTDOWN_DRAIN_MS, 0 to 30000, default 5000, so a stop with a busy stream stays inside launchctl's 10 s bootout timeout. */
export function shutdownDrainMs(): number {
  const raw = process.env.GATEWAY_SHUTDOWN_DRAIN_MS?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? Math.min(30000, Math.max(0, Math.round(value))) : 5000;
}
