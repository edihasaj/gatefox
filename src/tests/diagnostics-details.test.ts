import assert from "node:assert/strict";
import test from "node:test";
import { diagnosticDetails } from "../diagnostics-details.js";
import { summarizeTelemetry } from "../diagnostics.js";
import type { TelemetryEvent } from "../telemetry.js";
import { CopilotTurn, nativeCopilotCalls } from "../providers/copilot-turn.js";
import { nativeCatalog } from "../providers/copilot-render.js";
import { ProviderError } from "../providers/provider.js";
import { providerFailureDiagnostic } from "../provider-failure.js";
import { ClaudeMessageStream } from "../providers/claude-stream.js";
import { grokUsage } from "../providers/grok-stream.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";

const base = { at: "2026-10-27T12:00:00.000Z", host: "test", component: "server", pid: 1, model: "copilot/sonnet" };
const event = (fields: Record<string, string | number | boolean>): TelemetryEvent => ({ ...base, event: "request_completed", ...fields });

test("cache percentages use only reported pairs and include failed-request usage", () => {
  const events = [event({ inputTokens: 100, cachedTokens: 80, cacheWriteTokens: 20 }),
    event({ event: "request_failed", code: "invalid_tool_call", inputTokens: 100, cachedTokens: 0, cacheWriteTokens: 100 }),
    event({ inputTokens: 1000 }), event({})];
  const row = diagnosticDetails(events).cacheUsage[base.model];
  assert.deepEqual(row, { requests: 4, failed: 1, usageSamples: 3, cacheSamples: 2, cacheWriteSamples: 2,
    inputTokens: 1200, cachedTokens: 80, cacheInputTokens: 200, cacheWriteTokens: 120, outputTokens: 0, cacheHitPercent: 40 });
  const summary = summarizeTelemetry(events, new Date(0)) as { requests: Record<string, { cacheHit: string }> };
  assert.equal(summary.requests[base.model].cacheHit, "40%");
});

test("missing, invalid, and measured-zero cache use are distinct", () => {
  assert.equal(diagnosticDetails([event({ inputTokens: 100 })]).cacheUsage[base.model].cacheHitPercent, undefined);
  const invalid = diagnosticDetails([event({ inputTokens: 100, cachedTokens: 200 }), event({ inputTokens: -1, cachedTokens: 0 })]).cacheUsage[base.model];
  assert.equal(invalid.cacheSamples, 0);
  const zero = diagnosticDetails([event({ inputTokens: 100, cachedTokens: 0 })]).cacheUsage[base.model];
  assert.equal(zero.cacheSamples, 1); assert.equal(zero.cacheHitPercent, 0);
});

test("Copilot preserves missing cache reports through normalization, including mixed model calls", () => {
  const turn = () => new CopilotTurn({ model: "test", offered: ["test"], tools: [], choice: undefined, summary: "none" });
  const missing = turn();
  missing.accept({ type: "assistant.usage", data: { isByok: false, inputTokens: 100, outputTokens: 10 } });
  const first = missing.done(); assert.ok(first.type === "done");
  assert.equal(first.usage.input_tokens_details, undefined);
  assert.equal(first.accounting?.cacheWriteTokens, undefined);
  const mixed = turn();
  mixed.accept({ type: "assistant.usage", data: { isByok: false, inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 10 } });
  mixed.accept({ type: "assistant.usage", data: { isByok: false, inputTokens: 100, outputTokens: 10 } });
  const second = mixed.done(); assert.ok(second.type === "done");
  assert.equal(second.usage.input_tokens, 200);
  assert.equal(second.usage.input_tokens_details, undefined);
  assert.equal(second.accounting?.cacheWriteTokens, undefined);
  const zero = turn();
  zero.accept({ type: "assistant.usage", data: { isByok: false, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  const third = zero.done(); assert.ok(third.type === "done");
  assert.equal(third.usage.input_tokens_details?.cached_tokens, 0);
  assert.equal(third.accounting?.cacheWriteTokens, 0);
});

test("Claude requires all native input components for a cache percentage; Grok preserves gross input", () => {
  const usage = (native: Record<string, number>) => new ClaudeMessageStream({ tools: [], summaryVisible: false })
    .accept({ type: "result", subtype: "success", is_error: false, result: "ok", usage: native }).end!.usage;
  assert.equal(usage({ input_tokens: 100, output_tokens: 10 }).input_tokens_details, undefined);
  assert.equal(usage({ input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10 }).input_tokens_details, undefined);
  assert.equal(usage({ input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 }).input_tokens_details?.cached_tokens, 0);
  assert.equal(grokUsage({ input: 100, output: 10 }).input_tokens_details, undefined);
  assert.equal(grokUsage({ input: 100, cacheRead: 0, output: 10 }).input_tokens_details?.cached_tokens, 0);
  assert.equal(grokUsage({ input: 100, cacheRead: 80, output: 10 }).input_tokens, 100);
});

test("Anthropic explicit zero survives the adapter and incomplete cache components stay unreported", async t => {
  const key = "GATEWAY_DIAGNOSTICS_API_FIXTURE"; const before = process.env[key]; process.env[key] = "fixture";
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  let next: Record<string, number> = {};
  t.mock.method(globalThis, "fetch", async () => new Response([
    { type: "message_start", message: { usage: next } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("")));
  const adapter = new AnthropicAPI({ id: "fixture", type: "anthropic-api", baseUrl: "http://127.0.0.1:4000", apiKeyEnv: key, models: { alias: "fixture" } });
  for (const reported of [false, true]) {
    next = { input_tokens: 100, ...(reported ? { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } : {}) };
    for await (const item of adapter.infer({ model: "fixture", input: "hello" }, new AbortController().signal)) {
      if (item.type !== "done") continue;
      assert.equal(item.usage.input_tokens_details?.cached_tokens, reported ? 0 : undefined);
      assert.equal(item.accounting?.cacheWriteTokens, reported ? 0 : undefined);
    }
  }
});

test("Copilot reuse, rebuild reasons, and precise failures survive summary without raw content", () => {
  const details = diagnosticDetails([
    event({ event: "copilot_session", outcome: "continued", cacheReadTokens: 90, cacheWriteTokens: 10 }),
    event({ event: "copilot_session", outcome: "reseeded", missReason: "unexpected_tail", failed: true }),
    event({ event: "request_failed", code: "invalid_tool_call", upstreamCode: "duplicate_tool_id", message: "PRIVATE_SENTINEL", arguments: "PRIVATE_SENTINEL" }),
    event({ event: "turn_error", errorInfo: "responseStreamDisconnected", willRetry: true }),
    event({ event: "rpc_error", method: "fs/getMetadata", code: -32603 }),
  ]);
  assert.equal(details.copilotSessions.continued.cacheReadTokens, 90);
  assert.equal(details.copilotSessions.continued.cacheReadSamples, 1);
  assert.equal(details.copilotSessions["reseeded:unexpected_tail"].cacheReadSamples, 0);
  assert.equal(details.copilotSessions["reseeded:unexpected_tail"].count, 1);
  assert.equal(details.issues.find(row => row.event === "request_failed")?.code, "duplicate_tool_id");
  assert.equal(details.issues.find(row => row.event === "turn_error")?.retrying, true);
  assert.equal(details.issues.length, 2);
  assert.equal(JSON.stringify(details).includes("PRIVATE_SENTINEL"), false);
});

test("recent operational issues stay bounded and newest first", () => {
  const events = Array.from({ length: 70 }, (_, n) => event({ event: "request_failed", code: "cli_failed", at: new Date(Date.UTC(2026, 9, 27, 0, n)).toISOString() }));
  const details = diagnosticDetails(events);
  assert.equal(details.issueCount, 70); assert.equal(details.issues.length, 50);
  assert.equal(details.issues[0].at, events[69].at);
});

test("Copilot tool validation records fixed structural reasons without identities or values", () => {
  const tools = [{ type: "function" as const, function: { name: "probe" } }];
  const call = { name: nativeCatalog(tools)[0].name, type: "function", toolCallId: "call", arguments: {} };
  for (const [calls, code] of [
    [[{ ...call, name: "PRIVATE_SENTINEL" }], "unknown_tool"],
    [[call, call], "duplicate_tool_id"],
    [[{ ...call, type: "other" }], "malformed_tool_call"],
    [[{ ...call, arguments: "PRIVATE_SENTINEL" }], "invalid_tool_arguments"],
  ] as const) {
    assert.throws(() => nativeCopilotCalls(calls, tools), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.upstream?.code, code);
      const diagnostic = providerFailureDiagnostic({ requestId: "00000000-0000-0000-0000-000000000001", durationMs: 1, failure: error });
      assert.equal(diagnostic.upstreamCode, code);
      assert.equal(diagnostic.upstreamEvent, "copilot.tool_use");
      assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_SENTINEL"), false);
      return true;
    });
  }
});
