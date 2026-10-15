import test from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "../providers/provider.js";
import { liveLimits } from "../providers/copilot-live.js";
import { adapter, alive, callIds, harness, kind, live, outputFor, sleep, turn, until, user, type Entry } from "./copilot-live-harness.js";

const operations = (entries: Entry[]) => entries.map(entry => entry.op).filter(op => op !== "stdin_closed");
const outcomes = (events: Entry[]) => events.map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));

test("a tool loop keeps one CLI process, answers the waiting call and bills each request on its own", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    assert.deepEqual(a.events.filter(event => event.type !== "usage").map(kind), ["tool:lookup", "done"]);
    const doneA = a.events.at(-1); assert.ok(doneA?.type === "done");
    assert.deepEqual(doneA.usage, { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 } });
    assert.deepEqual(doneA.accounting, { cacheWriteTokens: 100, reasoningTokens: 1, nanoAiu: 1e9, nanoAiuStatus: "complete" });
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "NEXT 2")]);
    const doneB = b.events.at(-1); assert.ok(doneB?.type === "done");
    // Only the second model call: the first call's cache write is not billed again, and the prefix is read from cache.
    assert.deepEqual(doneB.usage, { input_tokens: 200, output_tokens: 5, total_tokens: 205, input_tokens_details: { cached_tokens: 100 } });
    assert.deepEqual(doneB.accounting, { cacheWriteTokens: 10, reasoningTokens: 1, nanoAiu: 1e8, nanoAiuStatus: "complete" });
    const c = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "NEXT 2"), ...b.output, ...outputFor(b.output, "plain")]);
    assert.equal(c.text, "answer 3");

    const entries = await h.log();
    assert.deepEqual(operations(entries), ["create", "session.send", "deliver", "deliver"], "one session; the history is sent once, then only tool outputs");
    assert.equal((await h.pids()).length, 1, "three requests used one CLI process");
    const send = entries.find(entry => entry.op === "session.send")!;
    assert.equal(send.prompts.length, 1); assert.match(send.prompts[0], /^<<item 1 user>>\nstart \[tool\]\n<<\/item>>$/);
    const calls = callIds([...a.output, ...b.output]);
    assert.deepEqual(entries.filter(entry => entry.op === "deliver").map(entry => [entry.toolCallId, entry.result]), [[calls[0], "NEXT 2"], [calls[1], "plain"]]);
    // While the session lives its folder is private, holds the CLI's own temp folder, and nothing else is left in the OS temp folder.
    const [name, ...rest] = await h.liveDirs(); assert.equal(rest.length, 0);
    assert.ok(name.startsWith(`gateway-copilot-live-${process.pid.toString(36)}-`));
    assert.equal((await stat(join(h.scratch, name))).mode & 0o777, 0o700);
    assert.equal(entries[0].tmpdir, join(h.scratch, name, "tmp"), "the CLI stages its temp files inside the session folder");
    assert.ok((await stat(join(h.scratch, name, "session-state", entries[0].params.sessionId, "events.jsonl"))).isFile(), "the CLI's prompt log lives in the private folder");
    const pid = entries[0].pid; await live().stop();
    assert.ok(await until(() => !alive(pid)), "the process ends with the session"); assert.deepEqual(await h.liveDirs(), [], "the prompt log goes with the folder");
  } finally { await h.restore(); }
});

test("parallel tool calls: each output reaches the waiting call it belongs to, whatever order they arrive in", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tools:2]")];
    const a = await turn(provider, first);
    const calls = callIds(a.output); assert.equal(calls.length, 2);
    const reversed = outputFor(a.output, id => `result-for-${id}`).reverse();
    const b = await turn(provider, [...first, ...a.output, ...reversed]);
    assert.match(b.text, /^answer/);
    const delivered = (await h.log()).filter(entry => entry.op === "deliver");
    assert.equal(delivered.length, 2);
    for (const entry of delivered) assert.equal(entry.result, `result-for-${entry.toolCallId}`);
    assert.deepEqual(delivered.map(entry => entry.toolCallId).sort(), [...calls].sort());
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});

test("a continued turn sends only its new items; divergence and changed instructions reseed in a new process", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first);
    const second = [...first, ...a.output, user("more")]; const b = await turn(provider, second);
    let entries = await h.log();
    assert.deepEqual(operations(entries), ["create", "session.send", "session.send"]);
    const more = entries.filter(entry => entry.op === "session.send")[1];
    assert.equal(more.prompts.length, 1); assert.ok(more.prompts[0].startsWith("<<item 3 user>>") && !more.prompts[0].includes("hello"), "the history is not resent");
    const oldPid = entries[0].pid;
    // An earlier message was edited: the session's history no longer matches, so the thread starts a new session.
    const third = [user("hello EDITED"), ...a.output, user("more"), ...b.output, user("again")];
    await turn(provider, third);
    entries = await h.log(); const creates = entries.filter(entry => entry.op === "create");
    assert.equal(creates.length, 2); assert.notEqual(creates[1].pid, oldPid);
    const seed = entries.filter(entry => entry.op === "session.sendMessages"); assert.equal(seed.length, 1);
    assert.equal(seed[0].prompts.length, 5, "the new session is seeded with the whole history, one message per item");
    assert.ok(await until(() => !alive(oldPid)), "the old process is gone");
    assert.equal((await h.liveDirs()).length, 1, "and so is its folder");
    // A changed system prompt is part of the session's identity.
    await turn(provider, [...third, ...b.output, user("fourth")], { extra: { instructions: "Be brief" } });
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 3);
    assert.deepEqual(outcomes(await h.sessions()).filter(value => /^(spawned|continued|reseeded)/.test(value)), ["spawned", "continued", "reseeded:prefix_diverged", "reseeded:fingerprint_changed"]);
  } finally { await h.restore(); }
});

test("the session is created with the caller's instructions, tool names and every confinement", async () => {
  const h = await harness();
  try {
    await turn(adapter(), [user("hi")], { extra: { instructions: "Be brief" } });
    const [create] = (await h.log()).filter(entry => entry.op === "create"); const params = create.params;
    assert.match(params.systemMessage.content, /Caller instructions:\nBe brief/); assert.match(params.systemMessage.content, /"native":"gateway_tool_0"/);
    assert.deepEqual([params.enableSessionStore, params.enableConfigDiscovery, params.requestPermission, params.requestUserInput, params.memory.enabled, params.infiniteSessions.enabled], [false, false, true, false, false, false]);
    assert.deepEqual([params.availableTools, params.allowedModels, params.mcpServers, params.customAgents], [["gateway_tool_0"], ["fixture"], {}, []]);
    assert.equal(params.tools[0].skipPermission, true); assert.equal(params.tools[0].name, "gateway_tool_0");
    assert.deepEqual(params.largeOutput, { enabled: false }, "a large tool result stays inline instead of being saved to a file outside the session folder");
    assert.equal(params.configDir, params.workingDirectory); assert.equal(params.configDir, create.directory); assert.ok(create.directory.startsWith(h.scratch));
    assert.equal(params.reasoningEffort, undefined);
  } finally { await h.restore(); }
});

test("an effort change between turns switches in place; one while tools wait starts a new session", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const second = [...first, ...a.output, user("more [tool]")];
    const b = await turn(provider, second, { extra: { reasoning: { effort: "high" } } });
    let entries = await h.log();
    assert.deepEqual(entries.filter(entry => entry.op === "switch").map(entry => entry.effort), ["high"]);
    assert.equal(entries.filter(entry => entry.op === "create").length, 1, "the cache survives an effort change");
    await turn(provider, [...second, ...b.output, ...outputFor(b.output, "plain")], { extra: { reasoning: { effort: "low" } } });
    entries = await h.log(); assert.equal(entries.filter(entry => entry.op === "create").length, 2);
    assert.ok(outcomes(await h.sessions()).includes("reseeded:effort_midturn"));
  } finally { await h.restore(); }
});

test("cancelling kills the process, removes its folder and the next request starts a new session", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller }).then(() => undefined, error => error as unknown);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.send")));
    const [pid] = await h.pids(); controller.abort();
    const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled");
    assert.ok(await until(() => !alive(pid)), "the CLI is killed"); assert.ok(await until(async () => (await h.liveDirs()).length === 0), "and its folder, with the prompt log, is removed");
    assert.equal(live().sessions().length, 0);
    const b = await turn(provider, [user("go again")]); assert.match(b.text, /^answer/);
    assert.notEqual((await h.pids()).at(-1), pid); assert.ok(outcomes(await h.sessions()).includes("reseeded:interrupted"));
  } finally { await h.restore(); }
});

test("a finished turn that the client abandons afterwards keeps its session", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const controller = new AbortController(); const first = [user("hello")];
    const a = await turn(provider, first, { controller }); controller.abort();
    await sleep(50); assert.equal(live().sessions().length, 1, "the abort that follows every finished request does not end the session");
    await turn(provider, [...first, ...a.output, user("more")]);
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});

test("a thread's second request while its first still runs is served one-shot", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.send")));
    const other = await turn(provider, [user("hello")]); assert.match(other.text, /^answer/);
    assert.ok((await h.sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "concurrent"));
    controller.abort(); await running;
  } finally { await h.restore(); }
});

test("the session cap serves newcomers one-shot, evicts only a cold session, and frees the process and folder", async () => {
  const h = await harness(); const cold = liveLimits.coldMs;
  try {
    const provider = adapter({ mode: "live", max: 1 });
    const a = await turn(provider, [user("a")], { context: { threadId: "A" } });
    const b = await turn(provider, [user("b")], { context: { threadId: "B" } }); assert.match(b.text, /^answer/);
    assert.equal(live().sessions().length, 1, "no warm session is evicted for a newcomer");
    assert.ok((await h.sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "capacity"));
    const [pidA] = await h.pids(); assert.ok(alive(pidA));
    liveLimits.coldMs = 0;
    await turn(provider, [user("c")], { context: { threadId: "C" } });
    assert.equal(live().sessions().length, 1); assert.ok(await until(() => !alive(pidA)), "the cold session's process ended"); assert.equal((await h.liveDirs()).length, 1);
    await turn(provider, [user("a"), ...a.output, user("a again")], { context: { threadId: "A" } });
    assert.ok(outcomes(await h.sessions()).includes("reseeded:evicted"));
  } finally { liveLimits.coldMs = cold; await h.restore(); }
});
