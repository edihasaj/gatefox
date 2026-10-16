import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "../providers/provider.js";
import { CopilotLiveSession, sessionLimits } from "../providers/copilot-live-session.js";
import { CopilotTurn } from "../providers/copilot-turn.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { adapter, alive, harness, live, outputFor, providerId, queuedUsage, sleep, thread, tools, turn, until, user, type Entry, type Harness } from "./copilot-live-harness.js";

// How a live session recovers when something around it goes wrong: a misbehaving start, a session that is still
// closing when its thread's next request comes, a bug in placement, usage left unread, and the old process of a
// replaced session.
const kinds = async (h: Harness) => (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));
const creates = async (h: Harness): Promise<Entry[]> => (await h.log()).filter(entry => entry.op === "create");

test("a session that misbehaves while it starts is never handed out: the request is served one-shot and nothing is left", { timeout: 30000 }, async () => {
  // The event comes just before session.create answers, or well before it.
  for (const delay of ["0", "150"]) {
    const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_BOOT_EVENT = "assistant.usage"; process.env.GATEWAY_COPILOT_LIVE_SLOW_CREATE = delay;
    try {
      const a = await turn(adapter(), [user("hello")]);
      assert.match(a.text, /^answer/);
      const outcomes = await kinds(h);
      assert.deepEqual(outcomes, ["fallback:spawn_failed"], `${delay}: a session that never served is not reported as spawned or crashed`);
      const [first, second] = await creates(h); assert.ok(String(first.directory).includes("-live-") && String(second.directory).includes("-run-"));
      assert.equal(second.alivePeers.length, 0, `${delay}: the CLI that misbehaved was gone before the one-shot CLI started`);
      assert.ok(await until(async () => (await h.liveDirs()).length === 0)); assert.equal(live().sessions().length, 0);
    } finally { await h.restore(); }
  }
});

test("the CLI's start-up announcements, before or after session.create answers, are part of a normal start", { timeout: 30000 }, async () => {
  for (const early of ["session.start", "session.managed_settings_resolved", undefined]) {
    const h = await harness(); if (early) process.env.GATEWAY_COPILOT_LIVE_BOOT_EVENT = early; process.env.GATEWAY_COPILOT_LIVE_SLOW_CREATE = "100";
    try {
      const provider = adapter(); const first = [user("hello")];
      const a = await turn(provider, first); await sleep(50);
      await turn(provider, [...first, ...a.output, user("more")]);
      assert.equal((await h.pids()).length, 1, `${early}: one process`);
      assert.deepEqual((await kinds(h)).filter(kind => !kind.startsWith("closed")), ["spawned", "continued"], String(early));
    } finally { await h.restore(); }
  }
});

test("a session that is still closing when its thread's next request comes frees its slot, says why, and is gone before the new one starts", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "400";
  try {
    const provider = adapter({ mode: "live", max: 1 }); const first = [user("go [tool]")];
    const a = await turn(provider, first);
    const [old] = await creates(h);
    // The tool wait runs out: the session aborts its pending call (slowly) and is killed after.
    live().sessions()[0].timers(60000, 20);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "abort")));
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")]);
    assert.match(b.text, /^answer/);
    const outcomes = await kinds(h);
    assert.ok(outcomes.includes("reseeded:tool_wait_expired"), outcomes.join(","));
    assert.ok(!outcomes.includes("fallback:capacity"), "the closing session did not hold the only slot");
    const [, next] = await creates(h);
    assert.ok(!next.alivePeers.includes(old.pid) && next.folders.length === 0, "the old process and its folder were gone when the new session was created");
  } finally { await h.restore(); }
});

test("a reseed and an eviction wait until the old process and its folder are gone before a new process starts", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "300";
  try {
    const provider = adapter({ mode: "live", max: 1 }); const first = [user("go [tool]")];
    await turn(provider, first);
    // An edited history while tools wait: the old session is aborted (slowly) and killed, then the thread reseeds.
    await turn(provider, [user("go [tool] EDITED"), user("again [tool]")]);
    // Another thread at the cap evicts the waiting session.
    await turn(provider, [user("other")], { context: { threadId: "B" } });
    const [first_, reseed, evicting] = await creates(h);
    assert.ok(reseed && evicting, "three sessions were created");
    for (const [entry, before] of [[reseed, first_], [evicting, reseed]] as const) {
      assert.ok(!alive(before.pid), "the replaced CLI is gone");
      assert.deepEqual([entry.alivePeers, entry.folders], [[], []], `no earlier CLI ran and no earlier folder was left when ${entry.pid} was created`);
    }
    const outcomes = await kinds(h); assert.ok(outcomes.includes("reseeded:prefix_diverged") && outcomes.includes("evicted"), outcomes.join(","));
  } finally { await h.restore(); }
});

test("an unexpected failure while placing a request in its session serves it one-shot instead of failing it", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    live(); // The registry exists from here.
    const registry = (globalThis as unknown as Record<symbol, { sessions: Map<string, unknown> }>)[Symbol.for("harness-gateway/copilot-sessions/v1")];
    const get = registry.sessions.get;
    registry.sessions.get = () => { throw new Error("placement bug"); };
    try {
      const a = await turn(adapter(), [user("hello")]);
      assert.match(a.text, /^answer/);
    } finally { registry.sessions.get = get; }
    assert.ok((await kinds(h)).includes("fallback:attach_failed"), (await kinds(h)).join(","));
    assert.ok((await creates(h)).every(entry => String(entry.directory).includes("-run-")), "the request ran one-shot");
  } finally { await h.restore(); }
});

test("usage the CLI reported in several calls before a cancellation reaches the caller as one running total", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const controller = new AbortController(); const afterAbort: InferenceEvent[] = []; let failure: unknown;
    const request = restoreReasoning({ model: "fixture", input: [user("go [lateusage2]")], tools } as ResponsesRequest, "scope");
    try {
      for await (const event of adapter().infer(request, controller.signal, thread)) {
        if (controller.signal.aborted) afterAbort.push(event);
        // The consumer is busy while the CLI reports two model calls' usage, then cancels.
        if (event.type === "text") { assert.ok(await until(() => queuedUsage() === 2), "both calls' usage is waiting in the request's queue"); controller.abort(); }
      }
    } catch (error) { failure = error; }
    assert.ok(failure instanceof ProviderError && failure.code === "cancelled");
    // The server records the first usage event after a cancellation and stops reading, so that one must hold both calls.
    const [first] = afterAbort;
    assert.ok(first?.type === "usage", "usage follows the cancellation");
    assert.deepEqual([first.usage.input_tokens, first.accounting?.nanoAiu, first.accounting?.cacheWriteTokens], [300, 1.1e9, 110]);
    assert.equal(afterAbort.filter(event => event.type === "usage").length, 1);
  } finally { await h.restore(); }
});

test("a session that closed before its request attached refuses it at once and stays closed", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const session = await CopilotLiveSession.start({ key: "unit", fingerprint: "f", window: "", config: { id: providerId, type: "copilot-subscription", models: { alias: "fixture" } },
      create: { model: "fixture" }, toolNames: new Set(), onClose: () => {} }, new AbortController().signal);
    await session.close("closed", "test");
    const turn_ = new CopilotTurn({ model: "fixture", offered: ["fixture"], tools: [], choice: undefined, summary: undefined });
    const events = session.run({ begin: { prompts: async () => [{ prompt: "hello" }] }, prefix: [], turn: turn_, signal: new AbortController().signal, onEnd: () => {} });
    assert.equal(session.state, "closed", "attaching does not bring a closed session back");
    const error = await (async () => { for await (const event of events) void event; })().then(() => undefined, (failure: unknown) => failure);
    assert.ok(error instanceof ProviderError && error.code === "cli_failed", String(error));
    assert.ok(!(await h.log()).some(entry => entry.op === "session.sendMessages"), "nothing was sent to it");
  } finally { await h.restore(); }
});

test("at the cap, a session that is already closing makes room before any parked session is evicted", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "400";
  try {
    const provider = adapter({ mode: "live", max: 2 });
    await turn(provider, [user("a [tool]")], { context: { threadId: "A" } }); await sleep(5);
    await turn(provider, [user("b")], { context: { threadId: "B" } });
    const [, b] = await h.pids();
    // Thread A's tool wait runs out: its session aborts its pending call (slowly) before it is killed.
    live().sessions().find(session => session.state === "awaiting_outputs")!.timers(60000, 20);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "abort")));
    await turn(provider, [user("c")], { context: { threadId: "C" } });
    assert.ok(alive(b), "the parked session of thread B was not evicted"); assert.equal(live().sessions().length, 2);
    const outcomes = await kinds(h);
    assert.ok(!outcomes.includes("evicted") && outcomes.includes("reaped:tool_wait_expired"), outcomes.join(","));
  } finally { await h.restore(); }
});

test("a thread whose session is being evicted waits for it and reseeds as evicted; no process runs beside the dying one", { timeout: 30000 }, async () => {
  // The evicted CLI answers session.abort only when the test lets it (the gate), and the abort limit is far beyond the test: the
  // dying session stays there for exactly as long as the test wants, whatever the machine's speed.
  const h = await harness(); const gate = join(h.directory, "abort-gate"); process.env.GATEWAY_COPILOT_LIVE_ABORT_GATE = gate;
  const limit = sessionLimits.abortMs; sessionLimits.abortMs = 600000;
  let newcomer: Promise<unknown> | undefined; let next: Promise<{ text: string }> | undefined;
  try {
    const provider = adapter({ mode: "live", max: 2 }); const first = [user("a [tool]")];
    const a = await turn(provider, first, { context: { threadId: "A" } }); await sleep(5);
    await turn(provider, [user("c [tool]")], { context: { threadId: "C" } });
    const [old] = await h.pids();
    // Thread B needs a slot: A, the least recently used session, waits for tools, so it is aborted and killed.
    newcomer = turn(provider, [user("b")], { context: { threadId: "B" } }).catch(error => error as unknown);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "abort" && entry.pid === old)));
    assert.ok(alive(old), "the evicted session is still ending");
    // Its thread's next request arrives inside that window, and waits for it: nothing new starts while the gate is shut.
    next = turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")], { context: { threadId: "A" } });
    next.catch(() => {});
    await sleep(300);
    assert.equal((await creates(h)).length, 2, "no CLI was started beside the dying one");
    assert.ok(alive(old), "and it is still there");
    await writeFile(gate, "x");
    assert.match((await next).text, /^answer/); await newcomer;
    const all = await creates(h); assert.equal(all.length, 4, "A, C, B and A again");
    for (const entry of all) assert.ok(entry.alivePeers.length + 1 <= 2, `${entry.alivePeers.length + 1} CLIs ran when ${entry.pid} was created; the cap is 2`);
    const again = all.at(-1)!; assert.ok(!again.alivePeers.includes(old) && !again.folders.some((name: string) => again.directory.endsWith(name)), "the evicted process was gone before its thread's new one started");
    assert.ok(!alive(old));
    const outcomes = await kinds(h);
    assert.ok(outcomes.includes("evicted") && outcomes.includes("reseeded:evicted"), `the thread says why it started over: ${outcomes.join(",")}`);
    assert.equal(outcomes.filter(kind => kind === "spawned").length, 3, "only the first request of each of the three threads spawned");
  } finally { sessionLimits.abortMs = limit; await writeFile(gate, "x"); await newcomer; await next?.catch(() => {}); await h.restore(); }
});
