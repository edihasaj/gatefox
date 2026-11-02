import test from "node:test";
import assert from "node:assert/strict";
import { startGateway } from "../server.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesInputItem } from "../protocol/types.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { ProviderError } from "../providers/provider.js";
import { adapter, harness, live, outputFor, providerId, thread, tools, turn, user } from "./copilot-live-harness.js";

for (const stream of [false, true]) test(`Copilot reasoning keeps the same live session through tools and follow-ups (stream=${stream})`, { timeout: 30000 }, async () => {
  const h = await harness();
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: h.directory,
    providers: [{ id: providerId, type: "copilot-subscription", models: { alias: "fixture" } }] };
  const server = await startGateway(config, undefined, undefined, { onFailure() {} });
  const token = await gatewayToken(h.directory);
  const send = async (input: ResponsesInputItem[]) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "thread-id": `reasoning-${stream}` },
      body: JSON.stringify({ model: "alias", input, tools, stream }),
    });
    assert.equal(response.status, 200);
    if (!stream) return await response.json() as { output: ResponsesInputItem[]; status: string };
    let result: { output: ResponsesInputItem[]; status: string } | undefined;
    for await (const event of readEvents(response.body!)) {
      if (event.type === "response.failed") assert.fail("continued session failed");
      if (event.type === "response.completed") result = event.response as typeof result;
    }
    assert.ok(result); return result;
  };
  try {
    const first = [user("go [tools:3][reasoning]")];
    const a = await send(first);
    const reasoning = a.output.filter(item => item.type === "reasoning");
    assert.equal(reasoning.length, 1);
    // The desktop can replay the summary after the calls, as observed in the incident.
    const echoed = [...a.output.filter(item => item.type !== "reasoning"), ...reasoning];
    const second = [...first, ...echoed, ...outputFor(a.output, "result")];
    const b = await send(second); assert.equal(b.status, "completed");
    const c = await send([...second, ...b.output, user("continue")]); assert.equal(c.status, "completed");
    const log = await h.log();
    assert.equal(log.filter(entry => entry.op === "create").length, 1, "no reseed or one-shot replay");
    assert.equal(log.filter(entry => entry.op === "deliver").length, 3, "each waiting tool receives its own output once");
    assert.deepEqual((await h.sessions()).filter(entry => ["spawned", "continued", "preserved"].includes(String(entry.outcome))).map(entry => entry.outcome), ["spawned", "continued", "continued"]);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await h.restore();
  }
});

test("a Copilot session preserved by the old summary conversion accepts corrected typed history", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter(); const first = [user("go [tools:3][reasoning]")];
    const a = await turn(provider, first);
    const input = [...first, ...a.output, ...outputFor(a.output, "result")];
    // Reproduce the previous ingress conversion without changing the retained native session.
    await assert.rejects(turn(provider, input), error => error instanceof ProviderError && error.upstream?.code === "copilot_session_preserved");
    const fixed = restoreReasoning({ model: "fixture", input, tools }, "scope", { preserveSummaries: true });
    for await (const _ of provider.infer(fixed, new AbortController().signal, thread)) { /* Finish the original session's tools. */ }
    const log = await h.log();
    assert.equal(log.filter(entry => entry.op === "create").length, 1);
    assert.equal(log.filter(entry => entry.op === "deliver").length, 3);
    assert.deepEqual((await h.sessions()).filter(entry => ["spawned", "continued", "preserved"].includes(String(entry.outcome))).map(entry => entry.outcome), ["spawned", "preserved", "continued"]);
  } finally { await h.restore(); }
});

test("an adopted old seed with historical reasoning migrates only its exact prefix and retains pending tools", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const provider = adapter();
    const first: ResponsesInputItem[] = [user("old task"), { type: "reasoning", summary: [{ type: "summary_text", text: "old public plan" }] },
      { type: "message", role: "assistant", content: "prior answer" }, user("go [tools:3][reasoning]")];
    const a = await turn(provider, first);
    const session = live().sessions()[0];
    Reflect.deleteProperty(session, "reasoningLedgerVersion"); // Object retained from the pre-fix module.
    const input = [...first, ...a.output, ...outputFor(a.output, "result")];
    const saved = structuredClone(session.ledger);
    const fixed = (history: ResponsesInputItem[]) => restoreReasoning({ model: "fixture", input: history, tools }, "scope", { preserveSummaries: true });
    const serve = async (history: ResponsesInputItem[]) => { for await (const _ of provider.infer(fixed(history), new AbortController().signal, thread)) { /* Drain the original native session. */ } };
    await assert.rejects(serve([user("changed task"), ...input.slice(1)]), error => error instanceof ProviderError && error.upstream?.code === "copilot_session_preserved");
    assert.deepEqual(session.ledger, saved); assert.equal(session.reasoningLedgerVersion, undefined);
    assert.equal((await h.log()).filter(entry => entry.op === "deliver").length, 0);
    await serve(input);
    const log = await h.log();
    assert.equal(log.filter(entry => entry.op === "create").length, 1);
    assert.equal(log.filter(entry => entry.op === "deliver").length, 3);
    assert.equal(session.reasoningLedgerVersion, 1);
  } finally { await h.restore(); }
});
