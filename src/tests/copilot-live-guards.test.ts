import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { startGateway } from "../server.js";
import { gatewayToken, validateConfig } from "../config.js";
import { resetUsageLedger } from "../usage-ledger.js";
import { readTelemetry } from "../telemetry.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { ProviderError } from "../providers/provider.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { adapter, alive, harness, live, outputFor, queuedUsage, sleep, thread, tools, turn, until, user, type Harness } from "./copilot-live-harness.js";

/** The process is dead, its folder is gone and the registry holds nothing. */
async function closed(h: Harness, pid: number): Promise<void> {
  assert.ok(await until(() => !alive(pid)), "the CLI process ended"); assert.ok(await until(async () => (await h.liveDirs()).length === 0), "its folder was removed");
  assert.ok(await until(() => live().sessions().length === 0), "the registry forgot it");
}
const kinds = async (h: Harness) => (await h.sessions()).map(entry => [entry.outcome, entry.missReason].filter(Boolean).join(":"));

// A tool call is pending and the model then does something on its own: each of these means the runtime is acting (or about to act, and bill) without a request.
const killers: Array<[string, string]> = [
  ["tool.execution_complete", "unattended_completion"], ["external_tool.completed", "unattended_completion"],
  ["model.call_start", "unattended_output"], ["assistant.turn_start", "unattended_output"], ["assistant.message", "unattended_output"], ["assistant.message_delta", "unattended_output"],
  ["assistant.usage", "unattended_output"], ["session.compaction_start", "unattended_output"], ["session.truncation", "unattended_output"], ["session.error", "unattended_output"],
  ["tool.execution_progress", "unattended_output"],
  // An effort change nobody asked for, and a start-up announcement once the session has served a request.
  ["session.model_change", "unattended_output"], ["session.start", "unattended_output"], ["session.managed_settings_resolved", "unattended_output"],
];

test("between requests, anything but housekeeping kills the session before it can spend: a timed-out or failed tool call, a model call, output", { timeout: 30000 }, async () => {
  for (const [type, reason] of killers) {
    const h = await harness();
    try {
      const provider = adapter(); const first = [user(`go [tool][late:${type}]`)];
      const a = await turn(provider, first);
      const [pid] = await h.pids();
      await closed(h, pid);
      assert.ok((await h.log()).some(entry => entry.op === "abort" && entry.pid === pid), `${type}: the pending turn is aborted before the kill`);
      assert.ok((await kinds(h)).includes(`crashed:${reason}`), `${type}: ${(await kinds(h)).join(",")}`);
      const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")]);
      assert.match(b.text, /^answer/); assert.ok((await kinds(h)).includes("reseeded:session_dead"), `${type}: the next request says why it starts over`);
      assert.ok(!(await h.log()).some(entry => entry.op === "deliver"), "a dead session is never handed outputs");
    } finally { await h.restore(); }
  }
});

test("housekeeping events between requests are accepted and the session lives on", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const types = ["session.info", "session.usage_info", "session.usage_checkpoint", "session.idle", "model.call_finished"]; const provider = adapter({ mode: "live", max: types.length });
    const firsts = await Promise.all(types.map(async type => { const first = [user(`go [tool][late:${type}]`)]; return { type, first, a: await turn(provider, first, { context: { threadId: type } }) }; }));
    await sleep(700);
    assert.equal(live().sessions().length, types.length, "none of them was killed");
    for (const { type, first, a } of firsts) await turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")], { context: { threadId: type } });
    assert.equal((await h.pids()).length, types.length, "each thread kept its one process");
    assert.ok(!(await kinds(h)).some(value => value.startsWith("crashed")));
  } finally { await h.restore(); }
});

test("a sub-agent event or a tool call nobody is waiting for kills the session, even among housekeeping events", { timeout: 30000 }, async () => {
  for (const [marker, reason] of [["lateagent:session.info", "sub_agent"], ["lateghost:external_tool.requested", "unannounced_tool"], ["lateghost:tool.execution_start", "unannounced_tool"]]) {
    const h = await harness();
    try {
      await turn(adapter(), [user(`go [tool][${marker}]`)]);
      const [pid] = await h.pids(); await closed(h, pid);
      assert.ok((await kinds(h)).includes(`crashed:${reason}`), `${marker}: ${(await kinds(h)).join(",")}`);
    } finally { await h.restore(); }
  }
});

test("a request for a tool call the model never announced fails the request and ends the session", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const error = await turn(adapter(), [user("go [tool][extrareq]")]).then(() => undefined, error => error as unknown);
    assert.ok(error instanceof ProviderError && error.code === "invalid_tool_call", String(error));
    await closed(h, (await h.pids())[0]);
  } finally { await h.restore(); }
});

test("a stop while tools wait, followed by outputs and a new message, starts over: the session is aborted and never handed the outputs", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tool]")];
    const a = await turn(provider, first); const [pid] = await h.pids();
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "aborted by the user"), user("never mind, do this instead")]);
    assert.match(b.text, /^answer/);
    const entries = await h.log();
    assert.ok(!entries.some(entry => entry.op === "deliver"), "no output was delivered to the old session");
    assert.ok(entries.some(entry => entry.op === "abort" && entry.pid === pid), "the old session's pending turn was aborted");
    assert.equal(entries.filter(entry => entry.op === "create").length, 2);
    assert.equal(entries.filter(entry => entry.op === "session.sendMessages").at(-1)!.prompts.length, 4, "the new session is seeded with the whole history");
    assert.ok((await kinds(h)).includes("reseeded:unexpected_tail"));
    assert.ok(await until(() => !alive(pid)));
  } finally { await h.restore(); }
});

test("two threads starting at once never run more live sessions than the cap", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter({ mode: "live", max: 1 });
    await Promise.all([turn(provider, [user("a")], { context: { threadId: "A" } }), turn(provider, [user("b")], { context: { threadId: "B" } })]);
    assert.equal(live().sessions().length, 1);
    const creates = (await h.log()).filter(entry => entry.op === "create");
    assert.equal(creates.length, 2); assert.equal(creates.filter(entry => String(entry.directory).includes("-live-")).length, 1, "one live process; the other request ran one-shot");
  } finally { await h.restore(); }
});

test("a complete answer whose idle event never comes still ends the request, and the session closes", { timeout: 20000 }, async () => {
  const h = await harness(); const idle = sessionLimits.idleMs; sessionLimits.idleMs = 150;
  try {
    const provider = adapter(); const first = [user("answer [noidle]")];
    const a = await turn(provider, first);
    assert.match(a.text, /^answer/); assert.equal(a.events.at(-1)?.type, "done");
    await closed(h, (await h.pids())[0]);
    assert.ok((await kinds(h)).includes("closed:idle_missing"));
    await turn(provider, [...first, ...a.output, user("more")]);
    assert.ok((await kinds(h)).includes("reseeded:idle_missing"));
  } finally { sessionLimits.idleMs = idle; await h.restore(); }
});

test("usage that arrived but was not read when the client cancelled is still reported", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const controller = new AbortController(); const events: InferenceEvent[] = []; let failure: unknown;
    const request = restoreReasoning({ model: "fixture", input: [user("go [lateusage]")], tools } as ResponsesRequest, "scope");
    try {
      for await (const event of adapter().infer(request, controller.signal, thread)) {
        events.push(event);
        // The consumer is busy while the CLI reports the model call's usage, then cancels.
        if (event.type === "text") { assert.ok(await until(() => queuedUsage() === 1), "the usage is waiting in the request's queue"); controller.abort(); }
      }
    } catch (error) { failure = error; }
    assert.ok(failure instanceof ProviderError && failure.code === "cancelled");
    const usage = events.find(event => event.type === "usage");
    assert.ok(usage?.type === "usage" && usage.usage.input_tokens === 100 && usage.accounting?.nanoAiu === 1e9, "the billed call reaches the caller before the cancellation");
  } finally { await h.restore(); }
});

test("tool outputs whose pending requests the session lost start the thread over instead of guessing", { timeout: 30000 }, async () => {
  const h = await harness(); const wait = sessionLimits.pendingMs; sessionLimits.pendingMs = 100;
  try {
    const provider = adapter(); const first = [user("go [tool]")]; const a = await turn(provider, first);
    (live().sessions()[0] as unknown as { requests: Map<string, string> }).requests.clear();
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")]);
    assert.match(b.text, /^answer/); assert.ok((await kinds(h)).includes("reseeded:tool_request_missing"));
    assert.ok(!(await h.log()).some(entry => entry.op === "deliver"));
  } finally { sessionLimits.pendingMs = wait; await h.restore(); }
});

test("a session that refuses a tool result is replaced by a one-shot answer, and its process and folder go", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tool][reject]")]; const a = await turn(provider, first);
    const b = await turn(provider, [...first, ...a.output, ...outputFor(a.output, "x")]);
    assert.match(b.text, /^answer/);
    assert.ok((await kinds(h)).includes("fallback:delivery_rejected"));
    const [pid] = await h.pids(); await closed(h, pid);
  } finally { await h.restore(); }
});

test("a session that never answers session.create falls back to one-shot within the start bound and leaves nothing behind", { timeout: 30000 }, async () => {
  const h = await harness(); const start = sessionLimits.startMs; sessionLimits.startMs = 200; process.env.GATEWAY_COPILOT_LIVE_STALL = h.stall;
  try {
    const a = await turn(adapter(), [user("hello")]);
    assert.match(a.text, /^answer/); assert.ok((await kinds(h)).includes("fallback:initialize_timeout"));
    const [stalled] = await h.pids(); assert.ok(await until(() => !alive(stalled)), "the stalled CLI was killed");
    assert.equal(live().sessions().length, 0);
  } finally { sessionLimits.startMs = start; await h.restore(); }
});

test("ending a session ends everything the CLI started, not just the CLI", { timeout: 30000 }, async () => {
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_CHILD = "1";
  let helper: number | undefined;
  try {
    const controller = new AbortController();
    const running = turn(adapter(), [user("go [hang]")], { controller }).then(() => undefined, () => undefined);
    assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "child")));
    helper = (await h.log()).find(entry => entry.op === "child")!.child as number; assert.ok(alive(helper));
    controller.abort(); await running;
    assert.ok(await until(() => !alive(helper!)), "the helper process in the CLI's group was killed with it");
  } finally { if (helper && alive(helper)) process.kill(helper, "SIGKILL"); await h.restore(); }
});

test("a second loaded copy of the module adopts the registry of the first", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    await turn(adapter(), [user("hello")]);
    const second = await import(new URL("../providers/copilot-live.js?second-copy", import.meta.url).href) as typeof import("../providers/copilot-live.js");
    assert.notEqual(second.copilotLive, (await import("../providers/copilot-live.js")).copilotLive, "a distinct module instance");
    assert.equal(second.copilotLive({ max: 4, parkMinutes: 30, toolWaitMinutes: 25 }).sessions().length, 1, "it sees the first copy's session instead of starting its own registry");
  } finally { await h.restore(); }
});

test("no prompt, tool argument or tool output reaches telemetry, the usage ledger or the CLI's account folder", { timeout: 30000 }, async () => {
  const h = await harness(); const state = join(h.directory, "state"); const account = join(h.directory, "account"); await mkdir(account);
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{ id: "copilot", type: "copilot-subscription", models: { alias: "fixture" }, authDirectory: account }] });
  resetUsageLedger(); const server = await startGateway(config);
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
    const headers = { Authorization: `Bearer ${await gatewayToken(state)}`, "Content-Type": "application/json", "thread-id": "privacy-thread" };
    const post = async (input: unknown[]) => { const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "alias", input, tools, instructions: "SENTINEL_INSTRUCTIONS" }) }); return await response.json() as { output: Array<Record<string, unknown>> }; };
    const first = [user("SENTINEL_PROMPT [tool]")]; const a = await post(first);
    const call = a.output.find(item => item.type === "function_call")!;
    await post([...first, ...a.output, { type: "function_call_output", call_id: call.call_id, output: "SENTINEL_OUTPUT" }]);
    const { flushTelemetry } = await import("../telemetry.js"); const { flushUsageLedger } = await import("../usage-ledger.js"); await flushTelemetry(); await flushUsageLedger();
    const files = async (folder: string): Promise<string[]> => (await readdir(folder, { recursive: true, withFileTypes: true }).catch(() => [])).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
    const gathered = [...await files(join(h.directory, "telemetry")), ...await files(join(state, "usage")), ...await files(account)];
    assert.ok(gathered.length >= 2, "there is telemetry and a ledger to read");
    for (const path of gathered) { const text = await readFile(path, "utf8"); for (const word of ["SENTINEL_PROMPT", "SENTINEL_OUTPUT", "SENTINEL_INSTRUCTIONS", call.arguments as string, "PROMPT-LOG"]) assert.ok(!text.includes(word), `${path} holds ${word}`); }
    assert.deepEqual(await files(account), [], "nothing is written to the CLI's account folder");
    const requests = (await readTelemetry(h.directory, 0)).filter(entry => entry.event === "request_completed");
    assert.deepEqual(requests.map(entry => entry.initiator), ["user", "agent"], "each request says who started its model calls");
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await h.restore(); }
});

test("an effort change the CLI never confirmed is forgotten when the request ends: a later model change is not its confirmation", { timeout: 30000 }, async () => {
  // The CLI applies the change and says nothing; 300 ms after the request's answer it reports a change to the same effort.
  const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_SWITCH_NO_CONFIRM = "1";
  try {
    const provider = adapter(); const first = [user("hello")];
    const a = await turn(provider, first, { extra: { reasoning: { effort: "low" } } });
    const [pid] = await h.pids();
    const b = await turn(provider, [...first, ...a.output, user("more [stray]")], { extra: { reasoning: { effort: "medium" } } });
    assert.match(b.text, /^answer/); assert.equal(live().sessions()[0]?.effort, "medium", "the change was applied in place");
    await closed(h, pid);
    assert.ok((await kinds(h)).includes("crashed:unattended_output"), (await kinds(h)).join(","));
  } finally { await h.restore(); }
});
