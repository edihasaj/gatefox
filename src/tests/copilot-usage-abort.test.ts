import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { flushUsageLedger, readUsageLedger, resetUsageLedger, type LedgerRow } from "../usage-ledger.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { ProviderError } from "../providers/provider.js";
import { sessionLimits } from "../providers/copilot-live-session.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { adapter, harness, providerId, queuedUsage, sleep, thread, tools, until, user, type Harness } from "./copilot-live-harness.js";

// Copilot bills a model call when it reports its usage. A request that ends early, because the caller cancelled or
// left, must still record that usage, in the ledger and in telemetry, whichever path served it.
// No test here measures time: each waits for the event that proves what it asserts, so a build that is wrong fails by an
// assertion or by the test's own timeout, and a correct build never fails because the machine was slow.

async function gateway(h: Harness, mode: "live" | "oneshot") {
  const state = join(h.directory, "state"); resetUsageLedger();
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{ id: providerId, type: "copilot-subscription", models: { alias: "fixture" }, copilotSessions: { mode } }] });
  const server = await startGateway(config);
  return { state, port: (server.address() as AddressInfo).port, token: await gatewayToken(state), idle: () => server.isIdle(),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** The ledger's rows once the gateway has finished with its requests (a finished request has written its row by then). */
async function ledgerRows(server: Awaited<ReturnType<typeof gateway>>): Promise<LedgerRow[]> {
  assert.ok(await until(() => server.idle(), 600000), "the gateway finished the request");
  await flushUsageLedger(); return readUsageLedger(server.state, 0);
}

test("a client that stops reading and then leaves still has the usage the CLI reported recorded, live or one-shot", { timeout: 60000 }, async () => {
  for (const mode of ["live", "oneshot"] as const) {
    const h = await harness(); const server = await gateway(h, mode);
    try {
      const body = JSON.stringify({ model: "alias", input: [user("go [bigusage]")], tools, stream: true });
      const client = request({ host: "127.0.0.1", port: server.port, path: "/v1/responses", method: "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "thread-id": "thread-usage" } });
      client.on("error", () => {});
      const responded = new Promise<IncomingMessage>(resolve => client.once("response", resolve)); client.end(body);
      // The response body is never read, so the gateway waits to write the large answer while the usage arrives behind it.
      await responded;
      assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "bigusage_sent")), mode);
      client.destroy();
      const [row, ...rest] = await ledgerRows(server);
      assert.equal(rest.length, 0, mode);
      assert.deepEqual([row?.status, row?.inputTokens, row?.cacheWriteTokens, row?.nanoAiu, row?.nanoAiuStatus], ["failed", 100, 100, 1e9, "complete"], `${mode}: the billed call is in the ledger`);
      if (mode === "live") {
        const interrupted = (await h.sessions()).find(entry => entry.outcome === "interrupted");
        assert.deepEqual([interrupted?.inputTokens, interrupted?.nanoAiu], [100, 1e9], "the session's end event counts it too");
      }
    } finally { await server.close(); await h.restore(); }
  }
});

test("a cancelled one-shot request hands over the usage its CLI reported, though more text was read ahead of it", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const controller = new AbortController(); const afterAbort: InferenceEvent[] = []; let failure: unknown;
    const input = restoreReasoning({ model: "fixture", input: [user("go [deltausage]")], tools } as ResponsesRequest, "scope");
    try {
      for await (const event of adapter({ mode: "oneshot" }).infer(input, controller.signal, thread)) {
        if (controller.signal.aborted) afterAbort.push(event);
        // The consumer is busy until the CLI has sent more text and then the call's usage; then it cancels.
        else if (event.type === "text") { assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "usage_sent"))); await sleep(50); controller.abort(); }
      }
    } catch (error) { failure = error; }
    assert.ok(failure instanceof ProviderError && failure.code === "cancelled", String(failure));
    // A caller that has gone may take only the first event after a cancellation: it is the usage, not the text ahead of it.
    assert.deepEqual(afterAbort.map(event => event.type), ["usage"]);
    const [usage] = afterAbort; assert.ok(usage.type === "usage");
    assert.deepEqual([usage.usage.input_tokens, usage.accounting?.nanoAiu], [100, 1e9]);
  } finally { await h.restore(); }
});

test("the end of a cancelled live request counts the usage that was queued when it was cancelled", { timeout: 30000 }, async () => {
  const h = await harness();
  try {
    const controller = new AbortController();
    const input = restoreReasoning({ model: "fixture", input: [user("go [deltausage]")], tools } as ResponsesRequest, "scope");
    try {
      for await (const event of adapter().infer(input, controller.signal, thread)) {
        // The consumer is busy until the call's usage is waiting in the request's queue; then it cancels.
        if (event.type === "text" && !controller.signal.aborted) { assert.ok(await until(() => queuedUsage() === 1)); controller.abort(); }
      }
    } catch { /* Cancelled. */ }
    const interrupted = (await h.sessions()).find(entry => entry.outcome === "interrupted");
    assert.deepEqual([interrupted?.inputTokens, interrupted?.cacheWriteTokens, interrupted?.nanoAiu], [100, 100, 1e9]);
  } finally { await h.restore(); }
});

/**
 * One request cancelled at its first text, while the CLI is being aborted: the CLI answers `session.abort` only when the test lets it
 * (after it has the usage it waits for), and the abort limit is far beyond the test, so the order is exact whatever the machine's speed.
 * A build that hands the usage over only at the end of the stream, or drops it, never gets the answer: it fails by its assertion or by timeout.
 */
async function cancelledWhileAborting(h: Harness, mode: "live" | "oneshot", marker: string, usages: number) {
  const gate = join(h.directory, "abort-gate"); process.env.GATEWAY_COPILOT_LIVE_ABORT_GATE = gate;
  const limit = sessionLimits.abortMs; sessionLimits.abortMs = 600000;
  const controller = new AbortController(); const afterAbort: InferenceEvent[] = []; let failure: unknown;
  const input = restoreReasoning({ model: "fixture", input: [user(`go [${marker}]`)], tools } as ResponsesRequest, "scope");
  try {
    for await (const event of adapter({ mode }).infer(input, controller.signal, thread)) {
      if (controller.signal.aborted) { afterAbort.push(event); if (afterAbort.filter(entry => entry.type === "usage").length === usages) await writeFile(gate, "x"); }
      else if (event.type === "text") controller.abort();
    }
  } catch (error) { failure = error; }
  finally { sessionLimits.abortMs = limit; await writeFile(gate, "x"); }
  return { afterAbort, failure };
}

for (const mode of ["oneshot", "live"] as const) {
  test(`a cancelled ${mode} request counts every usage its CLI sends with its last words, in one write with the answer to session.abort`, { timeout: 30000 }, async () => {
    // The CLI answers the abort with 200 more calls' usage in front of the answer; the request ends once all of them were read.
    const h = await harness(); process.env.GATEWAY_COPILOT_LIVE_ABORT_BURST = "200";
    try {
      const controller = new AbortController(); const totals: number[] = []; let failure: unknown;
      const input = restoreReasoning({ model: "fixture", input: [user("go [stall]")], tools } as ResponsesRequest, "scope");
      try {
        for await (const event of adapter({ mode }).infer(input, controller.signal, thread)) {
          if (controller.signal.aborted) { if (event.type === "usage") totals.push(event.usage.input_tokens); }
          else if (event.type === "text") controller.abort();
        }
      } catch (error) { failure = error; }
      assert.ok(failure instanceof ProviderError && failure.code === "cancelled", String(failure));
      // One call before the cancellation (100 input tokens) and 200 after it: the running total ends at the sum of 100 * 1..201.
      assert.equal(totals.at(-1), 100 * 201 * 202 / 2, `all 200 calls were counted (the last total of ${totals.length} was ${totals.at(-1)})`);
    } finally { await h.restore(); }
  });

  test(`a cancelled ${mode} request hands over the usage when the CLI reports it, not when the CLI's stream ends`, { timeout: 30000 }, async () => {
    const h = await harness();
    try {
      const { afterAbort, failure } = await cancelledWhileAborting(h, mode, "deltausage", 1);
      assert.ok(failure instanceof ProviderError && failure.code === "cancelled", String(failure));
      // The text the CLI sent after the cancellation is not handed over: only the usage is.
      assert.deepEqual(afterAbort.map(event => event.type), ["usage"], "the usage was handed over while the CLI was still being aborted");
      const [usage] = afterAbort; assert.ok(usage.type === "usage"); assert.deepEqual([usage.usage.input_tokens, usage.accounting?.nanoAiu], [100, 1e9]);
      if (mode === "live") {
        const interrupted = (await h.sessions()).find(entry => entry.outcome === "interrupted");
        assert.deepEqual([interrupted?.inputTokens, interrupted?.nanoAiu], [100, 1e9], "the session's end event counts what it reported while it was aborted");
      }
    } finally { await h.restore(); }
  });

  test(`a cancelled ${mode} request hands over each usage as a running total`, { timeout: 30000 }, async () => {
    const h = await harness();
    try {
      // The CLI reports its two calls after the cancellation; the abort is answered once both are in.
      const { afterAbort, failure } = await cancelledWhileAborting(h, mode, "lateusage2", 2);
      assert.ok(failure instanceof ProviderError && failure.code === "cancelled", String(failure));
      // The two calls (100 and 200 input tokens): each is handed over as it arrives, as the sum so far.
      assert.deepEqual(afterAbort.flatMap(event => event.type === "usage" ? [event.usage.input_tokens] : []), [100, 300]);
      assert.deepEqual(afterAbort.map(event => event.type).filter(type => type !== "usage"), [], "and nothing else");
      if (mode === "live") {
        const interrupted = (await h.sessions()).find(entry => entry.outcome === "interrupted");
        assert.deepEqual([interrupted?.inputTokens, interrupted?.nanoAiu], [300, 1.1e9], "the session's end event has the sum");
      }
    } finally { await h.restore(); }
  });
}
