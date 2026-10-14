import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureTelemetry, flushTelemetry, readTelemetry, telemetry, telemetryFields } from "../telemetry.js";
import { TurnTelemetry, errorClass } from "../turn-telemetry.js";
import { summarizeTelemetry } from "../diagnostics.js";

test("telemetry fields drop secret-shaped keys, objects and unsafe text", () => {
  const fields = telemetryFields({ model: "claude/opus", accessToken: "abc", cachedTokens: 5, refreshTokens: "secret", prompt: "hi", requestBody: "x", toolArguments: "{}", nested: { a: 1 }, durationMs: 12.3456,
    reason: "This model is absent; select <script> one", path: "/Users/someone/Projects/private-thing/file.txt", ok: true });
  assert.deepEqual(Object.keys(fields).sort(), ["cachedTokens", "durationMs", "model", "ok", "path", "reason"]);
  assert.equal(fields.reason, "This model is absent_ select _script_ one");
  assert.equal(fields.path, ".../file.txt");
  assert.equal(fields.durationMs, 12.346);
});

test("billing fields pass the telemetry filter while look-alike fields do not", () => {
  const fields = telemetryFields({ providerType: "copilot-subscription", cacheWriteTokens: 10, reasoningTokens: 3, nanoAiu: 2e9, nanoAiuStatus: "partial", promptTokens: "x", authToken: 5 });
  assert.deepEqual(fields, { providerType: "copilot-subscription", cacheWriteTokens: 10, reasoningTokens: 3, nanoAiu: 2e9, nanoAiuStatus: "partial" });
});

test("diagnostics sum Copilot credits per model", () => {
  const at = new Date().toISOString(); const base = { at, host: "mac", component: "gateway", pid: 1, model: "copilot/x" };
  const summary = summarizeTelemetry([{ ...base, event: "request_completed", nanoAiu: 2.5e9 }, { ...base, event: "request_failed", code: "x", nanoAiu: 1e9 }], new Date(0)) as { requests: Record<string, { credits?: number }> };
  assert.equal(summary.requests["copilot/x"].credits, 3.5);
});

test("events persist privately per day and turn telemetry flags silent completions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-telemetry-"));
  try {
    configureTelemetry(directory, "adapter");
    const turns = new TurnTelemetry(() => ({ provider: "gateway", model: "claude/opus" }));
    const turn = (id: string, status: string, items: string[]) => {
      turns.observe({ method: "turn/started", params: { threadId: "t", turn: { id } } });
      for (const type of items) turns.observe({ method: "item/completed", params: { threadId: "t", turnId: id, item: { type } } });
      turns.observe({ method: "turn/completed", params: { threadId: "t", turn: { id, status, ...(status === "failed" ? { error: { message: "stream disconnected before completion: Provider stream ended without completion" } } : {}) } } });
    };
    turn("a", "completed", ["reasoning", "agentMessage"]);
    turn("b", "completed", ["reasoning"]);
    turn("c", "failed", ["commandExecution"]);
    turns.close(); telemetry("request_failed", { model: "claude/opus", code: "upstream_unavailable", inputTokens: 100, cachedTokens: 90 });
    await flushTelemetry();
    const files = await readdir(join(directory, "telemetry")); assert.equal(files.length, 1); assert.match(files[0], /^events-\d{4}-\d{2}-\d{2}\.jsonl$/);
    assert.ok(!(await readFile(join(directory, "telemetry", files[0]), "utf8")).includes("stream disconnected"), "error text is classified, never stored");
    const events = await readTelemetry(directory, Date.now() - 60000);
    assert.deepEqual(events.map(event => event.event), ["turn_started", "turn_completed", "turn_started", "turn_empty_completion", "turn_started", "turn_completed", "request_failed"]);
    const summary = summarizeTelemetry(events, new Date(Date.now() - 60000)) as { turns: Record<string, Record<string, number>>; turnFailures: Record<string, number>; requests: Record<string, Record<string, unknown>>; recentProblems: unknown[] };
    assert.deepEqual(summary.turns["gateway claude/opus"], { started: 3, completed: 1, empty: 1, failed: 1 });
    assert.deepEqual(summary.turnFailures, { stream_disconnected: 1 });
    assert.equal(summary.requests["claude/opus"].cacheHit, "90%");
    assert.equal(summary.recentProblems.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("error classes cover the failures seen in the field", () => {
  assert.equal(errorClass("stream disconnected before completion: Provider stream ended without completion"), "stream_disconnected");
  assert.equal(errorClass("idle timeout waiting for SSE"), "idle_timeout");
  assert.equal(errorClass("Claude usage limit reached; resets at 5pm"), "usage_limit");
  assert.equal(errorClass(undefined), "none");
  assert.equal(errorClass("local queued attachment is invalid: Operation not permitted (os error 1)"), "attachment");
  assert.equal(errorClass("HTTP 503 from upstream"), "overloaded");
  // Digits inside a thread id are not a status code.
  assert.equal(errorClass("thread not loaded: 01a135fc-36e4-7c91-8e25-263539a552bd"), "other");
});
