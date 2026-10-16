import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

/**
 * Private, local diagnostics. Each process appends one JSON line per event to
 * `<state>/telemetry/events-YYYY-MM-DD.jsonl` (mode 0600, kept 14 days). Only
 * primitive fields pass, field names that could carry secrets or content are
 * dropped, and free text is reduced to a safe character set. Set
 * GATEWAY_TELEMETRY=off to disable it.
 */
export type TelemetryValue = string | number | boolean | null | undefined;
export interface TelemetryEvent { at: string; host: string; component: string; pid: number; event: string; [field: string]: TelemetryValue }

const forbidden = /token|secret|password|credential|cookie|auth(?!or)|prompt|body|content|text|input|argument|env|header/i;
const keepDays = 14;
let directory: string | undefined; let component = "gateway"; let ready: Promise<void> | undefined;
let writes: Promise<void> = Promise.resolve();

export function configureTelemetry(stateDirectory: string, name: string): void {
  directory = join(stateDirectory, "telemetry"); component = name; ready = undefined;
}

function safe(value: TelemetryValue): TelemetryValue {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined;
  if (typeof value !== "string") return value;
  const bounded = value.slice(0, 160).replace(/[^A-Za-z0-9 ._:/@+=,()#-]/g, "_");
  // Home-relative paths reveal folder names; keep only their last segment.
  return bounded.includes("/Users/") ? bounded.replace(/\/Users\/[^ ]*\/([^/ ]+)/g, ".../$1") : bounded;
}

/** The same character filter other local logs apply to free text. */
export const safeTelemetryValue = safe;

export function telemetryFields(fields: Record<string, unknown>): Record<string, TelemetryValue> {
  const result: Record<string, TelemetryValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    // Token counts are numbers; any other token-shaped field is dropped.
    const count = typeof value === "number" && /Tokens$/.test(key);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) || (forbidden.test(key) && !count)) continue;
    if (value === undefined || (value !== null && !["string", "number", "boolean"].includes(typeof value))) continue;
    const cleaned = safe(value as TelemetryValue); if (cleaned !== undefined) result[key] = cleaned;
  }
  return result;
}

async function prune(path: string): Promise<void> {
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  for (const name of await readdir(path).catch(() => [] as string[])) {
    const day = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (day && day < cutoff) await rm(join(path, name), { force: true }).catch(() => {});
  }
}

export function telemetry(event: string, fields: Record<string, unknown> = {}): void {
  if (!directory || process.env.GATEWAY_TELEMETRY === "off" || !/^[a-z][a-z0-9_]{0,63}$/.test(event)) return;
  const path = directory; const now = new Date();
  const line = JSON.stringify({ at: now.toISOString(), host: hostname().split(".")[0], component, pid: process.pid, event, ...telemetryFields(fields) }) + "\n";
  ready ||= mkdir(path, { recursive: true, mode: 0o700 }).then(() => prune(path));
  const prepared = ready;
  // One chain per process keeps each machine's timeline in order.
  writes = writes.then(() => prepared).then(() => appendFile(join(path, `events-${now.toISOString().slice(0, 10)}.jsonl`), line, { mode: 0o600 })).catch(() => {});
}

/** Waits for queued writes; tests and short-lived commands call this before exiting. */
export async function flushTelemetry(): Promise<void> { await writes; }

export async function readTelemetry(stateDirectory: string, sinceMs: number): Promise<TelemetryEvent[]> {
  const path = join(stateDirectory, "telemetry"); const since = new Date(sinceMs).toISOString().slice(0, 10);
  const events: TelemetryEvent[] = [];
  for (const name of (await readdir(path).catch(() => [] as string[])).sort()) {
    const day = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (!day || day < since) continue;
    for (const line of (await readFile(join(path, name), "utf8").catch(() => "")).split("\n")) {
      if (!line) continue;
      try { const event = JSON.parse(line) as TelemetryEvent; if (Date.parse(event.at) >= sinceMs) events.push(event); } catch { /* A torn line is skipped. */ }
    }
  }
  return events;
}
