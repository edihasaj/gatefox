import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { evictable, idleMs, pinReplay, rememberEnd, replayPinned, sessionRegistry } from "../providers/claude-session-registry.js";
import { systemPrefixCacheReadTokens, systemPrefixOnly } from "../providers/claude-usage.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture, type ClaudeFixture, type FixtureScenario } from "./claude-cli-fixture.js";
import type { InferenceEvent, ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";
import type { InferenceContext } from "../providers/provider.js";

/**
 * Live sessions must never write more cache than the one-shot replay path. Three rules keep that
 * true: every rendered block ends on a marker, a warm session is never evicted, and a thread whose
 * history diverged or whose CLI died replays until a session of its own could keep a cache again.
 * These requests carry no caller tools, so they need no relay and run on any machine.
 */
const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const said = (text: string): ResponsesInputItem => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const providerId = `claude-b4-${process.pid}`;
const keyOf = (threadId: string) => createHash("sha256").update(`${providerId}\0\0${threadId}`).digest("hex");
const adapter = (sessions: Record<string, unknown>) => new ClaudeSubscription({ id: providerId, type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: "replay", warmup: 0, ...sessions } });
const thread = (id: string): InferenceContext => ({ threadId: id });

async function turn(provider: ClaudeSubscription, input: ResponsesInputItem[], context: InferenceContext): Promise<string> {
  const events: InferenceEvent[] = [];
  for await (const event of provider.infer({ model: "fixture", input } as ResponsesRequest, new AbortController().signal, context)) events.push(event);
  return events.flatMap(event => event.type === "text" ? [event.text] : []).join("");
}

async function setup(scenario: FixtureScenario = { replies: [] }) {
  const f = await installClaudeFixture(scenario);
  configureTelemetry(f.directory, "test"); const since = Date.now();
  const events = async () => { await flushTelemetry(); return (await readTelemetry(f.directory, since)).filter(entry => entry.event === "claude_session" && entry.outcome !== "closed"); };
  return {
    f, since,
    events,
    writes: async () => (await events()).concat((await readTelemetry(f.directory, since)).filter(entry => entry.event === "claude_cli"))
      .reduce((sum, entry) => sum + (typeof entry.cacheWriteTokens === "number" ? entry.cacheWriteTokens : 0), 0),
    starts: async () => (await f.capture()).filter(entry => entry.start).map(entry => entry.start!),
    livePids: async () => (await f.capture()).filter(entry => entry.start === "live").map(entry => entry.pid),
  };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function gone(pid: number, withinMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (alive(pid)) { if (Date.now() - started > withinMs) return false; await sleep(10); }
  return true;
}
const age = (session: { lastUse: number }) => { session.lastUse = Date.now() - idleMs - 1000; };

test("a held thread reports the miss that held it until the cache hour passes", () => {
  const registry = sessionRegistry(); const now = Date.now();
  pinReplay(registry, "held-key", now, "prefix_diverged");
  assert.equal(replayPinned(registry, "held-key", now + 1000), "prefix_diverged");
  assert.equal(replayPinned(registry, "held-key", now + idleMs), undefined, "past the hour a session of its own could keep a cache again");
  assert.equal(registry.ended.get("held-key"), undefined, "and the reason goes with it");
  pinReplay(registry, "crashed-key", now, "crashed");
  assert.equal(replayPinned(registry, "crashed-key", now + 1), "crashed", "a CLI that died holds its thread too");
});

test("a hold keeps its reason when the ended log cycles past it", () => {
  const registry = sessionRegistry(); const now = Date.now();
  pinReplay(registry, "kept-key", now, "unexpected_tail");
  for (let n = 0; n < 257; n++) rememberEnd(registry, `other-${n}`, "closed");
  assert.equal(registry.ended.get("kept-key"), undefined, "the reason would have cycled out of the ended log");
  assert.equal(replayPinned(registry, "kept-key", now + 1), "unexpected_tail", "but the hold carries it, so the thread keeps replaying");
  registry.replayUntil.delete("kept-key");
});

test("a hold an earlier release left on an adopted registry still expires", () => {
  const registry = sessionRegistry(); const now = Date.now();
  (registry.replayUntil as Map<string, unknown>).set("legacy-key", now - 1000); rememberEnd(registry, "legacy-key", "crashed");
  assert.equal(replayPinned(registry, "legacy-key", now), "crashed", "its reason still came from the ended log");
  assert.equal(replayPinned(registry, "legacy-key", now + idleMs), undefined, "and an hour quiet still frees the thread");
});

test("a cache read only counts as a prefix rewrite once the request reached the prefix", () => {
  // The threshold is calibrated to the Codex system prefix, so a short prompt says nothing at all.
  assert.equal(systemPrefixOnly(558, 700), undefined, "the whole request is smaller than the prefix it supposedly rewrote");
  assert.equal(systemPrefixOnly(systemPrefixCacheReadTokens, 20_000), true, "a request that reached past it and read only the prefix rewrote its history");
  assert.equal(systemPrefixOnly(90_000, 400), false, "and one that read the conversation back did not");
});

test("an in-place upgrade adopts the registry an earlier release left, sessions and all", async () => {
  // These requests need no relay, so the registry's shared-object rules live here.
  const { f, starts, events, livePids } = await setup({ replies: [{ text: "one" }, { text: "two" }, { text: "three" }] });
  const symbol = Symbol.for("harness-gateway/claude-sessions/v1");
  const scope = globalThis as unknown as Record<symbol, Record<string, unknown> | undefined>;
  try {
    const provider = adapter({ mode: "live", max: 6 });
    await turn(provider, [user("first")], thread("u1"));
    const current = scope[symbol]!;
    // What 0.3.6 and 0.3.7 left on the symbol: interface version 1 with no replay holds and no owner scopes,
    // around the session that is already running.
    const registry: Record<string, unknown> = { interfaceVersion: 1, sessions: current.sessions, starting: new Set(), ended: new Map() };
    scope[symbol] = registry;
    assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions().length, 1, "the new runtime finds the session already running");
    assert.equal(scope[symbol], registry, "in place: the same registry object, not a replacement of its own");
    assert.ok(registry.replayUntil instanceof Map && registry.scopes instanceof Map, "the fields this release added came with their maps");
    assert.equal(await turn(provider, [user("first"), said("one"), user("second")], thread("u1")), "two", "the adopted session answered, scope and all");
    assert.deepEqual(await starts(), ["live"], "and the thread was not seeded a second process");
    assert.deepEqual((await events()).map(entry => entry.outcome), ["spawned", "continued"]);
    // The continued turn gave the adopted session its owner scope, so a switch to replay can retire it.
    const [adopted] = await livePids();
    await turn(adapter({ mode: "replay" }), [user("elsewhere")], thread("u2"));
    assert.ok(await gone(adopted!, 2000), "and a switch to replay retired the adopted session");
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await f.restore(); }
});

test("a full registry replays a new thread rather than evicting a warm one", async () => {
  const { f, starts, livePids, events } = await setup({ replies: [{ text: "a" }, { text: "b" }, { text: "c" }] });
  try {
    const provider = adapter({ mode: "live", max: 2 });
    await turn(provider, [user("first")], thread("t1"));
    await turn(provider, [user("second")], thread("t2"));
    assert.equal(await turn(provider, [user("third")], thread("t3")), "c");
    assert.deepEqual(await starts(), ["live", "live", "oneshot"], "the newcomer paid for itself instead of spending another thread's cache");
    assert.equal(claudeLive({ max: 2, parkMinutes: 60 }).sessions().length, 2, "nothing was closed to make room");
    for (const pid of await livePids()) assert.ok(alive(pid), "both sessions are still running");
    assert.equal(evictable(sessionRegistry()), undefined, "a session a minute old is not evictable");
    assert.deepEqual((await events()).map(entry => entry.outcome), ["spawned", "spawned", "fallback"], "and no session was reported evicted");
  } finally { await claudeLive({ max: 2, parkMinutes: 60 }).stop(); await f.restore(); }
});

test("a session whose cache has gone cold is the one that makes room", async () => {
  const { f, events, starts, livePids } = await setup({ replies: [{ text: "a" }, { text: "b" }] });
  try {
    const provider = adapter({ mode: "live", max: 1 });
    await turn(provider, [user("first")], thread("t1"));
    const [cold] = claudeLive({ max: 1, parkMinutes: 60 }).sessions(); const [first] = await livePids();
    age(cold!);
    assert.notEqual(evictable(sessionRegistry()), undefined, "once its cache is gone, a finished session may make room");
    assert.equal(await turn(provider, [user("second")], thread("t2")), "b");
    assert.deepEqual(await starts(), ["live", "live"]);
    assert.ok(await gone(first), "the cold session closed for it");
    assert.deepEqual((await events()).map(entry => entry.outcome).sort(), ["evicted", "spawned", "spawned"]);
  } finally { await claudeLive({ max: 1, parkMinutes: 60 }).stop(); await f.restore(); }
});

test("concurrent attaches never start more sessions than the cap", async () => {
  const { f, livePids, starts } = await setup();
  try {
    const provider = adapter({ mode: "live", max: 2 });
    await Promise.all([1, 2, 3].map(n => turn(provider, [user(`t${n}`)], thread(`c${n}`))));
    assert.ok((await livePids()).length <= 2, "the starting set counts toward the cap");
    assert.deepEqual((await starts()).sort(), ["live", "live", "oneshot"], "the attach that found no slot replayed");
  } finally { await claudeLive({ max: 2, parkMinutes: 60 }).stop(); await f.restore(); }
});

test("a diverged history replays instead of paying for a second cache write", async () => {
  const { f, starts, events } = await setup({ replies: [{ text: "one" }, { text: "two" }, { text: "three" }, { text: "four" }, { text: "five" }, { text: "six" }] });
  try {
    const provider = adapter({ mode: "live", max: 6 });
    await turn(provider, [user("first")], thread("d1"));
    assert.equal(await turn(provider, [user("first, edited")], thread("d1")), "two", "the diverged turn answered from the one-shot path");
    assert.deepEqual(await starts(), ["live", "oneshot"], "no second process was started for the same thread");
    assert.ok((await events()).some(entry => entry.outcome === "fallback" && entry.missReason === "prefix_diverged"));
    assert.equal(await turn(provider, [user("first, edited"), said("two"), user("again")], thread("d1")), "three", "still replaying while its cache could not survive a reseed");
    assert.deepEqual((await starts()).filter(entry => entry === "live").length, 1);
    // A request 59 minutes into the hold is still inside the cache hour, so it stays on replay and
    // restarts the hour: a busy thread never gets a session that would have to reseed it next turn.
    sessionRegistry().replayUntil.set(keyOf("d1"), { since: Date.now() - 59 * 60 * 1000, why: "prefix_diverged" });
    assert.equal(await turn(provider, [user("first, edited"), said("two"), said("three"), user("still")], thread("d1")), "four", "the minute that was left did not buy a reseed");
    assert.deepEqual((await starts()).filter(entry => entry === "live").length, 1, "and it started no second process");
    assert.ok(Date.now() - sessionRegistry().replayUntil.get(keyOf("d1"))!.since < 60_000, "the request kept the hold, with the hour starting at it");
    assert.equal(await turn(provider, [user("first, edited"), said("two"), said("three"), said("four"), user("still going")], thread("d1")), "five", "the next turn is held the same way");
    assert.deepEqual((await starts()).filter(entry => entry === "live").length, 1, "still one live process for this thread");
    // An hour quiet later the cache is gone either way, so the thread may hold a session again.
    sessionRegistry().replayUntil.set(keyOf("d1"), { since: Date.now() - idleMs - 1, why: "prefix_diverged" });
    assert.equal(await turn(provider, [user("first, edited"), said("two"), said("three"), said("four"), said("five"), user("now")], thread("d1")), "six");
    assert.deepEqual((await starts()).filter(entry => entry === "live").length, 2, "and it seeded a live session");
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await f.restore(); }
});

test("a crashed session holds its thread; only an idle hour lets a new process start", async () => {
  const { f, starts, events } = await setup({ replies: [{ text: "one" }, { text: "two" }, { text: "three" }], exitAtFirstUser: true });
  try {
    const provider = adapter({ mode: "live", max: 6 });
    assert.equal(await turn(provider, [user("first")], thread("c1")), "one", "the live CLI died on its seed, so the one-shot path answered");
    assert.deepEqual(await starts(), ["live", "oneshot"]);
    assert.ok((await events()).some(entry => entry.outcome === "crashed"), "and the crash itself is reported");
    assert.equal(await turn(provider, [user("first"), said("one"), user("again")], thread("c1")), "two", "the next request replays: a new process would only die on the same cache write");
    assert.ok((await events()).some(entry => entry.outcome === "fallback" && entry.missReason === "session_dead"), "held by the dead session");
    assert.deepEqual((await starts()).filter(entry => entry === "live").length, 1, "starting no live CLI");
    sessionRegistry().replayUntil.set(keyOf("c1"), { since: Date.now() - idleMs - 1, why: "crashed" });
    assert.equal(await turn(provider, [user("first"), said("one"), said("two"), user("later")], thread("c1")), "three");
    assert.deepEqual((await starts()).filter(entry => entry === "live").length, 2, "a thread quiet for an hour may hold a session again");
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await f.restore(); }
});

test("a returning thread costs live sessions no more cache than replay would have", async () => {
  // Measured pattern: more threads than slots, an eviction attempt, then each thread returns well
  // inside its cache's hour, with a user message that trails spaces and a tool result that trails a newline.
  // Distinct text per thread: two chats that happen to ask the same thing share one replay cache prefix.
  const open = (n: number) => `start thread ${n}`;
  const pattern = async (provider: ClaudeSubscription) => {
    for (const n of [1, 2, 3]) await turn(provider, [user(open(n))], thread(`r${n}`));
    await turn(provider, [user(open(1)), said("ok"), user(`follow up ${1}?  `)], thread("r1"));
    await turn(provider, [user(open(2)), said("ok"), user(`follow up ${2}?  `)], thread("r2"));
    await turn(provider, [user(open(1)), said("ok"), user(`follow up ${1}?  `), said("ok"), user(`third ${1}`)], thread("r1"));
  };
  let replayWrites = 0; let replayStarts: string[] = [];
  const replaySetup = await setup({ replies: [{ text: "ok" }], cache: true });
  try { await pattern(adapter({ mode: "replay" })); replayWrites = await replaySetup.writes(); replayStarts = await replaySetup.starts(); } finally { await replaySetup.f.restore(); }
  assert.equal(replayStarts.filter(entry => entry === "oneshot").length, 6, "every replay request ran its own CLI");
  const liveSetup = await setup({ replies: [{ text: "ok" }], cache: true });
  try {
    await pattern(adapter({ mode: "live", max: 2 }));
    const liveWrites = await liveSetup.writes();
    assert.ok(replayWrites > 0 && liveWrites <= replayWrites, `live sessions wrote ${liveWrites} cache tokens against replay's ${replayWrites}`);
    assert.ok((await liveSetup.starts()).filter(entry => entry === "live").length <= 3, "at most one session per live thread");
  } finally { await claudeLive({ max: 2, parkMinutes: 60 }).stop(); await liveSetup.f.restore(); }
});

test("switching a provider to replay closes its parked sessions at once and leaves other providers' alone", async () => {
  const { f, livePids, since } = await setup({ replies: [{ text: "a" }, { text: "b" }, { text: "c" }] });
  const other = (mode: string) => new ClaudeSubscription({ id: `${providerId}-other`, type: "claude-subscription", models: { alias: "fixture" }, claudeSessions: { mode: mode as "live" | "replay", warmup: 0 } });
  try {
    await turn(adapter({ mode: "live", max: 4 }), [user("mine")], thread("m1"));
    await turn(other("live"), [user("theirs")], thread("o1"));
    const [mine, theirs] = await livePids();
    assert.ok(alive(mine) && alive(theirs));
    // The same provider id with mode replay: the config changed, and the next request is the daemon's first sight of it.
    assert.equal(await turn(adapter({ mode: "replay" }), [user("after the switch")], thread("m2")), "c");
    assert.ok(await gone(mine, 2000), "the switched provider's parked session closed on that request, long before its park timer");
    assert.ok(alive(theirs), "a provider that stays live keeps its session");
    assert.equal(claudeLive({ max: 4, parkMinutes: 60 }).sessions().length, 1);
    await flushTelemetry();
    assert.ok((await readTelemetry(f.directory, since)).some(entry => entry.event === "claude_session" && entry.outcome === "closed" && entry.missReason === "mode_replay"), "and the close was reported");
  } finally { await claudeLive({ max: 4, parkMinutes: 60 }).stop(); await f.restore(); }
});
