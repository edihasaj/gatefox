import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { ClaudeReplayBlocked } from "../providers/claude-replay-budget.js";
import { sessionLimits } from "../providers/claude-session.js";
import { CliContinuityUnavailable, claudeStarted, claudeStartTimeout, startTimeoutLimits } from "../providers/cli-continuity.js";
import { ProviderError } from "../providers/provider.js";
import { classifyProviderFailure, providerFailureDiagnostic, streamFailureCode } from "../provider-failure.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { InferenceEvent } from "../protocol/types.js";

const startTimeout = (error: unknown) => error instanceof ProviderError && error.code === "upstream_unavailable" && error.status === 503 && error.upstream?.code === "session_start_timeout";
const final = (error: unknown) => error instanceof CliContinuityUnavailable && error.status === 400 && /initialize_timeout/.test(error.message);
async function run(provider: ClaudeSubscription, threadId: string): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of provider.infer({ model: "fixture", input: [{ role: "user", content: "hi" }] }, new AbortController().signal, { threadId })) events.push(event);
  return events;
}
/** Another loaded release has its own copy of the class; a query string makes Node load one. */
async function olderRelease(): Promise<typeof ProviderError> {
  const copy = await import(new URL("../providers/provider.js?older-release", import.meta.url).href) as { ProviderError: typeof ProviderError };
  assert.notEqual(copy.ProviderError, ProviderError);
  return copy.ProviderError;
}

test("a CLI that cannot start in time is retryable twice, then final, and a later start clears the count", { timeout: 60000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ text: "STARTED" }], ignoreInitialize: true });
  const startMs = sessionLimits.startMs; sessionLimits.startMs = 300;
  const provider = new ClaudeSubscription({ id: `overload-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { warmup: 0 } });
  try {
    for (let n = 0; n < startTimeoutLimits.retries; n++) await assert.rejects(run(provider, "slow"), startTimeout);
    await assert.rejects(run(provider, "slow"), final);
    await assert.rejects(run(provider, "other"), startTimeout, "another chat has its own count");
    assert.equal((await fixture.capture()).some(entry => entry.user !== undefined || entry.start === "oneshot"), false, "nothing was sent to Claude");
    sessionLimits.startMs = startMs; await fixture.setScenario({ replies: [{ text: "STARTED" }] });
    assert.equal((await run(provider, "slow")).map(event => event.type === "text" ? event.text : "").join(""), "STARTED");
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    sessionLimits.startMs = 300; await fixture.setScenario({ replies: [], ignoreInitialize: true });
    await assert.rejects(run(provider, "slow"), startTimeout);
  } finally { sessionLimits.startMs = startMs; await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); }
});

test("the start timeout is retried by Codex, named in diagnostics, and an old one is forgotten", () => {
  const failure = claudeStartTimeout("window", 1000);
  assert.equal(streamFailureCode(failure), "upstream_unavailable");
  const record = providerFailureDiagnostic({ requestId: "x", durationMs: 1, failure });
  assert.deepEqual([record.code, record.upstreamCode, record.upstreamEvent], ["upstream_unavailable", "session_start_timeout", "gateway.session"]);
  claudeStartTimeout("window", 2000); assert.ok(final(claudeStartTimeout("window", 3000)));
  assert.ok(startTimeout(claudeStartTimeout("window", 3000 + startTimeoutLimits.windowMs)));
  claudeStarted("window");
});

test("a typed failure of a session adopted from another release keeps its meaning", async () => {
  const Older = await olderRelease(), directory = await mkdtemp(join(tmpdir(), "gateway-older-"));
  try {
    const path = join(directory, "live.mjs");
    await writeFile(path, `const {ProviderError}=await import(${JSON.stringify(new URL("../providers/provider.js?older-release", import.meta.url).href)});
export const claudeLive=()=>({attach:async()=>({kind:"stream",events:(async function*(){throw new ProviderError("invalid_request","Claude ended while handling a queued conversation update.",400,{code:"steering_barrier_failed",event:"claude.session"});})()})});`);
    const provider = new ClaudeSubscription({ id: "adopted", type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { warmup: 0 } }, undefined, undefined, pathToFileURL(path).href);
    let failure: unknown; try { await run(provider, "adopted"); } catch (error) { failure = error; }
    assert.equal(Object.getPrototypeOf(failure), Older.prototype);
    const known = classifyProviderFailure(failure, undefined);
    assert.deepEqual([known.code, known.status, known.upstream?.code], ["invalid_request", 400, "steering_barrier_failed"]);
    assert.equal(streamFailureCode(known), "invalid_prompt", "final: Codex does not replay the chat");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("only a real ProviderError class of another release is recognised", async () => {
  const Older = await olderRelease();
  const older = new Older("cli_failed", "ended", 502);
  assert.ok(older instanceof ProviderError);
  assert.equal(older instanceof CliContinuityUnavailable, false, "a subclass check stays exact"); assert.equal(older instanceof ClaudeReplayBlocked, false);
  assert.equal(new ProviderError("x", "y") instanceof CliContinuityUnavailable, false);
  assert.ok(new CliContinuityUnavailable("Claude", "capacity") instanceof ProviderError);
  class Fake extends Error { code = "cli_failed"; status = 502; }
  class Deep extends Fake {}
  let reads = 0;
  const getter = Object.defineProperty(new Older("x", "y"), "code", { get() { reads++; return "x"; } });
  const hostile = new Proxy(new Error("private"), { getPrototypeOf() { throw new Error("trap"); } });
  for (const value of [new Fake("f"), new Deep("d"), Object.assign(new Error("e"), { code: "cli_failed", status: 502 }), { code: "x", status: 502 }, getter, null, undefined, "x"]) assert.equal(value instanceof ProviderError, false);
  assert.equal(reads, 0);
  assert.equal(classifyProviderFailure(hostile, undefined).code, "provider_failed");
});
