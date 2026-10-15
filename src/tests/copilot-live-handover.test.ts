import test from "node:test";
import assert from "node:assert/strict";
import type { ProviderConfig } from "../config.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { ResponsesWriter } from "../protocol/responses.js";
import type { ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";
import { CopilotSubscription, copilotLiveInput, copilotRun } from "../providers/copilot.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
import { adapter, alive, callIds, harness, live, outputFor, providerId, thread, tools, turn, until, user, type Harness } from "./copilot-live-harness.js";

// How a continuation hands the caller's tool outputs to the calls waiting in the session.
const kinds = async (h: Harness) => (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));

test("a tool result the CLI answers with an error, or not in time, is a refused delivery: the request is served one-shot", async () => {
  for (const marker of ["rpcerror", "nodeliver"]) {
    const h = await harness(); const deliver = sessionLimits.deliverMs; sessionLimits.deliverMs = 300;
    try {
      const provider = adapter(); const first = [user(`go [tool][${marker}]`)]; const a = await turn(provider, first);
      const [pid] = await h.pids();
      const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")]);
      assert.match(b.text, /^answer/, marker);
      assert.ok((await kinds(h)).includes("fallback:delivery_rejected"), `${marker}: ${(await kinds(h)).join(",")}`);
      assert.ok(await until(async () => (await kinds(h)).includes("crashed:delivery_rejected")), `${marker}: the session ends for it`);
      assert.ok(!alive(pid)); assert.equal(live().sessions().length, 0);
    } finally { sessionLimits.deliverMs = deliver; await h.restore(); }
  }
});

test("more parallel tool outputs than the CLI connection takes at once all reach their waiting calls", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tools:33]")]; const a = await turn(provider, first);
    const calls = callIds(a.output); assert.equal(calls.length, 33);
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, id => `result-for-${id}`)]);
    assert.match(b.text, /^answer/);
    const delivered = (await h.log()).filter(entry => entry.op === "deliver");
    assert.deepEqual(delivered.map(entry => entry.toolCallId).sort(), [...calls].sort());
    for (const entry of delivered) assert.equal(entry.result, `result-for-${entry.toolCallId}`);
    assert.equal((await h.pids()).length, 1, "the session served it"); assert.deepEqual((await kinds(h)).filter(kind => kind.startsWith("fallback")), []);
  } finally { await h.restore(); }
});

test("an empty tool output is handed over as a placeholder, so the waiting call is still answered", async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tool]")]; const a = await turn(provider, first);
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "")]);
    assert.match(b.text, /^answer/);
    assert.deepEqual((await h.log()).filter(entry => entry.op === "deliver").map(entry => entry.result), ["(no output)"]);
    assert.equal((await h.pids()).length, 1);
  } finally { await h.restore(); }
});

test("a translation that does not match the session's ledger starts the thread over instead of sending the wrong items", async () => {
  const h = await harness();
  try {
    const config: ProviderConfig = { id: providerId, type: "copilot-subscription", models: { alias: "fixture" }, copilotSessions: { mode: "live" } };
    const provider = new CopilotSubscription(config); const signal = new AbortController().signal;
    const prepare = (input: ResponsesInputItem[], threadId: string) =>
      copilotLiveInput(config, copilotRun(config, restoreReasoning({ model: "fixture", input, tools } as ResponsesRequest, "scope"), signal, { threadId }), threadId);
    /** Places the request in the thread's session as the provider would and returns the output items Codex replays next. */
    const serve = async (input: ReturnType<typeof prepare>): Promise<ResponsesInputItem[]> => {
      const outcome = await live().attach(input, signal); const writer = new ResponsesWriter("fixture", () => {});
      assert.equal(outcome.kind, "stream");
      if (outcome.kind === "stream") for await (const event of outcome.events) writer.accept(event);
      return writer.result().output as ResponsesInputItem[];
    };
    // Waiting for tool outputs, while the translated message at the output's place is not that call's tool message.
    const first = [user("go [tool]")]; const a = await turn(provider, first, { context: thread });
    const outputs = prepare([...first, ...a.output, ...outputFor(a.output, "x")], "thread-1");
    outputs.conversation = outputs.conversation.map(message => message.role === "tool" ? { ...message, tool_call_id: "call_other" } : message);
    await serve(outputs);
    assert.ok(!(await h.log()).some(entry => entry.op === "deliver"), "nothing was handed to the waiting call");
    // After a finished turn: an untouched translation continues; one with a message the ledger does not count starts over.
    const hello = [user("hello")]; const b = await turn(provider, hello, { context: { threadId: "thread-2" } });
    const more = [...hello, ...b.output, user("more")];
    const c = await serve(prepare(more, "thread-2"));
    const extra = prepare([...more, ...c, user("again")], "thread-2"); extra.conversation = [...extra.conversation, extra.conversation.at(-1)!];
    await serve(extra);
    assert.deepEqual((await kinds(h)).filter(kind => /^(spawned|continued|reseeded)/.test(kind)), ["spawned", "reseeded:unexpected_tail", "spawned", "continued", "reseeded:unexpected_tail"]);
  } finally { await h.restore(); }
});
