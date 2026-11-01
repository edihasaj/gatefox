import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sessionLimits } from "../providers/copilot-live-session.js";
import { ProviderError } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { adapter, alive, callIds, defaultAdapter, harness, kind, live, lookupName, outputFor, png, sleep, tools, turn, until, user, type Entry } from "./copilot-live-harness.js";

const operations = (entries: Entry[]) => entries.map(entry => entry.op).filter(op => op !== "stdin_closed");
const outcomes = (events: Entry[]) => events.map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));
const imageUser = (text: string) => ({ type: "message" as const, role: "user" as const, content: [{ type: "input_text" as const, text }, { type: "input_image" as const, image_url: png }] });

test("a session-only client keeps its Copilot CLI through tools and a new user turn", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(), context = { sessionId: "native-session-only" };
    const first = [user("start [tool]")], a = await turn(provider, first, { context });
    const second = [...first, ...a.output, ...outputFor(a.output, "plain")];
    const b = await turn(provider, second, { context });
    await turn(provider, [...second, ...b.output, user("Follow up")], { context });
    assert.equal((await h.pids()).length, 1);
    assert.equal((await h.log()).filter(row => row.op === "deliver").length, 1);
  } finally { await h.restore(); }
});

test("Copilot's omitted function type completes a live tool loop without a session failure", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool][omittype]")];
    const result = await turn(provider, first);
    assert.equal(callIds(result.output).length, 1);
    const followup = await turn(provider, [...first, ...result.output, ...outputFor(result.output, "plain")]);
    assert.match(followup.text, /^answer/);
    assert.equal((await h.pids()).length, 1);
    assert.ok(!(await h.sessions()).some(event => event.outcome === "crashed" || event.failed === true));
    assert.equal((await h.log()).filter(event => event.op === "deliver").length, 1);
  } finally { await h.restore(); }
});

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
    assert.deepEqual(operations(entries), ["create", "session.sendMessages", "deliver", "continuation", "deliver", "continuation"], "one session; the history is sent once, then only tool outputs, each answered by one continuation");
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

test("a continued turn sends only new items; divergence preserves the session and controlled changes still reseed", { timeout: 30000 }, async () => {
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
    // An earlier message was edited: the session's history no longer matches. Preserve it and refuse the request.
    const third = [user("hello EDITED"), ...a.output, user("more"), ...b.output, user("again")];
    await assert.rejects(turn(provider, third),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "copilot_session_preserved");
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "no replay or replacement was created");
    assert.equal(alive(oldPid), true, "the warm session survived the mismatch");
    // A changed system prompt is part of the session's identity.
    const matching = [...first, ...a.output, user("more"), ...b.output, user("again")];
    await turn(provider, [...matching, user("fourth")], { extra: { instructions: "Be brief" } });
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 2);
    // So is the window: the same history under another context window starts over.
    await turn(provider, [...matching, user("fourth"), user("fifth")], { extra: { instructions: "Be brief" }, context: { threadId: "thread-1", windowId: "window-2" } });
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 3);
    const kinds = outcomes(await h.sessions());
    assert.deepEqual(kinds.filter(value => /^(spawned|continued|reseeded)/.test(value)), ["spawned", "continued", "reseeded:fingerprint_changed", "reseeded:window_changed"]);
    assert.ok(kinds.includes("preserved:prefix_diverged"), kinds.join(","));
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

test("an effort change between turns switches in place; a mid-tool change preserves, and a set effort going unset reseeds", { timeout: 30000 }, async () => {
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
    await assert.rejects(turn(provider, third, { extra: { reasoning: { effort: "low" } } }),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "copilot_session_preserved");
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "the pending warm session survived");
    const c = await turn(provider, third, { extra: { reasoning: { effort: "high" } } });
    entries = await h.log(); assert.equal(entries.filter(entry => entry.op === "create").length, 1);
    // No effort now means the model's default, which the old session (now at "high") cannot give.
    await turn(provider, [...third, ...c.output, user("again")]);
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 2);
    assert.deepEqual((await h.log()).filter(entry => entry.op === "create").map(entry => entry.params.reasoningEffort), ["low", undefined]);
    const kinds = outcomes(await h.sessions()); assert.ok(kinds.includes("preserved:effort_midturn") && kinds.includes("reseeded:fingerprint_changed"), kinds.join(","));
  } finally { await h.restore(); }
});

test("an effort change the CLI does not answer in time ends the session and refuses the request, without waiting the native limit or replaying", { timeout: 30000 }, async () => {
  const h = await harness(); const limit = sessionLimits.switchMs; sessionLimits.switchMs = 100;
  // The CLI reads its switches when it starts: it answers a model switch only 300 ms after it was asked, which is past the limit.
  process.env.GATEWAY_COPILOT_LIVE_SLOW_SWITCH = "300";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids(); const started = Date.now();
    await assert.rejects(turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "medium" } } }),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.ok(Date.now() - started < 5000, "the limit, not the native ten seconds, bounded the wait");
    assert.ok(await until(() => !alive(pid)), "a session whose effort is unknown is killed"); assert.ok(await until(() => live().sessions().length === 0));
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "no second CLI started inside the refused request");
    assert.equal((await h.log()).filter(entry => entry.op === "session.sendMessages").length, 1, "nothing was sent for the refused request");
    assert.ok(!outcomes(await h.sessions()).some(kind => kind.startsWith("reseeded")));
  } finally { sessionLimits.switchMs = limit; await h.restore(); }
});

test("a CLI that rejects an effort change preserves the session: the request is refused and the same effort continues it", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    // The CLI reads its switches when it starts, so this one is set before the session spawns; it only affects effort changes.
    process.env.GATEWAY_COPILOT_LIVE_SWITCH_REJECT = "1";
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids(); const second = [...first, ...a.output, user("more")];
    await assert.rejects(turn(provider, second, { extra: { reasoning: { effort: "medium" } } }),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "copilot_session_preserved");
    let entries = await h.log();
    assert.deepEqual(entries.filter(entry => entry.op === "switch").map(entry => entry.effort), ["medium"], "the change was asked for once");
    assert.equal(entries.filter(entry => entry.op === "create").length, 1, "no reseed or replay process");
    assert.equal(entries.filter(entry => entry.op === "session.sendMessages").length, 1, "the refused request sent nothing to the session");
    assert.ok(alive(pid)); assert.equal(live().sessions().length, 1); assert.equal(live().sessions()[0].effort, "low", "the session still runs at its own effort");
    assert.ok(outcomes(await h.sessions()).includes("preserved:effort_rejected"));
    // The same request at the effort the session has continues it.
    const b = await turn(provider, second, { extra: { reasoning: { effort: "low" } } });
    assert.match(b.text, /^answer/);
    entries = await h.log();
    assert.equal(entries.filter(entry => entry.op === "create").length, 1); assert.equal((await h.pids()).length, 1); assert.equal(live().sessions()[0].pid, pid);
    assert.equal(entries.filter(entry => entry.op === "switch").length, 1, "no further switch was needed");
    assert.ok(outcomes(await h.sessions()).includes("continued"));
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

test("an effort confirmation for another effort than the one asked for ends the session; the request is refused without a replay", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SWITCH_EFFORT = "xhigh";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    await assert.rejects(turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "medium" } } }),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.ok(await until(() => !alive(pid)), "the session that changed to an effort nobody asked for is killed");
    assert.ok(await until(() => live().sessions().length === 0), "and no session keeps it");
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "no second CLI of either kind started inside the refused request");
    const kinds = outcomes(await h.sessions());
    assert.ok(kinds.includes("crashed:effort_mismatch") || kinds.includes("crashed:effort_unconfirmed"), kinds.join(","));
    assert.ok(!kinds.some(kind => kind.startsWith("reseeded")), "nothing reseeded within the request");
    // A later, independent request is a new controlled seed, which says why.
    delete process.env.GATEWAY_COPILOT_LIVE_SWITCH_EFFORT;
    const later = await turn(provider, [...first, ...a.output, user("more")]);
    assert.match(later.text, /^answer/); assert.equal((await h.log()).filter(entry => entry.op === "create").length, 2);
    assert.ok(outcomes(await h.sessions()).includes("reseeded:session_dead"), outcomes(await h.sessions()).join(","));
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

test("an effort confirmation for another effort that arrives in the same read as the answer to the change ends the session before its answer is read, and the request is refused without a replay", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SWITCH_EFFORT = "xhigh"; process.env.GATEWAY_COPILOT_LIVE_SWITCH_ONE_WRITE = "1";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    // The confirmation is routed after the change returned and the request attached; it must not be read as a part of the answer.
    await assert.rejects(turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "medium" } } }),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.ok(await until(() => !alive(pid)), "the session that runs at an effort nobody asked for is killed");
    assert.ok(await until(() => live().sessions().length === 0), "and no session keeps it");
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "no replay process was created");
    const kinds = outcomes(await h.sessions());
    assert.ok(kinds.includes("crashed:effort_mismatch") && kinds.includes("blocked:stream_failed"), kinds.join(","));
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

test("a live CLI killed after text was streamed ends the request as a final refusal: no replay, no new CLI, and the SDK is told not to retry", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const events: InferenceEvent[] = []; let failure: unknown; let victim: number | undefined;
    const request = restoreReasoning({ model: "fixture", input: [user("go [slow]")], tools } as ResponsesRequest, "scope");
    try {
      for await (const event of adapter().infer(request, new AbortController().signal, { threadId: "thread-1" })) {
        events.push(event);
        // Only the fixture CLI this test started is killed, once the caller has already received text.
        if (event.type === "text" && victim === undefined) { [victim] = await h.pids(); process.kill(victim, "SIGKILL"); }
      }
    } catch (error) { failure = error; }
    assert.ok(events.some(event => event.type === "text"), "the caller had already received text");
    assert.ok(failure instanceof ProviderError && failure.status === 400 && failure.upstream?.code === "session_continuity_unavailable", String(failure));
    assert.equal(streamFailureCode(failure as ProviderError), "invalid_prompt", "the client does not retry the full conversation");
    assert.ok(victim !== undefined && await until(() => !alive(victim!)));
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "no one-shot replay or second live CLI started");
    assert.ok(await until(() => live().sessions().length === 0), "nothing usable is left registered");
    assert.ok(await until(async () => outcomes(await h.sessions()).includes("blocked:stream_failed")), outcomes(await h.sessions()).join(","));
  } finally { await h.restore(); }
});

test("a thread's second request while its first runs refuses without disturbing the active session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const [pid] = await h.pids();
    await assert.rejects(turn(provider, [user("hello")]),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.ok(alive(pid), "the original session survived"); assert.equal((await h.log()).filter(entry => String(entry.directory).includes("-run-")).length, 0);
    assert.ok((await h.sessions()).some(entry => entry.outcome === "blocked" && entry.missReason === "concurrent"));
    controller.abort(); await running;
  } finally { await h.restore(); }
});

test("at the session cap a newcomer evicts only a cold parked session, preferring one that finished its turn", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", max: 2 }); const ctx = (threadId: string) => ({ context: { threadId } });
    const a = await turn(provider, [user("a [tool]")], ctx("A")); await sleep(5);   // waiting for tool outputs
    await turn(provider, [user("b")], ctx("B")); await sleep(5);                    // finished its turn
    const [pidA, pidB] = await h.pids();
    for (const session of live().sessions()) session.lastUse = Date.now() - 31 * 60000;
    await turn(provider, [user("c [tool]")], ctx("C"));
    assert.ok(await until(() => !alive(pidB)), "the finished session goes first, though a waiting one is older"); assert.ok(alive(pidA));
    assert.equal(live().sessions().length, 2); assert.ok(await until(async () => (await h.liveDirs()).length === 2), "its folder went with it");
    await sleep(5); await turn(provider, [user("d")], ctx("D"));
    assert.ok(await until(() => !alive(pidA)), "then, with none finished, the least recently used waiting one"); assert.equal(live().sessions().length, 2);
    // An evicted thread starts over and says why, once the sessions it would displace are cold too.
    for (const session of live().sessions()) session.lastUse = Date.now() - 31 * 60000;
    await turn(provider, [user("a [tool]"), ...a.output, ...outputFor(a.output, "late"), user("a again")], ctx("A"));
    assert.ok(outcomes(await h.sessions()).includes("reseeded:evicted"));
    assert.ok(!(await h.sessions()).some(entry => entry.missReason === "capacity"), "nothing fell back for lack of a slot");
  } finally { await h.restore(); }
});

test("a running session is never evicted: at the cap with every session generating, a newcomer refuses", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", max: 1 }); const controller = new AbortController();
    const running = turn(provider, [user("go [hang]")], { controller, context: { threadId: "A" } }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const [pid] = await h.pids();
    await assert.rejects(turn(provider, [user("b")], { context: { threadId: "B" } }),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    assert.ok(alive(pid)); assert.equal(live().sessions().length, 1);
    assert.equal((await h.log()).filter(entry => String(entry.directory).includes("-run-")).length, 0);
    assert.ok((await h.sessions()).some(entry => entry.outcome === "blocked" && entry.missReason === "capacity"));
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
    await assert.rejects(turn(provider, [user("b")], { context: { threadId: "B" } }),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable");
    await writeFile(gate, "x"); await again;
    assert.ok(alive(pid), "thread A kept its session"); assert.equal((await h.log()).filter(entry => entry.op === "create" && entry.pid === pid).length, 1);
    const kinds = outcomes(await h.sessions());
    assert.ok(kinds.includes("blocked:capacity") && kinds.includes("continued") && !kinds.includes("reseeded:evicted"), kinds.join(","));
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
