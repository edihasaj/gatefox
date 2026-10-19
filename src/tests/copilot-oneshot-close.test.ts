import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../providers/provider.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
import { adapter, alive, callIds, harness, thread, tools, turn, until, user, type Harness } from "./copilot-live-harness.js";

// A one-shot session declares the caller's tools as external tools, so a turn that ends in tool calls leaves their requests
// pending in the CLI. Like a live session that ends, it must be closed so that the runtime cannot fail those calls and make
// a model call of its own: `session.abort`, then SIGKILL of the process group, never `session.delete` and SIGTERM. That holds for
// every end except one that ended idle with nothing pending: a tool request the gateway rejects, a failure, a cancellation, and a
// consumer that stops reading all leave a CLI that may hold a request, and none of them may delete the session or send SIGTERM.
// The fixture CLI logs a SIGTERM and ignores it, so "no SIGTERM" is read from its log and "killed" from its being gone; nothing here
// measures time, so a loaded machine cannot fail a correct build.
const operations = async (h: Harness, pid: number) => (await h.log()).filter(entry => entry.pid === pid).map(entry => entry.op as string);

test("a one-shot turn that ends in tool calls is aborted and killed at once; one that ends in text is deleted and stopped", { timeout: 20000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    const provider = adapter({ mode: "oneshot" });
    const tools = await turn(provider, [user("go [tool]")]);
    assert.equal(callIds(tools.output).length, 1, "the turn ended in a tool call");
    const [pid] = await h.pids();
    // The fixture ignores SIGTERM, so only the SIGKILL has ended it.
    assert.ok(!alive(pid), "the CLI is gone when the request has ended");
    const ops = await operations(h, pid);
    assert.ok(ops.includes("abort"), `the pending tool request was aborted: ${ops.join(",")}`);
    assert.ok(!ops.includes("delete") && !ops.includes("sigterm"), `no session.delete or SIGTERM: ${ops.join(",")}`);
    assert.ok(await until(async () => (await h.liveDirs()).length === 0), "its folder was removed");
    // A turn that ended in text has nothing pending: it is deleted and stopped the ordinary way.
    delete process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM;
    await turn(provider, [user("hello")]);
    const text = (await h.pids()).at(-1)!; const textOps = await operations(h, text);
    assert.ok(textOps.includes("delete") && !textOps.includes("abort"), textOps.join(","));
    assert.ok(await until(() => !alive(text)));
  } finally { await h.restore(); }
});

/** The CLI of the latest request is gone (the fixture ignores SIGTERM, so only the SIGKILL ended it) and was only aborted. */
async function assertAbortedAndKilled(h: Harness, label: string) {
  const pid = (await h.pids()).at(-1)!; const ops = await operations(h, pid);
  assert.ok(!alive(pid), `${label}: the CLI is gone`);
  assert.ok(ops.includes("abort"), `${label}: the request was aborted: ${ops.join(",")}`);
  assert.ok(!ops.includes("delete") && !ops.includes("sigterm"), `${label}: no session.delete or SIGTERM: ${ops.join(",")}`);
}

test("a one-shot turn whose tool request the gateway rejects, or that fails otherwise, is aborted and killed like one that holds a request", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    const provider = adapter({ mode: "oneshot" });
    const other = { type: "function" as const, name: "other", description: "Another", parameters: { type: "object", properties: {} } };
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ["tool calls disabled", "go [tool]", { tool_choice: "none" }],
      ["another tool than the required one", "go [tool]", { tools: [tools[0], other], tool_choice: { type: "function", name: "other" } }],
      ["a native tool call", "go [nativemsg]", {}],
      ["a permission request", "go [permission]", {}],
    ];
    for (const [label, text, extra] of cases) {
      const error = await turn(provider, [user(text)], { extra }).then(() => undefined, error => error as unknown);
      assert.ok(error instanceof ProviderError, `${label}: the request failed: ${String(error)}`);
      await assertAbortedAndKilled(h, label);
    }
    assert.equal((await h.pids()).length, cases.length, "one CLI per request");
  } finally { await h.restore(); }
});

test("a one-shot request cancelled while its tool request is pending is aborted, then killed at once, without SIGTERM or session.delete", { timeout: 20000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    const controller = new AbortController();
    try {
      // The consumer leaves as soon as the tool call arrives, before the stream has ended.
      for await (const event of adapter({ mode: "oneshot" }).infer({ model: "fixture", input: [user("go [tool]")], tools }, controller.signal, thread)) if (event.type === "tool") controller.abort();
    } catch { /* A request cancelled mid-stream ends with the cancellation. */ }
    await assertAbortedAndKilled(h, "cancelled with a pending tool request");
  } finally { await h.restore(); }
});

test("a one-shot request cancelled before any tool event is aborted and killed too: the CLI may already hold a request", { timeout: 20000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    const controller = new AbortController();
    const running = turn(adapter({ mode: "oneshot" }), [user("go [hang]")], { controller }).then(() => undefined, error => error as unknown);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "session.sendMessages")));
    controller.abort();
    const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled", String(error));
    await assertAbortedAndKilled(h, "cancelled while the model works");
  } finally { await h.restore(); }
});

test("a consumer that stops reading at the tool event ends the one-shot session with an abort and a kill", { timeout: 20000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    // `break` calls the generator's return() while it holds the tool event, before the turn's end is read.
    for await (const event of adapter({ mode: "oneshot" }).infer({ model: "fixture", input: [user("go [tool]")], tools }, new AbortController().signal, thread)) if (event.type === "tool") break;
    await assertAbortedAndKilled(h, "consumer left at the tool event");
  } finally { await h.restore(); }
});

test("a one-shot CLI that does not answer session.abort is killed once the abort limit has passed", { timeout: 20000 }, async () => {
  // The CLI never answers within the test, so the request can only end by the limit: a build that waits for the answer hangs until
  // the test's timeout, one that kills before the limit is caught by the lower bound (a slow machine only makes it longer).
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "600000"; const limit = sessionLimits.abortMs; sessionLimits.abortMs = 1000;
  try {
    const controller = new AbortController(); let abortedAt = 0;
    try {
      for await (const event of adapter({ mode: "oneshot" }).infer({ model: "fixture", input: [user("go [tool]")], tools }, controller.signal, thread)) if (event.type === "tool") { abortedAt = Date.now(); controller.abort(); }
    } catch { /* Cancelled. */ }
    const elapsed = Date.now() - abortedAt; const pid = (await h.pids()).at(-1)!;
    assert.ok(abortedAt > 0 && !alive(pid), "the CLI is gone"); assert.ok(elapsed >= 900, `not killed before the abort limit (${elapsed} ms of 1000)`);
    assert.deepEqual((await operations(h, pid)).filter(op => op === "delete" || op === "sigterm"), []);
  } finally { sessionLimits.abortMs = limit; await h.restore(); }
});

test("a one-shot request cancelled while its session is being created never sends its prompt, though the CLI is still ending", { timeout: 20000 }, async () => {
  // The CLI answers session.create only when it receives the abort, and session.abort later still, so its connection is open when the
  // creation finishes and a prompt could go out: whatever the machine's speed.
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_CREATE_AFTER_ABORT = "1"; process.env.GATEWAY_COPILOT_LIVE_SLOW_ABORT = "1500";
  try {
    const controller = new AbortController();
    const running = turn(adapter({ mode: "oneshot" }), [user("hello")], { controller }).then(() => undefined, error => error as unknown);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "create")));
    controller.abort();
    const error = await running; assert.ok(error instanceof ProviderError && error.code === "cancelled", String(error));
    const pid = (await h.pids()).at(-1)!; assert.ok(await until(() => !alive(pid)), "the CLI is gone");
    const ops = await operations(h, pid);
    assert.ok(ops.includes("create") && ops.includes("abort"), ops.join(","));
    // `session.sendMessages` is a billed model call: nothing may start one for a request nobody waits for.
    assert.ok(!ops.includes("session.sendMessages"), `the prompt was sent after the cancellation: ${ops.join(",")}`);
  } finally { await h.restore(); }
});
