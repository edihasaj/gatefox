import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { claudeFailure } from "../providers/claude-errors.js";
import { ClaudeMessageStream, claudeResultFailure } from "../providers/claude-stream.js";
import { streamFailureCode } from "../provider-failure.js";
import { ClaudeSubscription } from "../providers/claude.js";
import { ProviderError } from "../providers/provider.js";
import { claudeUsageEvent } from "../providers/claude-usage.js";

test("native Claude rate-limit, authentication, billing and server errors survive opaque result text", () => {
  for (const [code, expected, status] of [["rate_limit", "rate_limit_exceeded", 429], ["authentication_failed", "authentication", 401], ["billing_error", "insufficient_quota", 429], ["server_error", "upstream_unavailable", 503]] as const) {
    const error = claudeFailure({ type: "assistant", error: code, message: { content: [{ type: "text", text: "private account data" }] } })!;
    assert.equal(error.code, expected); assert.equal(error.status, status);
    assert.ok(!JSON.stringify(error).includes("private account data"));
  }
  const result = claudeFailure({ type: "result", is_error: true, subtype: "success", result: "private account data" })!;
  assert.equal(result.code, "inference_failed"); assert.equal(result.upstream?.subtype, "success");
  assert.equal(claudeFailure({ type: "assistant", message: { content: [{ type: "text", text: "rate_limit" }] } }), undefined);
  assert.equal(claudeFailure({ type: "result", is_error: false, subtype: "success", result: "rate_limit" }), undefined);
});

test("native billing failures and result-only credit refusals explain the account action without private details", () => {
  const privateText = "Your credit balance is too low to access the Anthropic API. private payment and account details";
  const refusals = [
    { type: "assistant", error: "billing_error", message: { content: [{ type: "text", text: "private payment and account details" }] } },
    { type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: privateText }] } },
    { type: "result", is_error: true, error_code: "billing_error", result: "authentication and usage limit instructions" },
    { type: "result", is_error: true, subtype: "error_during_execution", errors: [privateText] },
    { type: "result", is_error: true, subtype: "success", result: "Credit balance is too low · private payment and account details" },
    { type: "result", is_error: true, subtype: "success", result: "API Error: Insufficient credits. private payment and account details" },
  ];
  for (const refusal of refusals) {
    const failure = claudeFailure(refusal)!;
    assert.equal(failure.code, "insufficient_quota"); assert.equal(failure.status, 429);
    assert.equal(streamFailureCode(failure), "invalid_prompt");
    assert.match(failure.message, /Claude billing or extra-usage credits/);
    assert.match(failure.message, /billing settings and payment method/);
    assert.ok(!JSON.stringify(failure).includes("private payment and account details"));
    for (const endTurn of [false, true]) {
      const stream = new ClaudeMessageStream({ tools: [], summaryVisible: false, endTurn });
      assert.throws(() => stream.accept(refusal), error => error instanceof ProviderError && error.code === "insufficient_quota");
    }
  }
  const failure = claudeResultFailure({ type: "result", is_error: true, subtype: "success",
    result: "Credit balance is too low. Check authentication or usage limits in your account." });
  assert.equal(failure.code, "insufficient_quota", "billing precedes unstructured auth and usage-limit heuristics");
});

test("a Claude assistant invalid_request is a safe non-retryable request failure", () => {
  const privateText = "private account and request details";
  const failure = claudeFailure({ type: "assistant", error: "invalid_request", message: { content: [{ type: "text", text: privateText }] } })!;
  assert.equal(failure.code, "invalid_request"); assert.equal(failure.status, 400);
  assert.equal(streamFailureCode(failure), "invalid_prompt");
  assert.ok(!JSON.stringify(failure).includes(privateText));
});

test("a Claude result invalid_request is a safe non-retryable request failure", () => {
  const privateText = "private account and request details";
  const failure = claudeFailure({ type: "result", is_error: true, error_code: "invalid_request", result: privateText })!;
  assert.equal(failure.code, "invalid_request"); assert.equal(failure.status, 400);
  assert.equal(streamFailureCode(failure), "invalid_prompt");
  assert.ok(!JSON.stringify(failure).includes(privateText));
});

test("credit diagnosis ignores successful prose, unknown errors, tool data and unbounded diagnostics", () => {
  const credit = "Credit balance is too low";
  assert.equal(claudeFailure({ type: "assistant", message: { content: [{ type: "text", text: credit }] } }), undefined);
  assert.equal(claudeFailure({ type: "result", is_error: false, subtype: "success", result: credit }), undefined);
  const success = new ClaudeMessageStream({ tools: [], summaryVisible: false });
  assert.equal(success.accept({ type: "result", is_error: false, subtype: "success", result: credit }).end?.kind, "result");
  const failures = [
    { type: "result", is_error: true, result: "We discussed billing and payment methods." },
    { type: "result", is_error: true, result: "An unrelated error quotes: Credit balance is too low" },
    { type: "result", is_error: true, result: credit + "x" },
    { type: "result", is_error: true, result: credit + ".".repeat(16 * 1024) },
    { type: "result", is_error: true, errors: [{ message: credit }, null, 42] },
    { type: "result", is_error: true, errors: [...Array(8).fill("unknown"), credit] },
    { type: "assistant", error: "unknown", message: { content: [{ type: "tool_use", text: credit }] } },
  ];
  for (const message of failures) assert.equal(claudeFailure(message)!.code, "inference_failed");
  assert.equal(claudeResultFailure({ type: "result", is_error: true, error_code: { toString: "private unknown code" } }).code, "inference_failed");
  for (const [error_code, expected] of [["rate_limit", "rate_limit_exceeded"], ["authentication_failed", "authentication"], ["server_error", "upstream_unavailable"]] as const) {
    assert.equal(claudeResultFailure({ type: "result", is_error: true, error_code, result: credit }).code, expected);
  }
});

test("the observed CLI rate-limit event wins over a following is_error success result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-claude-rate-"));
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const fixture = `#!${process.execPath}\nfor await(const _ of process.stdin){}\nconsole.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour',resetsAt:${reset},private:'private account data'}}));\nconsole.log(JSON.stringify({type:'assistant',error:'rate_limit',message:{content:[{type:'text',text:'private account data'}]}}));\nconsole.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'private account data'}));\n`;
  await writeFile(join(directory, "claude"), fixture, { mode: 0o700 }); await chmod(join(directory, "claude"), 0o700);
  const old = process.env.PATH; process.env.PATH = directory + delimiter + old;
  try {
    const observations: unknown[] = [];
    const provider = new ClaudeSubscription({ id: "fixture", type: "claude-subscription", models: { fixture: "fixture" } }, async limit => { observations.push(limit); });
    await assert.rejects(async () => { for await (const _ of provider.infer({ model: "fixture", input: "fixture" }, new AbortController().signal)) {} }, error => {
      assert.ok(error instanceof ProviderError); assert.equal(error.code, "usage_limit"); assert.equal(error.status, 429);
      assert.match(error.message, /five-hour usage limit reached/); assert.ok(error.message.includes(new Date(reset * 1000).toISOString())); assert.ok(!error.message.includes("private account data")); return true;
    });
    assert.deepEqual(observations, [{ status: "rejected", window: "five_hour", resetsAt: reset }]);
  } finally { if (old === undefined) delete process.env.PATH; else process.env.PATH = old; await rm(directory, { recursive: true, force: true }); }
});

test("Claude usage metadata accepts native enums and epoch seconds only", () => {
  const event = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1791825000, private: "secret" } };
  assert.deepEqual(claudeUsageEvent(event), { status: "rejected", window: "five_hour", resetsAt: 1791825000 });
  assert.equal(claudeUsageEvent({ ...event, type: "assistant" }), undefined);
  for (const patch of [{ resetsAt: 1791825000000 }, { resetsAt: "1791825000" }, { status: "secret" }, { rateLimitType: "secret" }]) {
    assert.equal(claudeUsageEvent({ ...event, rate_limit_info: { ...event.rate_limit_info, ...patch } }), undefined);
  }
});

const allowed = { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt: 1791825000 } };
const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1791825000 } };
const failureOf = (lines: Array<Record<string, unknown>>) => {
  const stream = new ClaudeMessageStream({ tools: [], summaryVisible: false });
  try { for (const line of lines) stream.accept(line); } catch (error) { assert.ok(error instanceof ProviderError); return error; }
  assert.fail("the stream did not fail");
};

test("a Claude rate_limit is a final usage limit only after a rejected rate_limit_event", () => {
  // The CLI's subscriber capacity 429: "Server is temporarily limiting requests (not your usage limit)".
  const throttle = { type: "assistant", error: "rate_limit", apiErrorIsTransient: true, message: { content: [{ type: "text", text: "private account data" }] } };
  for (const lines of [[throttle], [allowed, throttle], [allowed, { ...throttle, apiErrorIsTransient: undefined }], [rejected, throttle]]) {
    const error = failureOf(lines);
    assert.equal(error.code, "rate_limit_exceeded"); assert.equal(error.status, 429); assert.equal(streamFailureCode(error), "rate_limit_exceeded", "Codex retries a throttle");
    assert.equal(error.upstream?.code, "rate_limit"); assert.ok(!error.message.includes("private account data"));
  }
  const limit = failureOf([rejected, { ...throttle, apiErrorIsTransient: undefined }]);
  assert.equal(limit.code, "usage_limit"); assert.equal(streamFailureCode(limit), "invalid_prompt", "a subscription limit stops Codex at once");
  assert.match(limit.message, /five-hour usage limit reached/);
});

test("a Claude result that says it is not the usage limit stays retryable", () => {
  const limit = { status: "rejected", window: "five_hour", resetsAt: 1791825000 } as const;
  const transient = { type: "result", subtype: "success", is_error: true, result: "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited" };
  for (const value of [undefined, limit]) {
    const error = claudeResultFailure(transient, value);
    assert.equal(error.code, "rate_limit_exceeded"); assert.equal(streamFailureCode(error), "rate_limit_exceeded");
  }
  const reached = { type: "result", subtype: "success", is_error: true, result: "Claude usage limit reached" };
  assert.equal(claudeResultFailure(reached).code, "rate_limit_exceeded", "without a rejected event the limit is not proven");
  assert.equal(claudeResultFailure(reached, limit).code, "usage_limit");
  assert.equal(failureOf([rejected, reached]).code, "usage_limit");
});
