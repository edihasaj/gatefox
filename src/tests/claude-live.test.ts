import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { ProviderError, type InferenceContext } from "../providers/provider.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { runShutdownHooks, runtimeBusy } from "../runtime-activity.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture, type ClaudeFixture, type FixtureScenario } from "./claude-cli-fixture.js";
import type { InferenceEvent, ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";
import type { ClaudeLimit } from "../providers/claude-usage.js";
import { sessionLimits } from "../providers/claude-session.js";

const tools = ["alpha", "beta"].map(name => ({ type: "function" as const, name, description: `Tool ${name}`, parameters: { type: "object", properties: { id: { type: "number" } } } }));
const thread: InferenceContext = { threadId: "thread-1" };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kind = (event: InferenceEvent) => event.type === "tool" ? `tool:${event.call.function.name}` : event.type;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function gone(pid: number, withinMs: number): Promise<boolean> {
  const started = Date.now();
  while (alive(pid)) { if (Date.now() - started > withinMs) return false; await sleep(10); }
  return true;
}
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const adapter = (sessions: Record<string, unknown> = {}, onUsage?: (limit: ClaudeLimit) => Promise<void>) => new ClaudeSubscription({ id: "claude", type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live", ...sessions } }, onUsage);

/** One request as the server runs it, plus the output items Codex would replay next time. */
async function turn(provider: ClaudeSubscription, input: ResponsesInputItem[], options: { context?: InferenceContext; effort?: string; signal?: AbortSignal; abortAfterTexts?: number; controller?: AbortController } = {}) {
  const request: ResponsesRequest = { model: "fixture", input, tools, ...(options.effort ? { reasoning: { effort: options.effort } } : {}) };
  const events: InferenceEvent[] = []; const writer = new ResponsesWriter("fixture", () => {});
  const controller = options.controller ?? new AbortController();
  for await (const event of provider.infer(restoreReasoning(request, "scope"), controller.signal, options.context ?? thread)) {
    events.push(event); writer.accept(event);
    if (options.abortAfterTexts && events.filter(entry => entry.type === "text").length === options.abortAfterTexts) controller.abort();
  }
  return { events, output: writer.result().output as ResponsesInputItem[], text: events.flatMap(event => event.type === "text" ? [event.text] : []).join("") };
}
const outputFor = (output: ResponsesInputItem[], result: string): ResponsesInputItem[] =>
  output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: `${result}:${item.name}` }] : []);

async function setup(scenario: FixtureScenario): Promise<{ f: ClaudeFixture; since: number; sessions: () => Promise<Array<Record<string, unknown>>> }> {
  const f = await installClaudeFixture(scenario);
  configureTelemetry(f.directory, "test"); const since = Date.now();
  return { f, since, sessions: async () => { await flushTelemetry(); return (await readTelemetry(f.directory, since)).filter(entry => entry.event === "claude_session"); } };
}
async function teardown(f: ClaudeFixture): Promise<void> { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await f.restore(); }
const pids = async (f: ClaudeFixture, mode = "live") => (await f.capture()).filter(entry => entry.start === mode).map(entry => entry.pid);

test("a tool loop keeps one CLI process, relays the caller's outputs verbatim and reports per-request usage", async () => {
  const { f, sessions } = await setup({ replies: [{ text: "Checking", calls: [{ tool: "alpha", input: { id: 1 } }, { tool: "beta", input: { id: 2 } }] }, { text: "Done" }] });
  try {
    const limits: ClaudeLimit[] = [];
    const provider = adapter({}, async limit => { limits.push(limit); }); const first = [user("Use alpha and beta")];
    const a = await turn(provider, first);
    assert.deepEqual(a.events.map(kind), ["text", "text", "tool:alpha", "tool:beta", "done"]);
    await sleep(100);
    assert.equal(limits.length, 1, "a rate limit printed after the request ended still reaches the provider");
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "result")]);
    assert.equal(b.text, "Done");
    const capture = await f.capture();
    assert.equal((await pids(f)).length, 1, "both requests used one CLI process");
    assert.deepEqual(capture.filter(entry => entry.toolResult !== undefined).map(entry => entry.toolResult), ["result:alpha", "result:beta"]);
    assert.deepEqual(capture.filter(entry => entry.control).map(entry => entry.control), ["initialize"]);
    const start = capture.find(entry => entry.start)!; const mcp = capture.find(entry => entry.mcpTools)!;
    assert.deepEqual([start.advisorOff, start.toolSearchOff, mcp.mcpTools, mcp.maxResult], [true, true, 2, 2000000], "only gateway tools, with large results allowed");
    const events = await sessions();
    assert.deepEqual(events.map(entry => [entry.outcome, entry.cacheReadTokens, entry.cacheWriteTokens, entry.outputTokens]), [["spawned", 100, 10, 7], ["continued", 100, 10, 7]]);
  } finally { await teardown(f); }
});

test("the next user turn sends only its new items, even after restored reasoning summaries", async () => {
  const { f } = await setup({ replies: [{ thinking: "plan", text: "Calling", calls: [{ tool: "alpha", input: { id: 1 } }] }, { thinking: "check", text: "Done" }, { text: "Second" }] });
  try {
    const provider = adapter(); const first = [user("Use alpha")];
    const a = await turn(provider, first);
    assert.ok(a.output.some(item => item.type === "reasoning"), "Codex replays Claude's reasoning as summaries");
    const second = [...first, ...a.output, ...outputFor(a.output, "result")];
    const b = await turn(provider, second);
    const third = [...second, ...b.output, user("Next question")];
    const c = await turn(provider, third);
    assert.equal(c.text, "Second");
    const messages = responsesToChatRequest(restoreReasoning({ model: "fixture", input: third }, "scope")).messages;
    assert.ok(messages.filter(message => message.role === "assistant" && typeof message.content === "string" && !message.tool_calls).length >= 2);
    const users = (await f.capture()).filter(entry => entry.user !== undefined);
    assert.equal(users.length, 2); assert.equal((await pids(f)).length, 1);
    assert.deepEqual(users[1].heads, [`<<item ${messages.length} user>>`], "only the new user message, numbered in the conversation");
  } finally { await teardown(f); }
});

test("editing an earlier message reseeds in a new process and stops the old one", async () => {
  const { f, sessions } = await setup({ replies: [{ text: "One" }, { text: "Two" }] });
  try {
    const provider = adapter();
    const a = await turn(provider, [user("first")]);
    await turn(provider, [user("first, edited"), ...a.output, user("second")]);
    const [old, fresh] = await pids(f);
    assert.ok(fresh && fresh !== old); assert.ok(await gone(old, 2000), "the old process exits");
    const reseed = (await sessions()).find(entry => entry.outcome === "reseeded")!;
    assert.deepEqual([reseed.missReason, reseed.divergedAt], ["prefix_diverged", 0]);
  } finally { await teardown(f); }
});

test("an effort change between turns keeps the process; thinking off or a change while tools run reseeds", async () => {
  const { f, sessions } = await setup({ replies: [{ text: "A" }, { text: "B" }, { text: "C" }, { calls: [{ tool: "alpha", input: { id: 1 } }] }, { text: "D" }] });
  try {
    const provider = adapter(); const first = [user("one")];
    const a = await turn(provider, first, { effort: "low" });
    const second = [...first, ...a.output, user("two")];
    const b = await turn(provider, second, { effort: "high" });
    assert.deepEqual((await f.capture()).filter(entry => entry.control === "apply_flag_settings").map(entry => entry.effort), ["high"]);
    assert.equal((await pids(f)).length, 1);
    await turn(provider, [...second, ...b.output, user("three")]);
    const other = { threadId: "thread-2" }; const start = [user("tools")];
    const d = await turn(provider, start, { context: other, effort: "low" });
    await turn(provider, [...start, ...d.output, ...outputFor(d.output, "r")], { context: other, effort: "high" });
    assert.deepEqual((await sessions()).filter(entry => entry.outcome === "reseeded").map(entry => entry.missReason), ["fingerprint_changed", "effort_midturn"]);
    assert.equal((await pids(f)).length, 4);
  } finally { await teardown(f); }
});

test("cancelling text interrupts and keeps the session; the next history may keep or drop the partial text", async () => {
  const { f, sessions } = await setup({ replies: [{ slow: true }, { text: "After drop" }, { slow: true }, { text: "After keep" }] });
  try {
    const provider = adapter(); const first = [user("long")];
    await assert.rejects(turn(provider, first, { abortAfterTexts: 2 }), { code: "cancelled" });
    const second = [...first, user("shorter please")];
    const b = await turn(provider, second);
    assert.equal(b.text, "After drop");
    const third = [...second, ...b.output, user("long again")];
    let partial = "";
    await assert.rejects((async () => { const controller = new AbortController(); for await (const event of provider.infer(restoreReasoning({ model: "fixture", input: third, tools }, "scope"), controller.signal, thread)) { if (event.type === "text") partial += event.text; if (partial.length >= 10) controller.abort(); } })(), { code: "cancelled" });
    const d = await turn(provider, [...third, { type: "message", role: "assistant", content: [{ type: "output_text", text: partial }] }, user("go on")]);
    assert.equal(d.text, "After keep");
    assert.equal((await pids(f)).length, 1, "interrupts keep the process");
    assert.deepEqual((await f.capture()).filter(entry => entry.control === "interrupt").length, 2);
    assert.deepEqual((await sessions()).map(entry => entry.outcome), ["interrupted", "continued", "interrupted", "continued"]);
  } finally { await teardown(f); }
});

test("cancelling while a tool call is being written closes the session", async () => {
  const { f, sessions } = await setup({ replies: [{ slowTool: "alpha" }] });
  try {
    const controller = new AbortController(); const request = turn(adapter(), [user("call slowly")], { controller });
    while (!(await f.capture()).some(entry => entry.user !== undefined)) await sleep(10);
    await sleep(60); controller.abort();
    await assert.rejects(request, { code: "cancelled" });
    const [pid] = await pids(f);
    assert.ok(await gone(pid, 2000));
    assert.deepEqual((await sessions()).map(entry => [entry.outcome, entry.missReason]), [["interrupted", undefined], ["closed", "interrupted_tool"]]);
  } finally { await teardown(f); }
});

test("losing the relay kills the CLI with SIGKILL before any tool result is written", async () => {
  const { f, sessions } = await setup({ replies: [{ calls: [{ tool: "alpha", input: { id: 1 } }] }] });
  try {
    await turn(adapter(), [user("call")]);
    const [session] = claudeLive({ max: 6, parkMinutes: 60 }).sessions(); const [pid] = await pids(f);
    session.relay!.close();
    assert.ok(await gone(pid, 2000), "the MCP child's deadman killed the CLI");
    await sleep(50);
    const capture = await f.capture();
    assert.equal(capture.some(entry => entry.toolResult !== undefined || entry.exit !== undefined), false);
    const crash = (await sessions()).find(entry => entry.outcome === "crashed")!;
    assert.deepEqual([crash.missReason, crash.exitSignal], ["exited", "SIGKILL"]);
  } finally { await teardown(f); }
});

test("a CLI tool_use for a non-gateway tool fails the request and kills the session before it can run", async () => {
  const { f } = await setup({ replies: [{ foreign: "Bash" }] });
  try {
    await assert.rejects(turn(adapter(), [user("run")]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call" && error.upstream?.code === "native_builtin_tool");
    const [pid] = await pids(f);
    assert.ok(await gone(pid, 300));
    assert.equal((await f.capture()).some(entry => entry.exit !== undefined), false, "killed, not asked to end its session");
  } finally { await teardown(f); }
});

test("at capacity a finished session is evicted, a generating one never is", async () => {
  const { f, sessions } = await setup({ replies: [{ text: "one" }, { slow: true }, { text: "fallback" }] });
  try {
    const provider = adapter({ max: 1 });
    await turn(provider, [user("first")]);
    const [first] = await pids(f);
    const controller = new AbortController(); const events: InferenceEvent[] = [];
    const slow = (async () => { for await (const event of provider.infer({ model: "fixture", input: [user("slow")], tools }, controller.signal, { threadId: "thread-2" })) events.push(event); })();
    while (!events.length) await sleep(10);
    assert.ok(await gone(first, 2000), "the finished session made room");
    const third = await turn(provider, [user("third")], { context: { threadId: "thread-3" } });
    assert.equal(third.text, "fallback");
    controller.abort(); await assert.rejects(slow, { code: "cancelled" });
    assert.deepEqual((await f.capture()).filter(entry => entry.start).map(entry => entry.start), ["live", "live", "oneshot"]);
    assert.ok((await sessions()).some(entry => entry.outcome === "evicted"));
  } finally { await teardown(f); }
});

test("a parked session is reaped when its timer fires, and the probe stops reporting it", async () => {
  const { f, sessions } = await setup({ replies: [{ calls: [{ tool: "alpha", input: { id: 1 } }] }] });
  try {
    await turn(adapter({ parkMinutes: 0.004 }), [user("park")]);
    assert.equal(runtimeBusy(), true, "a recent tool wait keeps idle restarts away");
    const [pid] = await pids(f);
    assert.ok(await gone(pid, 3000));
    assert.equal(runtimeBusy(), false);
    assert.ok((await sessions()).some(entry => entry.outcome === "reaped"));
  } finally { await teardown(f); }
});

test("module copies share one registry; another interface version is not reused", async () => {
  const { f } = await setup({ replies: [{ text: "one" }] });
  const symbol = Symbol.for("harness-gateway/claude-sessions/v1"); const scope = globalThis as unknown as Record<symbol, unknown>;
  try {
    await turn(adapter(), [user("first")]);
    const copy = await import(new URL("../providers/claude-live.js?copy=1", import.meta.url).href) as typeof import("../providers/claude-live.js");
    assert.equal(copy.claudeLive({ max: 6, parkMinutes: 60 }).sessions().length, 1);
    const registryCopy = await import(new URL("../providers/claude-session-registry.js?copy=1", import.meta.url).href) as typeof import("../providers/claude-session-registry.js");
    assert.equal(registryCopy.sessionRegistry(), scope[symbol], "a second registry module finds the same global registry");
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    const other = { interfaceVersion: 2, sessions: new Map([["other", {}]]) }; scope[symbol] = other;
    assert.equal(copy.claudeLive({ max: 6, parkMinutes: 60 }).sessions().length, 0);
    assert.notEqual(scope[symbol], other, "an incompatible registry is replaced, not reused");
  } finally { await teardown(f); }
});

test("a CLI that exits at spawn falls back to one-shot with spawn_failed", async () => {
  const { f, sessions } = await setup({ replies: [{ text: "one-shot" }], exitAtSpawn: true });
  try {
    assert.equal((await turn(adapter(), [user("hi")])).text, "one-shot");
    assert.deepEqual((await f.capture()).filter(entry => entry.start).map(entry => entry.start), ["live", "oneshot"]);
    assert.deepEqual((await sessions()).map(entry => [entry.outcome, entry.missReason]), [["fallback", "spawn_failed"]]);
  } finally { await teardown(f); }
});

test("compaction requests and requests without a thread run one-shot", async () => {
  const { f } = await setup({ replies: [{ text: "a" }, { text: "b" }] });
  try {
    await turn(adapter(), [user("compact")], { context: { threadId: "thread-1", requestKind: "compaction" } });
    await turn(adapter(), [user("no thread")], { context: {} });
    assert.deepEqual((await f.capture()).filter(entry => entry.start).map(entry => entry.start), ["oneshot", "oneshot"]);
  } finally { await teardown(f); }
});

test("a request for a thread that is still generating falls back", async () => {
  const { f, sessions } = await setup({ replies: [{ slow: true }, { text: "parallel" }] });
  try {
    const provider = adapter(); const controller = new AbortController(); const events: InferenceEvent[] = [];
    const slow = (async () => { for await (const event of provider.infer({ model: "fixture", input: [user("slow")], tools }, controller.signal, thread)) events.push(event); })();
    while (!events.length) await sleep(10);
    assert.equal((await turn(provider, [user("again")])).text, "parallel");
    controller.abort(); await assert.rejects(slow, { code: "cancelled" });
    assert.ok((await sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "concurrent"));
  } finally { await teardown(f); }
});

test("session files of a dead gateway process are swept; a live owner's stay", async () => {
  const { mkdir, readdir, writeFile, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { sweepSessionDirectories } = await import("../providers/claude-session.js");
  const key = join(tmpdir(), "gateway-claude", "feedfacefeedface");
  const dead = join(key, `${(2 ** 22 + 12345).toString(36)}-0000`), live = join(key, `${process.pid.toString(36)}-0001`), work = join(key, "work");
  try {
    for (const path of [dead, live, work]) { await mkdir(path, { recursive: true }); await writeFile(join(path, "mcp.json"), "{}"); }
    await sweepSessionDirectories();
    assert.deepEqual((await readdir(key)).sort(), [`${process.pid.toString(36)}-0001`, "work"].sort());
  } finally { await rm(key, { recursive: true, force: true }); }
});

test("shutdown closes idle sessions at once and a running one when its turn ends", async () => {
  const { f } = await setup({ replies: [{ text: "idle" }, { slow: true }] });
  try {
    const provider = adapter();
    await turn(provider, [user("first")]);
    const controller = new AbortController(); const events: InferenceEvent[] = [];
    const slow = (async () => { for await (const event of provider.infer({ model: "fixture", input: [user("slow")], tools }, controller.signal, { threadId: "thread-2" })) events.push(event); })();
    while (!events.length) await sleep(10);
    const [idle, running] = await pids(f);
    await runShutdownHooks(3000);
    assert.ok(await gone(idle, 2000)); assert.equal(alive(running), true, "the running turn continues");
    controller.abort(); await assert.rejects(slow, { code: "cancelled" });
    assert.ok(await gone(running, 3000), "and its session closes once the turn has ended");
  } finally { await teardown(f); }
});

test("a follow-up sent the moment done arrives continues the session instead of racing it", async () => {
  const { f, sessions } = await setup({ replies: [{ calls: [{ tool: "alpha", input: { id: 1 } }] }, { text: "Done" }] });
  try {
    const provider = adapter(); const first = [user("Use alpha")]; const writer = new ResponsesWriter("fixture", () => {});
    const events = provider.infer({ model: "fixture", input: first, tools }, new AbortController().signal, thread)[Symbol.asyncIterator]();
    let follow: Promise<{ text: string }> | undefined;
    for (let next = await events.next(); !next.done; next = await events.next()) {
      writer.accept(next.value);
      // Like a server that answers before the provider's generator has returned.
      if (next.value.type === "done") { const output = writer.result().output as ResponsesInputItem[]; follow = turn(provider, [...first, ...output, ...outputFor(output, "r")]); await follow; }
    }
    assert.equal((await follow!).text, "Done");
    assert.deepEqual((await sessions()).map(entry => entry.outcome), ["spawned", "continued"]);
  } finally { await teardown(f); }
});

test("a CLI whose MCP child never says hello falls back before any user message is sent", async () => {
  const { f, sessions } = await setup({ replies: [{ text: "one-shot" }], noMcp: true });
  const previous = sessionLimits.startMs; sessionLimits.startMs = 800;
  try {
    assert.equal((await turn(adapter(), [user("hi")])).text, "one-shot");
    const capture = await f.capture(); const [live] = await pids(f);
    assert.equal(capture.some(entry => entry.pid === live && entry.user !== undefined), false, "the live CLI never got the seed");
    assert.deepEqual((await sessions()).map(entry => [entry.outcome, entry.missReason]), [["fallback", "spawn_failed"]]);
    assert.ok(await gone(live, 2000));
  } finally { sessionLimits.startMs = previous; await teardown(f); }
});
