import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionRegistry, recordWarmupCompletion, warmupCompletions, warmupLimit, warmupMs } from "../providers/claude-session-registry.js";
import { ProviderError, type InferenceContext } from "../providers/provider.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture, type ClaudeFixture, type FixtureScenario } from "./claude-cli-fixture.js";
import type { InferenceEvent, ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

const providerId = `claude-warmup-${process.pid}`;
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const key = (threadId: string) => createHash("sha256").update(`${providerId}\0\0${threadId}`).digest("hex");
const provider = (sessions: Record<string, unknown> = {}) => new ClaudeSubscription({
  id: providerId, type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live", ...sessions },
});

async function turn(subscription: ClaudeSubscription, input: ResponsesInputItem[], context: InferenceContext, controller = new AbortController()) {
  const events: InferenceEvent[] = []; const writer = new ResponsesWriter("fixture", () => {});
  const request: ResponsesRequest = { model: "fixture", input };
  for await (const event of subscription.infer(request, controller.signal, context)) { events.push(event); writer.accept(event); }
  return { events, output: writer.result().output as ResponsesInputItem[] };
}

async function setup(scenario: FixtureScenario): Promise<{ fixture: ClaudeFixture; since: number }> {
  const fixture = await installClaudeFixture(scenario);
  configureTelemetry(fixture.directory, "test");
  return { fixture, since: Date.now() };
}

async function teardown(fixture: ClaudeFixture): Promise<void> {
  await claudeLive({ max: 6, parkMinutes: 60 }).stop();
  await fixture.restore();
}

const starts = async (fixture: ClaudeFixture) => (await fixture.capture()).flatMap(entry => entry.start ? [entry.start] : []);

test("the default warmup serves the first request one-shot, then promotes and continues", { timeout: 30000 }, async () => {
  const { fixture, since } = await setup({ replies: [{ text: "one" }, { text: "two" }, { text: "three" }] });
  try {
    const subscription = provider(); const context = { threadId: "thread" };
    const first = [user("one")]; await turn(subscription, first, context);
    const second = [...first, user("two")]; const seeded = await turn(subscription, second, context);
    await turn(subscription, [...second, ...seeded.output, user("three")], context);
    assert.deepEqual(await starts(fixture), ["oneshot", "live"], "the first request parks no CLI and the third continues the promoted one");
    await flushTelemetry();
    const sessions = (await readTelemetry(fixture.directory, since)).filter(event => event.event === "claude_session");
    assert.deepEqual(sessions.map(event => [event.outcome, event.missReason, event.afterWarmup]), [
      ["fallback", "warmup", undefined],
      ["spawned", undefined, true],
      ["continued", undefined, undefined],
    ]);
  } finally { await teardown(fixture); }
});

test("warmup zero restores immediate live-session spawning", { timeout: 30000 }, async () => {
  const { fixture } = await setup({ replies: [{ text: "one" }] });
  try {
    await turn(provider({ warmup: 0 }), [user("one")], { threadId: "thread" });
    assert.deepEqual(await starts(fixture), ["live"]);
  } finally { await teardown(fixture); }
});

test("failed and cancelled warmup requests do not promote a thread", { timeout: 30000 }, async () => {
  const { fixture } = await setup({ replies: [{ fail: true }, { slow: true }, { text: "one" }, { text: "two" }] });
  try {
    const subscription = provider(); const context = { threadId: "thread" };
    await assert.rejects(turn(subscription, [user("failed")], context), (error: unknown) => error instanceof ProviderError && error.code === "cli_failed");
    const controller = new AbortController();
    const cancelling = (async () => {
      for await (const event of subscription.infer({ model: "fixture", input: [user("cancelled")] }, controller.signal, context)) {
        if (event.type === "text") controller.abort();
      }
    })();
    await assert.rejects(cancelling, { code: "cancelled" });
    await turn(subscription, [user("one")], context);
    await turn(subscription, [user("one"), user("two")], context);
    assert.deepEqual(await starts(fixture), ["oneshot", "oneshot", "oneshot", "live"]);
  } finally { await teardown(fixture); }
});

test("one-request threads leave no live sessions and do not exhaust admission", { timeout: 30000 }, async () => {
  const { fixture } = await setup({ replies: [] });
  try {
    const subscription = provider();
    for (let index = 0; index < 30; index++) await turn(subscription, [user(`fork ${index}`)], { threadId: `fork-${index}` });
    assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions().length, 0);
    await turn(subscription, [user("first")], { threadId: "real" });
    await turn(subscription, [user("first"), user("second")], { threadId: "real" });
    assert.equal((await starts(fixture)).filter(start => start === "live").length, 1);
  } finally { await teardown(fixture); }
});

test("warmup state expires, evicts its oldest key, and survives compatible registry adoption", async () => {
  const registry = sessionRegistry(); registry.warmups.clear();
  try {
    for (let index = 0; index <= warmupLimit; index++) recordWarmupCompletion(registry, `key-${index}`, 1000);
    assert.equal(registry.warmups.size, warmupLimit);
    assert.equal(warmupCompletions(registry, "key-0", 1000), 0, "the oldest entry falls out at the cap");
    assert.equal(warmupCompletions(registry, `key-${warmupLimit}`, 1000 + warmupMs), 0, "entries expire after 24 hours");

    const symbol = Symbol.for("harness-gateway/claude-sessions/v1");
    const global = globalThis as unknown as Record<symbol, Record<string, unknown>>;
    global[symbol] = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), ended: new Map(), replayUntil: new Map(), scopes: new Map() };
    const missing = sessionRegistry();
    assert.ok(missing.warmups instanceof Map, "a registry from before warmup gains an empty map");
    const kept = new Map([[key("kept"), { count: 2, lastTouched: 1000 }]]);
    global[symbol] = { interfaceVersion: 1, sessions: new Map(), starting: new Set(), ended: new Map(), replayUntil: new Map(), warmups: kept, scopes: new Map() };
    assert.equal(warmupCompletions(sessionRegistry(), key("kept"), 1000), 2, "an adopted registry retains completed requests");
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); }
});

test("replay mode neither records nor creates warmup state", { timeout: 30000 }, async () => {
  const { fixture, since } = await setup({ replies: [{ text: "one" }] });
  try {
    await turn(provider({ mode: "replay" }), [user("one")], { threadId: "thread" });
    await flushTelemetry();
    assert.equal((await readTelemetry(fixture.directory, since)).some(event => event.event === "claude_session"), false);
    assert.equal(warmupCompletions(sessionRegistry(), key("thread")), 0);
  } finally { await teardown(fixture); }
});
