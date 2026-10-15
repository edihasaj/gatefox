import test from "node:test";
import assert from "node:assert/strict";
import { busyActivities, runtimeBusy } from "../runtime-activity.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import type { ResponsesRequest } from "../protocol/types.js";
import { adapter, harness, live, outputFor, sleep, thread, tools, turn, until, user } from "./copilot-live-harness.js";

// An idle restart or a self-update waits while the gateway is busy. Live Copilot sessions must keep it busy while a session
// is starting or generating, or has waited for tool outputs for under 10 minutes, so an upgrade never kills a running turn;
// a parked session, and one that waited longer than its cache lasts, must not hold an upgrade back.
const busy = () => busyActivities().includes("copilot_sessions");
const idle = () => assert.deepEqual([busy(), runtimeBusy()], [false, false]);
const minutes = (count: number) => count * 60 * 1000;

test("the gateway is busy while a Copilot session starts and while it generates, and idle once the turn is done", { timeout: 20000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_CREATE = "500";
  try {
    const provider = adapter();
    // The CLI is started and has not answered session.create yet.
    const starting = turn(provider, [user("hello")]);
    assert.ok(await until(() => busy(), 400), "busy while the session starts"); assert.equal(runtimeBusy(), true);
    await starting; idle();
    // The turn streams its answer for a while.
    let during: boolean | undefined;
    const request = restoreReasoning({ model: "fixture", input: [user("go [slow]")], tools } as ResponsesRequest, "scope");
    for await (const event of provider.infer(request, new AbortController().signal, thread)) if (event.type === "text" && during === undefined) during = busy();
    assert.equal(during, true, "busy while a turn generates");
    assert.ok(await until(() => !busy(), 1000)); idle();
  } finally { await h.restore(); }
});

test("a session that waits for tool outputs keeps the gateway busy for ten minutes, then stops holding an upgrade back", { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tool]")];
    const a = await turn(provider, first);
    const [session] = live().sessions(); assert.equal(session.state, "awaiting_outputs");
    assert.equal(busy(), true, "busy right after the tool call");
    session.lastUse -= minutes(9); assert.equal(busy(), true, "still busy after nine minutes");
    session.lastUse -= minutes(2); idle();
    // The same session, answered, finishes its turn and parks: nothing to wait for.
    session.lastUse = Date.now();
    assert.equal(busy(), true);
    await turn(provider, [...first, ...a.output, ...outputFor(a.output, "plain")]);
    await sleep(20); idle();
  } finally { await h.restore(); }
});
