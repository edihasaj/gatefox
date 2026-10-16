import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { resetUsageLedger } from "../usage-ledger.js";
import type { WireEvent } from "../protocol/types.js";

// A running `usage` event reports spend the provider already knows. It is accounting only: it neither opens the response
// stream, nor counts as an output event, nor is the first event a request's time to first event is measured to.
const usage = { input_tokens: 100, output_tokens: 5, total_tokens: 105 };

async function setup(provider: Provider, heartbeatMs = 2000) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-usage-events-")); configureTelemetry(directory, "server"); resetUsageLedger();
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, timeoutMs: 10000,
    providers: [{ id: "fixture", type: "codex-subscription", models: { alias: "upstream" } }] };
  const server = await startGateway(config, () => provider, undefined, { heartbeatMs, onFailure: () => {} });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  return { directory, post: async () => { const started = Date.now(); const response = await fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "hello", stream: true }) }); return { response, headMs: Date.now() - started }; },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

test("a request whose provider reports usage and then nothing else is empty: usage opens no stream and is no first event", { timeout: 10000 }, async () => {
  // The provider holds the transport head back (emitsTransport), so the head opens at the first real event or at the heartbeat.
  const gateway = await setup({ emitsTransport: true, async *infer() { yield { type: "usage", usage }; await delay(300); yield { type: "done", usage }; } });
  try {
    const { response, headMs } = await gateway.post();
    assert.ok(headMs >= 250, `the usage event did not send the response head (${headMs} ms)`);
    const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event);
    assert.equal(events.at(-1)!.type, "response.completed");
    await flushTelemetry(); const entries = await readTelemetry(gateway.directory, Date.now() - 60000);
    assert.deepEqual(entries.filter(entry => entry.event === "request_completed"), [], "usage alone does not make a request completed");
    const [empty] = entries.filter(entry => entry.event === "request_empty"); assert.ok(empty, "it is an empty request");
    assert.equal(empty.events, 1); assert.equal(empty.inputTokens, 100, "its spend is still recorded");
    assert.ok(Number(empty.firstEventMs) >= 250, `time to first event is measured to the first real event (${empty.firstEventMs} ms)`);
  } finally { await gateway.close(); }
});

test("a provider that has reported only usage gets its response head at the heartbeat, like one that has said nothing", { timeout: 10000 }, async () => {
  const gateway = await setup({ emitsTransport: true, async *infer() { yield { type: "usage", usage }; await delay(1200); yield { type: "text", text: "late" }; yield { type: "done", usage }; } }, 400);
  try {
    const { response, headMs } = await gateway.post();
    assert.ok(headMs >= 350 && headMs < 1000, `the head came with the heartbeat, not with the usage event or the first text (${headMs} ms)`);
    const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event);
    assert.equal(events.at(-1)!.type, "response.completed");
    await flushTelemetry(); const [completed] = (await readTelemetry(gateway.directory, Date.now() - 60000)).filter(entry => entry.event === "request_completed");
    assert.equal(completed.events, 2, "the text and the end are its events; usage is not");
    assert.ok(Number(completed.firstEventMs) >= 1000, `time to first event is the text's (${completed.firstEventMs} ms)`);
  } finally { await gateway.close(); }
});
