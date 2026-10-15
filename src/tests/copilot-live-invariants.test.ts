import test from "node:test";
import assert from "node:assert/strict";
import { CopilotSubscription } from "../providers/copilot.js";
import { ProviderError } from "../providers/provider.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
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

test("two first requests of one thread at once start one live CLI; the second is served one-shot", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_CREATE = "400";
  try {
    const provider = adapter();
    const first = turn(provider, [user("a")]);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "create")), "the first request is starting its session");
    const second = await turn(provider, [user("a")]);
    await first;
    assert.match(second.text, /^answer/);
    assert.equal((await liveCreates(h)).length, 1, "exactly one live CLI"); assert.equal(live().sessions().length, 1);
    assert.deepEqual((await kinds(h)).filter(kind => kind.startsWith("fallback")), ["fallback:concurrent"]);
  } finally { await h.restore(); }
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
    const running = turn(adapter(), [user("go [slow]")]);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    const [pid] = await h.pids();
    await turn(adapter({ mode: "oneshot" }), [user("other")], { context: { threadId: "other" } });
    const a = await running;
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
      assert.ok(error instanceof ProviderError && error.code === "cli_failed", `${close}: ${String(error)}`);
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
    const started = Date.now(); await live().stop();
    assert.ok(!alive(pid)); assert.ok(Date.now() - started < 1000, `closed in ${Date.now() - started} ms, without waiting for a grace period`);
    assert.ok(!(await h.log()).some(entry => entry.op === "sigterm"), "no SIGTERM was needed");
  } finally { await h.restore(); }
});

test("a session that dies while its effort change is in flight is reported as dead, not as a refused change", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_SWITCH = "500";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    const next = turn(provider, [...first, ...a.output, user("more")], { extra: { reasoning: { effort: "high" } } });
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "switch")));
    process.kill(pid, "SIGKILL");
    const b = await next; assert.match(b.text, /^answer/);
    const outcomes = await kinds(h);
    assert.ok(outcomes.includes("reseeded:session_dead") && !outcomes.includes("reseeded:effort_rejected"), outcomes.join(","));
  } finally { await h.restore(); }
});
