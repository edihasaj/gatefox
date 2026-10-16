import { appendFile, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { flushTelemetry, readTelemetry, safeTelemetryValue } from "./telemetry.js";

/**
 * Content-free usage ledger. One JSON line per finished request is appended to
 * `<state>/usage/usage-YYYY-MM.jsonl` (UTC month; directory 0700, files 0600; the
 * current month and the previous 12 are kept). A row holds identifiers, counts and
 * credit amounts only: never prompts, instructions, messages, tool names or
 * arguments, session or account ids, credentials or error text.
 * GATEWAY_USAGE_LEDGER=off disables it and creates nothing.
 */
export type LedgerStatus = "completed" | "empty" | "failed";
export type NanoAiuStatus = "complete" | "partial" | "unavailable";
export interface UsageFields {
  requestId: string; responseId?: string; provider?: string; providerType?: string; model?: string; status: LedgerStatus;
  origin?: "gateway" | "telemetry"; session?: boolean;
  inputTokens?: number; cachedTokens?: number; cacheWriteTokens?: number; outputTokens?: number; reasoningTokens?: number;
  /** null (or absent) means no credit amount was reported; that is not zero. */
  nanoAiu?: number | null; nanoAiuStatus?: NanoAiuStatus;
}
export interface LedgerRow extends UsageFields { v: 1; at: string; host: string; origin: "gateway" | "telemetry"; inputTokens: number; cachedTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number; nanoAiu: number | null }

/** Request routes whose usage a spend tool reads from the ledger. Spendwatch mirrors this set. */
export const LEDGER_COUNTED_TYPES: ReadonlySet<string> = new Set(["copilot-subscription", "claude-subscription"]);
const keepMonths = 12;
const statuses = new Set<string>(["completed", "empty", "failed"]);
const nanoStatuses = new Set<string>(["complete", "partial", "unavailable"]);
export const ledgerFields: ReadonlySet<string> = new Set(["v", "at", "host", "requestId", "responseId", "provider", "providerType", "model", "status", "origin", "session",
  "inputTokens", "cachedTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "nanoAiu", "nanoAiuStatus"]);

const prepared = new Map<string, Promise<void>>(); const lastMonth = new Map<string, string>(); const fileModes = new Set<string>();
let writes: Promise<void> = Promise.resolve();
/** Request ids this process has queued rows for. The telemetry import skips them, whenever they finish. */
const recorded = new Set<string>();
const remember = (requestId: string) => { recorded.add(requestId); if (recorded.size > 20000) recorded.delete(recorded.keys().next().value!); };

export const usageLedgerEnabled = (): boolean => process.env.GATEWAY_USAGE_LEDGER !== "off";
export const usageLedgerMarks = (type: string): boolean => usageLedgerEnabled() && LEDGER_COUNTED_TYPES.has(type);

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const text = (value: unknown): string | undefined => typeof value === "string" && value ? String(safeTelemetryValue(value)) : undefined;
const monthOf = (at: string | Date): string => (typeof at === "string" ? at : at.toISOString()).slice(0, 7);
const fileFor = (directory: string, month: string): string => join(directory, `usage-${month}.jsonl`);

const sessionField = (fields: UsageFields): { session?: boolean } => fields.origin === "telemetry" && typeof fields.session === "boolean" ? { session: fields.session } : {};

function build(fields: UsageFields, at: string, host: string): LedgerRow | undefined {
  const requestId = text(fields.requestId); if (!requestId || !statuses.has(fields.status)) return;
  const nanoAiu = typeof fields.nanoAiu === "number" && Number.isFinite(fields.nanoAiu) && fields.nanoAiu >= 0 ? fields.nanoAiu : null;
  const row: LedgerRow = { v: 1, at, host, requestId, ...(text(fields.responseId) ? { responseId: text(fields.responseId) } : {}),
    ...(text(fields.provider) ? { provider: text(fields.provider) } : {}), ...(text(fields.providerType) ? { providerType: text(fields.providerType) } : {}),
    ...(text(fields.model) ? { model: text(fields.model) } : {}), status: fields.status, origin: fields.origin === "telemetry" ? "telemetry" : "gateway",
    ...sessionField(fields), inputTokens: count(fields.inputTokens), cachedTokens: count(fields.cachedTokens), cacheWriteTokens: count(fields.cacheWriteTokens),
    outputTokens: count(fields.outputTokens), reasoningTokens: count(fields.reasoningTokens), nanoAiu,
    ...(fields.nanoAiuStatus && nanoStatuses.has(fields.nanoAiuStatus) ? { nanoAiuStatus: fields.nanoAiuStatus } : {}) };
  const empty = !row.inputTokens && !row.cachedTokens && !row.cacheWriteTokens && !row.outputTokens && !row.reasoningTokens && row.nanoAiu === null;
  return empty ? undefined : row;
}

async function appendLines(path: string, lines: string[]): Promise<void> {
  await appendFile(path, lines.join("\n") + "\n", { mode: 0o600 });
  if (!fileModes.has(path)) { fileModes.add(path); await chmod(path, 0o600); }
}
const append = (directory: string, row: LedgerRow) => appendLines(fileFor(directory, monthOf(row.at)), [JSON.stringify(row)]);

/** Request ids already in the ledger files, so a repeated import never writes a row twice. */
async function ledgerRequestIds(directory: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!/^usage-\d{4}-\d{2}\.jsonl$/.test(name)) continue;
    for (const line of (await readFile(join(directory, name), "utf8").catch(() => "")).split("\n")) {
      try { const id = (JSON.parse(line) as { requestId?: unknown }).requestId; if (typeof id === "string") ids.add(id); } catch { /* A torn line is skipped. */ }
    }
  }
  return ids;
}

async function prune(directory: string, now: Date): Promise<void> {
  const [year, month] = monthOf(now).split("-").map(Number); const total = year * 12 + (month - 1) - keepMonths;
  const oldest = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const found = /^usage-(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (found && found < oldest) { await rm(join(directory, name), { force: true }).catch(() => {}); fileModes.delete(join(directory, name)); }
  }
}

/**
 * Copies the last telemetry window once, so request history that predates the ledger survives telemetry
 * expiry. It skips every request this process records (they get a gateway row) and any request already
 * in the ledger, and writes all rows in one append per month, so a failed import repeats cleanly.
 */
async function importTelemetry(stateDirectory: string, directory: string, types: ReadonlyMap<string, string>): Promise<void> {
  const marker = join(directory, "telemetry-import.json");
  if (await readFile(marker, "utf8").then(() => true, () => false)) return;
  const known = await ledgerRequestIds(directory); const months = new Map<string, string[]>(); let rows = 0;
  for (const event of await readTelemetry(stateDirectory, 0)) {
    const status: LedgerStatus | undefined = event.event === "request_completed" ? "completed" : event.event === "request_empty" ? "empty" : event.event === "request_failed" ? "failed" : undefined;
    if (!status || typeof event.requestId !== "string" || recorded.has(event.requestId) || known.has(event.requestId) || !(count(event.inputTokens) > 0 || count(event.outputTokens) > 0)) continue;
    const provider = typeof event.provider === "string" ? event.provider : undefined; const providerType = provider ? types.get(provider) : undefined;
    const row = build({ requestId: event.requestId, provider, ...(providerType ? { providerType } : {}), model: typeof event.model === "string" ? event.model : undefined, status,
      origin: "telemetry", session: event.session === true, inputTokens: count(event.inputTokens), cachedTokens: count(event.cachedTokens), outputTokens: count(event.outputTokens),
      cacheWriteTokens: count(event.cacheWriteTokens), reasoningTokens: count(event.reasoningTokens),
      nanoAiu: typeof event.nanoAiu === "number" ? event.nanoAiu : null, nanoAiuStatus: typeof event.nanoAiuStatus === "string" ? event.nanoAiuStatus as NanoAiuStatus : undefined }, event.at, typeof event.host === "string" ? text(event.host) ?? "unknown" : "unknown");
    if (!row) continue;
    known.add(row.requestId); rows++;
    const month = monthOf(row.at); months.set(month, [...(months.get(month) || []), JSON.stringify(row)]);
  }
  for (const [month, lines] of months) await appendLines(fileFor(directory, month), lines);
  await writeFile(marker, JSON.stringify({ importedAt: new Date().toISOString(), rows }), { mode: 0o600 }); await chmod(marker, 0o600);
}

/**
 * Queues one row for a finished request. Never throws; a row with no usage is skipped.
 * `types` maps provider ids to their kind for the one-time telemetry import.
 */
export function recordUsage(stateDirectory: string, fields: UsageFields, now: Date = new Date(), types: ReadonlyMap<string, string> = new Map()): void {
  if (!usageLedgerEnabled()) return;
  const row = build({ ...fields, origin: "gateway" }, now.toISOString(), hostname().split(".")[0]); if (!row) return;
  // Marked now, not when the write runs: a request that finishes while the import reads telemetry is still excluded.
  remember(row.requestId);
  const directory = join(stateDirectory, "usage"); const month = monthOf(now);
  writes = writes.then(async () => {
    let ready = prepared.get(directory);
    if (!ready) {
      ready = mkdir(directory, { recursive: true, mode: 0o700 }).then(() => chmod(directory, 0o700)).then(() => importTelemetry(stateDirectory, directory, types));
      prepared.set(directory, ready);
    }
    await ready.catch(() => { prepared.delete(directory); });
    if (lastMonth.get(directory) !== month) { lastMonth.set(directory, month); await prune(directory, now); }
    await append(directory, row);
  }).catch(() => {});
}

/** Waits for queued writes; tests and short-lived commands call this before exiting. */
export async function flushUsageLedger(): Promise<void> { await writes; }

/** Writes the telemetry and the ledger rows still queued; a process calls this just before it exits, whichever of the two fails. */
export async function flushRecords(): Promise<void> { await Promise.allSettled([flushTelemetry(), flushUsageLedger()]); }

/** Forgets per-process directory state; tests use it to start from a clean process view. */
export function resetUsageLedger(): void { prepared.clear(); lastMonth.clear(); fileModes.clear(); recorded.clear(); }

/** Reads rows at or after `sinceMs`, keeping only the documented fields. One row per request id; the gateway's own row wins over an imported one. */
export async function readUsageLedger(stateDirectory: string, sinceMs: number): Promise<LedgerRow[]> {
  const directory = join(stateDirectory, "usage"); const since = monthOf(new Date(sinceMs)); const rows = new Map<string, LedgerRow>();
  for (const name of (await readdir(directory).catch(() => [] as string[])).sort()) {
    const month = /^usage-(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1]; if (!month || month < since) continue;
    for (const line of (await readFile(join(directory, name), "utf8").catch(() => "")).split("\n")) {
      if (!line) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>; if (raw.v !== 1 || typeof raw.at !== "string" || Date.parse(raw.at) < sinceMs) continue;
        const kept = Object.fromEntries(Object.entries(raw).filter(([key]) => ledgerFields.has(key)));
        const row = build({ ...(kept as unknown as UsageFields), origin: raw.origin === "telemetry" ? "telemetry" : "gateway" }, raw.at, typeof raw.host === "string" ? raw.host : "unknown");
        const earlier = row ? rows.get(row.requestId) : undefined;
        if (row && (!earlier || (earlier.origin === "telemetry" && row.origin === "gateway"))) rows.set(row.requestId, row);
      } catch { /* A torn line is skipped. */ }
    }
  }
  return [...rows.values()];
}
