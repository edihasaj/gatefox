import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apiCacheTrace } from "../providers/api-cache-trace.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

test("cold-cache diagnostics identify changed prefixes without storing content, identities or digests", async t => {
  const root = await mkdtemp(join(tmpdir(), "cache-trace-")); configureTelemetry(root, "test");
  let now = Date.now(); const since = now; t.mock.method(Date, "now", () => now);
  const secret = "private-prompt-tool-value-never-in-telemetry";
  const request = { model: "fixture", instructions: secret, input: secret, tools: [] };
  const context = { threadId: "private-thread-never-logged" };
  const cold = { input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 0 } };
  const one = apiCacheTrace("trace-fixture", "fixture", request, context, "private-affinity-never-logged");
  now += 20 * 60_000; one.record(cold); now += 2000;
  apiCacheTrace("trace-fixture", "fixture", request, context, "private-affinity-never-logged").record(cold);
  apiCacheTrace("trace-fixture", "fixture", { ...request, instructions: "new instruction" }, context, "changed-affinity").record(cold);
  await flushTelemetry(); const events = (await readTelemetry(root, since)).filter(row => row.event === "api_cache_cold");
  assert.equal(events.length, 3); assert.equal(events[0].previousMeasured, false);
  assert.equal(events[1].idleSeconds, 2, "long inference is not reported as idle");
  assert.equal(events[1].catalogChanged, false); assert.equal(events[1].instructionsChanged, false); assert.equal(events[1].openingChanged, false); assert.equal(events[1].affinityChanged, false);
  assert.equal(events[2].instructionsChanged, true); assert.equal(events[2].affinityChanged, true);
  const logged = JSON.stringify(events);
  for (const value of [secret, context.threadId, "private-affinity-never-logged", "changed-affinity"]) assert.ok(!logged.includes(value));
  assert.ok(!/[a-f0-9]{64}/.test(logged), "prefix digests stay only in process memory");
});

test("anonymous, unknown-usage and warm requests do not manufacture cold-cache incidents", async () => {
  const root = await mkdtemp(join(tmpdir(), "cache-trace-empty-")); configureTelemetry(root, "test");
  const request = { model: "fixture", input: "synthetic" };
  const cold = { input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 0 } };
  apiCacheTrace("trace-anonymous", "fixture", request, {}).record(cold);
  apiCacheTrace("trace-unknown", "fixture", request, { threadId: "unknown" }).record({ input_tokens: 200000, output_tokens: 1, total_tokens: 200001 });
  apiCacheTrace("trace-warm", "fixture", request, { threadId: "warm" }).record({ ...cold, input_tokens_details: { cached_tokens: 199000 } });
  await flushTelemetry(); assert.equal((await readTelemetry(root, 0)).filter(row => row.event === "api_cache_cold").length, 0);
});
