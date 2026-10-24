import { readOwnedJson } from "../app-management/storage.js";
import { bootIdentity, processStartMs } from "../boot-identity.js";
import { maintenancePath } from "./state.js";

/**
 * The in-process maintenance owner (maintenance.ts) publishes one small heartbeat per configuration. This is the only
 * evidence the app has that metadata checks are running, so it is believed only while all of these hold: the record is
 * well formed, says `active`, was refreshed recently, and its pid is alive with the same operating-system start (and boot)
 * it recorded. A dead, reused or merely old record is never reported as scheduled. Output is fixed words, never a path.
 */
export const maintenanceProtocol = 1;
export const maintenanceHeartbeatMs = 30_000;
/** Four missed beats: a slow disk or a busy loop is forgiven, a stopped owner is not. */
export const maintenanceFreshMs = 120_000;
/**
 * The loop behind the heartbeat must have completed a policy read or a pass this recently. A read is bounded to 10 s, a pass to
 * 150 s and the poll is 30 s, so a healthy loop never reaches this; a loop stuck in either is reported stale even while the
 * heartbeat (a separate timer) stays fresh.
 */
export const maintenanceStallMs = 300_000;
const futureToleranceMs = 5_000;
const startSkewMs = 2_000;

export type MaintenanceOwner = "server" | "service";
export type MaintenanceReason = "service_unavailable" | "service_stale";
export interface MaintenanceStatus { scheduled: boolean; reason?: MaintenanceReason }

export interface MaintenanceHeartbeat {
  protocol: 1;
  pid: number;
  /** Operating-system start of `pid` in epoch milliseconds, the half of the identity that survives pid reuse. */
  startedAtMs: number;
  bootId?: string;
  owner: MaintenanceOwner;
  /** Distinguishes two owners in one process (a hot swap), so the old one never overwrites the new one's record. */
  instance: string;
  updatedAt: number;
  /** Last time the maintenance loop itself completed a policy read or a pass; the heartbeat timer cannot move it. */
  progressAt: number;
  state: "active" | "stopped";
}

/** Everything that touches the clock or the process table, so tests decide what is alive and when. */
export interface MaintenanceIdentity {
  now(): number;
  pid(): number;
  alive(pid: number): boolean;
  start(pid: number): Promise<number | undefined>;
  boot(): Promise<string | undefined>;
}

export const defaultIdentity: MaintenanceIdentity = {
  now: () => Date.now(),
  pid: () => process.pid,
  alive: pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH" && (error as NodeJS.ErrnoException).code !== "EPERM"; }
  },
  start: pid => processStartMs(pid).catch(() => undefined),
  boot: async () => (await bootIdentity().catch(() => undefined))?.id,
};

const instancePattern = /^[0-9a-f-]{8,64}$/i;
const bootPattern = /^[0-9a-fA-F][0-9a-fA-F-]{6,63}$/;
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseHeartbeat(value: unknown): MaintenanceHeartbeat | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.protocol !== maintenanceProtocol) return undefined;
  if (item.state !== "active" && item.state !== "stopped") return undefined;
  if (item.owner !== "server" && item.owner !== "service") return undefined;
  if (!positive(item.pid) || !positive(item.startedAtMs) || !positive(item.updatedAt) || !positive(item.progressAt)) return undefined;
  if (typeof item.instance !== "string" || !instancePattern.test(item.instance)) return undefined;
  if (item.bootId !== undefined && (typeof item.bootId !== "string" || !bootPattern.test(item.bootId))) return undefined;
  return { protocol: 1, pid: item.pid, startedAtMs: item.startedAtMs, ...(item.bootId !== undefined ? { bootId: item.bootId } : {}),
    owner: item.owner, instance: item.instance, updatedAt: item.updatedAt, progressAt: item.progressAt, state: item.state };
}

/** Reads the heartbeat file; `undefined` means there is none, a throw means it could not be trusted or read. */
export async function readHeartbeat(configPath: string): Promise<MaintenanceHeartbeat | undefined> {
  let raw: unknown;
  try { raw = await readOwnedJson<unknown>(await maintenancePath(configPath)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const parsed = parseHeartbeat(raw);
  if (!parsed) throw new Error("heartbeat invalid");
  return parsed;
}

/** Whether the process that wrote `beat` is still the same process: alive, same boot, same operating-system start. */
export async function sameProcess(beat: MaintenanceHeartbeat, identity: MaintenanceIdentity): Promise<boolean> {
  if (!identity.alive(beat.pid)) return false;
  const boot = await identity.boot().catch(() => undefined);
  if (beat.bootId !== undefined && boot !== undefined && beat.bootId !== boot) return false;
  const started = await identity.start(beat.pid).catch(() => undefined);
  return started !== undefined && Math.abs(started - beat.startedAtMs) <= startSkewMs;
}

/** Observation only: reads one bounded file and asks the process table; writes and starts nothing. */
export async function readMaintenanceStatus(configPath: string, identity: MaintenanceIdentity = defaultIdentity): Promise<MaintenanceStatus> {
  let beat: MaintenanceHeartbeat | undefined;
  try { beat = await readHeartbeat(configPath); } catch { return { scheduled: false, reason: "service_unavailable" }; }
  if (!beat || beat.state !== "active") return { scheduled: false, reason: "service_unavailable" };
  const age = identity.now() - beat.updatedAt;
  if (age > maintenanceFreshMs || age < -futureToleranceMs) return { scheduled: false, reason: "service_stale" };
  const idle = identity.now() - beat.progressAt;
  if (idle > maintenanceStallMs || beat.progressAt - beat.updatedAt > futureToleranceMs) return { scheduled: false, reason: "service_stale" };
  try { return await sameProcess(beat, identity) ? { scheduled: true } : { scheduled: false, reason: "service_stale" }; }
  catch { return { scheduled: false, reason: "service_unavailable" }; }
}
