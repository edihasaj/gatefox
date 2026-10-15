import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ProviderError } from "../providers/provider.js";
import { adapter, alive, callIds, defaultAdapter, harness, kind, live, lookupName, outputFor, png, sleep, tools, turn, until, user, type Entry } from "./copilot-live-harness.js";

const operations = (entries: Entry[]) => entries.map(entry => entry.op).filter(op => op !== "stdin_closed");
const outcomes = (events: Entry[]) => events.map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));
const imageUser = (text: string) => ({ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text }, { type: "input_image" as const, image_url: png }] });

test("a tool loop keeps one CLI process, answers the waiting call and bills each request on its own", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    assert.deepEqual(a.events.filter(event => event.type !== "usage").map(kind), ["tool:lookup", "done"]);
    const doneA = a.events.at(-1); assert.ok(doneA?.type === "done");
    assert.deepEqual(doneA.usage, { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 } });
    assert.deepEqual(doneA.accounting, { cacheWriteTokens: 100, reasoningTokens: 1, nanoAiu: 1e9, nanoAiuStatus: "complete", initiator: "user" });
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "NEXT 2")]);
    const doneB = b.events.at(-1); assert.ok(doneB?.type === "done");
    // Only the second model call: the first call's cache write is not billed again, and the prefix is read from cache.
    assert.deepEqual(doneB.usage, { input_tokens: 200, output_tokens: 5, total_tokens: 205, input_tokens_details: { cached_tokens: 100 } });
    assert.deepEqual(doneB.accounting, { cacheWriteTokens: 10, reasoningTokens: 1, nanoAiu: 1e8, nanoAiuStatus: "complete", initiator: "agent" });
    const c = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "NEXT 2"), ...b.output, ...outputFor(b.output, "plain")]);
    assert.equal(c.text, "answer 3");

    const entries = await h.log();
    assert.deepEqual(operations(entries), ["create", "session.sendMessages", "deliver", "deliver"], "one session; the history is sent once, then only tool outputs");
    assert.equal((await h.pids()).length, 1, "three requests used one CLI process");
    const send = entries.find(entry => entry.op === "session.sendMessages")!;
    assert.equal(send.prompts.length, 1); assert.match(send.prompts[0], /^<<item 1 user>>\nstart \[tool\]\n<<\/item>>$/);
    const calls = callIds([...a.output, ...b.output]);
    assert.deepEqual(entries.filter(entry => entry.op === "deliver").map(entry => [entry.toolCallId, entry.result]), [[calls[0], "NEXT 2"], [calls[1], "plain"]]);
    // While the session lives its folder is private, holds the CLI's own temp folder, and the only thing in the OS temp folder is the
    // dedicated parent (private too), so the startup sweep reads that parent and never the whole OS temp folder.
    const [name, ...rest] = await h.liveDirs(); assert.equal(rest.length, 0);
    assert.ok(name.startsWith(`gateway-copilot-live-${process.pid.toString(36)}-`));
    assert.deepEqual(await readdir(h.scratch), [basename(h.parent)]); assert.equal((await stat(h.parent)).mode & 0o777, 0o700);
    assert.equal((await stat(join(h.parent, name))).mode & 0o777, 0o700);
    assert.equal(entries[0].tmpdir, join(h.parent, name, "tmp"), "the CLI stages its temp files inside the session folder");
    assert.ok((await stat(join(h.parent, name, "session-state", entries[0].params.sessionId, "events.jsonl"))).isFile(), "the CLI's prompt log lives in the private folder");
    // The session event carries the request's detail and who started its model calls, and no content.
    const telemetry = await h.sessions();
    assert.deepEqual(telemetry.filter(entry => entry.outcome === "spawned" || entry.outcome === "continued").map(entry => [entry.outcome, entry.initiator, entry.reasoningTokens, entry.cacheReadTokens, entry.cacheWriteTokens, entry.nanoAiu]),
      [["spawned", "user", 1, 0, 100, 1e9], ["continued", "agent", 1, 100, 10, 1e8], ["continued", "agent", 1, 200, 10, 1e8]]);
    const pid = entries[0].pid; await live().stop();
    assert.ok(await until(() => !alive(pid)), "the process ends with the session"); assert.deepEqual(await h.liveDirs(), [], "the prompt log goes with the folder");
  } finally { await h.restore(); }
});

test("a provider with no copilotSessions setting runs live: one CLI process across a tool loop", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = defaultAdapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first); const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "plain")]);
    assert.match(b.text, /^answer/); assert.equal((await h.pids()).length, 1, "the default is a live session");
    assert.equal(live().sessions().length, 1);
    // oneshot and replay stay available as explicit choices: every request is its own process.
    await live().stop();
    for (const mode of ["oneshot", "replay"]) {
      const before = (await h.pids()).length; await turn(adapter({ mode }), [user("a")]); await turn(adapter({ mode }), [user("b")]);
      assert.equal((await h.pids()).length, before + 2, `${mode} starts a process per request`); assert.equal(live().sessions().length, 0);
    }
  } finally { await h.restore(); }
});

test("parallel tool calls: each output reaches the waiting call it belongs to, whatever order they arrive in", { timeout: 30000 }, async () => {
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

test("a continued turn sends only its new items; divergence and changed instructions reseed in a new process", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first);
    const second = [...first, ...a.output, user("more")]; const b = await turn(provider, second);
    let entries = await h.log();
    assert.deepEqual(operations(entries), ["create", "session.sendMessages", "session.sendMessages"]);
    const more = entries.filter(entry => entry.op === "session.sendMessages")[1];
    assert.equal(more.prompts.length, 1); assert.ok(more.prompts[0].startsWith("<<item 3 user>>") && !more.prompts[0].includes("hello"), "the history is not resent");
    const oldPid = entries[0].pid;
    // An earlier message was edited: the session's history no longer matches, so the thread starts a new session.
    const third = [user("hello EDITED"), ...a.output, user("more"), ...b.output, user("again")];
    await turn(provider, third);
    entries = await h.log(); const creates = entries.filter(entry => entry.op === "create");
    assert.equal(creates.length, 2); assert.notEqual(creates[1].pid, oldPid);
    const seed = entries.filter(entry => entry.op === "session.sendMessages").at(-1)!;
    assert.equal(seed.prompts.length, 5, "the new session is seeded with the whole history, one message per item");
    assert.ok(await until(() => !alive(oldPid)), "the old process is gone");
    assert.ok(await until(async () => (await h.liveDirs()).length === 1), "and so is its folder");
    // A changed system prompt is part of the session's identity.
    await turn(provider, [...third, ...b.output, user("fourth")], { extra: { instructions: "Be brief" } });
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 3);
    // So is the window: the same history under another context window starts over.
    await turn(provider, [...third, ...b.output, user("fourth"), user("fifth")], { extra: { instructions: "Be brief" }, context: { threadId: "thread-1", windowId: "window-2" } });
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 4);
    assert.deepEqual(outcomes(await h.sessions()).filter(value => /^(spawned|continued|reseeded)/.test(value)), ["spawned", "continued", "reseeded:prefix_diverged", "reseeded:fingerprint_changed", "reseeded:window_changed"]);
  } finally { await h.restore(); }
});

test("the session is created with the caller's instructions, tool names and every confinement", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    await turn(adapter(), [user("hi")], { extra: { instructions: "Be brief" } });
    const [create] = (await h.log()).filter(entry => entry.op === "create"); const params = create.params;
    assert.match(params.systemMessage.content, /Caller instructions:\nBe brief/); assert.ok(params.systemMessage.content.includes(`"native":"${lookupName}"`));
    assert.deepEqual([params.enableSessionStore, params.enableConfigDiscovery, params.requestPermission, params.requestUserInput, params.memory.enabled, params.infiniteSessions.enabled], [false, false, true, false, false, false]);
    assert.deepEqual([params.availableTools, params.allowedModels, params.mcpServers, params.customAgents], [[lookupName], ["fixture"], {}, []]);
    assert.match(lookupName, /^tool_lookup_[0-9a-f]{16}$/, "a name derived from the tool's identity, not its position");
    assert.equal(params.tools[0].skipPermission, true); assert.equal(params.tools[0].name, lookupName); assert.equal(params.tools[0].defer, "never", "no tool hides behind the CLI's tool search");
    assert.deepEqual(params.toolSearch, { enabled: false });
    assert.deepEqual(params.largeOutput, { enabled: false }, "a large tool result stays inline instead of being saved to a file outside the session folder");
    assert.equal(params.configDir, params.workingDirectory); assert.equal(params.configDir, create.directory); assert.ok(create.directory.startsWith(h.parent));
    assert.equal(params.reasoningEffort, undefined);
    // The CLI itself is confined by its command line, live or one-shot: no built-in MCP servers, no custom instructions, no remote
    // control or export, no self-update, and its log in the private folder.
    await turn(adapter({ mode: "oneshot" }), [user("hi")], { context: { threadId: "one-shot" } });
    const spawned = (await h.log()).filter(entry => entry.op === "create"); assert.equal(spawned.length, 2);
    for (const { args, directory } of spawned) {
      assert.deepEqual(args, ["--headless", "--stdio", "--no-auto-update", "--disable-builtin-mcps", "--no-custom-instructions", "--no-remote", "--no-remote-export", "--log-dir", directory]);
    }
  } finally { await h.restore(); }
});

test("a reordered tool catalog is the same session; a different catalog is a new one", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const other = { type: "function" as const, name: "other", description: "Another", parameters: { type: "object", properties: {} } };
    const first = [user("hello")]; const catalog = [tools[0], other];
    const a = await turn(provider, first, { extra: { tools: catalog } });
    await turn(provider, [...first, ...a.output, user("more")], { extra: { tools: [other, tools[0]] } });
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "the order of the catalog does not matter");
    const [create] = (await h.log()).filter(entry => entry.op === "create");
    assert.deepEqual(create.params.availableTools, [...create.params.availableTools].sort(), "tools are listed by their stable names");
    await turn(provider, [...first, ...a.output, user("more"), user("again")], { extra: { tools: [other] } });
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 2);
  } finally { await h.restore(); }
});

test("a tool that keeps its name but changes its description or parameters is a new session", { timeout: 30000 }, async () => {
  // The tool's native name hashes only its namespace and name, so the schema in the session's fingerprint is the only thing that tells these apart.
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first);
    const described = { ...tools[0], description: "Look something up, in more detail" };
    const b = await turn(provider, [...first, ...a.output, user("more")], { extra: { tools: [described] } });
    const reshaped = { ...described, parameters: { type: "object", properties: { id: { type: "string" }, limit: { type: "number" } } } };
    await turn(provider, [...first, ...a.output, user("more"), ...b.output, user("again")], { extra: { tools: [reshaped] } });
    const creates = (await h.log()).filter(entry => entry.op === "create");
    assert.equal(creates.length, 3, "each change of the schema started a new session");
    assert.deepEqual(creates.map(entry => entry.params.availableTools), [[lookupName], [lookupName], [lookupName]], "the name did not change");
    assert.deepEqual(creates.map(entry => entry.params.tools[0].description), ["Caller tool lookup. Look something up", "Caller tool lookup. Look something up, in more detail", "Caller tool lookup. Look something up, in more detail"]);
    assert.deepEqual(creates.map(entry => Object.keys(entry.params.tools[0].parameters.properties)), [["id"], ["id"], ["id", "limit"]]);
    assert.deepEqual(outcomes(await h.sessions()).filter(value => /^(spawned|continued|reseeded)/.test(value)), ["spawned", "reseeded:fingerprint_changed", "reseeded:fingerprint_changed"]);
  } finally { await h.restore(); }
});

test("an effort change between turns switches in place; one while tools wait, or a set effort that goes unset, starts a new session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const second = [...first, ...a.output, user("more [tool]")];
    const b = await turn(provider, second, { extra: { reasoning: { effort: "high" } } });
    let entries = await h.log();
    assert.deepEqual(entries.filter(entry => entry.op === "switch").map(entry => entry.effort), ["high"]);
    assert.equal(entries.filter(entry => entry.op === "create").length, 1, "the cache survives an effort change");
    const third = [...second, ...b.output, ...outputFor(b.output, "plain")];
    const c = await turn(provider, third, { extra: { reasoning: { effort: "low" } } });
    entries = await h.log(); assert.equal(entries.filter(entry => entry.op === "create").length, 2);
    // No effort now means the model's default, which the old session (still at "low") cannot give.
    await turn(provider, [...third, ...c.output, user("again")]);
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 3);
    assert.deepEqual((await h.log()).filter(entry => entry.op === "create").map(entry => entry.params.reasoningEffort), ["low", "low", undefined]);
    const kinds = outcomes(await h.sessions()); assert.ok(kinds.includes("reseeded:effort_midturn") && kinds.includes("reseeded:fingerprint_changed"), kinds.join(","));
  } finally { await h.restore(); }
});

test("the CLI's own confirmation of an effort change, which comes before its answer, keeps the session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const b = await turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "medium" } } });
    assert.match(b.text, /^answer/);
    assert.equal((await h.pids()).length, 1, "one CLI process across the effort change");
    const kinds = outcomes(await h.sessions());
    assert.deepEqual(kinds.filter(kind => /^(spawned|continued|reseeded|crashed|fallback)/.test(kind)), ["spawned", "continued"], kinds.join(","));
    assert.equal(live().sessions()[0].effort, "medium");
  } finally { await h.restore(); }
});

test("an effort confirmation for another effort than the one asked for ends the session; the request is served by a new one", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SWITCH_EFFORT = "xhigh";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    const b = await turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "medium" } } });
    assert.match(b.text, /^answer/); assert.ok(await until(() => !alive(pid)), "the session that changed to an effort nobody asked for is killed");
    const kinds = outcomes(await h.sessions());
    assert.ok(kinds.includes("crashed:effort_mismatch") && kinds.includes("reseeded:session_dead"), kinds.join(","));
  } finally { await h.restore(); }
});

test("an effort confirmation that arrives in the same read as the answer to the change still counts: a matching one keeps the session", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SWITCH_ONE_WRITE = "1";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const b = await turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "medium" } } });
    assert.match(b.text, /^answer/); assert.equal((await h.pids()).length, 1, "one CLI process across the effort change");
    assert.equal(live().sessions()[0].effort, "medium");
    const c = await turn(provider, [...first, ...a.output, user("more"), ...b.output, user("again")], { extra: { reasoning: { effort: "high" } } });
    assert.match(c.text, /^answer/); assert.equal((await h.pids()).length, 1, "and across a second one");
  } finally { await h.restore(); }
});

test("an effort confirmation for another effort that arrives in the same read as the answer to the change ends the session before its answer is read", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SWITCH_EFFORT = "xhigh"; process.env.GATEWAY_COPILOT_LIVE_SWITCH_ONE_WRITE = "1";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    // The confirmation is routed after the change returned and the request attached; it must not be read as a part of the answer.
    const b = await turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "medium" } } });
    assert.match(b.text, /^answer/, "the request is still served, one-shot");
    assert.ok(await until(() => !alive(pid)), "the session that runs at an effort nobody asked for is killed");
    assert.equal(live().sessions().length, 0, "and no session keeps it");
    const kinds = outcomes(await h.sessions());
    assert.ok(kinds.includes("crashed:effort_mismatch") && kinds.includes("fallback:stream_failed"), kinds.join(","));
  } finally { await h.restore(); }
});

test("cancelling aborts the session, kills the process, removes its folder and the next request starts a new session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller }).then(() => undefined, error => error as unknown);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const [pid] = await h.pids(); controller.abort();
    const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled");
    assert.ok(await until(() => !alive(pid)), "the CLI is killed"); assert.ok(await until(async () => (await h.liveDirs()).length === 0), "and its folder, with the prompt log, is removed");
    assert.ok(await until(() => live().sessions().length === 0));
    assert.ok((await h.log()).some(entry => entry.op === "abort"), "the running turn was aborted before the process was killed");
    const b = await turn(provider, [user("go again")]); assert.match(b.text, /^answer/);
    assert.notEqual((await h.pids()).at(-1), pid); assert.ok(outcomes(await h.sessions()).includes("reseeded:interrupted"));
  } finally { await h.restore(); }
});

test("a finished turn that the client abandons afterwards keeps its session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const controller = new AbortController(); const first = [user("hello")];
    const a = await turn(provider, first, { controller }); controller.abort();
    await sleep(50); assert.equal(live().sessions().length, 1, "the abort that follows every finished request does not end the session");
    assert.ok(!(await h.log()).some(entry => entry.op === "abort"));
    await turn(provider, [...first, ...a.output, user("more")]);
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});

test("a thread's second request while its first still runs is served one-shot", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const other = await turn(provider, [user("hello")]); assert.match(other.text, /^answer/);
    assert.ok((await h.sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "concurrent"));
    controller.abort(); await running;
  } finally { await h.restore(); }
});

test("at the session cap a newcomer evicts the least recently used parked session, preferring one that finished its turn", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", max: 2 }); const ctx = (threadId: string) => ({ context: { threadId } });
    const a = await turn(provider, [user("a [tool]")], ctx("A")); await sleep(5);   // waiting for tool outputs, the oldest
    await turn(provider, [user("b")], ctx("B")); await sleep(5);                    // finished its turn
    const [pidA, pidB] = await h.pids();
    await turn(provider, [user("c [tool]")], ctx("C"));
    assert.ok(await until(() => !alive(pidB)), "the finished session goes first, though a waiting one is older"); assert.ok(alive(pidA));
    assert.equal(live().sessions().length, 2); assert.ok(await until(async () => (await h.liveDirs()).length === 2), "its folder went with it");
    await sleep(5); await turn(provider, [user("d")], ctx("D"));
    assert.ok(await until(() => !alive(pidA)), "then, with none finished, the least recently used waiting one"); assert.equal(live().sessions().length, 2);
    // An evicted thread starts over and says why.
    await turn(provider, [user("a [tool]"), ...a.output, ...outputFor(a.output, "late"), user("a again")], ctx("A"));
    assert.ok(outcomes(await h.sessions()).includes("reseeded:evicted"));
    assert.ok(!(await h.sessions()).some(entry => entry.missReason === "capacity"), "nothing fell back for lack of a slot");
  } finally { await h.restore(); }
});

test("a running session is never evicted: at the cap with every session generating, a newcomer is served one-shot", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", max: 1 }); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller, context: { threadId: "A" } }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const [pid] = await h.pids();
    const b = await turn(provider, [user("b")], { context: { threadId: "B" } }); assert.match(b.text, /^answer/);
    assert.ok(alive(pid)); assert.equal(live().sessions().length, 1);
    assert.ok((await h.sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "capacity"));
    controller.abort(); await running;
  } finally { await h.restore(); }
});

test("a session whose own next request is still being placed is not evicted for a newcomer", { timeout: 30000 }, async () => {
  // The CLI answers the effort change only when the test lets it, which is after the newcomer was placed.
  const h = await harness(); const gate = join(h.directory, "switch-gate"); process.env.GATEWAY_COPILOT_LIVE_SWITCH_GATE = gate;
  try {
    const provider = adapter({ mode: "live", max: 1 }); const first = [user("a")];
    const a = await turn(provider, first, { context: { threadId: "A" }, extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    // Thread A's next request waits on the CLI to apply an effort change; the only slot is its session.
    const again = turn(provider, [...first, ...a.output, user("more")], { context: { threadId: "A" }, extra: { reasoning: { effort: "high" } } });
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "switch")));
    const b = await turn(provider, [user("b")], { context: { threadId: "B" } }); assert.match(b.text, /^answer/);
    await writeFile(gate, "x"); await again;
    assert.ok(alive(pid), "thread A kept its session"); assert.equal((await h.log()).filter(entry => entry.op === "create" && entry.pid === pid).length, 1);
    const kinds = outcomes(await h.sessions());
    assert.ok(kinds.includes("fallback:capacity") && kinds.includes("continued") && !kinds.includes("reseeded:evicted"), kinds.join(","));
  } finally { await h.restore(); }
});

test("conversation images travel as private file attachments on their item, in a seed and in a continuation, on one process", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [imageUser("look")];
    const a = await turn(provider, first);
    await turn(provider, [...first, ...a.output, imageUser("and this")]);
    const entries = await h.log(); const sends = entries.filter(entry => entry.op === "session.sendMessages");
    const folder = entries.find(entry => entry.op === "create")!.directory as string;
    assert.equal((await h.pids()).length, 1, "a screenshot does not move the thread off its live session");
    assert.equal(sends.length, 2);
    const sha = createHash("sha256").update(Buffer.from(png.split(",")[1], "base64")).digest("hex");
    for (const [index, send] of sends.entries()) {
      const [attachment] = send.attachments[0]; const [file] = send.files[0];
      assert.equal(attachment.type, "file"); assert.equal(attachment.data, undefined, "no image bytes in the message");
      assert.ok(attachment.path.startsWith(join(folder, "images") + "/"), "the image lives in the session's private folder");
      assert.deepEqual([file.sha, file.mode], [sha, 0o600], "the file holds the image's bytes and only its owner can read it");
      assert.match(attachment.displayName, new RegExp(`^conversation-message-${index === 0 ? 1 : 3}-part-2$`));
      assert.ok(send.prompts[0].includes(`[Attached image ${attachment.displayName}]`), "the text names the attachment it belongs to");
    }
    await live().stop(); assert.deepEqual(await h.liveDirs(), [], "the images go with the folder");
  } finally { await h.restore(); }
});

test("an image in a tool output reaches the waiting call as a binary result", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tool]")];
    const a = await turn(provider, first);
    const output = callIds(a.output).map(call_id => ({ type: "function_call_output" as const, call_id, output: [{ type: "input_text" as const, text: "a screenshot" }, { type: "input_image" as const, image_url: png }] }));
    const b = await turn(provider, [...first, ...a.output, ...output]);
    assert.match(b.text, /^answer/); assert.equal((await h.pids()).length, 1);
    const [delivery] = (await h.log()).filter(entry => entry.op === "deliver");
    assert.deepEqual(delivery.result, { textResultForLlm: "a screenshot\n[Image 1 attached]", resultType: "success", binaryResultsForLlm: [{ type: "image", data: png.split(",")[1], mimeType: "image/png" }] });
  } finally { await h.restore(); }
});
