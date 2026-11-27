import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProviderError } from "../providers/provider.js";
import { GeminiEndedStore } from "../providers/gemini-ended-store.js";
import { geminiEndReasons, geminiStopReason, geminiStopReasons, fixedReason as fixedGeminiReason } from "../providers/gemini-reasons.js";
import { adapter, alive, builtinTools, callIds, grepName, harness, kind, live, lookupName, outputFor, sleep, tools, turn, until, user } from "./gemini-live-harness.js";

const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as ProviderError);
const continuityRefusal = (error: ProviderError | undefined) => { assert.ok(error instanceof ProviderError); assert.equal(error.status, 400); assert.equal(error.upstream?.code, "session_continuity_unavailable"); return error; };

test("a tool loop keeps one Gemini process, and a new user turn reuses the session", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    assert.deepEqual(a.events.map(kind), ["text", "tool:lookup", "done"]);
    const call = a.events.find(event => event.type === "tool");
    assert.ok(call?.type === "tool" && call.call.function.arguments === JSON.stringify({ id: "7" }));
    assert.equal(callIds(a.output).length, 1);
    const second = [...first, ...a.output, ...outputFor(a.output, "weather-ok")];
    const b = await turn(provider, second);
    assert.match(b.text, /got:weather-ok$/);
    const c = await turn(provider, [...second, ...b.output, user("follow up [plain]")]);
    assert.equal(c.text, "answer to plain");
    assert.equal((await h.pids()).length, 1, "one process served all three requests");
    assert.deepEqual((await h.sessions()).filter(entry => entry.outcome === "spawned" || entry.outcome === "continued").map(entry => entry.outcome), ["spawned", "continued", "continued"]);
  } finally { await h.restore(); }
});

test("the caller's catalog is what the CLI lists, and the gateway holds every call", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    await turn(adapter(), [user("start [tool]")]);
    const listed = (await h.log()).find(entry => entry.op === "listed")!;
    assert.deepEqual(listed.names, [lookupName]);
    assert.equal(listed.discover, -32601, "server/discover is answered, not hung");
    assert.equal((await h.log()).filter(entry => entry.op === "result").length, 0, "nothing is answered until the caller replies");
  } finally { await h.restore(); }
});

test("a native tool is never allowed and never runs, and an unknown gateway tool is refused", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    const native = await turn(provider, [user("go [native]")], { context: { threadId: "native" } });
    assert.equal(native.text, "native:r", "the CLI was told to run nothing");
    await sleep(50);
    await assert.rejects(access(join(h.scratch, "native-ran")), "the provider executed no tool of its own");
    const unknown = await turn(provider, [user("go [unknown]")], { context: { threadId: "unknown" } });
    assert.equal(unknown.text, "unknown:denied:r");
    const foreign = await turn(provider, [user("go [foreign]")], { context: { threadId: "foreign" } });
    assert.equal(foreign.text, "foreign:r");
    const outcomes = (await h.log()).filter(entry => entry.op === "permission").map(entry => entry.outcome);
    assert.deepEqual(outcomes, ["r", "r", "r"]);
    assert.ok(!outcomes.some(outcome => outcome === "aa"), "allow_always is never selected");
    assert.ok((await h.sessions()).some(entry => entry.permissionsDenied === 1), "the refusals are counted");
  } finally { await h.restore(); }
});

test("a caller tool named like a CLI built-in stays the caller's tool and runs through the loop", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("find it [builtinname]")];
    const a = await turn(provider, first, { context: { threadId: "builtin-name" }, extra: { tools: builtinTools } });
    assert.deepEqual((await h.log()).find(entry => entry.op === "listed")!.names, [grepName], "the caller's grep_search is what the CLI lists");
    assert.deepEqual(a.events.map(kind), ["text", "tool:grep_search", "done"], "the announcement guard did not end the session over the tool's name");
    const call = a.events.find(event => event.type === "tool");
    assert.ok(call?.type === "tool" && call.call.function.arguments === JSON.stringify({ pattern: "needle" }));
    const second = [...first, ...a.output, ...outputFor(a.output, "needle at line 3")];
    const b = await turn(provider, second, { context: { threadId: "builtin-name" }, extra: { tools: builtinTools } });
    assert.match(b.text, /builtinname:needle at line 3$/, "the caller ran the tool and its output came back through the same session");
    assert.equal((await h.pids()).length, 1, "one process served both requests");
    assert.ok(!(await h.sessions()).some(entry => entry.missReason === "invalid_tool_call"), "no announcement guard fired");
    assert.deepEqual((await h.log()).filter(entry => entry.op === "permission").map(entry => entry.outcome), ["a"], "allowed once, as a call of the gateway's own server");
  } finally { await h.restore(); }
});

test("a client request the gateway does not serve is answered rather than left waiting", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const result = await turn(adapter(), [user("go [clientrequest]")], { context: { threadId: "clientrequest" } });
    assert.equal(result.text, "fs:-32601", "fs/read_text_file is refused, and the CLI advertised no filesystem access");
  } finally { await h.restore(); }
});

test("with resume: refuse, history that does not extend the session is refused and the session survives", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", resume: "refuse" }); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    const good = [...first, ...a.output, ...outputFor(a.output, "ok")];
    continuityRefusal(await rejected(turn(provider, [user("start [tool] edited"), ...a.output, ...outputFor(a.output, "ok")])));
    continuityRefusal(await rejected(turn(provider, [...first, ...a.output])));
    continuityRefusal(await rejected(turn(provider, good, { extra: { tools: [...tools, { type: "function", name: "other", description: "Other", parameters: { type: "object", properties: {} } }] } })));
    continuityRefusal(await rejected(turn(provider, good, { context: { threadId: "other-thread" } })));
    assert.equal((await h.pids()).length, 1, "no refusal started a process");
    const b = await turn(provider, good);
    assert.match(b.text, /got:ok$/, "the session still held the call after every refusal");
    const reasons = (await h.sessions()).filter(entry => entry.outcome === "refused").map(entry => entry.missReason);
    assert.deepEqual(reasons, ["prefix_diverged", "unexpected_tail", "fingerprint_changed", "session_missing"]);
  } finally { await h.restore(); }
});

test("with resume: refuse, a conversation whose session ended is never reopened, so its history is never paid for twice", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", resume: "refuse" }); const first = [user("hello [plain]")];
    const a = await turn(provider, first, { context: { threadId: "ended-thread" } });
    assert.equal(a.text, "answer to plain");
    const [session] = live().sessions();
    await session.close("reaped", "parked");
    assert.ok(await until(async () => live().sessions().length === 0));
    const refusal = continuityRefusal(await rejected(turn(provider, [...first, ...a.output], { context: { threadId: "ended-thread" } })));
    assert.match(refusal.message, /parked/);
    assert.equal((await h.pids()).length, 1, "an ended conversation never starts a second process");
    // The record survives a gateway restart: the store file is what a new process would read.
    const stored = JSON.parse(await readFile(join(h.home, "gateway-ended-sessions.json"), "utf8")) as { entries?: Record<string, unknown> };
    assert.ok(Object.keys(stored.entries ?? {}).length === 1, "the ended conversation is recorded in the private home");
  } finally { await h.restore(); }
});

test("by default a conversation whose session ended replays its history into a new session and continues there", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello [plain]")];
    const a = await turn(provider, first, { context: { threadId: "replay-thread" } });
    const [session] = live().sessions();
    await session.close("reaped", "parked");
    assert.ok(await until(async () => live().sessions().length === 0));
    const second = [...first, ...a.output, user("again [think]")];
    const b = await turn(provider, second, { context: { threadId: "replay-thread" } });
    assert.equal(b.text, "answer to think");
    assert.equal((await h.pids()).length, 2, "the replay started one new process");
    // The new session holds the whole history, so the next turn continues it without a third process.
    const c = await turn(provider, [...second, ...b.output, user("more [plain]")], { context: { threadId: "replay-thread" } });
    assert.equal(c.text, "answer to plain");
    assert.equal((await h.pids()).length, 2);
    const entries = await h.sessions();
    const spawned = entries.filter(entry => entry.outcome === "spawned");
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1].replayed, "parked");
    assert.ok(spawned.every(entry => typeof entry.startMs === "number" && entry.startMs >= 0), "each spawn records how long the CLI took to start");
    assert.ok(!entries.some(entry => entry.outcome === "refused"));
  } finally { await h.restore(); }
});

test("by default history the session does not hold replaces the session instead of being refused", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("start [plain]")];
    const a = await turn(provider, first);
    // A chat that started on another model: Gemini never saw this history, so a new session receives all of it.
    const b = await turn(provider, [user("edited start [plain]"), ...a.output, user("next [think]")]);
    assert.equal(b.text, "answer to think");
    assert.equal((await h.pids()).length, 2);
    const replaced = (await h.sessions()).filter(entry => entry.outcome === "spawned").at(-1);
    assert.equal(replaced?.replayed, "prefix_diverged");
    const fresh = await turn(provider, [user("other [plain]"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "earlier" }] }, user("go [plain]")], { context: { threadId: "never-seen" } });
    assert.equal(fresh.text, "answer to plain", "history with no session is replayed, not refused as session_missing");
    assert.equal((await h.sessions()).filter(entry => entry.outcome === "spawned").at(-1)?.replayed, "session_missing");
  } finally { await h.restore(); }
});

test("a store left in the registry by an earlier release is replaced, so a hot-swapped gateway still replays", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello [plain]")];
    const a = await turn(provider, first, { context: { threadId: "swap-thread" } });
    const [session] = live().sessions();
    await session.close("reaped", "parked");
    assert.ok(await until(async () => live().sessions().length === 0));
    // What 2.3.0 left behind after an idle swap: its own store object, which has no `reopen`.
    const registry = (globalThis as unknown as Record<symbol, { stores: Map<string, unknown> }>)[Symbol.for("harness-gateway/gemini-sessions/v1")];
    const real = GeminiEndedStore.forHome(h.home);
    registry.stores.set(h.home, { lookup: (key: string) => real.lookup(key), reserve: (key: string) => real.reserve(key),
      finish: (key: string, why: string) => real.finish(key, why), release: (key: string) => real.release(key) });
    const b = await turn(provider, [...first, ...a.output, user("again [plain]")], { context: { threadId: "swap-thread" } });
    assert.equal(b.text, "answer to plain");
    assert.ok(!(await h.sessions()).some(entry => entry.missReason === "ended_store_unavailable"));
  } finally { await h.restore(); }
});

test("the pool refuses beyond its capacity instead of crowding out a parked conversation", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", max: 2 });
    for (const id of ["a", "b"]) await turn(provider, [user(`go [plain] ${id}`)], { context: { threadId: `cap-${id}` } });
    assert.equal(live().sessions().length, 2);
    continuityRefusal(await rejected(turn(provider, [user("go [plain] c")], { context: { threadId: "cap-c" } })));
    assert.ok((await h.sessions()).some(entry => entry.outcome === "refused" && entry.missReason === "capacity"));
    assert.equal((await h.pids()).length, 2, "the refused conversation started nothing");
  } finally { await h.restore(); }
});

test("a stop reason from the CLI is mapped to a fixed code and never reaches the caller, telemetry or the record", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    for (const known of geminiStopReasons) assert.equal(geminiStopReason(known), known);
    for (const odd of ["CANARY", "", undefined, null, 5, {}, ["end_turn"], { toString: null }, "end_turn "]) assert.equal(geminiStopReason(odd), "unknown");
    assert.equal(fixedGeminiReason("CANARY"), "other"); assert.equal(fixedGeminiReason("parked"), "parked");
    const provider = adapter();
    // An unknown stop reason fails the request: the turn may have spent allowance, so it is never retried elsewhere.
    const error = await rejected(turn(provider, [user("go [stopcanary]")], { context: { threadId: "canary" } }));
    assert.ok(error instanceof ProviderError && error.status === 400, `a fixed refusal, got ${error?.status}`);
    assert.ok(!JSON.stringify(error).includes("CANARY") && !error!.message.includes("CANARY"), "the CLI's own text is never forwarded");
    assert.ok(await until(async () => (await h.pids()).every(pid => !alive(pid))), "the process went with the session");
    // A conversation whose session died this way is refused rather than replayed into a second, charged process.
    const repeat = await rejected(turn(provider, [user("go [stopcanary]")], { context: { threadId: "canary" } }));
    assert.match(repeat!.message, /session_dead|no longer|ended|unavailable/i);
    const entries = await h.sessions();
    assert.ok(entries.some(entry => entry.outcome === "crashed"), "the crash is recorded");
    assert.ok(!JSON.stringify(entries).includes("CANARY"), "the canary appears in no telemetry event");
    const known = new Set<string>(geminiEndReasons);
    for (const entry of entries) if (typeof entry.missReason === "string") assert.ok(known.has(entry.missReason), `fixed missReason, got ${entry.missReason}`);
    const stored = await readFile(join(h.home, "gateway-ended-sessions.json"), "utf8").catch(() => "");
    assert.ok(!stored.includes("CANARY"), "and never in the persisted record");
  } finally { await h.restore(); }
});

for (const tag of ["nullframe", "arrayframe", "numframe", "badmsg", "badcode", "badresult"]) {
  test(`a malformed ${tag} frame ends the connection without taking the gateway down`, { timeout: 40000 }, async () => {
    const h = await harness();
    try {
      const error = await rejected(turn(adapter(), [user(`go [${tag}]`)], { context: { threadId: `fuzz-${tag}` } }));
      assert.ok(error instanceof ProviderError, "the request fails rather than hanging");
      assert.ok(await until(async () => live().sessions().length === 0), "the session is gone");
      assert.ok((await h.pids()).every(pid => !alive(pid)), "no CLI survives it");
    } finally { await h.restore(); }
  });
}

test("a cancelled request closes its session instead of leaving a half-answered prompt", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const controller = new AbortController();
    const pending = turn(adapter(), [user("go [stall]")], { context: { threadId: "stall" }, controller });
    assert.ok(await until(async () => live().sessions().some(session => session.state === "generating")));
    controller.abort();
    const error = await rejected(pending);
    assert.ok(error instanceof ProviderError && error.status === 499, `a cancellation, got ${error?.status}`);
    assert.ok(await until(async () => live().sessions().length === 0));
    assert.ok(await until(async () => (await h.liveDirs()).length === 0), "the session's private folder is removed");
  } finally { await h.restore(); }
});
