import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { sessionKey } from "../providers/claude-live-contract.js";
import { replayPinned, sessionRegistry } from "../providers/claude-session-registry.js";
import { ProviderError } from "../providers/provider.js";
import { providerLimit, queuedLimit } from "../providers/claude-native-output.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { installClaudeFixture, type FixtureScenario } from "./claude-cli-fixture.js";
import type { ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

/**
 * A usage or rate limit judges the account, not the CLI. Before any output it changed nothing in the CLI's history,
 * so it must surface as the limit and leave no one-hour crash hold (seen as repeated session_dead on 14 Nov 2026).
 */
const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: text });
const limited = (error: unknown) => error instanceof ProviderError && error.code === "rate_limit_exceeded";

async function harness(name: string, scenario: FixtureScenario) {
  const fixture = await installClaudeFixture(scenario);
  const id = `limit-recovery-${name}-${process.pid}`;
  const provider = new ClaudeSubscription({ id, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const key = sessionKey(`${id}\0`, name);
  const turn = async (input: ResponsesInputItem[], extra: Partial<ResponsesRequest> = {}) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, ...extra } as ResponsesRequest, new AbortController().signal, { threadId: name })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  const starts = async () => (await fixture.capture()).flatMap(entry => entry.start ? [entry.start] : []);
  return { turn, starts, hold: () => replayPinned(sessionRegistry(), key), done: async () => { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await fixture.restore(); } };
}

test("only native provider limits qualify, and only as the first queued terminal frame", () => {
  const limit = { type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "limit" }] } };
  assert.equal(queuedLimit([{ type: "system", subtype: "status" }, limit])?.code, "rate_limit_exceeded");
  assert.equal(queuedLimit([{ type: "assistant", error: "billing_error", message: { content: [] } }])?.code, "insufficient_quota");
  assert.equal(queuedLimit([{ type: "result", subtype: "success", is_error: false }, limit]), undefined);
  assert.equal(queuedLimit([{ type: "assistant", error: "invalid_request", message: { content: [] } }]), undefined);
  assert.equal(providerLimit(new ProviderError("rate_limit_exceeded", "x", 429)), false, "a limit without a native Claude envelope is not trusted");
});

test("a rate limit before any output leaves no hold, and the next message continues live", { timeout: 30000 }, async () => {
  const h = await harness("before-output", { replies: [{ failureCode: "rate_limit" }, { text: "back again" }] });
  try {
    await assert.rejects(h.turn([user("first")]), limited);
    assert.equal(h.hold(), undefined, "no crash hold, so no session_dead");
    assert.match(JSON.stringify(await h.turn([user("first"), user("retry")])), /back again/);
    assert.deepEqual(await h.starts(), ["live", "live"], "a fresh live session, never a one-shot replay");
  } finally { await h.done(); }
});

test("a rate limit after delivered tool results keeps the crash hold", { timeout: 30000 }, async () => {
  const h = await harness("after-outputs", { replies: [{ calls: [{ tool: "read", input: {} }] }, { failureCode: "rate_limit" }, { text: "must not run" }] });
  try {
    const first = [user("Read")], output = await h.turn(first, { tools });
    const results = output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "tool result" }] : []);
    await assert.rejects(h.turn([...first, ...output, ...results], { tools }), limited);
    assert.equal(h.hold(), "crashed");
    assert.deepEqual(await h.starts(), ["live"]);
  } finally { await h.done(); }
});
