import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionKey } from "../providers/claude-live-contract.js";
import { replayPinned, sessionRegistry } from "../providers/claude-session-registry.js";
import { ProviderError } from "../providers/provider.js";
import { isNativeOutput } from "../providers/claude-native-output.js";
import { queuedAuthentication } from "../providers/claude-native-output.js";
import { ClaudeSession } from "../providers/claude-session.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { installClaudeFixture, type FixtureScenario } from "./claude-cli-fixture.js";
import type { ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

/**
 * A native authentication failure that arrives before any output, tool-result delivery or steering changed nothing
 * in the CLI, so it must not hold the thread for an hour. Anything later keeps the crash hold and never retries.
 */
const generic401 = "Failed to authenticate. API Error: 401 native private diagnostic";
const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: text });
const authentication = (error: unknown) => error instanceof ProviderError && error.code === "authentication";
const stop = () => claudeLive({ max: 6, parkMinutes: 60 }).stop();

test("native output covers content blocks and successful assistant frames, never failure diagnostics", () => {
  assert.equal(isNativeOutput({ type: "stream_event" }, "content_block_start"), true);
  assert.equal(isNativeOutput({ type: "stream_event" }, "content_block_delta"), true);
  assert.equal(isNativeOutput({ type: "assistant" }, undefined), true);
  assert.equal(isNativeOutput({ type: "assistant", error: null }, undefined), true);
  assert.equal(isNativeOutput({ type: "assistant", error: false }, undefined), true);
  assert.equal(isNativeOutput({ type: "assistant", error: "authentication_failed" }, undefined), false);
  assert.equal(isNativeOutput({ type: "stream_event" }, "message_start"), false);
  assert.equal(isNativeOutput({ type: "system", subtype: "status" }, undefined), false);
});

test("a queued login failure is found only when it is the first terminal frame", () => {
  const auth = { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: generic401 }] } };
  const success = { type: "result", subtype: "success", is_error: false };
  const billing = { type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "limit" }] } };
  assert.equal(queuedAuthentication([auth])?.upstream?.code, "authentication_failed");
  assert.equal(queuedAuthentication([{ type: "system", subtype: "status" }, { type: "stream_event" }, auth])?.upstream?.code, "authentication_failed");
  assert.equal(queuedAuthentication([success, auth]), undefined);
  assert.equal(queuedAuthentication([billing, auth]), undefined);
  assert.equal(queuedAuthentication([{ type: "result", is_error: true, error_code: "authentication_failed", result: "Not logged in" }])?.upstream?.reason, "login_unavailable");
  assert.equal(queuedAuthentication([]), undefined);
});

async function harness(name: string, scenario: FixtureScenario) {
  const fixture = await installClaudeFixture(scenario);
  const id = `auth-recovery-${name}-${process.pid}`;
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const key = sessionKey(`${id}\0`, name);
  const turn = async (input: ResponsesInputItem[], extra: Partial<ResponsesRequest> = {}) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, ...extra } as ResponsesRequest, new AbortController().signal, { threadId: name })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  const starts = async () => (await fixture.capture()).flatMap(entry => entry.start ? [entry.start] : []);
  const hold = () => replayPinned(sessionRegistry(), key);
  return { fixture, turn, starts, hold, done: async () => { await stop(); await fixture.restore(); } };
}

/** Keeps the reader from consuming a session's lines until its CLI has exited and the session has closed, so close() sees them queued. */
function delayedConsumer(): () => void {
  const run = ClaudeSession.prototype.run;
  let delayed = false;
  ClaudeSession.prototype.run = function (this: ClaudeSession, ...args: Parameters<typeof run>) {
    const events = run.apply(this, args);
    // Only the first request is held back; later sessions in the same test run normally.
    if (delayed) return events;
    delayed = true;
    const gate = new Promise<void>(resolve => {
      const started = Date.now();
      const timer = setInterval(() => { if (this.state === "closed" || Date.now() - started > 10000) { clearInterval(timer); resolve(); } }, 5);
    });
    return { [Symbol.asyncIterator]() {
      const iterator = events[Symbol.asyncIterator]();
      return { next: async () => { await gate; return iterator.next(); }, return: async (value?: unknown) => (await iterator.return?.(value)) ?? { done: true as const, value } };
    } };
  };
  return () => { ClaudeSession.prototype.run = run; };
}
const text = (output: ResponsesInputItem[]) => JSON.stringify(output);
const results = (output: ResponsesInputItem[]) => output.flatMap(item => item.type === "function_call"
  ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "tool result" }] : []);

test("a permanent native login failure before output lets the next request retry on the same thread", { timeout: 30000 }, async () => {
  const h = await harness("permanent", { replies: [{ authenticationFailed: "Not logged in" }, { text: "back again" }] });
  try {
    await assert.rejects(h.turn([user("first")]), authentication);
    assert.equal(h.hold(), undefined, "no crash hold");
    assert.match(text(await h.turn([user("first"), user("retry")])), /back again/);
    assert.deepEqual(await h.starts(), ["live", "live"], "a fresh live session, never a one-shot replay");
  } finally { await h.done(); }
});

test("a recovered generic 401 leaves no hold, so the next message on the thread succeeds", { timeout: 30000 }, async () => {
  const h = await harness("recovered", { replies: [{ authenticationFailed: generic401 }, { text: "recovered" }, { text: "next answer" }] });
  try {
    const first = [user("first")], recovered = await h.turn(first);
    assert.match(text(recovered), /recovered/);
    assert.equal(h.hold(), undefined);
    assert.match(text(await h.turn([...first, ...recovered, user("again")])), /next answer/);
    assert.deepEqual(await h.starts(), ["live", "oneshot", "live"]);
  } finally { await h.done(); }
});

test("hidden reasoning before an authentication failure keeps the hold and starts no one-shot", { timeout: 30000 }, async () => {
  const h = await harness("hidden", { replies: [{ thinking: "private", authenticationAfterThinking: generic401 }, { text: "must not run" }] });
  try {
    await assert.rejects(h.turn([user("first")], { reasoning: { summary: "none" } }), authentication);
    assert.equal(h.hold(), "crashed");
    await assert.rejects(h.turn([user("first"), user("again")], { reasoning: { summary: "none" } }), (error: unknown) => error instanceof ProviderError && error.status === 400);
    assert.deepEqual(await h.starts(), ["live"]);
  } finally { await h.done(); }
});

test("authentication failing after delivered tool results keeps the hold and starts no one-shot", { timeout: 30000 }, async () => {
  const h = await harness("outputs", { replies: [{ calls: [{ tool: "read", input: {} }] }, { authenticationFailed: generic401 }, { text: "must not run" }] });
  try {
    const first = [user("Read")], output = await h.turn(first, { tools });
    await assert.rejects(h.turn([...first, ...output, ...results(output)], { tools }), authentication);
    assert.equal(h.hold(), "crashed");
    assert.deepEqual(await h.starts(), ["live"]);
  } finally { await h.done(); }
});

test("authentication failing after queued steering keeps the hold and starts no one-shot", { timeout: 30000 }, async () => {
  const h = await harness("steered", { replies: [{ calls: [{ tool: "read", input: {} }] }, { authenticationFailed: generic401 }, { text: "must not run" }] });
  try {
    const first = [user("Read")], output = await h.turn(first, { tools });
    await assert.rejects(h.turn([...first, ...output, ...results(output), user("New context")], { tools }), authentication);
    assert.equal(h.hold(), "crashed");
    assert.deepEqual(await h.starts(), ["live"]);
  } finally { await h.done(); }
});
test("a login failure printed just before the CLI exits is kept and leaves no hold", { timeout: 30000 }, async () => {
  const restore = delayedConsumer();
  const h = await harness("exit-permanent", { replies: [{ authenticationFailed: "Not logged in", exitAfterAuthentication: true }, { text: "back again" }] });
  try {
    await assert.rejects(h.turn([user("first")]), authentication);
    assert.equal(h.hold(), undefined);
    assert.match(text(await h.turn([user("first"), user("retry")])), /back again/);
    assert.deepEqual(await h.starts(), ["live", "live"]);
  } finally { restore(); await h.done(); }
});

test("a generic 401 printed before the CLI exits takes the automatic recovery, then the next message succeeds", { timeout: 30000 }, async () => {
  const restore = delayedConsumer();
  const h = await harness("exit-recovered", { replies: [{ authenticationFailed: generic401, exitAfterAuthentication: true }, { text: "recovered" }, { text: "next answer" }] });
  try {
    const first = [user("first")], recovered = await h.turn(first);
    assert.match(text(recovered), /recovered/);
    assert.equal(h.hold(), undefined);
    assert.match(text(await h.turn([...first, ...recovered, user("again")])), /next answer/);
    assert.deepEqual(await h.starts(), ["live", "oneshot", "live"]);
  } finally { restore(); await h.done(); }
});

test("hidden output before a login failure and exit keeps the hold, the native error and starts no one-shot", { timeout: 30000 }, async () => {
  const restore = delayedConsumer();
  const h = await harness("exit-hidden", { replies: [{ thinking: "private", authenticationAfterThinking: generic401, exitAfterAuthentication: true }, { text: "must not run" }] });
  try {
    await assert.rejects(h.turn([user("first")], { reasoning: { summary: "none" } }), authentication);
    assert.equal(h.hold(), "crashed");
    assert.deepEqual(await h.starts(), ["live"]);
  } finally { restore(); await h.done(); }
});
