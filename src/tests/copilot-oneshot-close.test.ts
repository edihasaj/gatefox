import test from "node:test";
import assert from "node:assert/strict";
import { adapter, alive, callIds, harness, thread, tools, turn, until, user, type Harness } from "./copilot-live-harness.js";

// A one-shot session declares the caller's tools as external tools, so a turn that ends in tool calls leaves their requests
// pending in the CLI. Like a live session that ends, it must be closed so that the runtime cannot fail those calls and make
// a model call of its own: `session.abort`, then SIGKILL of the process group, never `session.delete` and SIGTERM.
const operations = async (h: Harness, pid: number) => (await h.log()).filter(entry => entry.pid === pid).map(entry => entry.op as string);

test("a one-shot turn that ends in tool calls is aborted and killed at once; one that ends in text is deleted and stopped", { timeout: 20000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    const provider = adapter({ mode: "oneshot" });
    const started = Date.now();
    const tools = await turn(provider, [user("go [tool]")]);
    assert.equal(callIds(tools.output).length, 1, "the turn ended in a tool call");
    const [pid] = await h.pids();
    // The fixture ignores SIGTERM, so only the SIGKILL has ended it, and the turn did not wait the SIGTERM grace for it.
    assert.ok(!alive(pid), "the CLI is gone when the request has ended"); assert.ok(Date.now() - started < 1200, `closed without a SIGTERM grace (${Date.now() - started} ms)`);
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

test("a one-shot request cancelled while its tool request is pending is killed at once, without waiting for the CLI to obey SIGTERM", { timeout: 20000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_IGNORE_TERM = "1";
  try {
    const controller = new AbortController(); const started = Date.now();
    try {
      // The consumer leaves as soon as the tool call arrives, before the stream has ended.
      for await (const event of adapter({ mode: "oneshot" }).infer({ model: "fixture", input: [user("go [tool]")], tools }, controller.signal, thread)) if (event.type === "tool") controller.abort();
    } catch { /* A request cancelled mid-stream ends with the cancellation. */ }
    const [pid] = await h.pids(); assert.ok(!alive(pid), "the CLI is gone");
    assert.ok(Date.now() - started < 1200, `killed without the SIGTERM grace (${Date.now() - started} ms)`);
    assert.ok(!(await operations(h, pid)).includes("delete"), "and no session.delete was sent");
  } finally { await h.restore(); }
});
