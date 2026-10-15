import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig } from "../config.js";
import { ProviderError } from "../providers/provider.js";
import { resetLiveSweep } from "../providers/copilot-live.js";
import { runShutdownHooks } from "../runtime-activity.js";
import { adapter, alive, callIds, harness, live, outputFor, thread, turn, until, user, type Harness } from "./copilot-live-harness.js";

const settled = (value: Promise<unknown>) => value.then(() => undefined, error => error as unknown);
/** After a failure the process is dead, the folder is gone and the registry holds nothing. */
async function closed(h: Harness, pid: number): Promise<void> {
  assert.ok(await until(() => !alive(pid)), "the CLI process ended"); assert.ok(await until(async () => (await h.liveDirs()).length === 0), "its folder was removed");
  assert.ok(await until(() => live().sessions().length === 0), "the registry forgot it");
}

test("folders of a gateway that died are swept once, and a living gateway's folders are kept", async () => {
  const h = await harness();
  try {
    resetLiveSweep();
    const dead = join(h.scratch, "gateway-copilot-live-zzzzzz-abc123"); const living = join(h.scratch, `gateway-copilot-live-${process.ppid.toString(36)}-abc123`); const oneShot = join(h.scratch, "gateway-copilot-abc123");
    for (const path of [dead, living, oneShot]) await mkdir(path);
    await turn(adapter(), [user("hello")]);
    const names = await h.liveDirs();
    assert.ok(!names.includes("gateway-copilot-live-zzzzzz-abc123"), "a dead owner's folder, which holds a prompt log, is removed");
    assert.ok(names.includes(living.split("/").at(-1)!) && names.includes("gateway-copilot-abc123"), "other folders stay");
  } finally { await h.restore(); }
});

test("a permission request, a foreign tool or a native tool call is rejected and ends the session completely", async () => {
  for (const marker of ["permission", "native", "nativemsg"]) {
    const h = await harness();
    try {
      const error = await settled(turn(adapter(), [user(`do it [${marker}]`)]));
      assert.ok(error instanceof ProviderError && error.code === "invalid_tool_call", `${marker}: ${String(error)}`);
      const [pid] = await h.pids(); await closed(h, pid);
      assert.ok((await h.sessions()).some(entry => entry.outcome === "crashed"), "the crash is recorded");
    } finally { await h.restore(); }
  }
});

test("a parked session, one waiting too long for tool outputs and a crashed CLI each release their process and folder", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first); live().sessions()[0].timers(40, 60000);
    await closed(h, (await h.pids())[0]);
    // Waiting on tool outputs ends sooner than parking: Copilot fails a pending tool call after 30 minutes and then calls the model on its own.
    const b = await turn(provider, [...first, ...a.output, user("go [tool]")]);
    live().sessions()[0].timers(60000, 40);
    await closed(h, (await h.pids())[1]);
    const c = await turn(provider, [...first, ...a.output, user("go [tool]"), ...b.output, ...outputFor(b.output, "plain")]);
    assert.match(c.text, /^answer/);
    // Killing the CLI under an idle session ends it too.
    const [pid] = [(await h.pids()).at(-1)!]; process.kill(pid, "SIGKILL");
    await closed(h, pid);
    await turn(provider, [...first, ...a.output, user("go [tool]"), ...b.output, ...outputFor(b.output, "plain"), ...c.output, user("after the crash")]);
    const kinds = (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));
    assert.ok(kinds.includes("reaped") && kinds.includes("reaped:tool_wait") && kinds.includes("crashed:cli_failed") && kinds.includes("reseeded:session_dead"), kinds.join(","));
  } finally { await h.restore(); }
});

test("gateway shutdown closes every live session, and an exiting gateway can stop them synchronously", async () => {
  const h = await harness();
  try {
    const provider = adapter();
    await turn(provider, [user("a [tool]")], { context: { threadId: "A" } }); await turn(provider, [user("b")], { context: { threadId: "B" } });
    await turn(provider, [user("c")], { context: { threadId: "C" } });
    const pids = await h.pids(); assert.equal(pids.length, 3); assert.equal((await h.liveDirs()).length, 3);
    const [third] = live().sessions().slice(-1);
    third.emergencyStop(); assert.ok(await until(() => !alive(pids[2])), "the exit handler kills the CLI at once");
    assert.equal((await h.liveDirs()).length, 2, "and removes its folder without awaiting anything");
    await runShutdownHooks(3000);
    for (const pid of pids) assert.ok(await until(() => !alive(pid)));
    assert.deepEqual(await h.liveDirs(), []); assert.equal(live().sessions().length, 0);
  } finally { await h.restore(); }
});

test("requests that cannot join a session run one-shot, and a forced tool choice also ends the thread's session", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const creates = async () => (await h.log()).filter(entry => entry.op === "create");
    await turn(provider, [user("hello")], { context: {} });
    await turn(provider, [user("hello")], { context: { threadId: "thread-1", requestKind: "compaction" } });
    const png = { type: "message" as const, role: "user" as const, content: [{ type: "input_image" as const, image_url: "data:image/png;base64,iVBORw0KGgo=" }] };
    await turn(provider, [user("look"), png]);
    assert.equal(live().sessions().length, 0, "no session was started"); assert.ok((await creates()).every(entry => entry.params.largeOutput === undefined), "all three ran the one-shot path");
    assert.deepEqual(await h.liveDirs(), [], "one-shot folders are removed too");
    const a = await turn(provider, [user("start")]); assert.equal(live().sessions().length, 1);
    const [pid] = [(await h.pids()).at(-1)!];
    const forced = await turn(provider, [user("start"), ...a.output, user("call it [tool]")], { extra: { tool_choice: { type: "function", name: "lookup" } } });
    assert.equal(callIds(forced.output).length, 1, "the forced call was served one-shot");
    await closed(h, pid);
    await turn(provider, [user("answer without tools")], { extra: { tool_choice: "none" } });
    const reasons = (await h.sessions()).filter(entry => entry.outcome === "fallback").map(entry => entry.missReason);
    assert.deepEqual(reasons, ["no_thread", "request_kind", "images", "forced_choice", "forced_choice"]);
    assert.equal(live().sessions().length, 0);
  } finally { await h.restore(); }
});

test("a session whose CLI dies before its first event falls back to one-shot, and one-shot mode retires parked sessions", async () => {
  const h = await harness();
  try {
    const provider = adapter(); process.env.GATEWAY_COPILOT_LIVE_DIE = h.die;
    const a = await turn(provider, [user("hello [die]")], { context: thread });
    assert.match(a.text, /^answer/); assert.equal((await h.pids()).length, 2, "the dead CLI was replaced by a one-shot CLI");
    assert.ok((await h.sessions()).some(entry => entry.outcome === "fallback" && entry.missReason === "stream_failed"));
    await closed(h, (await h.pids())[0]);
    await turn(provider, [user("fresh")], { context: { threadId: "thread-2" } }); const pid = (await h.pids()).at(-1)!; assert.equal(live().sessions().length, 1);
    // The same provider switched to one-shot: its parked session ends with the next request.
    await turn(adapter({ mode: "oneshot" }), [user("again")], { context: { threadId: "thread-2" } });
    await closed(h, pid);
  } finally { delete process.env.GATEWAY_COPILOT_LIVE_DIE; await h.restore(); }
});

test("copilotSessions is validated: live or one-shot, bounded limits, Copilot providers only", () => {
  const config = (copilotSessions: unknown, type = "copilot-subscription") => validateConfig({ version: 1, port: 1, stateDirectory: "/tmp/state", providers: [{ id: "c", type, models: { a: "x" }, copilotSessions }] }, "/tmp");
  assert.deepEqual(config({ mode: "live", max: 2, parkMinutes: 10, toolWaitMinutes: 5 }).providers[0].copilotSessions, { mode: "live", max: 2, parkMinutes: 10, toolWaitMinutes: 5 });
  assert.doesNotThrow(() => config({ mode: "replay" })); assert.doesNotThrow(() => config({ mode: "oneshot" }));
  assert.throws(() => config({ mode: "stream" }), /mode must be oneshot, replay or live/);
  assert.throws(() => config({ max: 0 }), /max must be 1 through 16/); assert.throws(() => config({ parkMinutes: 4 }), /parkMinutes/);
  assert.throws(() => config({ toolWaitMinutes: 26 }), /toolWaitMinutes must be 1 through 25/);
  assert.throws(() => config([]), /must be an object/); assert.throws(() => config({}, "claude-subscription"), /only valid for copilot-subscription/);
});
