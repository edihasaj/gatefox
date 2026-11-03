import test from "node:test";
import assert from "node:assert/strict";
import { grokLimits } from "../providers/grok-live-session.js";
import { ProviderError } from "../providers/provider.js";
import { validateConfig, grokSessionSettings } from "../config.js";
import { adapter, alive, callIds, harness, live, outputFor, sleep, turn, until, user } from "./grok-live-harness.js";

const rejected = (promise: Promise<unknown>) => promise.then(() => undefined, error => error as ProviderError);
const gone = async (h: Awaited<ReturnType<typeof harness>>, pids: number[]) => until(async () => live().sessions().length === 0 && (await h.liveDirs()).length === 0 && pids.every(pid => !alive(pid)));

test("a parked session is closed after parkMinutes: process killed, folder removed, and the conversation is refused with the reason", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    grokLimits.parkMs = 150;
    const provider = adapter(); const first = [user("start [plain]")];
    const a = await turn(provider, first);
    assert.equal(a.text, "answer to plain");
    assert.equal((await h.liveDirs()).length, 1);
    const pids = await h.pids();
    assert.ok(await gone(h, pids), "reaped");
    const error = await rejected(turn(provider, [...first, ...a.output, user("again [plain]")]));
    assert.equal(error?.upstream?.code, "session_continuity_unavailable"); assert.match(error!.message, /parked/);
    const events = await h.sessions();
    assert.ok(events.some(entry => entry.outcome === "reaped" && entry.missReason === "parked"));
    assert.ok(events.some(entry => entry.outcome === "refused" && entry.missReason === "parked"));
  } finally { await h.restore(); }
});

test("a session waiting for tool outputs is closed after toolWaitMinutes and its held call fails", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    grokLimits.toolWaitMs = 150;
    const provider = adapter(); const first = [user("start [tool]")];
    const a = await turn(provider, first);
    assert.equal(callIds(a.output).length, 1);
    assert.ok(await gone(h, await h.pids()), "reaped while waiting");
    const error = await rejected(turn(provider, [...first, ...a.output, ...outputFor(a.output, "late")]));
    assert.equal(error?.upstream?.code, "session_continuity_unavailable"); assert.match(error!.message, /tool_wait_expired/);
    assert.ok((await h.sessions()).some(entry => entry.outcome === "reaped" && entry.missReason === "tool_wait_expired"));
  } finally { await h.restore(); }
});

test("a crash during a turn fails the request, and a crash while waiting for outputs ends the conversation", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    const error = await rejected(turn(provider, [user("go [crash]")], { context: { threadId: "crash" } }));
    // A crash after the prompt was sent is final: a retry would pay for the turn again in a second process.
    assert.ok(error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable", `crash error: ${error?.code}`);
    assert.ok(await gone(h, await h.pids()));
    const first = [user("start [tool]")]; const a = await turn(provider, first, { context: { threadId: "waiting" } });
    const pid = (await h.pids()).at(-1)!; process.kill(pid, "SIGKILL");
    assert.ok(await until(() => live().sessions().length === 0));
    const refused = await rejected(turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")], { context: { threadId: "waiting" } }));
    assert.equal(refused?.upstream?.code, "session_continuity_unavailable"); assert.match(refused!.message, /session_dead/);
    assert.ok((await h.sessions()).filter(entry => entry.outcome === "crashed").length >= 2);
    assert.ok(await until(async () => (await h.liveDirs()).length === 0));
  } finally { await h.restore(); }
});

test("a CLI that dies at start fails the request with no process, server or folder left", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    process.env.GATEWAY_TEST_GROK_DIE_ON_START = "1";
    const error = await rejected(turn(adapter(), [user("go [plain]")]));
    assert.ok(error instanceof ProviderError && error.code === "cli_failed");
    assert.equal(live().sessions().length, 0); assert.ok(await until(async () => (await h.liveDirs()).length === 0));
  } finally { await h.restore(); }
});

test("an aborted request kills the session; at most grokSessions.max conversations are live and the next is refused", { timeout: 40000 }, async () => {
  const h = await harness();
  try {
    const stalled = new AbortController(); const provider = adapter();
    const running = rejected(turn(provider, [user("go [stall]")], { context: { threadId: "stall" }, controller: stalled }));
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "prompt")));
    stalled.abort();
    const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled");
    assert.ok(await gone(h, await h.pids()), "abort ended the process");
    const capped = adapter({ mode: "live", max: 1 });
    const one = await turn(capped, [user("a [plain]")], { context: { threadId: "one" } });
    assert.equal(one.text, "answer to plain");
    const busy = await rejected(turn(capped, [user("b [plain]")], { context: { threadId: "two" } }));
    assert.ok(busy instanceof ProviderError && busy.status === 400 && busy.upstream?.code === "session_continuity_unavailable" && /capacity/.test(busy.message));
    assert.equal(live().sessions().length, 1); assert.equal((await h.pids()).length, 2, "the refused conversation started nothing");
    assert.ok((await h.sessions()).some(entry => entry.outcome === "refused" && entry.missReason === "capacity"));
    await sleep(0);
  } finally { await h.restore(); }
});

test("grokSessions is validated: live or one-shot, bounded limits, Grok providers only; absent means live", () => {
  const config = (grokSessions: unknown, type = "grok-subscription") => validateConfig({ version: 1, port: 1, stateDirectory: "/tmp/state", providers: [{ id: "g", type, models: { a: "x" }, grokSessions }] }, "/tmp");
  assert.deepEqual(config({ mode: "live", max: 2, parkMinutes: 10, toolWaitMinutes: 5 }).providers[0].grokSessions, { mode: "live", max: 2, parkMinutes: 10, toolWaitMinutes: 5 });
  assert.doesNotThrow(() => config({ mode: "oneshot" }));
  assert.throws(() => config({ mode: "replay" }), /mode must be oneshot or live/);
  assert.throws(() => config({ max: 0 }), /max must be 1 through 16/); assert.throws(() => config({ parkMinutes: 4 }), /parkMinutes/);
  assert.throws(() => config({ toolWaitMinutes: 26 }), /toolWaitMinutes must be 1 through 25/);
  assert.throws(() => config([]), /must be an object/); assert.throws(() => config({}, "copilot-subscription"), /only valid for grok-subscription/);
  assert.deepEqual(grokSessionSettings({}), { mode: "live", max: 4, parkMinutes: 30, toolWaitMinutes: 25 }, "live is the default");
  assert.equal(grokSessionSettings({ grokSessions: { mode: "oneshot" } }).mode, "oneshot");
});
