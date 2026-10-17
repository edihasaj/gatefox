import type { TelemetryEvent } from "./telemetry.js";

const problems = new Set(["turn_error", "turn_empty_completion", "turn_quiet", "request_failed", "request_empty", "rpc_error", "component_exit",
  "execution_host_failed", "adapter_start_failed", "claude_cli_failed"]);
type Counts = Record<string, number>;
const bump = (counts: Counts, key: unknown) => { const name = String(key ?? "unknown"); counts[name] = (counts[name] || 0) + 1; };
const accountEvents = new Set(["account_engine_started", "account_engine_failed", "account_route_refused", "account_route_fallback", "account_usage_merged"]);
const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
const percentile = (values: number[], p: number) => { if (!values.length) return undefined; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]; };

/** Aggregates local telemetry into counts per model and a short list of recent problems. */
export function summarizeTelemetry(events: TelemetryEvent[], since: Date): Record<string, unknown> {
  const turns: Record<string, Counts> = {}; const turnFailures: Counts = {};
  const requests: Record<string, Counts & { input?: number; cached?: number; nano?: number }> = {}; const firstEvent: Record<string, number[]> = {};
  const retries: Counts = {}; const rpcErrors: Counts = {}; const components: Counts = {}; const host: Counts = {}; const claude: Counts = {};
  const sessions: Record<string, { count: number; rewrites: number; cacheReadTokens: number; cacheWriteTokens: number }> = {}; const accounts: Counts = {};
  const recent: Array<Record<string, unknown>> = [];
  // Every Auto-review request from a gateway executor (node_repl, shell, apply_patch, network, MCP, permissions).
  const autoReview: Counts = {};
  for (const event of events) {
    const model = String(event.model ?? "unknown");
    if (event.event.startsWith("turn_")) {
      const key = `${event.provider ?? "unknown"} ${model}`; turns[key] ||= {};
      if (event.event === "turn_completed" || event.event === "turn_empty_completion") bump(turns[key], event.event === "turn_empty_completion" ? "empty" : event.status);
      else if (event.event === "turn_started") bump(turns[key], "started");
      else if (event.event === "turn_quiet") bump(turns[key], "quiet");
      if (event.event === "turn_error" || (event.event === "turn_completed" && event.status === "failed")) bump(turnFailures, `${event.errorInfo ?? event.errorClass ?? "unknown"}${event.willRetry ? " (retrying)" : ""}`);
    }
    if (event.event.startsWith("request_")) {
      const entry = requests[model] ||= {};
      // Translation failures also carry their fixed reason, so a 400 is separable per model. A gateway-rule refusal
      // (remote compaction) names itself in `translation_reason` instead.
      const why = event.reason ?? event.translation_reason;
      bump(entry, event.event === "request_failed" ? `failed:${event.code}${why ? ":" + why : ""}` : event.event.slice(8));
      // Auto-review requests, of any kind, counted apart from chat requests.
      if (event.autoReview === true) bump(autoReview, event.event === "request_failed" ? `failed:${event.code}` : event.event.slice(8));
      if (typeof event.inputTokens === "number") entry.input = (entry.input || 0) + event.inputTokens;
      if (typeof event.cachedTokens === "number") entry.cached = (entry.cached || 0) + event.cachedTokens;
      if (typeof event.nanoAiu === "number" && Number.isFinite(event.nanoAiu)) entry.nano = (entry.nano || 0) + event.nanoAiu;
      if (typeof event.firstEventMs === "number") (firstEvent[model] ||= []).push(event.firstEventMs);
    }
    if (event.event === "provider_retry") bump(retries, event.upstreamCode ?? event.code);
    if (event.event === "rpc_error") bump(rpcErrors, `${event.method} ${event.code} ${event.reason ?? (event.rejection && event.rejection !== "other" ? event.rejection : event.errorClass) ?? ""}`.trim());
    if (event.event === "component_exit") bump(components, `${event.component} exit ${event.code}`);
    if (event.event.startsWith("execution_host_") || event.event === "native_acquire") bump(host, `${event.event}${event.outcome ? ":" + event.outcome : ""}`);
    if (event.event === "claude_cli") bump(claude, event.isError ? `error:${event.result}` : event.interrupted ? "interrupted" : event.aborted ? "aborted" : event.result);
    // Live Claude sessions: how requests were served and what each outcome cost in cache tokens.
    if (event.event === "claude_session") {
      const entry = sessions[`${event.outcome ?? "unknown"}${event.missReason ? ":" + event.missReason : ""}`] ||= { count: 0, rewrites: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      entry.count++; entry.rewrites += event.systemPrefixOnly === true ? 1 : 0;
      entry.cacheReadTokens += tokens(event.cacheReadTokens); entry.cacheWriteTokens += tokens(event.cacheWriteTokens);
    }
    if (accountEvents.has(event.event)) bump(accounts, `${event.event}${event.reason ? ":" + event.reason : ""}`);
    if (problems.has(event.event) && !(event.event === "request_failed" && event.code === "cancelled")) {
      const { at, host: machine, component, event: name, pid: _pid, ...fields } = event;
      recent.push({ at, machine, component, event: name, ...fields }); if (recent.length > 25) recent.shift();
    }
  }
  const requestSummary = Object.fromEntries(Object.entries(requests).map(([model, entry]) => {
    const { input, cached, nano, ...counts } = entry;
    return [model, { ...counts, ...(nano === undefined ? {} : { credits: Math.round(nano / 1e6) / 1000 }), cacheHit: input ? `${Math.round(100 * (cached || 0) / input)}%` : undefined,
      firstEventMsP50: percentile(firstEvent[model] || [], 0.5), firstEventMsP95: percentile(firstEvent[model] || [], 0.95) }];
  }));
  return { since: since.toISOString(), events: events.length, machines: [...new Set(events.map(event => event.host))],
    turns, turnFailures, requests: requestSummary, autoReview, providerRetries: retries, rpcErrors, componentExits: components, executionHost: host, claudeCli: claude,
    claudeSessions: sessions, accountEngines: accounts, recentProblems: recent };
}
