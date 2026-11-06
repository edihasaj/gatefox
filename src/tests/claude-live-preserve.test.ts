import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionKey } from "../providers/claude-live-contract.js";
import { compactionCheckpoint, pinReplay, sessionRegistry } from "../providers/claude-session-registry.js";
import { ProviderError } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];
const user = (content: string): ResponsesInputItem => ({ type: "message", role: "user", content });

for (const mismatch of ["missing", "duplicate", "assistant", "forced"] as const) {
  test(`${mismatch} tool continuation preserves the CLI and pending results without one-shot replay`, { timeout: 30000 }, async () => {
    const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] }, { text: "Continued" }] });
    configureTelemetry(fixture.directory, "test");
    const provider = new ClaudeSubscription({ id: `preserve-${mismatch}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
    const turn = async (input: ResponsesInputItem[], tool_choice?: ResponsesRequest["tool_choice"]) => {
      const writer = new ResponsesWriter("fixture", () => {});
      for await (const event of provider.infer({ model: "fixture", input, tools, tool_choice }, new AbortController().signal, { threadId: "kept" })) writer.accept(event);
      return writer.result().output as ResponsesInputItem[];
    };
    try {
      const first = [user("Read")], output = await turn(first);
      const results = output.flatMap(item => item.type === "function_call"
        ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "exact result" }] : []);
      const continuation = [...first, ...output, ...results];
      const [kept] = claudeLive({ max: 6, parkMinutes: 60 }).sessions();
      const pending = [...kept.pending];
      const invalid = mismatch === "missing" ? [...first, ...output]
        : mismatch === "duplicate" ? [...continuation, ...results]
        : mismatch === "assistant" ? [...continuation, { type: "message" as const, role: "assistant" as const, content: "Unobserved assistant output" }]
        : continuation;
      for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(turn(invalid, mismatch === "forced" ? "required" : undefined),
        (error: unknown) => error instanceof ProviderError && error.upstream?.code === "claude_session_preserved"
          && error.status === 400 && streamFailureCode(error) === "invalid_prompt");
      assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0], kept);
      assert.equal(kept.state, "awaiting_outputs");
      assert.deepEqual(kept.pending, pending);
      assert.equal((await fixture.capture()).some(row => row.toolResult !== undefined), false, "refused requests deliver nothing");
      assert.ok((await turn(continuation)).some(item => item.type === "message"));
      const capture = await fixture.capture();
      assert.deepEqual(capture.filter(row => row.start).map(row => row.start), ["live"]);
      assert.deepEqual(capture.filter(row => row.toolResult !== undefined).map(row => row.toolResult), ["exact result"]);
    } finally {
      await claudeLive({ max: 6, parkMinutes: 60 }).stop();
      await flushTelemetry(); await fixture.restore();
    }
  });
}

test("an adopted history-mismatch replay hold refuses before starting any CLI", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "Must not run" }] });
  configureTelemetry(fixture.directory, "test");
  const id = `legacy-mismatch-${process.pid}`;
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  pinReplay(sessionRegistry(), sessionKey(`${id}\0`, "old"), Date.now(), "unexpected_tail");
  try {
    await assert.rejects(async () => {
      for await (const _ of provider.infer({ model: "fixture", input: "Continue" }, new AbortController().signal, { threadId: "old" })) { /* No inference. */ }
    }, (error: unknown) => error instanceof ProviderError && error.upstream?.code === "claude_session_replay_blocked" && error.status === 400);
    assert.equal((await fixture.capture()).length, 0);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await flushTelemetry(); await fixture.restore();
  }
});

for (const reason of ["unexpected_tail", "crashed"]) test(`successful compaction recovers an unchanged ${reason} hold`, { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "Summary" }, { text: "Recovered" }] });
  configureTelemetry(fixture.directory, "test");
  const id = `legacy-compact-${process.pid}`, key = sessionKey(`${id}\0`, "old");
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  pinReplay(sessionRegistry(), key, Date.now(), reason);
  try {
    for await (const _ of provider.infer({ model: "fixture", input: "Summarize" }, new AbortController().signal, { threadId: "old", requestKind: "compaction" })) {}
    assert.equal(sessionRegistry().replayUntil.has(key), false);
    for await (const _ of provider.infer({ model: "fixture", input: "Compacted history" }, new AbortController().signal, { threadId: "old" })) {}
    assert.deepEqual((await fixture.capture()).filter(row => row.start).map(row => row.start), ["oneshot", "live"]);
    // A late completion cannot clear another operation's replacement hold.
    const registry = sessionRegistry(), otherKey = sessionKey("hold-race", "other");
    pinReplay(registry, otherKey, Date.now(), "prefix_diverged");
    const checkpoint = compactionCheckpoint("hold-race", "other")!;
    pinReplay(registry, otherKey, Date.now(), "unexpected_tail");
    checkpoint(); assert.equal(registry.replayUntil.has(otherKey), true);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await flushTelemetry(); await fixture.restore();
  }
});

for (const ending of ["failed", "cancelled"] as const) test(`${ending} compaction preserves a Claude crash hold`, async () => {
  const fixture = await installClaudeFixture({ replies: [{ fail: ending === "failed", slow: ending === "cancelled", text: "Summary" }] });
  configureTelemetry(fixture.directory, "test");
  const id = `dead-compact-${ending}-${process.pid}`, key = sessionKey(`${id}\0`, "held");
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const registry = sessionRegistry(); pinReplay(registry, key, Date.now(), "crashed"); const hold = registry.replayUntil.get(key);
  const controller = new AbortController();
  try {
    await assert.rejects(async () => {
      for await (const event of provider.infer({ model: "fixture", input: "Summarize" }, controller.signal, { threadId: "held", requestKind: "compaction" })) {
        if (ending === "cancelled" && event.type === "text") controller.abort();
      }
    });
    assert.equal(registry.replayUntil.get(key), hold);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});

test("a completed compaction cannot release a replacement crash hold or a new live session", () => {
  const registry = sessionRegistry(), scope = "crash-compact-race", thread = "held", key = sessionKey(scope, thread);
  pinReplay(registry, key, Date.now(), "crashed"); const replaced = compactionCheckpoint(scope, thread)!;
  pinReplay(registry, key, Date.now(), "crashed"); const replacement = registry.replayUntil.get(key);
  replaced(); assert.equal(registry.replayUntil.get(key), replacement);
  const occupied = compactionCheckpoint(scope, thread)!;
  registry.sessions.set(key, { state: "turn_done" } as never);
  try { occupied(); assert.equal(registry.replayUntil.get(key), replacement); }
  finally { registry.sessions.delete(key); registry.replayUntil.delete(key); registry.ended.delete(key); }
});

for (const nativeError of ["invalid_request", { toString: "private" }]) test(`late Claude output records safe ${typeof nativeError} categories and compaction recovers its held thread`, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] }, { text: "Summary" }, { text: "Recovered" }] });
  configureTelemetry(fixture.directory, "test"); const since = Date.now();
  const id = `late-output-${process.pid}`, context = { threadId: "held" };
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const drain = async (request: ResponsesRequest, compaction = false) => {
    for await (const _ of provider.infer(request, new AbortController().signal, { ...context, ...(compaction ? { requestKind: "compaction" as const } : {}) })) {}
  };
  try {
    await drain({ model: "fixture", input: "Read", tools });
    const [session] = claudeLive({ max: 6, parkMinutes: 60 }).sessions();
    (session as unknown as { detached(message: Record<string, unknown>, event?: string): void }).detached({
      type: "assistant", error: nativeError, message: { id: "private-message-id", content: [{ type: "text", text: "private diagnostic prose" }] },
    });
    await session.close("closed", "test", true);
    await assert.rejects(drain({ model: "fixture", input: "Continue" }), (error: unknown) => error instanceof ProviderError && error.upstream?.code === "session_continuity_unavailable");
    assert.deepEqual((await fixture.capture()).filter(row => row.start).map(row => row.start), ["live"]);
    await flushTelemetry(); const events = await readTelemetry(fixture.directory, since);
    const violation = events.find(row => row.event === "claude_session_violation")!;
    assert.equal(violation.messageKind, "assistant"); assert.equal(violation.nativeError, typeof nativeError === "string" ? nativeError : "other");
    assert.equal(violation.state, "awaiting_outputs"); assert.equal(violation.pendingCalls, 1);
    assert.equal(JSON.stringify(events).includes("private"), false);
    await drain({ model: "fixture", input: "Summarize" }, true);
    await drain({ model: "fixture", input: "Compacted history" });
    assert.deepEqual((await fixture.capture()).filter(row => row.start).map(row => row.start), ["live", "oneshot", "live"]);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});

for (const fails of [false, true]) test(`${fails ? "failed" : "completed"} client compaction ${fails ? "preserves" : "replaces"} the session without a window ID`, { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "Original answer" },
    { text: "Compact summary", ...(fails ? { fail: true } : {}) }, { text: "Recovered" }, { text: "Next" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `compact-preserve-${fails}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[], compaction = false) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input }, new AbortController().signal,
      { threadId: "compacted", ...(compaction ? { requestKind: "compaction" as const } : {}) })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    await turn([user("Original history")]);
    const [original] = claudeLive({ max: 6, parkMinutes: 60 }).sessions();
    const compact = turn([user("Summarize the original history")], true);
    if (fails) await assert.rejects(compact); else await compact;
    assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0], original, "compaction does not close the original session");
    if (fails) {
      await assert.rejects(turn([user("Replacement history")]), { code: "invalid_request", status: 400 });
      assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0], original);
      assert.deepEqual((await fixture.capture()).filter(row => row.start).map(row => row.start), ["live", "oneshot"]);
    } else {
      const replacement = [user("Replacement history")];
      const output = await turn(replacement);
      assert.notEqual(claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0], original);
      await turn([...replacement, ...output, user("Continue")]);
      assert.deepEqual((await fixture.capture()).filter(row => row.start).map(row => row.start), ["live", "oneshot", "live"]);
      await assert.rejects(turn([user("Another unexplained edit")]), { code: "invalid_request", status: 400 });
    }
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await flushTelemetry(); await fixture.restore();
  }
});

test("compaction completion cannot authorize resetting a session that progressed or was replaced", async () => {
  const registry = sessionRegistry(), scope = "compaction-race", thread = "same";
  const key = sessionKey(scope, thread);
  const session = { key, state: "turn_done", ledger: { items: ["first"] }, compacted: false };
  registry.sessions.set(key, session as never);
  try {
    const progressed = compactionCheckpoint(scope, thread)!;
    session.ledger = { items: ["first", "second"] };
    progressed(); assert.equal(session.compacted, false);
    const changedPhase = compactionCheckpoint(scope, thread)!;
    session.state = "generating";
    changedPhase(); assert.equal(session.compacted, false);
    assert.equal(compactionCheckpoint(scope, thread), undefined);
    session.state = "turn_done";
    const replaced = compactionCheckpoint(scope, thread)!;
    registry.sessions.set(key, { ...session } as never);
    replaced(); assert.equal(session.compacted, false);
  } finally { registry.sessions.delete(key); }
});
