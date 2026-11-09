import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionKey } from "../providers/claude-live-contract.js";
import { sessionRegistry } from "../providers/claude-session-registry.js";
import { ProviderError } from "../providers/provider.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { ResponsesInputItem } from "../protocol/types.js";

const user = (content: string): ResponsesInputItem => ({ type: "message", role: "user", content });
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

test("an interrupt watchdog closes a cancelled CLI without holding or automatically replaying the chat", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ ignoreInterrupt: true, replies: [{ text: "partial", slow: true }, { text: "recovered" }] });
  configureTelemetry(fixture.directory, "test");
  const since = Date.now(), id = `interrupt-timeout-${process.pid}`, threadId = "cancelled";
  const key = sessionKey(`${id}\0`, threadId);
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const controller = new AbortController();
  const starts = async () => (await fixture.capture()).flatMap(entry => entry.start ? [entry.start] : []);
  try {
    await assert.rejects(async () => {
      for await (const event of provider.infer({ model: "fixture", input: [user("first")] }, controller.signal, { threadId })) {
        if (event.type === "text") controller.abort();
      }
    }, { code: "cancelled" });
    const session = sessionRegistry().sessions.get(key);
    assert.ok(session);
    while (session.state !== "closed") await pause();
    assert.equal(sessionRegistry().replayUntil.has(key), false, "a deliberate cancellation close creates no crash hold");
    assert.deepEqual(await starts(), ["live"], "the cancelled request never replays or starts another CLI");
    let answer = "";
    for await (const event of provider.infer({ model: "fixture", input: [user("first"), user("try again")] }, new AbortController().signal, { threadId })) {
      if (event.type === "text") answer += event.text;
    }
    assert.equal(answer, "recovered");
    assert.deepEqual(await starts(), ["live", "live"], "only a new caller request starts the replacement");
    await flushTelemetry();
    const events = await readTelemetry(fixture.directory, since);
    assert.ok(events.some(event => event.event === "claude_session" && event.outcome === "closed" && event.missReason === "interrupt_timeout"));
    assert.equal(events.some(event => event.event === "claude_session" && event.outcome === "crashed"), false);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await flushTelemetry();
    await fixture.restore();
  }
});

test("a genuine CLI exit still creates a crash hold and refuses a later request", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ fail: true }, { text: "must not replay" }] });
  const id = `interrupt-crash-${process.pid}`, threadId = "crashed", key = sessionKey(`${id}\0`, threadId);
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const infer = async () => { for await (const _ of provider.infer({ model: "fixture", input: [user("first")] }, new AbortController().signal, { threadId })) { /* Drain. */ } };
  try {
    await assert.rejects(infer);
    assert.equal(sessionRegistry().replayUntil.has(key), true);
    await assert.rejects(infer, (error: unknown) => error instanceof ProviderError && error.upstream?.code === "session_continuity_unavailable");
    assert.deepEqual((await fixture.capture()).flatMap(entry => entry.start ? [entry.start] : []), ["live"]);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await fixture.restore();
  }
});
