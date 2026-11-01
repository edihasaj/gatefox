import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../providers/provider.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
import { streamFailureCode, providerFailureDiagnostic } from "../provider-failure.js";
import { adapter, harness, live, outputFor, turn, until, user } from "./copilot-live-harness.js";

for (const mode of ["REJECT", "SILENT", "CRASH", "POST_CRASH", "CANCEL"] as const) test(`Copilot ${mode} during queued steering never replays`, { timeout: 30000 }, async () => {
  const h = await harness(), saved = sessionLimits.deliverMs;
  sessionLimits.deliverMs = 200;
  const controller = new AbortController();
  try {
    const setting = mode === "POST_CRASH" ? "POST_STEERING_CRASH" : "STEERING_" + (mode === "CANCEL" ? "SILENT" : mode);
    process.env["GATEWAY_COPILOT_LIVE_" + setting] = "1";
    const provider = adapter(), first = [user("go [tool]")], a = await turn(provider, first);
    const request = turn(provider, [...first, ...a.output, ...outputFor(a.output, "result"), user("Retain this update")], { controller });
    if (mode === "CANCEL") { await until(async () => (await h.log()).some(row => row.op === "steering")); controller.abort(); }
    await assert.rejects(request, (error: unknown) => error instanceof ProviderError && (mode === "CANCEL" ? error.code === "cancelled" : error.status === 400));
    await until(() => live().sessions().length === 0);
    const entries = await h.log();
    assert.equal(entries.filter(row => row.op === "create").length, 1);
    assert.equal(entries.filter(row => row.op === "deliver").length, mode === "POST_CRASH" ? 1 : 0);
    assert.ok(entries.filter(row => row.op === "create").every(row => row.directory.includes("-live-")));
  } finally { controller.abort(); sessionLimits.deliverMs = saved; await h.restore(); }
});

test("adopted Copilot sessions without immediate-input capability preserve pending tools", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(), first = [user("go [tool]")], a = await turn(provider, first);
    const session = live().sessions()[0]; Object.defineProperty(session, "queuedInputVersion", { value: undefined });
    await assert.rejects(turn(provider, [...first, ...a.output, ...outputFor(a.output, "result"), user("Update")]),
      (error: unknown) => error instanceof ProviderError && error.upstream?.code === "copilot_session_preserved");
    assert.equal(live().sessions()[0], session);
    assert.equal((await h.log()).filter(row => row.op === "deliver").length, 0);
    await turn(provider, [...first, ...a.output, ...outputFor(a.output, "result")]);
    assert.equal(live().sessions()[0], session);
  } finally { await h.restore(); }
});

test("charged native-tool violations stay diagnostic and become final for client reconnects", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    await assert.rejects(turn(adapter(), [user("[nativemsg]")]), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "invalid_tool_call"); assert.equal(error.upstream?.code, "unknown_tool");
      assert.equal(streamFailureCode(error), "invalid_prompt");
      assert.equal(providerFailureDiagnostic({ requestId: "invalid", durationMs: 1, failure: error }).upstreamCode, "unknown_tool");
      return true;
    });
    assert.equal((await h.log()).filter(row => row.op === "create").length, 1);
  } finally { await h.restore(); }
});
