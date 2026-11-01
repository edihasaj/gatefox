import { hostname } from "node:os";
import { readTelemetry, type TelemetryEvent } from "./telemetry.js";

export interface CacheDiagnostic {
  requests: number; failed: number; usageSamples: number; cacheSamples: number; cacheWriteSamples: number;
  inputTokens: number; cachedTokens: number; cacheInputTokens: number; cacheWriteTokens: number; outputTokens: number;
  cacheHitPercent?: number;
}
export interface SessionDiagnostic { count: number; failed: number; cacheReadTokens: number; cacheWriteTokens: number; cacheReadSamples: number; cacheWriteSamples: number }
export interface DiagnosticIssue { at: string; event: string; code: string; model?: string; provider?: string; retrying: boolean }
export interface DiagnosticsReport {
  version: 1; hostname: string; checkedAt: string; since: string; hours: number;
  models: Array<CacheDiagnostic & { model: string }>;
  sessions: Array<SessionDiagnostic & { outcome: string }>;
  issues: DiagnosticIssue[]; hasMoreModels: boolean; hasMoreIssues: boolean;
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const label = (value: unknown): string | undefined => typeof value === "string" && /^[a-z0-9][a-z0-9/._: ()-]{0,127}$/i.test(value) ? value : undefined;
const operational = new Set(["request_failed", "request_empty", "turn_error", "provider_retry", "engine_exit", "execution_host_control_lost", "execution_host_failed", "execution_host_unhealthy"]);

/** Report only observed counts. Missing cache usage is different from a measured zero. */
export function diagnosticDetails(events: TelemetryEvent[]): {
  cacheUsage: Record<string, CacheDiagnostic>; copilotSessions: Record<string, SessionDiagnostic>; issues: DiagnosticIssue[]; issueCount: number;
} {
  const cacheUsage: Record<string, CacheDiagnostic> = Object.create(null);
  const copilotSessions: Record<string, SessionDiagnostic> = Object.create(null);
  const issues: DiagnosticIssue[] = []; let issueCount = 0;
  for (const event of events) {
    if (["request_completed", "request_failed", "request_empty"].includes(event.event)) {
      const model = label(event.model) ?? "unknown";
      const row = cacheUsage[model] ??= { requests: 0, failed: 0, usageSamples: 0, cacheSamples: 0, cacheWriteSamples: 0,
        inputTokens: 0, cachedTokens: 0, cacheInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
      row.requests++; if (event.event === "request_failed") row.failed++;
      if (count(event.inputTokens)) { row.inputTokens += event.inputTokens; row.usageSamples++; }
      if (count(event.inputTokens) && count(event.cachedTokens) && event.cachedTokens <= event.inputTokens) {
        row.cacheSamples++; row.cachedTokens += event.cachedTokens; row.cacheInputTokens += event.inputTokens;
      }
      if (count(event.cacheWriteTokens)) { row.cacheWriteSamples++; row.cacheWriteTokens += event.cacheWriteTokens; }
      if (count(event.outputTokens)) row.outputTokens += event.outputTokens;
    }
    if (event.event === "copilot_session") {
      const key = `${label(event.outcome) ?? "unknown"}${label(event.missReason) ? ":" + event.missReason : ""}`;
      const row = copilotSessions[key] ??= { count: 0, failed: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheReadSamples: 0, cacheWriteSamples: 0 };
      row.count++; if (event.failed === true) row.failed++;
      if (count(event.cacheReadTokens)) { row.cacheReadTokens += event.cacheReadTokens; row.cacheReadSamples++; }
      if (count(event.cacheWriteTokens)) { row.cacheWriteTokens += event.cacheWriteTokens; row.cacheWriteSamples++; }
    }
    const sessionFailure = ["copilot_session", "claude_session", "grok_cli"].includes(event.event) && ["crashed", "fallback", "blocked", "preserved"].includes(String(event.outcome));
    const transportFailure = event.event === "unix_session_end" && event.cause === "transport_closed";
    if ((!operational.has(event.event) && !sessionFailure && !transportFailure)
      || (event.event === "request_failed" && event.code === "cancelled")) continue;
    const at = Date.parse(event.at); if (!Number.isFinite(at)) continue;
    issues.push({ at: new Date(at).toISOString(), event: event.event,
      code: label(event.upstreamCode) ?? label(event.missReason) ?? label(event.code) ?? label(event.errorInfo) ?? label(event.reason) ?? label(event.cause) ?? event.event,
      ...(label(event.model) ? { model: label(event.model) } : {}), ...(label(event.provider) ? { provider: label(event.provider) } : {}),
      retrying: event.willRetry === true || event.event === "provider_retry" });
    issueCount++;
  }
  for (const row of Object.values(cacheUsage)) {
    if (row.cacheSamples > 0 && row.cacheInputTokens > 0) row.cacheHitPercent = Math.round(1000 * row.cachedTokens / row.cacheInputTokens) / 10;
  }
  issues.sort((a, b) => b.at.localeCompare(a.at));
  return { cacheUsage, copilotSessions, issues: issues.slice(0, 50), issueCount };
}

/** Local telemetry only: this operation never starts inference or changes a connection. */
export async function readDiagnostics(stateDirectory: string, hours = 1, now = Date.now()): Promise<DiagnosticsReport> {
  const since = new Date(now - hours * 3600000);
  const events = await readTelemetry(stateDirectory, since.getTime());
  const details = diagnosticDetails(events);
  const models = Object.entries(details.cacheUsage).sort(([a], [b]) => a.localeCompare(b));
  return { version: 1, hostname: hostname().split(".")[0], checkedAt: new Date(now).toISOString(), since: since.toISOString(), hours,
    models: models.slice(0, 64).map(([model, row]) => ({ model, ...row })),
    sessions: Object.entries(details.copilotSessions).map(([outcome, row]) => ({ outcome, ...row })).slice(0, 64),
    issues: details.issues, hasMoreModels: models.length > 64, hasMoreIssues: details.issueCount > 50 };
}
