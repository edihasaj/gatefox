import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { healthWindowMs } from "./health-types.js";

/**
 * The counts the watchdog reads out of this Mac's own telemetry log. Only the eight
 * fixed fields below are ever looked at, only counts and method names come out, and a
 * line that is not one of ours is skipped rather than reported. Telemetry is written
 * in UTC, so the two files that can cover a 15-minute window are today's and
 * yesterday's, named by their UTC date.
 */
export const watchedFields = ["at", "event", "component", "kind", "method", "code", "site", "errorClass", "rejection"] as const;
export type WatchedField = (typeof watchedFields)[number];
/** One accepted line: only the watched fields survive, and `at` becomes an instant. */
export interface HealthEvent {
  event: string; at: number;
  component?: string; kind?: string; method?: string; code?: string | number; site?: string;
  /** The error's class name, and the fixed refusal vocabulary. Only `rejection` is judged. */
  errorClass?: string; rejection?: string;
}

/** The methods whose refusals mean a chat could not start or continue at all. */
export const sessionMethods = new Set(["thread/start", "thread/resume", "thread/fork", "turn/start"]);
/** The JSON-RPC code the adapter and the pinned SDK refuse unavailable shared execution with. */
export const unavailableCode = -32001;

/** A refusal this recent, after the latest recovery marker, is a Mac that is still refusing. */
export const refusalOngoingMs = 5 * 60_000;
/** How far from a `self_upgrade` or `server_drain` a `component_exit` still counts as the restart's own. */
export const restartExplainsExitMs = 15_000;
/** The `self_upgrade` components whose arrival means the service or the inference server was replaced. */
const upgradeMarkers = new Set(["service", "server"]);

export interface TelemetrySignals {
  /** `execution_host_failed` events in the window. */
  hostFailures: number;
  /** `component_exit` events in the window, per component kind, minus the exits a restart explains. */
  exits: Record<string, number>;
  /** Exits a `self_upgrade` or a requested restart explained, per kind; they never move a verdict. */
  explainedExits: Record<string, number>;
  /** `rpc_error` events that stopped a session method, per method. */
  rpcErrors: Record<string, number>;
  /** Every session refusal in the window, whichever method it stopped. 1-2 warn, `refusalFailThreshold` and up fail. */
  refusals: number;
  /** Refusals after the latest recovery marker: the ones a restart has not already answered. */
  activeRefusals: number;
  /** The active refusals that are also within the last `refusalOngoingMs`. Only these can fail, from `refusalFailThreshold`. */
  recentRefusals: number;
  /** Whether one active refusal is within the last `refusalOngoingMs`. */
  refusalsOngoing: boolean;
  /** The methods that have an ongoing refusal. */
  ongoingMethods: string[];
  /** When the last refusal of each method happened, as an instant, whatever the markers say. */
  lastRefusalAt: Record<string, number>;
  /** `gateway_features_trimmed` events whose site was the one configuration retry. */
  featureRetries: number;
  /** Feature retries in the window that were followed by a refusal of a session method. */
  retriedThenRefused: number;
  /** The sharing degradations seen, from the fixed list. */
  nativeSharing: string[];
  /** Whether any `component_exit` names the native component. */
  nativeExited: boolean;
}

export const emptySignals = (): TelemetrySignals =>
  ({ hostFailures: 0, exits: {}, explainedExits: {}, rpcErrors: {}, refusals: 0, activeRefusals: 0, recentRefusals: 0, refusalsOngoing: false, ongoingMethods: [], lastRefusalAt: {}, featureRetries: 0, retriedThenRefused: 0, nativeSharing: [], nativeExited: false });

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/** One telemetry line, kept only as far as its fields are watched ones. A torn line is nothing. */
export function parseHealthEvent(line: string): HealthEvent | undefined {
  if (!line) return;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return; }
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const event = text(row.event);
  if (!event || !/^[a-z][a-z0-9_]{0,63}$/.test(event)) return;
  const at = Date.parse(String(row.at ?? ""));
  if (Number.isNaN(at)) return;
  const kept: Record<string, string | number> = {};
  for (const field of watchedFields) {
    const value = row[field];
    if (typeof value === "string") kept[field] = value.slice(0, 128);
    else if (typeof value === "number" && Number.isFinite(value)) kept[field] = value;
  }
  // `at` is kept as the instant it names, so a window is one comparison wide.
  return { ...kept, event, at } as unknown as HealthEvent;
}

/**
 * Whether a `rpc_error` line names a session method the gateway could not serve. The judgement
 * reads `rejection`, whose values come from a fixed list, never `reason`'s free text: an
 * unclassified refusal ("other") and a refused execution path (-32001) are what a chat feels.
 */
function refusedSessionMethod(row: HealthEvent): boolean {
  if (row.event !== "rpc_error") return false;
  const method = row.method;
  if (typeof method !== "string" || !sessionMethods.has(method)) return false;
  return row.code === unavailableCode || row.rejection === "other";
}

export interface SummarizeOptions {
  /** The instant the window ends at; the clock "ongoing" is measured against. */
  now?: number;
  /** Instants that mark a recovery the telemetry cannot show, such as the service process's own start. */
  markers?: number[];
}

/**
 * Whether a restart explains a `component_exit`: a `self_upgrade` of the service explains any
 * component, one of the inference server or a `server_drain` explains an inference exit, and
 * the two have to be within `restartExplainsExitMs` of each other.
 */
function explainedByRestart(kind: string, at: number, rows: HealthEvent[]): boolean {
  return rows.some(row => {
    if (Math.abs(row.at - at) > restartExplainsExitMs) return false;
    if (row.event === "self_upgrade") return row.component === "service" || (row.component === "server" && kind === "inference");
    return row.event === "server_drain" && kind === "inference";
  });
}

/**
 * Whether the host failed or restarted again after this recovery. A recovery that did not hold
 * heals nothing, so a host that flaps cannot keep resetting the refusals it is causing.
 */
const relapsed = (recovered: HealthEvent, rows: HealthEvent[]): boolean =>
  rows.some(row => row.at > recovered.at && (row.event === "execution_host_failed" || row.event === "execution_host_restarted"));

/** Reduces the window's lines to counts. `at` is the epoch millisecond the parser kept. */
export function summarizeHealthEvents(rows: HealthEvent[], options: SummarizeOptions = {}): TelemetrySignals {
  const signals = emptySignals();
  const now = options.now ?? Date.now();
  const retries: number[] = [];
  const refusals: { at: number; method: string }[] = [];
  // The latest recovery marker: an event that says the thing which was refusing has been replaced or has healed.
  const marker = Math.max(0, ...(options.markers ?? []), ...rows.filter(row => (row.event === "execution_host_recovered" && !relapsed(row, rows))
    || (row.event === "self_upgrade" && upgradeMarkers.has(String(row.component)))).map(row => row.at));
  for (const row of rows) {
    const at = typeof row.at === "number" ? row.at : 0;
    if (row.event === "execution_host_failed") signals.hostFailures++;
    if (row.event === "component_exit") {
      const kind = typeof row.kind === "string" ? row.kind : "unknown";
      const into = explainedByRestart(kind, at, rows) ? signals.explainedExits : signals.exits;
      into[kind] = (into[kind] ?? 0) + 1;
      if (kind === "native" && into === signals.exits) signals.nativeExited = true;
    }
    if (row.event === "gateway_features_trimmed" && row.site === "retry") signals.featureRetries++, retries.push(at);
    if (refusedSessionMethod(row)) {
      const method = String(row.method);
      signals.rpcErrors[method] = (signals.rpcErrors[method] ?? 0) + 1;
      signals.refusals++;
      signals.lastRefusalAt[method] = Math.max(signals.lastRefusalAt[method] ?? 0, at);
      refusals.push({ at, method });
    }
    if ((row.event === "native_sharing_unavailable" || row.event === "native_sharing_fallback") && !signals.nativeSharing.includes(row.event)) signals.nativeSharing.push(row.event);
  }
  const active = refusals.filter(refusal => refusal.at > marker);
  const recent = active.filter(refusal => refusal.at >= now - refusalOngoingMs);
  signals.activeRefusals = active.length;
  signals.recentRefusals = recent.length;
  signals.refusalsOngoing = recent.length > 0;
  signals.ongoingMethods = [...new Set(recent.map(refusal => refusal.method))].sort();
  // A retry that still ends in a refusal is the one config-load failure worth alerting on, while that refusal is ongoing.
  signals.retriedThenRefused = signals.refusalsOngoing ? active.filter(refusal => retries.some(retry => refusal.at >= retry)).length : 0;
  return signals;
}

/** The UTC date names a 15-minute window can touch: its own day and the one before. */
export function telemetryFileNames(nowMs: number, windowMs = healthWindowMs): string[] {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [...new Set([day(nowMs), day(nowMs - windowMs)])].map(date => `events-${date}.jsonl`);
}

export interface TelemetryReadDeps {
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
  windowMs?: number;
  /** Drops rows after this instant, so a replay or a test cannot see events from its own future. Live reads set none. */
  until?: number;
}

/** Every watchable line in the window, read from the state directory's own telemetry. */
export async function readHealthTelemetry(stateDirectory: string, deps: TelemetryReadDeps = {}): Promise<HealthEvent[]> {
  const read = deps.readFile ?? (path => readFile(path, "utf8").catch(() => ""));
  const now = deps.now?.() ?? Date.now();
  const windowMs = deps.windowMs ?? healthWindowMs;
  const since = now - windowMs;
  const rows: HealthEvent[] = [];
  for (const name of telemetryFileNames(now, windowMs)) {
    for (const line of (await read(join(stateDirectory, "telemetry", name))).split("\n")) {
      const row = parseHealthEvent(line);
      if (row && typeof row.at === "number" && row.at >= since && (deps.until === undefined || row.at <= deps.until)) rows.push(row);
    }
  }
  return rows;
}
