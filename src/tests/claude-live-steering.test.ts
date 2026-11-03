import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeSubscription } from "../providers/claude.js";
import { claudeLive } from "../providers/claude-live.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { installClaudeFixture } from "./claude-cli-fixture.js";
import type { ResponsesInputItem } from "../protocol/types.js";
import { ProviderError } from "../providers/provider.js";

const user = (text: string): ResponsesInputItem => ({ type: "message", role: "user", content: text });
const tools = [{ type: "function" as const, name: "read", parameters: { type: "object", properties: {} } }];

test("tool results followed by user and developer updates continue the same native CLI without history replay", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [
    { calls: [{ tool: "read", input: {} }] },
    { text: "Updated", calls: [{ tool: "read", input: {} }] },
    { text: "Finished" },
  ] });
  configureTelemetry(fixture.directory, "test");
  const since = Date.now();
  const provider = new ClaudeSubscription({ id: `steering-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[]) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "steered" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  const results = (output: ResponsesInputItem[]) => output.flatMap(item => item.type === "function_call"
    ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "tool result" }] : []);
  try {
    const first = [user("Start")]; const a = await turn(first);
    const second: ResponsesInputItem[] = [...first, ...a, ...results(a), user("New context"),
      { type: "message", role: "developer", content: "Preserve these additional instructions" }, user("Continue with the update")];
    const b = await turn(second);
    const c = await turn([...second, ...b, ...results(b)]);
    assert.ok(c.some(item => item.type === "message"));
    const capture = await fixture.capture();
    assert.deepEqual(capture.flatMap(entry => entry.start ? [entry.start] : []), ["live"], "steering and later tools reuse the initial CLI");
    const seeded = capture.filter(entry => entry.user !== undefined)[1];
    assert.ok(seeded.heads?.some(head => /^<<item \d+ developer>>$/.test(head)), "the reseed retains the developer role");
    assert.equal(seeded.heads?.filter(head => /^<<item \d+ user>>$/.test(head)).length, 2, "only the new caller messages are queued");
    assert.ok(capture.some(entry => entry.toolResult === "tool result"), "the third request relays its tool result");
    await flushTelemetry();
    const events = (await readTelemetry(fixture.directory, since)).filter(event => event.event === "claude_session");
    assert.equal(events.some(event => event.outcome === "reseeded"), false);
    assert.equal(capture.filter(entry => entry.control === "apply_flag_settings").length, 1);
    assert.equal(events.some(event => event.outcome === "fallback"), false);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await flushTelemetry(); await fixture.restore();
  }
});

test("a steer recorded before the tool output and a subagent report after it continue the same CLI", { timeout: 30000 }, async () => {
  // 2026-11-03: a parent chat waited on `wait_agent`; the user's mid-turn message was recorded before the output and the
  // subagent's report after it. The session refused the request as `unexpected_tail` until it expired an hour later.
  const fixture = await installClaudeFixture({ replies: [
    { calls: [{ tool: "read", input: {} }] },
    { text: "Both received" },
  ] });
  configureTelemetry(fixture.directory, "test");
  const since = Date.now();
  const provider = new ClaudeSubscription({ id: `interleaved-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[]) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "interleaved" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    const first = [user("Start")]; const a = await turn(first);
    const call = a.find(item => item.type === "function_call") as { call_id: string } | undefined;
    assert.ok(call);
    const report = { type: "agent_message", author: "worker", recipient: "root", content: "Subagent finished" } as unknown as ResponsesInputItem;
    const b = await turn([...first, ...a, user("Also check the docs"), { type: "function_call_output", call_id: call.call_id, output: "tool result" }, report]);
    assert.ok(b.some(item => item.type === "message"));
    const capture = await fixture.capture();
    assert.deepEqual(capture.flatMap(entry => entry.start ? [entry.start] : []), ["live"], "the same CLI continues");
    assert.ok(capture.some(entry => entry.toolResult === "tool result"), "the output is relayed as the tool result");
    const queued = capture.filter(entry => entry.user !== undefined).at(-1);
    assert.equal(queued?.heads?.filter(head => /^<<item \d+ user>>$/.test(head)).length, 2, "the steer and the report follow, never the output as text");
    await flushTelemetry();
    const events = (await readTelemetry(fixture.directory, since)).filter(event => event.event === "claude_session");
    assert.equal(events.some(event => event.outcome === "preserved" || event.outcome === "reseeded" || event.outcome === "fallback"), false);
  } finally {
    await claudeLive({ max: 6, parkMinutes: 60 }).stop();
    await flushTelemetry(); await fixture.restore();
  }
});

for (const mode of ["rejected", "cancelled", "crashed", "timed-out"] as const) test(`${mode} steering handoff never delivers tool results or replays`, { timeout: 30000 }, async () => {
  const cancel = mode === "cancelled";
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] }, { text: "Must not run" }],
    ...(cancel ? { delaySteeringMs: 500 } : mode === "timed-out" ? { delaySteeringMs: 6000 } : mode === "crashed" ? { crashSteering: true } : { rejectSteering: true }) });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `handoff-${mode}-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const run = async (input: ResponsesInputItem[], controller = new AbortController()) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools }, controller.signal, { threadId: "handoff" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    const first = [user("Read")], output = await run(first);
    const outputs = output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "held result" }] : []);
    const controller = new AbortController();
    const request = run([...first, ...output, ...outputs, user("New instructions")], controller);
    if (cancel) {
      for (let i = 0; i < 100 && !(await fixture.capture()).some(row => row.control === "apply_flag_settings"); i++) await new Promise(resolve => setTimeout(resolve, 10));
      controller.abort();
    }
    await assert.rejects(request, (error: unknown) => error instanceof ProviderError && (cancel ? error.code === "cancelled" : error.status === 400 && error.upstream?.code === "steering_barrier_failed"));
    const capture = await fixture.capture();
    assert.deepEqual(capture.filter(row => row.start).map(row => row.start), ["live"]);
    assert.equal(capture.some(row => row.toolResult !== undefined), false);
    assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions().length, 0, "an interrupted queued input is not reused with unconfirmed history");
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});

test("CLI death after acknowledging steering and receiving tool results is final without replay", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] }, { fail: true }, { text: "REPLAYED" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `post-ack-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[]) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "post-ack" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  try {
    const first = [user("Read")], output = await turn(first);
    const outputs = output.flatMap(item => item.type === "function_call" ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "delivered result" }] : []);
    await assert.rejects(turn([...first, ...output, ...outputs, user("New instructions")]),
      (error: unknown) => error instanceof ProviderError && error.status === 400 && error.upstream?.code === "steering_barrier_failed");
    const capture = await fixture.capture();
    assert.ok(capture.some(row => row.control === "apply_flag_settings"));
    assert.ok(capture.some(row => row.toolResult === "delivered result"));
    assert.deepEqual(capture.filter(row => row.start).map(row => row.start), ["live"]);
    assert.equal(claudeLive({ max: 6, parkMinutes: 60 }).sessions().length, 0);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});

test("an older adopted CLI without queued-input support reseeds once then continues", { timeout: 30000 }, async () => {
  const fixture = await installClaudeFixture({ replies: [{ calls: [{ tool: "read", input: {} }] }, { calls: [{ tool: "read", input: {} }] }, { text: "Done" }] });
  configureTelemetry(fixture.directory, "test");
  const provider = new ClaudeSubscription({ id: `old-steering-${process.pid}`, type: "claude-subscription", models: { fixture: "fixture" }, claudeSessions: { mode: "live", warmup: 0 } });
  const turn = async (input: ResponsesInputItem[]) => {
    const writer = new ResponsesWriter("fixture", () => {});
    for await (const event of provider.infer({ model: "fixture", input, tools }, new AbortController().signal, { threadId: "adopted" })) writer.accept(event);
    return writer.result().output as ResponsesInputItem[];
  };
  const results = (output: ResponsesInputItem[]) => output.flatMap(item => item.type === "function_call"
    ? [{ type: "function_call_output" as const, call_id: item.call_id, output: "result" }] : []);
  try {
    const first = [user("Start")], a = await turn(first);
    Object.defineProperty(claudeLive({ max: 6, parkMinutes: 60 }).sessions()[0], "queuedInputVersion", { value: undefined });
    const second = [...first, ...a, ...results(a), user("Update")], b = await turn(second);
    await turn([...second, ...b, ...results(b), user("Another update")]);
    assert.deepEqual((await fixture.capture()).filter(row => row.start).map(row => row.start), ["live", "live"]);
  } finally { await claudeLive({ max: 6, parkMinutes: 60 }).stop(); await flushTelemetry(); await fixture.restore(); }
});
