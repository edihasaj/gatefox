import test from "node:test";
import assert from "node:assert/strict";
import { CopilotSubscription } from "../providers/copilot.js";
import { ProviderError } from "../providers/provider.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { adapter, alive, harness, live, providerId, sleep, turn, until, user, type Entry, type Harness } from "./copilot-live-harness.js";

// Each test pins one guard of the live session design: removing the guard makes it fail.
const kinds = async (h: Harness) => (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));
const liveCreates = async (h: Harness): Promise<Entry[]> => (await h.log()).filter(entry => entry.op === "create" && String(entry.directory).includes("-live-"));
const settled = (value: Promise<unknown>) => value.then(() => undefined, error => error as unknown);
/** The settled value, or "pending" once `ms` passes. */
const within = (value: Promise<unknown>, ms: number) => Promise.race([value, sleep(ms).then(() => "pending")]);

test("a model change between turns starts a new session: the CLI fixes the model at creation", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = new CopilotSubscription({ id: providerId, type: "copilot-subscription", models: { alias: "fixture", other: "fixture-2" }, copilotSessions: { mode: "live" } });
    const first = [user("hello")];
    const a = await turn(provider, first);
    const b = await turn(provider, [...first, ...a.output, user("more")], { extra: { model: "fixture-2" } });
    assert.match(b.text, /^answer/);
    const creates = await liveCreates(h);
    assert.deepEqual(creates.map(entry => entry.params.model), ["fixture", "fixture-2"]); assert.notEqual(creates[0].pid, creates[1].pid);
    assert.ok((await kinds(h)).includes("reseeded:fingerprint_changed"), (await kinds(h)).join(","));
  } finally { await h.restore(); }
});

test("two first requests of one thread at once start one live CLI; the second is refused without a one-shot replay", { timeout: 30000 }, async () => {
  // No CLI answers session.create until the test has seen the first request start its own, so the first is still starting when the second comes.
  const h = await harness(); const gate = join(h.directory, "create-gate"); process.env.GATEWAY_COPILOT_LIVE_CREATE_GATE = gate;
  let first: Promise<unknown> | undefined;
  try {
    const provider = adapter();
    first = settled(turn(provider, [user("a")]));
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "create")), "the first request is starting its session");
    const error = await within(settled(turn(provider, [user("a")])), 5000);
    assert.ok(error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable", String(error));
    assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "the refused request did not start a CLI of its own");
    await writeFile(gate, "x");
    assert.equal(await within(first, 10000), undefined, "the first request completed on its live session");
    assert.equal((await liveCreates(h)).length, 1, "exactly one live CLI"); assert.equal(live().sessions().length, 1);
    assert.deepEqual((await kinds(h)).filter(kind => kind.startsWith("fallback") || kind.startsWith("blocked")), ["blocked:concurrent"]);
  } finally { await writeFile(gate, "x").catch(() => undefined); if (first) await first; await h.restore(); }
});

test("the park timer never closes a session while its turn runs", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const controller = new AbortController();
    const running = settled(turn(adapter(), [user("go [hang]")], { controller }));
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const [session] = live().sessions(); session.timers(40, 40);
    await sleep(300);
    assert.equal(session.state, "generating", "the running turn keeps its session"); assert.ok(alive(session.pid!));
    controller.abort(); await running;
  } finally { await h.restore(); }
});

test("switching the provider to one-shot lets a running turn finish, then closes its session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const started = turn(adapter(), [user("go [slow]")]); const running = settled(started);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const [pid] = await h.pids();
    await turn(adapter({ mode: "oneshot" }), [user("other")], { context: { threadId: "other" } });
    await running; const a = await started;
    assert.match(a.text, /^answer/); assert.equal(a.events.at(-1)?.type, "done");
    // The end event follows the process exit and the folder's removal, so wait for the event itself.
    assert.ok(await until(async () => (await kinds(h)).includes("closed:mode_oneshot")), `then its session closes: ${(await kinds(h)).join(",")}`);
    assert.ok(!alive(pid));
    const outcomes = await kinds(h);
    assert.ok(outcomes.includes("closed:mode_oneshot") && !outcomes.some(kind => kind.startsWith("fallback") || kind.startsWith("crashed")), outcomes.join(","));
  } finally { await h.restore(); }
});

test("a session closed under a running request fails that request at once", { timeout: 30000 }, async () => {
  for (const close of ["stop", "shutdown"] as const) {
    const h = await harness();
    try {
      const running = settled(turn(adapter(), [user("go [stall]")]));
      assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages"))); await sleep(50);
      if (close === "stop") await live().stop(); else await (await import("../runtime-activity.js")).runShutdownHooks(3000);
      const error = await within(running, 2000);
      assert.ok(error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable", `${close}: ${String(error)}`);
      assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, `${close}: no replacement or replay CLI started`);
    } finally { await h.restore(); }
  }
});

test("a tool call whose pending request never comes fails the request and ends the session", { timeout: 30000 }, async () => {
  const h = await harness(); const wait = sessionLimits.requestsMs; sessionLimits.requestsMs = 200;
  try {
    const error = await settled(turn(adapter(), [user("go [tool][norequest]")]));
    assert.ok(error instanceof ProviderError && error.code === "invalid_tool_call", String(error));
    const [pid] = await h.pids(); assert.ok(await until(() => !alive(pid))); assert.ok(await until(() => live().sessions().length === 0));
  } finally { sessionLimits.requestsMs = wait; await h.restore(); }
});

test("closing a live session kills its CLI at once, even one that ignores SIGTERM", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    await turn(adapter(), [user("hello")]); const [pid] = await h.pids();
    // The fixture ignores SIGTERM and logs it: a close that asked for the exit would have logged it, and one that waited for it would not end.
    await live().stop();
    assert.ok(!alive(pid)); assert.ok(!(await h.log()).some(entry => entry.op === "sigterm"), "no SIGTERM was needed");
  } finally { await h.restore(); }
});

test("a session that dies while its effort change is in flight refuses the request: no second CLI starts inside it", { timeout: 30000 }, async () => {
  // The CLI answers the change only when the test lets it, which is after the CLI has been killed.
  const h = await harness(); const gate = join(h.directory, "switch-gate"); process.env.GATEWAY_COPILOT_LIVE_SWITCH_GATE = gate;
  let next: Promise<unknown> | undefined;
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    next = settled(turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "high" } } }));
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "switch")));
    process.kill(pid, "SIGKILL"); await writeFile(gate, "x");
    const error = await within(next, 10000);
    assert.ok(error instanceof ProviderError && error.status === 400 && error.upstream?.code === "session_continuity_unavailable", String(error));
    assert.equal((await liveCreates(h)).length, 1); assert.equal((await h.log()).filter(entry => entry.op === "create").length, 1, "no replacement or one-shot CLI started inside the refused request");
    const outcomes = await kinds(h);
    assert.ok(!outcomes.some(kind => kind.startsWith("reseeded")) && !outcomes.includes("preserved:effort_rejected"), outcomes.join(","));
    // A later, independent request is a controlled seed that says the old session was dead.
    const b = await turn(provider, [...first, ...a.output, user("more")]);
    assert.match(b.text, /^answer/); assert.equal((await liveCreates(h)).length, 2);
    assert.ok((await kinds(h)).includes("reseeded:session_dead"), (await kinds(h)).join(","));
  } finally { await writeFile(gate, "x").catch(() => undefined); await next; await h.restore(); }
});
