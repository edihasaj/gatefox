import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { claudeFailure } from "../providers/claude-errors.js";
import { ClaudeSubscription } from "../providers/claude.js";
import { ProviderError } from "../providers/provider.js";
import { claudeUsageEvent } from "../providers/claude-usage.js";

test("native Claude rate-limit, authentication, billing and server errors survive opaque result text", () => {
  for (const [code, expected, status] of [["rate_limit", "usage_limit", 429], ["authentication_failed", "authentication", 401], ["billing_error", "insufficient_quota", 429], ["server_error", "upstream_unavailable", 503]] as const) {
    const error = claudeFailure({ type: "assistant", error: code, message: { content: [{ type: "text", text: "private account data" }] } })!;
    assert.equal(error.code, expected); assert.equal(error.status, status);
    assert.ok(!JSON.stringify(error).includes("private account data"));
  }
  const result = claudeFailure({ type: "result", is_error: true, subtype: "success", result: "private account data" })!;
  assert.equal(result.code, "inference_failed"); assert.equal(result.upstream?.subtype, "success");
  assert.equal(claudeFailure({ type: "assistant", message: { content: [{ type: "text", text: "rate_limit" }] } }), undefined);
  assert.equal(claudeFailure({ type: "result", is_error: false, subtype: "success", result: "rate_limit" }), undefined);
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
