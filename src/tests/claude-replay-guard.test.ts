import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../providers/provider.js";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { configureTelemetry, flushTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import { ResponsesWriter } from "../protocol/responses.js";
import type { ResponsesInputItem } from "../protocol/types.js";
import { cacheGuardedInference } from "../cache-guarded-inference.js";

test("large cache misses stop before the third CLI and client compaction can recover", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: [{ text: "one" }, { text: "two" }, { text: "compact" }, { text: "recovered" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `replay-guard-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "replay" } });
  const turn = async (text: string, requestKind?: "compaction") => {
    for await (const _ of provider.infer({ model: "fixture", input: text }, new AbortController().signal, { threadId: "large", requestKind })) { /* Drain completed usage. */ }
  };
  const starts = async () => (await fixture.capture()).filter(entry => entry.start).length;
  try {
    await turn("a".repeat(400000)); await turn("b".repeat(400000));
    assert.equal(await starts(), 2);
    await assert.rejects(turn("c".repeat(400000)), { code: "invalid_request", status: 400 });
    assert.equal(await starts(), 2, "the rejected request spent no inference and spawned no CLI");
    await turn("c".repeat(400000), "compaction");
    await turn("Short client-compacted history");
    assert.equal(await starts(), 4, "compaction remains possible and its smaller history clears the guard");
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore();
  }
});

test("repeated cold live reseeds stop without falling back to a paid one-shot", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: [
    { calls: [{ tool: "read", input: {} }] }, { calls: [{ tool: "read", input: {} }] },
  ] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `seed-guard-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[], windowId: string) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }] }, new AbortController().signal, { threadId: "reseed", windowId })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  const append = (input: ResponsesInputItem[], output: ResponsesInputItem[]): ResponsesInputItem[] => [...input, ...output,
    ...output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "result" }] : []),
    { type: "message", role: "developer", content: "New caller instructions" }];
  try {
    const first: ResponsesInputItem[] = [{ type: "message", role: "user", content: "a".repeat(400000) }];
    const a = await turn(first, "before"); const second = append(first, a); const b = await turn(second, "after");
    const [kept] = claudeLive({ max: 6, parkMinutes: 60 }).sessions();
    assert.ok(kept);
    const pending = [...kept.pending];
    await assert.rejects(turn(append(second, b), "another"), { code: "invalid_request", status: 400 });
    assert.deepEqual((await fixture.capture()).flatMap(entry => entry.start ? [entry.start] : []), ["live", "live"]);
    assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0], kept, "the cache guard refuses before discarding the live session");
    assert.equal(kept.state, "awaiting_outputs");
    assert.deepEqual(kept.pending, pending, "pending relay calls remain available");
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore();
  }
});

for (const mode of ["replay", "live"] as const) test(`measured cache writes from rejected tools still stop repeated ${mode} failures`, { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: [{ foreign: "Bash" }, { foreign: "Bash" }, { foreign: "Bash" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `failure-guard-${mode}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode, warmup: 0 } });
  const turn = async (text: string) => {
    for await (const _ of provider.infer({ model: "fixture", input: text }, new AbortController().signal, { threadId: "failed" })) { /* Drain the original failure. */ }
  };
  try {
    await assert.rejects(turn("a".repeat(400000)), { code: "invalid_tool_call" });
    // Replay pays for a second CLI before the stop; a live thread whose session died is refused at once, without any second CLI.
    if (mode === "replay") await assert.rejects(turn("b".repeat(400000)), { code: "invalid_tool_call" });
    else await assert.rejects(turn("b".repeat(400000)), (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    await assert.rejects(turn("c".repeat(400000)), { code: "invalid_request", status: 400 });
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, mode === "replay" ? 2 : 1, "a charged failure cannot bypass the stop");
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore();
  }
});

test("compacted conversation recovery is independent of large fixed instructions", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: [{ text: "one" }, { text: "two" }, { text: "recovered" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `fixed-prefix-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "replay" } });
  const turn = async (text: string) => {
    for await (const _ of provider.infer({ model: "fixture", input: text, instructions: "Fixed instructions".repeat(100000) }, new AbortController().signal, { threadId: "fixed" })) {}
  };
  try {
    await turn("a".repeat(400000)); await turn("b".repeat(400000));
    await turn("Small compacted history");
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 3);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore();
  }
});

for (const mode of ["replay", "live"] as const) test(`cancelled charged requests cannot bypass the ${mode} cache guard`, { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: [{ text: "visible", slow: true }, { text: "visible", slow: true }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `cancel-guard-${mode}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode, warmup: 0 } });
  const turn = async (text: string) => {
    const controller = new AbortController();
    // Explicit client window changes permit replacement histories; cancellation
    // accounting must still stop the third charged seed and retain the second CLI.
    for await (const event of provider.infer({ model: "fixture", input: text }, controller.signal, { threadId: "cancelled", windowId: text[0] })) {
      if (event.type === "text") controller.abort();
    }
  };
  try {
    await assert.rejects(turn("a".repeat(400000)), { code: "cancelled" });
    await assert.rejects(turn("b".repeat(400000)), { code: "cancelled" });
    await assert.rejects(turn("c".repeat(400000)), { code: "invalid_request", status: 400 });
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 2, "interrupt accounting is recorded once and remains enforced");
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore();
  }
});

for (const cancelled of [false, true]) test(`charged Claude compaction ${cancelled ? "cancellations" : "failures"} have a bounded shared recovery budget`, { timeout: 30000 }, async () => {
  const reply = cancelled ? { text: "visible", slow: true } : { foreign: "Bash" };
  const fixture = await installClaudeFixture({ cache: true, replies: [reply, reply, reply] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `compaction-guard-${cancelled}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" } });
  const turn = async (text: string) => {
    const controller = new AbortController();
    for await (const event of cacheGuardedInference(provider, { model: "fixture", input: text }, controller.signal,
      { threadId: "compact", requestKind: "compaction" }, `compaction-${cancelled}`)) {
      if (cancelled && event.type === "text") controller.abort();
    }
  };
  try {
    await assert.rejects(turn("a".repeat(400000)), { code: cancelled ? "cancelled" : "invalid_tool_call" });
    await assert.rejects(turn("b".repeat(400000)), { code: cancelled ? "cancelled" : "invalid_tool_call" });
    await assert.rejects(turn("c".repeat(400000)), { code: "invalid_request", status: 400 });
    assert.equal((await fixture.capture()).filter(entry => entry.start).length, 2);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore();
  }
});
