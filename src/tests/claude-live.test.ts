import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { ClaudeSession, sessionLimits } from "../providers/claude-session.js";

const tools = ["alpha", "beta"].map(name => ({ type: "function" as const, name, description: `Tool ${name}`, parameters: { type: "object", properties: { id: { type: "number" } } } }));
const thread: InferenceContext = { threadId: "thread-1" };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kind = (event: InferenceEvent) => event.type === "tool" ? `tool:${event.call.function.name}` : event.type;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Waits however long it takes: a process that is never stopped fails its test by the test's timeout, and a loaded machine fails nothing.
async function gone(pid: number): Promise<boolean> {
  while (alive(pid)) await sleep(10);
  return true;
}
/** Polls until `check` holds, with no bound of its own (see `gone`). */
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> { while (!(await check())) await sleep(10); }
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
// Session directories live in the shared temporary directory; a per-process provider id keeps concurrent suites apart.
const providerId = `claude-${process.pid}`;
const sessionKey = (threadId: string) => createHash("sha256").update(`${providerId}\0\0${threadId}`).digest("hex");
const adapter = (sessions: Record<string, unknown> = {}, onUsage?: (limit: ClaudeLimit) => Promise<void>) => new ClaudeSubscription({ id: providerId, type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "live", warmup: 0, ...sessions } }, onUsage);

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
// Telemetry appends are asynchronous and sessions end in the background. Whatever still settles after the sessions are stopped writes its
// telemetry into the suite's own folder from here on, never into the fixture folder that is about to be removed; what was already
// queued for the fixture folder lands before it goes.
async function teardown(f: ClaudeFixture): Promise<void> {
  await claudeLive({ max: 6, parkMinutes: 60 }).stop();
  configureTelemetry(join(tmpdir(), "claude-live-late"), "test"); await flushTelemetry(); await f.restore();
}
const pids = async (f: ClaudeFixture, mode = "live") => (await f.capture()).filter(entry => entry.start === mode).map(entry => entry.pid);

test("a tool loop keeps one CLI process, relays the caller's outputs verbatim and reports per-request usage", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ text: "Checking", calls: [{ tool: "alpha", input: { id: 1 } }, { tool: "beta", input: { id: 2 } }] }, { text: "Done" }] });
  try {
    const limits: ClaudeLimit[] = [];
    const provider = adapter({}, async limit => { limits.push(limit); }); const first = [user("Use alpha and beta")];
    // A gateway started from a Claude Code shell must not hand that session's variables to its CLIs.
    const host = { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT };
    Object.assign(process.env, { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" });
    const a = await turn(provider, first).finally(() => { for (const [name, value] of Object.entries(host)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
    assert.deepEqual(a.events.map(kind), ["text", "text", "tool:alpha", "tool:beta", "done"]);
    const ended = a.events.at(-1); assert.ok(ended?.type === "done" && ended.accounting?.cacheWriteTokens === 10, "a live session reports its cache writes for the usage ledger");
    await eventually(() => limits.length > 0);
    assert.equal(limits.length, 1, "a rate limit printed after the request ended still reaches the provider");
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "result")]);
    assert.equal(b.text, "Done");
    const capture = await f.capture();
    assert.equal((await pids(f)).length, 1, "both requests used one CLI process");
    assert.deepEqual(capture.filter(entry => entry.toolResult !== undefined).map(entry => entry.toolResult), ["result:alpha", "result:beta"]);
    assert.deepEqual(capture.filter(entry => entry.control).map(entry => entry.control), ["initialize"]);
    const start = capture.find(entry => entry.start)!; const mcp = capture.find(entry => entry.mcpTools)!;
    assert.deepEqual([start.advisorOff, start.toolSearchOff, mcp.mcpTools, mcp.maxResult], [true, true, 2, 2000000], "only gateway tools, with large results allowed");
    assert.deepEqual(start.claudeVars, ["CLAUDE_CODE_DISABLE_ADVISOR_TOOL", "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT"], "only the gateway's own Claude Code variables");
    const events = await sessions();
    assert.deepEqual(events.map(entry => [entry.outcome, entry.cacheReadTokens, entry.cacheWriteTokens, entry.outputTokens]), [["spawned", 100, 10, 7], ["continued", 100, 10, 7]]);
  } finally { await teardown(f); }
});

test("the next user turn sends only its new items, even after restored reasoning summaries", { timeout: 30000 }, async () => {
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

test("editing an earlier message answers one-shot, stops the old process and starts no new one", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ text: "One" }, { text: "Two" }] });
  try {
    const provider = adapter();
    const a = await turn(provider, [user("first")]);
    const b = await turn(provider, [user("first, edited"), ...a.output, user("second")]);
    assert.equal(b.text, "Two", "the one-shot path answered");
    const [old, ...others] = await pids(f);
    assert.deepEqual(others, [], "a second cache write in a new process would only repeat what the one-shot path already pays");
    assert.ok(await gone(old), "the diverged session exits");
    assert.equal((await pids(f, "oneshot")).length, 1);
    const events = await sessions();
    assert.equal(events.filter(entry => entry.outcome === "reseeded").length, 0);
    const held = events.find(entry => entry.outcome === "fallback")!;
    assert.deepEqual([held.missReason, typeof held.threadKey], ["prefix_diverged", "string"]);
  } finally { await teardown(f); }
});

test("an effort change between turns keeps the process; thinking off reseeds and a change while tools run answers one-shot", { timeout: 30000 }, async () => {
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
    const events = await sessions();
    assert.deepEqual(events.filter(entry => entry.outcome === "reseeded").map(entry => entry.missReason), ["fingerprint_changed"]);
    assert.deepEqual(events.filter(entry => entry.outcome === "fallback").map(entry => entry.missReason), ["effort_midturn"], "a forced downgrade serves this request one-shot");
    assert.equal((await pids(f)).length, 3, "two threads and one reseed; the held thread started no process");
  } finally { await teardown(f); }
});

test("cancelling text interrupts and keeps the session; the next history may keep or drop the partial text", { timeout: 30000 }, async () => {
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

test("cancelling while a tool call is being written closes the session", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ slowTool: "alpha" }] });
  try {
    const controller = new AbortController(); const request = turn(adapter(), [user("call slowly")], { controller });
    await eventually(async () => (await f.capture()).some(entry => entry.user !== undefined));
    // The gateway has read the start of the tool call (the session knows a call is being written) before the request is cancelled.
    const session = claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0] as unknown as { messageTool: boolean };
    await eventually(() => session.messageTool === true); controller.abort();
    await assert.rejects(request, { code: "cancelled" });
    const [pid] = await pids(f);
    assert.ok(await gone(pid));
    assert.deepEqual((await sessions()).map(entry => [entry.outcome, entry.missReason]), [["interrupted", undefined], ["closed", "interrupted_tool"]]);
  } finally { await teardown(f); }
});

test("losing the relay kills the CLI with SIGKILL before any tool result is written", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ calls: [{ tool: "alpha", input: { id: 1 } }] }] });
  try {
    await turn(adapter(), [user("call")]);
    const [session] = claudeLive({ max: 6, parkMinutes: 60 }).sessions(); const [pid] = await pids(f);
    session.relay!.close();
    assert.ok(await gone(pid), "the MCP child's deadman killed the CLI");
    await sleep(50);
    const capture = await f.capture();
    assert.equal(capture.some(entry => entry.toolResult !== undefined || entry.exit !== undefined), false);
    const crash = (await sessions()).find(entry => entry.outcome === "crashed")!;
    assert.deepEqual([crash.missReason, crash.exitSignal], ["exited", "SIGKILL"]);
  } finally { await teardown(f); }
});

test("a CLI tool_use for a non-gateway tool fails the request and kills the session before it can run", { timeout: 30000 }, async () => {
  const { f } = await setup({ replies: [{ foreign: "Bash" }] });
  try {
    await assert.rejects(turn(adapter(), [user("run")]), (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call" && error.upstream?.code === "native_builtin_tool");
    const [pid] = await pids(f);
    assert.ok(await gone(pid));
    assert.equal((await f.capture()).some(entry => entry.exit !== undefined), false, "killed, not asked to end its session");
  } finally { await teardown(f); }
});

test("at capacity a cold session makes room, a generating one never does", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ text: "one" }, { slow: true }, { text: "fallback" }] });
  try {
    const provider = adapter({ max: 1 });
    await turn(provider, [user("first")]);
    const [first] = await pids(f);
    // A session that still has its cache is not worth taking one from, so only a cold one may be evicted.
    claudeLive({ max: 1, parkMinutes: 60 }).sessions()[0]!.lastUse = Date.now() - 61 * 60 * 1000;
    const controller = new AbortController(); const events: InferenceEvent[] = [];
    const slow = (async () => { for await (const event of provider.infer({ model: "fixture", input: [user("slow")], tools }, controller.signal, { threadId: "thread-2" })) events.push(event); })();
    while (!events.length) await sleep(10);
    assert.ok(await gone(first), "the cold session made room");
    const third = await turn(provider, [user("third")], { context: { threadId: "thread-3" } });
    assert.equal(third.text, "fallback");
    controller.abort(); await assert.rejects(slow, { code: "cancelled" });
    assert.deepEqual((await f.capture()).filter(entry => entry.start).map(entry => entry.start), ["live", "live", "oneshot"], "the running turn kept its slot and the newcomer replayed");
    assert.ok((await sessions()).some(entry => entry.outcome === "evicted"));
  } finally { await teardown(f); }
});

test("a parked session is reaped when its timer fires, and the probe stops reporting it", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ calls: [{ tool: "alpha", input: { id: 1 } }] }] });
  try {
    await turn(adapter({ parkMinutes: 60 }), [user("park")]);
    assert.equal(runtimeBusy(), true, "a recent tool wait keeps idle restarts away");
    const [pid] = await pids(f);
    // Only now does the park timer become short, so the order is exact: the session was parked and busy, then reaped.
    claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0]!.park(50);
    assert.ok(await gone(pid));
    assert.equal(runtimeBusy(), false);
    assert.ok((await sessions()).some(entry => entry.outcome === "reaped"));
  } finally { await teardown(f); }
});

test("module copies share one registry; another interface version is not reused", { timeout: 30000 }, async () => {
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

test("a CLI that exits at spawn falls back to one-shot with spawn_failed", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ text: "one-shot" }], exitAtSpawn: true });
  try {
    assert.equal((await turn(adapter(), [user("hi")])).text, "one-shot");
    assert.deepEqual((await f.capture()).filter(entry => entry.start).map(entry => entry.start), ["live", "oneshot"]);
    assert.deepEqual((await sessions()).map(entry => [entry.outcome, entry.missReason]), [["fallback", "spawn_failed"]]);
    assert.equal(existsSync(join(tmpdir(), "gateway-claude", sessionKey("thread-1").slice(0, 16))), false, "a failed start leaves no thread directory behind");
  } finally { await teardown(f); }
});

test("a live CLI that dies before its first event falls back to one-shot with stream_failed", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ text: "one-shot" }], exitAtFirstUser: true });
  try {
    assert.equal((await turn(adapter(), [user("hi")])).text, "one-shot");
    assert.deepEqual((await f.capture()).filter(entry => entry.start).map(entry => entry.start), ["live", "oneshot"]);
    assert.ok((await sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "stream_failed"));
  } finally { await teardown(f); }
});

test("compaction requests and requests without a thread run one-shot", { timeout: 30000 }, async () => {
  const { f } = await setup({ replies: [{ text: "a" }, { text: "b" }] });
  try {
    await turn(adapter(), [user("compact")], { context: { threadId: "thread-1", requestKind: "compaction" } });
    await turn(adapter(), [user("no thread")], { context: {} });
    assert.deepEqual((await f.capture()).filter(entry => entry.start).map(entry => entry.start), ["oneshot", "oneshot"]);
  } finally { await teardown(f); }
});

test("a request for a thread that is still generating falls back", { timeout: 30000 }, async () => {
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

test("session files of a dead gateway process are swept; a live owner's stay", { timeout: 30000 }, async () => {
  const { mkdir, readdir, writeFile, rm } = await import("node:fs/promises");
  const { sweepSessionDirectories } = await import("../providers/claude-session.js");
  const key = join(tmpdir(), "gateway-claude", `feedface${process.pid.toString(16).padStart(8, "0")}`);
  const dead = join(key, `${(2 ** 22 + 12345).toString(36)}-0000`), live = join(key, `${process.pid.toString(36)}-0001`), work = join(key, "work");
  try {
    for (const path of [dead, live, work]) { await mkdir(path, { recursive: true }); await writeFile(join(path, "mcp.json"), "{}"); }
    await sweepSessionDirectories();
    assert.deepEqual((await readdir(key)).sort(), [`${process.pid.toString(36)}-0001`, "work"].sort());
  } finally { await rm(key, { recursive: true, force: true }); }
});

test("shutdown closes idle sessions at once and a running one when its turn ends", { timeout: 30000 }, async () => {
  const { f } = await setup({ replies: [{ text: "idle" }, { slow: true }] });
  try {
    const provider = adapter();
    await turn(provider, [user("first")]);
    const controller = new AbortController(); const events: InferenceEvent[] = [];
    const slow = (async () => { for await (const event of provider.infer({ model: "fixture", input: [user("slow")], tools }, controller.signal, { threadId: "thread-2" })) events.push(event); })();
    while (!events.length) await sleep(10);
    const [idle, running] = await pids(f);
    await runShutdownHooks(3000);
    assert.ok(await gone(idle)); assert.equal(alive(running), true, "the running turn continues");
    controller.abort(); await assert.rejects(slow, { code: "cancelled" });
    assert.ok(await gone(running), "and its session closes once the turn has ended");
  } finally { await teardown(f); }
});

test("a follow-up sent the moment done arrives continues the session instead of racing it", { timeout: 30000 }, async () => {
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

test("a CLI whose MCP child never says hello falls back before any user message is sent", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ text: "one-shot" }], noMcp: true });
  const previous = sessionLimits.startMs; sessionLimits.startMs = 3000;
  try {
    assert.equal((await turn(adapter(), [user("hi")])).text, "one-shot");
    const capture = await f.capture(); const [live] = await pids(f);
    assert.equal(capture.some(entry => entry.pid === live && entry.user !== undefined), false, "the live CLI never got the seed");
    assert.deepEqual((await sessions()).map(entry => [entry.outcome, entry.missReason]), [["fallback", "spawn_failed"]]);
    assert.ok(await gone(live));
  } finally { sessionLimits.startMs = previous; await teardown(f); }
});

test("text between tool calls continues the session: the ledger echoes the text as the caller received it", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ text: "Checking", calls: [{ tool: "alpha", input: { id: 1 } }, { tool: "beta", input: { id: 2 } }], between: "Then beta" }, { text: "Done" }] });
  try {
    const provider = adapter(); const first = [user("Use alpha, then beta")];
    const a = await turn(provider, first);
    assert.deepEqual(a.events.filter(event => event.type === "tool").map(kind), ["tool:alpha", "tool:beta"]);
    assert.ok(a.text.startsWith("Checking") && a.text.endsWith("Then beta"));
    assert.equal((await turn(provider, [...first, ...a.output, ...outputFor(a.output, "result")])).text, "Done");
    assert.deepEqual((await sessions()).map(entry => entry.outcome), ["spawned", "continued"]);
  } finally { await teardown(f); }
});

test("a kept partial whose text resumed after thinking continues the session", { timeout: 30000 }, async () => {
  const { f, sessions } = await setup({ replies: [{ slow: true, text: "Intro", thinking: "pause" }, { text: "After keep" }] });
  try {
    const provider = adapter(); const first = [user("long")]; let partial = "";
    await assert.rejects((async () => { const controller = new AbortController(); for await (const event of provider.infer(restoreReasoning({ model: "fixture", input: first, tools }, "scope"), controller.signal, thread)) { if (event.type === "text") partial += event.text; if (partial.includes("more more")) controller.abort(); } })(), { code: "cancelled" });
    const b = await turn(provider, [...first, { type: "message", role: "assistant", content: [{ type: "output_text", text: partial }] }, user("go on")]);
    assert.equal(b.text, "After keep");
    assert.deepEqual((await sessions()).map(entry => entry.outcome), ["interrupted", "continued"]);
  } finally { await teardown(f); }
});

test("a non-gateway tool_use kills the session at once, even while the caller is not reading", { timeout: 30000 }, async () => {
  const { f } = await setup({ replies: [{ text: "Looking", foreign: "Bash" }] });
  try {
    const iterator = adapter().infer({ model: "fixture", input: [user("run")], tools }, new AbortController().signal, thread)[Symbol.asyncIterator]();
    const first = await iterator.next().catch((error: unknown) => error);
    const [pid] = await pids(f); assert.ok(pid, "a live session served the request");
    assert.ok(await gone(pid), "killed before the consumer pulled the tool_use line");
    await assert.rejects(async () => { if (first instanceof Error) throw first; for (let next = await iterator.next(); !next.done; next = await iterator.next()); },
      (error: unknown) => error instanceof ProviderError && error.code === "invalid_tool_call" && error.upstream?.code === "native_builtin_tool");
  } finally { await teardown(f); }
});

test("a session retired during a turn closes when that turn is cancelled after its result was read", { timeout: 30000 }, async () => {
  const { f } = await setup({ replies: [{ text: "Finished early" }] });
  try {
    const controller = new AbortController();
    const iterator = adapter().infer({ model: "fixture", input: [user("hi")], tools }, controller.signal, thread)[Symbol.asyncIterator]();
    await iterator.next();
    // The result line has been read into the request's queue, though nobody asked for it yet.
    const session = claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0] as unknown as { attached?: { queue: Array<{ type?: unknown }> } };
    await eventually(() => session.attached?.queue.some(message => message.type === "result") === true);
    await runShutdownHooks(3000);
    const [pid] = await pids(f); assert.equal(alive(pid), true, "the running turn keeps its session");
    controller.abort();
    await assert.rejects(iterator.next(), { code: "cancelled" });
    assert.ok(await gone(pid), "the retired session closes with the turn");
  } finally { await teardown(f); }
});

test("each provider's park time applies to its own sessions, whatever another provider sent since", { timeout: 30000 }, async () => {
  const { f } = await setup({ replies: [{ calls: [{ tool: "alpha", input: { id: 1 } }] }, { calls: [{ tool: "alpha", input: { id: 1 } }] }] });
  // A session is parked when its request starts, before its park timer can have fired, so that call names the process and the park
  // time of each session. Sampling the registry afterwards would race the 240 ms park, which can end before a loaded runner resumes.
  const parked = new Map<string, { pid: number; ms: number }>(); const park = ClaudeSession.prototype.park;
  ClaudeSession.prototype.park = function (this: ClaudeSession, ms: number) { if (this.pid) parked.set(this.key, { pid: this.pid, ms }); return park.call(this, ms); };
  try {
    // The second provider's request arrives while the first one's process is still starting.
    await Promise.all([turn(adapter({ parkMinutes: 0.004 }), [user("short")]), turn(adapter({ parkMinutes: 60 }), [user("long")], { context: { threadId: "thread-2" } })]);
    const short = parked.get(sessionKey("thread-1")); const long = parked.get(sessionKey("thread-2"));
    assert.equal(short?.ms, 240, "the first provider's park time"); assert.equal(long?.ms, 60 * 60000, "the second provider's park time");
    assert.ok(await gone(short!.pid), "the short park reaps its session");
    assert.equal(alive(long!.pid), true, "the long park keeps the other one");
  } finally { ClaudeSession.prototype.park = park; await teardown(f); }
});
