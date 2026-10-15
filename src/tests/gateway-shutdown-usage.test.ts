import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";
import type { InferenceEvent, UsageAccounting } from "../protocol/types.js";
import { flushRecords, resetUsageLedger } from "../usage-ledger.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

// Copilot bills a model call when it reports its usage. At shutdown the server stops its running requests and keeps
// reading each provider, for usage only, before the process exits; the ledger and telemetry written last must hold
// what those requests reported, however long after the stop it arrived (within the usage drain).
const usage = { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 80 } };
const accounting: UsageAccounting = { cacheWriteTokens: 10, reasoningTokens: 3, nanoAiu: 2e9, nanoAiuStatus: "complete" };

async function gateway(t: TestContext, infer: Provider["infer"]) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-shutdown-usage-")); resetUsageLedger(); configureTelemetry(directory, "test");
  const previous = process.env.GATEWAY_SHUTDOWN_DRAIN_MS; process.env.GATEWAY_SHUTDOWN_DRAIN_MS = "100";
  t.after(async () => {
    if (previous === undefined) delete process.env.GATEWAY_SHUTDOWN_DRAIN_MS; else process.env.GATEWAY_SHUTDOWN_DRAIN_MS = previous;
    await flushRecords(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "fake", type: "copilot-subscription", models: { alias: "actual" } }] });
  const server = await startGateway(config, () => ({ infer }) as Provider, undefined, { onFailure: () => {} });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  return { directory, server, post: () => fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "hi", stream: true }) }) };
}

test("usage a provider reports well after the shutdown stopped its request is in the ledger when the server has closed", { timeout: 20000 }, async t => {
  const gw = await gateway(t, async function* (_request, signal): AsyncGenerator<InferenceEvent> {
    yield { type: "text", text: "partial" };
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    // A one-shot CLI that is still exiting reports the call it had already paid for more than a second after it was stopped.
    await delay(1500);
    yield { type: "usage", usage, accounting }; yield { type: "done", usage, accounting };
  });
  const response = await gw.post(); const reader = response.body!.getReader(); await reader.read();
  // What the files hold at the instant the server reports itself closed, which is when a stopping process exits: the drain
  // has to have written every row by then, with no later flush to rely on.
  const written = () => { const directory = join(gw.directory, "usage"); try { return readdirSync(directory).filter(name => /^usage-.*\.jsonl$/.test(name)).map(name => readFileSync(join(directory, name), "utf8")).join(""); } catch { return ""; } };
  let atClose = "";
  await new Promise<void>(resolve => { gw.server.close(() => { atClose = written(); resolve(); }); });
  const [row, ...rest] = atClose.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.origin === "gateway");
  assert.equal(rest.length, 0);
  assert.deepEqual([row?.status, row?.inputTokens, row?.cacheWriteTokens, row?.nanoAiu, row?.nanoAiuStatus], ["failed", 100, 10, 2e9, "complete"], "the billed call is in the ledger");
  await flushTelemetry();
  // The drain writes its record just before its final flush, so that flush came after the stopped request's row.
  const events = await readTelemetry(gw.directory, 0); const drained = events.find(event => event.event === "server_drain");
  assert.ok(drained && Date.parse(drained.at) >= Date.parse(String(row?.at)), "the final flush waited for the stopped request to finish");
  const failed = events.find(event => event.event === "request_failed");
  assert.equal(failed?.nanoAiu, 2e9, "telemetry keeps the spend too"); assert.equal(failed?.abortCause, "shutdown");
  await reader.cancel().catch(() => {});
});
