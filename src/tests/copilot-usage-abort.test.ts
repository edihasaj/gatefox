import test from "node:test";
import assert from "node:assert/strict";
import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { flushUsageLedger, readUsageLedger, resetUsageLedger, type LedgerRow } from "../usage-ledger.js";
import { restoreReasoning } from "../protocol/reasoning-state.js";
import { ProviderError } from "../providers/provider.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { adapter, harness, providerId, sleep, thread, tools, until, user, type Harness } from "./copilot-live-harness.js";

// Copilot bills a model call when it reports its usage. A request that ends early, because the caller cancelled or
// left, must still record that usage, in the ledger and in telemetry, whichever path served it.

async function gateway(h: Harness, mode: "live" | "oneshot") {
  const state = join(h.directory, "state"); resetUsageLedger();
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{ id: providerId, type: "copilot-subscription", models: { alias: "fixture" }, copilotSessions: { mode } }] });
  const server = await startGateway(config);
  return { state, port: (server.address() as AddressInfo).port, token: await gatewayToken(state),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** The ledger's rows once one is written, or none after a few seconds. */
async function ledgerRows(state: string): Promise<LedgerRow[]> {
  for (let attempt = 0; attempt < 100; attempt++) { await flushUsageLedger(); const rows = await readUsageLedger(state, 0); if (rows.length) return rows; await sleep(50); }
  return [];
}

test("a client that stops reading and then leaves still has the usage the CLI reported recorded, live or one-shot", { timeout: 30000 }, async () => {
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
      assert.ok(await until(async () => (await h.log()).some(entry => entry.op === "bigusage_sent")), mode); await sleep(300);
      client.destroy();
      const [row, ...rest] = await ledgerRows(server.state);
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
        // The consumer is busy while the CLI sends more text and then the call's usage; then it cancels.
        else if (event.type === "text") { await sleep(350); controller.abort(); }
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
    const input = restoreReasoning({ model: "fixture", input: [user("go [lateusage]")], tools } as ResponsesRequest, "scope");
    try {
      for await (const event of adapter().infer(input, controller.signal, thread)) {
        // The consumer is busy while the CLI reports the call's usage, then cancels.
        if (event.type === "text" && !controller.signal.aborted) { await sleep(350); controller.abort(); }
      }
    } catch { /* Cancelled. */ }
    const interrupted = (await h.sessions()).find(entry => entry.outcome === "interrupted");
    assert.deepEqual([interrupted?.inputTokens, interrupted?.cacheWriteTokens, interrupted?.nanoAiu], [100, 100, 1e9]);
  } finally { await h.restore(); }
});
