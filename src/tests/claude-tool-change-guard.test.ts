import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import { ResponsesWriter } from "../protocol/responses.js";
import type { ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

const tool = (name: string) => ({ type: "function" as const, name, parameters: { type: "object", properties: {} } });
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: text });

// 8 November 2026: a resumed large chat seeded cold, Codex then added its MCP tools, and the
// guard stopped the next request although it would have continued the reseeded session.
for (const guarded of [false, true]) test(`a tool-catalog reseed after a cold seed lets the warm continuation run${guarded ? " through the shared guard" : ""}`, { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ cache: true, replies: [{ text: "one" }, { text: "two" }, { text: "three" }] });
  configureTelemetry(fixture.directory, "test"); const since = Date.now();
  const provider = new ClaudeSubscription({ id: `tool-change-${guarded}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[], names: string[]) => {
    const writer = new ResponsesWriter("fixture", () => {});
    const request: ResponsesRequest = { model: "fixture", input, tools: names.map(tool) };
    const context = { threadId: "tool-change" }, signal = new AbortController().signal;
    const events = guarded ? cacheGuardedInference(provider, request, signal, context, `tool-change-scope-${process.pid}`) : provider.infer(request, signal, context);
    for await (const event of events) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    const first = [user("a".repeat(400000))];
    const a = await turn(first, ["read"]);
    const second = [...first, ...a, user("next")];
    const b = await turn(second, ["read", "write"]);
    const third = [...second, ...b, user("again")];
    await assert.doesNotReject(turn(third, ["read", "write"]));
    await flushTelemetry();
    const sessions = (await readTelemetry(fixture.directory, since)).filter(entry => entry.event === "claude_session").map(entry => entry.outcome);
    assert.deepEqual(sessions.filter(outcome => outcome !== "closed"), ["spawned", "reseeded", "continued"]);
    assert.deepEqual((await fixture.capture()).flatMap(entry => entry.start ? [entry.start] : []), ["live", "live"], "the continuation started no new CLI");
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore();
  }
});
