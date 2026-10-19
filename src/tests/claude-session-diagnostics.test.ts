import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTelemetry } from "../diagnostics.js";
import { telemetryFields } from "../telemetry.js";
import type { TelemetryEvent } from "../telemetry.js";

const event = (name: string, fields: Record<string, string | number | boolean | undefined> = {}): TelemetryEvent => ({ at: new Date().toISOString(), host: "mac", component: "test", pid: 1, event: name, ...fields });

test("the telemetry field filter keeps the Claude session identifiers", () => {
  // Ids and numbers only: a thread's hashed key prefix and a boolean, never a body, token or name.
  const fields = telemetryFields({ event: "claude_session", threadKey: "ab12cd34", missReason: "warmup", systemPrefixOnly: true, afterWarmup: true, cacheReadTokens: 32035, liveSessions: 2 });
  assert.deepEqual(fields, { event: "claude_session", threadKey: "ab12cd34", missReason: "warmup", systemPrefixOnly: true, afterWarmup: true, cacheReadTokens: 32035, liveSessions: 2 });
});

test("diagnostics summarize live Claude sessions by outcome and miss reason, with cache tokens", () => {
  const summary = summarizeTelemetry([
    event("claude_session", { outcome: "spawned", threadKey: "ab12cd34", cacheReadTokens: 0, cacheWriteTokens: 900, systemPrefixOnly: true }),
    event("claude_session", { outcome: "continued", cacheReadTokens: 900, cacheWriteTokens: 40 }),
    event("claude_session", { outcome: "continued", cacheReadTokens: 940, cacheWriteTokens: 12 }),
    event("claude_session", { outcome: "reseeded", missReason: "prefix_diverged", divergedAt: 3, cacheReadTokens: 200, cacheWriteTokens: 700 }),
    event("claude_session", { outcome: "fallback", missReason: "capacity" }),
    event("claude_cli", { result: "none", aborted: true, interrupted: true }),
    event("account_route_fallback", { reason: "not_logged_in" }), event("account_route_fallback", { reason: "not_logged_in" }), event("account_engine_started"),
  ], new Date(Date.now() - 60000)) as Record<string, Record<string, unknown>>;
  assert.deepEqual(summary.claudeSessions, {
    spawned: { count: 1, rewrites: 1, cacheReadTokens: 0, cacheWriteTokens: 900 },
    continued: { count: 2, rewrites: 0, cacheReadTokens: 1840, cacheWriteTokens: 52 },
    "reseeded:prefix_diverged": { count: 1, rewrites: 0, cacheReadTokens: 200, cacheWriteTokens: 700 },
    "fallback:capacity": { count: 1, rewrites: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });

  assert.deepEqual(summary.accountEngines, { "account_route_fallback:not_logged_in": 2, account_engine_started: 1 });
  assert.deepEqual(summary.claudeCli, { interrupted: 1 });
});
