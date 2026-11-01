import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeAuthenticationFailure } from "../providers/claude-auth.js";
import { ProviderError } from "../providers/provider.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { InferenceEvent } from "../protocol/types.js";

const generic401 = "Failed to authenticate. API Error: 401 native private diagnostic";
const permanent = [
  ["Not logged in", "login_unavailable"],
  ["OAuth session expired and could not be refreshed", "session_expired"],
  ["Failed to authenticate. API Error: 401 OAuth token has expired", "session_expired"],
  ["Failed to authenticate. API Error: 401 Refresh token expired", "session_expired"],
  ["Please run /login · API Error: 401 Refresh token has been revoked", "credential_revoked"],
  ["Please run /login · API Error: 401 Your credentials have been revoked", "credential_revoked"],
] as const;
const failure = (text: string) => ({
  type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text }] },
});
let providerSequence = 0;
const provider = (live = false) => new ClaudeSubscription({
  id: `claude-auth-${process.pid}-${++providerSequence}`, type: "claude-subscription", models: { alias: "fixture" },
  ...(live ? { claudeSessions: { mode: "live", warmup: 0 } } : {}),
});
async function infer(instance: ClaudeSubscription, signal = new AbortController().signal, request: Record<string, unknown> = {}) {
  const events: InferenceEvent[] = [];
  for await (const event of instance.infer({ model: "fixture", input: "fixture", ...request }, signal, { threadId: "auth-thread" })) events.push(event);
  return events;
}

test("classifies only native authentication envelopes, with explicit permanent states ahead of CLI 401", () => {
  for (const [text, reason] of permanent) {
    const error = claudeAuthenticationFailure(failure(text))!;
    assert.equal(error.upstream?.reason, reason);
    assert.match(error.message, /requires login/);
  }
  const generic = claudeAuthenticationFailure(failure(generic401))!;
  assert.equal(generic.upstream?.reason, "upstream_rejected");
  assert.match(generic.message, /Retry; if it persists, sign in again/);
  assert.equal(claudeAuthenticationFailure({ type: "result", is_error: false, error_code: "authentication_failed", result: generic401 }), undefined);
  assert.equal(claudeAuthenticationFailure({ type: "assistant", error: "unknown", message: { content: [{ type: "text", text: generic401 }] } }), undefined);
  assert.equal(claudeAuthenticationFailure({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "tool_use", text: generic401 }] } })?.upstream?.reason, "unknown");
});

test("incomplete diagnostics never authorize recovery", () => {
  const long = `${generic401} ${"x".repeat(16 * 1024)}`;
  assert.equal(claudeAuthenticationFailure(failure(long))?.upstream?.reason, "unknown");
  const ninth = { type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: generic401 },
    ...Array.from({ length: 8 }, (_, index) => ({ type: "text", text: index === 7 ? "OAuth token has expired" : "safe" }))] } };
  assert.equal(claudeAuthenticationFailure(ninth)?.upstream?.reason, "unknown");
  const many = { type: "result", is_error: true, error_code: "authentication_failed", result: generic401,
    errors: [...Array(8).fill("safe"), "OAuth token has expired"] };
  assert.equal(claudeAuthenticationFailure(many)?.upstream?.reason, "unknown");
});

test("a generic native 401 gets exactly one fresh one-shot attempt and safe fixed telemetry", async () => {
  const fixture = await installClaudeFixture({ replies: [{ authenticationFailed: generic401 }, { text: "recovered" }] });
  configureTelemetry(fixture.directory, "test"); const since = Date.now();
  try {
    assert.deepEqual((await infer(provider())).map(event => event.type), ["text", "text", "done"]);
    const starts = (await fixture.capture()).filter(entry => entry.start === "oneshot");
    assert.equal(starts.length, 2);
    await flushTelemetry();
    const recovery = (await readTelemetry(fixture.directory, since)).filter(event => event.event === "claude_credential_recovery");
    assert.deepEqual(recovery.map(event => [event.reason, event.attempt, event.outcome]), [["upstream_rejected", 2, "attempted"], ["upstream_rejected", 2, "recovered"]]);
    assert.ok(!JSON.stringify(recovery).includes("native private diagnostic"));
  } finally { await fixture.restore(); }
});

test("recovery reports success before a consumer stops at its done event", async () => {
  const fixture = await installClaudeFixture({ replies: [{ authenticationFailed: generic401 }, { text: "recovered" }] });
  configureTelemetry(fixture.directory, "test"); const since = Date.now();
  try {
    for await (const event of provider().infer({ model: "fixture", input: "fixture" }, new AbortController().signal, { threadId: "done-break" })) {
      if (event.type === "done") break;
    }
    await flushTelemetry();
    const recovery = (await readTelemetry(fixture.directory, since)).filter(event => event.event === "claude_credential_recovery");
    assert.deepEqual(recovery.map(event => event.outcome), ["attempted", "recovered"]);
  } finally { await fixture.restore(); }
});

test("a consumer that stops before done does not report recovery", async () => {
  const fixture = await installClaudeFixture({ replies: [{ authenticationFailed: generic401 }, { text: "recovered" }] });
  configureTelemetry(fixture.directory, "test"); const since = Date.now();
  try {
    const events = provider().infer({ model: "fixture", input: "fixture" }, new AbortController().signal, { threadId: "early-break" })[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "text");
    await events.return?.(undefined);
    await flushTelemetry();
    const recovery = (await readTelemetry(fixture.directory, since)).filter(event => event.event === "claude_credential_recovery");
    assert.deepEqual(recovery.map(event => event.outcome), ["attempted"]);
  } finally { await fixture.restore(); }
});

test("permanent, unknown, billing and usage failures do not get a credential retry", async () => {
  const cases = [
    ...permanent.map(([diagnostic, reason]) => ({ reply: { authenticationFailed: diagnostic }, code: "authentication", reason })),
    { reply: { authenticationFailed: "a private unclassified failure" }, code: "authentication", reason: "unknown" },
    { reply: { failureCode: "billing_error" }, code: "insufficient_quota", reason: undefined },
    { reply: { failureCode: "rate_limit" }, code: "rate_limit_exceeded", reason: undefined },
  ];
  for (const expected of cases) {
    const fixture = await installClaudeFixture({ replies: [expected.reply, { text: "must not run" }] });
    try {
      await assert.rejects(infer(provider()), error => error instanceof ProviderError && error.code === expected.code && error.upstream?.reason === expected.reason);
      assert.equal((await fixture.capture()).filter(entry => entry.start === "oneshot").length, 1);
    } finally { await fixture.restore(); }
  }
});

test("any yielded reasoning or text prevents credential recovery", async () => {
  for (const reply of [
    { thinking: "private", authenticationAfterThinking: generic401 },
    { text: "visible", authenticationAfterText: generic401 },
  ]) {
    const fixture = await installClaudeFixture({ replies: [reply, { text: "must not run" }] });
    try {
      await assert.rejects(infer(provider()), error => error instanceof ProviderError && error.code === "authentication");
      assert.equal((await fixture.capture()).filter(entry => entry.start === "oneshot").length, 1);
    } finally { await fixture.restore(); }
  }
});

test("cancelling during credential backoff starts no replacement", async () => {
  const fixture = await installClaudeFixture({ replies: [{ authenticationFailed: generic401 }, { text: "must not run" }] });
  configureTelemetry(fixture.directory, "test"); const since = Date.now();
  try {
    const controller = new AbortController();
    const pending = assert.rejects(infer(provider(), controller.signal), { code: "cancelled", status: 499 });
    for (;;) {
      await flushTelemetry();
      if ((await readTelemetry(fixture.directory, since)).some(event => event.event === "claude_credential_recovery" && event.outcome === "attempted")) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await pending;
    assert.equal((await fixture.capture()).filter(entry => entry.start === "oneshot").length, 1);
  } finally { await fixture.restore(); }
});

test("a forced-tool mismatch stops before a second billed attempt or authentication recovery", async () => {
  const fixture = await installClaudeFixture({ replies: [
    { calls: [{ tool: "beta", input: {} }] }, { authenticationFailed: generic401 }, { calls: [{ tool: "alpha", input: {} }] },
  ] });
  const tools = ["alpha", "beta"].map(name => ({ type: "function" as const, name, parameters: { type: "object", properties: {} } }));
  try {
    await assert.rejects(infer(provider(), new AbortController().signal, { tools, tool_choice: { type: "function", name: "alpha" } }),
      error => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.equal((await fixture.capture()).filter(entry => entry.start === "oneshot").length, 1);
  } finally { await fixture.restore(); }
});

test("a forced-tool mismatch after reasoning remains final without retry or authentication recovery", async () => {
  const fixture = await installClaudeFixture({ replies: [
    { thinking: "private planning", calls: [{ tool: "beta", input: {} }] }, { authenticationFailed: generic401 }, { text: "must not run" },
  ] });
  const tools = ["alpha", "beta"].map(name => ({ type: "function" as const, name, parameters: { type: "object", properties: {} } }));
  try {
    await assert.rejects(infer(provider(), new AbortController().signal, { tools, tool_choice: { type: "function", name: "alpha" } }),
      error => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.equal((await fixture.capture()).filter(entry => entry.start === "oneshot").length, 1);
  } finally { await fixture.restore(); }
});

test("two native 401 rejections keep the original final failure after exactly two CLIs", async () => {
  const fixture = await installClaudeFixture({ replies: [{ authenticationFailed: generic401 }, { authenticationFailed: generic401 }] });
  try {
    await assert.rejects(infer(provider()), error => error instanceof ProviderError && error.code === "authentication" && error.upstream?.reason === "upstream_rejected");
    assert.equal((await fixture.capture()).filter(entry => entry.start === "oneshot").length, 2);
  } finally { await fixture.restore(); }
});

test("a live pre-event authentication failure replaces the closed session with one fresh one-shot CLI", async () => {
  const fixture = await installClaudeFixture({ replies: [{ authenticationFailed: generic401 }, { text: "recovered" }] });
  try {
    assert.equal((await infer(provider(true))).at(-1)?.type, "done");
    const starts = await fixture.capture();
    assert.equal(starts.filter(entry => entry.start === "live").length, 1);
    assert.equal(starts.filter(entry => entry.start === "oneshot").length, 1);
    assert.equal(starts.find(entry => entry.start === "oneshot")?.priorLiveAlive, false);
  } finally { await fixture.restore(); }
});

test("a live reasoning event makes a later authentication failure final", async () => {
  const fixture = await installClaudeFixture({ replies: [{ thinking: "private", authenticationAfterThinking: generic401 }, { text: "must not run" }] });
  try {
    await assert.rejects(infer(provider(true)), error => error instanceof ProviderError && error.code === "authentication");
    const starts = await fixture.capture();
    assert.equal(starts.filter(entry => entry.start === "live").length, 1, JSON.stringify(starts));
    assert.equal(starts.filter(entry => entry.start === "oneshot").length, 0);
  } finally { await fixture.restore(); }
});
