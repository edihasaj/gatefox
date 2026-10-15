import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { copilotSessionSettings, validateConfig } from "../config.js";
import { ProviderError } from "../providers/provider.js";
import { legacyAgeMs, sweepCopilotDirectories } from "../providers/copilot-directories.js";
import { runShutdownHooks } from "../runtime-activity.js";
import { createGatewayHandler } from "../server.js";
import { adapter, alive, callIds, harness, live, outputFor, thread, turn, until, user, type Harness } from "./copilot-live-harness.js";

const settled = (value: Promise<unknown>) => value.then(() => undefined, error => error as unknown);
/** After a failure the process is dead, the folder is gone and the registry holds nothing. */
async function closed(h: Harness, pid: number): Promise<void> {
  assert.ok(await until(() => !alive(pid)), "the CLI process ended"); assert.ok(await until(async () => (await h.liveDirs()).length === 0), "its folder was removed");
  assert.ok(await until(() => live().sessions().length === 0), "the registry forgot it");
}
const exists = (path: string) => stat(path).then(() => true, () => false);

test("a dead gateway's folders, live or one-shot, are swept; a living gateway's folders and unrelated ones stay", async () => {
  const h = await harness();
  try {
    const names = {
      deadLive: "gateway-copilot-live-zzzzzz-abc123", deadRun: "gateway-copilot-run-zzzzzz-abc123",
      livingLive: `gateway-copilot-live-${process.ppid.toString(36)}-abc123`, livingRun: `gateway-copilot-run-${process.ppid.toString(36)}-abc123`,
      own: `gateway-copilot-run-${process.pid.toString(36)}-abc123`, unrelated: "gateway-copilot-harness-abc123", legacyFresh: "gateway-copilot-abc123", legacyOld: "gateway-copilot-OLD123",
    };
    for (const name of Object.values(names)) await mkdir(join(h.scratch, name));
    const old = new Date(Date.now() - 3 * 3600 * 1000); await utimes(join(h.scratch, names.legacyOld), old, old);
    await sweepCopilotDirectories(h.scratch);
    for (const name of [names.deadLive, names.deadRun, names.legacyOld]) assert.equal(await exists(join(h.scratch, name)), false, `${name} belongs to nobody and holds a prompt log`);
    for (const name of [names.livingLive, names.livingRun, names.own, names.unrelated, names.legacyFresh]) assert.equal(await exists(join(h.scratch, name)), true, `${name} stays`);
    // A symlink with a dead owner's name is not followed or removed: only real directories are the gateway's.
    const target = join(h.scratch, "target"); await mkdir(target); await symlink(target, join(h.scratch, "gateway-copilot-run-zzzzzz-link"));
    await sweepCopilotDirectories(h.scratch);
    assert.equal(await exists(join(h.scratch, "gateway-copilot-run-zzzzzz-link")), true); assert.equal(await exists(target), true);
    // A legacy folder is swept only once it is older than any request can run.
    legacyAgeMs.value = 0; try { await sweepCopilotDirectories(h.scratch); } finally { legacyAgeMs.value = 2 * 3600 * 1000; }
    assert.equal(await exists(join(h.scratch, names.legacyFresh)), false);
  } finally { await h.restore(); }
});

test("starting the gateway sweeps a dead gateway's folders before any Copilot request, whatever the mode", async () => {
  const h = await harness();
  try {
    const dead = [join(h.scratch, "gateway-copilot-live-zzzzzz-abc123"), join(h.scratch, "gateway-copilot-run-zzzzzz-abc123")];
    for (const path of dead) { await mkdir(join(path, "session-state"), { recursive: true }); }
    await createGatewayHandler({ version: 1, port: 0, stateDirectory: join(h.directory, "state"), providers: [{ id: "c", type: "copilot-subscription", models: { a: "x" }, copilotSessions: { mode: "oneshot" } }] });
    for (const path of dead) assert.equal(await exists(path), false, "removed at startup, with no Copilot request made");
    assert.deepEqual(await h.pids(), [], "no CLI was started for it");
  } finally { await h.restore(); }
});

test("a permission request, a foreign tool or a native tool call is rejected and ends the session completely", async () => {
  for (const marker of ["permission", "native", "nativemsg", "foreignreq", "foreignstart"]) {
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
    const waiting = (await h.pids())[1];
    assert.ok((await h.log()).some(entry => entry.op === "abort" && entry.pid === waiting), "the waiting turn is aborted before its process is killed");
    const c = await turn(provider, [...first, ...a.output, user("go [tool]"), ...b.output, ...outputFor(b.output, "plain")]);
    assert.match(c.text, /^answer/);
    // Killing the CLI under an idle session ends it too.
    const [pid] = [(await h.pids()).at(-1)!]; process.kill(pid, "SIGKILL");
    await closed(h, pid);
    await turn(provider, [...first, ...a.output, user("go [tool]"), ...b.output, ...outputFor(b.output, "plain"), ...c.output, user("after the crash")]);
    const kinds = (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));
    assert.ok(kinds.includes("reaped") && kinds.includes("reaped:tool_wait_expired") && kinds.includes("crashed:cli_failed") && kinds.includes("reseeded:session_dead"), kinds.join(","));
    assert.ok(kinds.includes("reseeded:tool_wait_expired"), "the next request after a tool-wait expiry says so");
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

test("requests that cannot join a session run one-shot; forced and disabled tool choices are served in the session", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const creates = async () => (await h.log()).filter(entry => entry.op === "create");
    await turn(provider, [user("hello")], { context: {} });
    await turn(provider, [user("hello")], { context: { threadId: "thread-1", requestKind: "compaction" } });
    assert.equal(live().sessions().length, 0, "no session was started"); assert.equal((await creates()).length, 2, "both ran one-shot");
    assert.ok(await until(async () => (await h.liveDirs()).length === 0), "one-shot folders are removed too");
    const a = await turn(provider, [user("start")]); assert.equal(live().sessions().length, 1);
    const [pid] = [(await h.pids()).at(-1)!];
    // A forced choice keeps the whole catalog and names the tool on the last message; the session survives.
    const second = [user("start"), ...a.output, user("call it [tool]")];
    const forced = await turn(provider, second, { extra: { tool_choice: { type: "function", name: "lookup" } } });
    assert.equal(callIds(forced.output).length, 1, "the forced call was served in the session");
    const entries = await h.log(); const last = entries.filter(entry => entry.op === "session.sendMessages").at(-1)!;
    assert.match(last.prompts.at(-1), /\nUse the required caller tool tool_lookup_[0-9a-f]{16}\.$/);
    assert.equal(entries.filter(entry => entry.op === "create").at(-1)!.params.availableTools.length, 1, "the catalog is whole");
    assert.equal(live().sessions().length, 1); assert.equal(live().sessions()[0].pid, pid);
    // Tool outputs cannot carry the choice line, so that one request starts a new session.
    const third = [...second, ...forced.output, ...outputFor(forced.output, "again [tool]")];
    await turn(provider, third, { extra: { tool_choice: "required" } });
    assert.ok((await h.sessions()).some(entry => entry.outcome === "reseeded" && entry.missReason === "forced_choice"));
    assert.notEqual(live().sessions()[0].pid, pid); assert.ok(await until(() => !alive(pid)));
    // `none` keeps the catalog and adds a line instead of emptying it.
    const before = (await creates()).length;
    await turn(provider, [user("fresh")], { context: { threadId: "thread-none" }, extra: { tool_choice: "none" } });
    const fresh = (await creates()).slice(before); assert.equal(fresh.length, 1); assert.equal(fresh[0].params.availableTools.length, 1);
    const noneSend = (await h.log()).filter(entry => entry.op === "session.sendMessages").at(-1)!;
    assert.match(noneSend.prompts.at(-1), /\nDo not call any caller tool; answer directly\.$/);
    // A model that calls a tool anyway under `none`, or another tool than the forced one, fails the request.
    const error = await settled(turn(provider, [user("go [tool]")], { context: { threadId: "thread-none-2" }, extra: { tool_choice: "none" } }));
    assert.ok(error instanceof ProviderError && error.code === "invalid_tool_call");
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

test("copilotSessions is validated: live or one-shot, bounded limits, Copilot providers only; absent means live", () => {
  const config = (copilotSessions: unknown, type = "copilot-subscription") => validateConfig({ version: 1, port: 1, stateDirectory: "/tmp/state", providers: [{ id: "c", type, models: { a: "x" }, copilotSessions }] }, "/tmp");
  assert.deepEqual(config({ mode: "live", max: 2, parkMinutes: 10, toolWaitMinutes: 5 }).providers[0].copilotSessions, { mode: "live", max: 2, parkMinutes: 10, toolWaitMinutes: 5 });
  assert.doesNotThrow(() => config({ mode: "replay" })); assert.doesNotThrow(() => config({ mode: "oneshot" }));
  assert.throws(() => config({ mode: "stream" }), /mode must be oneshot, replay or live/);
  assert.throws(() => config({ max: 0 }), /max must be 1 through 16/); assert.throws(() => config({ parkMinutes: 4 }), /parkMinutes/);
  assert.throws(() => config({ toolWaitMinutes: 26 }), /toolWaitMinutes must be 1 through 25/);
  assert.throws(() => config([]), /must be an object/); assert.throws(() => config({}, "claude-subscription"), /only valid for copilot-subscription/);
  assert.deepEqual(copilotSessionSettings({}), { mode: "live", max: 4, parkMinutes: 30, toolWaitMinutes: 25 }, "live is the default");
  assert.equal(copilotSessionSettings({ copilotSessions: {} }).mode, "live");
  for (const mode of ["oneshot", "replay"] as const) assert.equal(copilotSessionSettings({ copilotSessions: { mode } }).mode, "oneshot");
});
