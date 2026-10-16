import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway } from "../server.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import type { InferenceEvent, UsageAccounting } from "../protocol/types.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { flushUsageLedger, readUsageLedger, resetUsageLedger, type LedgerRow } from "../usage-ledger.js";
import { fixtureCli } from "./copilot-fixture-cli.js";

// A Messages request is accounted exactly like a Responses request: the same ledger row and telemetry, the ledger marker on
// the id the client keeps, and no billing detail in what the client receives.

const messages = (stream: boolean) => ({ model: "alias", max_tokens: 64, messages: [{ role: "user", content: "hello" }], stream });
const billing = ["nanoAiu", "cacheWriteTokens", "reasoningTokens", "nanoAiuStatus", "initiator", '"type":"usage"', "event: usage"];
/** The ledger fields that describe spend; the ids and the time differ per request. */
const spend = (row: LedgerRow | undefined) => row && [row.status, row.provider, row.providerType, row.model, row.origin, row.inputTokens, row.cachedTokens,
  row.cacheWriteTokens, row.outputTokens, row.reasoningTokens, row.nanoAiu, row.nanoAiuStatus];

async function gateway(t: TestContext, providers: Record<string, unknown>[], factory?: () => Provider) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-messages-usage-")); resetUsageLedger(); configureTelemetry(directory, "test");
  const server = await startGateway(validateConfig({ version: 1, port: 0, stateDirectory: directory, providers }), factory, undefined, { onFailure() {} });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = await gatewayToken(directory);
  const post = (path: string, body: unknown, signal?: AbortSignal) => fetch(base + path, { method: "POST", signal, body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(path === "/v1/messages" ? { "x-api-key": token } : { Authorization: `Bearer ${token}` }) } });
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  t.after(async () => { await close(); await flushUsageLedger(); await flushTelemetry(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const rows = async () => { await flushUsageLedger(); return readUsageLedger(directory, 0); };
  return { directory, post, rows, idle: () => server.isIdle() };
}

test("a Messages request on a Copilot route records the same ledger row and telemetry as a Responses request, with the marker on its message id", { timeout: 60000 }, async t => {
  const fixture = await fixtureCli("gateway-messages-usage-copilot-"); t.after(() => fixture.restore()); fixture.mode("billing");
  const gw = await gateway(t, [{ id: "copilot", type: "copilot-subscription", models: { alias: "fixture" }, copilotSessions: { mode: "oneshot" } }]);
  for (const stream of [false, true]) {
    const responses = await gw.post("/v1/responses", { model: "alias", input: "hello", stream });
    const responsesText = await responses.text(); assert.equal(responses.status, 200, responsesText);
    const message = await gw.post("/v1/messages", messages(stream));
    const messageText = await message.text(); assert.equal(message.status, 200, messageText);
    assert.match(messageText, /fixture-proof/);
    for (const word of [...billing, "cache_creation_input_tokens"]) assert.ok(!messageText.includes(word), `${word} stays local (stream ${stream})`);
    const responseId = stream ? /"id":"(resp_[0-9a-z_]+)"/.exec(responsesText)?.[1] : (JSON.parse(responsesText) as { id: string }).id;
    const messageId = stream ? /"id":"(msg_[0-9a-z_]+)"/.exec(messageText)?.[1] : (JSON.parse(messageText) as { id: string }).id;
    assert.equal(messageId, `msg_gl_${message.headers.get("request-id")!.replaceAll("-", "")}`, "the Messages id carries the ledger marker");
    const rows = await gw.rows(); const byRequest = (response: Response) => rows.find(row => row.requestId === response.headers.get("x-request-id"));
    const [fromResponses, fromMessages] = [byRequest(responses), byRequest(message)];
    assert.equal(fromResponses?.responseId, responseId); assert.equal(fromMessages?.responseId, messageId, "the ledger row names the id the client keeps");
    assert.deepEqual(spend(fromMessages), spend(fromResponses), `the Messages row records what the Responses row records (stream ${stream})`);
    assert.deepEqual(spend(fromMessages), ["completed", "copilot", "copilot-subscription", "alias", "gateway", 150, 120, 10, 7, 4, 3e9, "complete"]);
  }
  await flushTelemetry();
  const completed = (await readTelemetry(gw.directory, 0)).filter(event => event.event === "request_completed");
  assert.equal(completed.length, 4);
  for (const event of completed) assert.deepEqual([event.providerType, event.nanoAiu, event.nanoAiuStatus, event.cacheWriteTokens, event.reasoningTokens, event.inputTokens],
    ["copilot-subscription", 3e9, "complete", 10, 4, 150], "telemetry is the same for both protocols");
});

const usage = { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 80 } };
const accounting: UsageAccounting = { cacheWriteTokens: 10, reasoningTokens: 3, nanoAiu: 2e9, nanoAiuStatus: "complete" };
const fake = (events: (signal: AbortSignal) => AsyncGenerator<InferenceEvent>) => () => ({ infer: (_request: unknown, signal: AbortSignal) => events(signal) }) as Provider;

test("a Messages request that fails after billed usage keeps that spend in the ledger and returns a native error", async t => {
  const gw = await gateway(t, [{ id: "fake", type: "copilot-subscription", models: { alias: "actual" } }], fake(async function* () {
    yield { type: "usage", usage, accounting }; throw new ProviderError("model_route", "Copilot returned an unexpected model instead of the requested model", 502);
  }));
  const response = await gw.post("/v1/messages", messages(false)); const body = await response.json() as { type: string; error: { type: string } };
  assert.equal(response.status, 502); assert.equal(body.type, "error"); assert.equal(body.error.type, "api_error");
  const [row, ...rest] = await gw.rows(); assert.equal(rest.length, 0);
  assert.deepEqual([row.status, row.providerType, row.inputTokens, row.cachedTokens, row.cacheWriteTokens, row.reasoningTokens, row.nanoAiu, row.nanoAiuStatus],
    ["failed", "copilot-subscription", 100, 80, 10, 3, 2e9, "complete"]);
});

test("usage a provider reports after a Messages client disconnected is still recorded", async t => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const gw = await gateway(t, [{ id: "fake", type: "copilot-subscription", models: { alias: "actual" } }], fake(async function* (signal) {
    began(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    yield { type: "usage", usage, accounting }; yield { type: "done", usage, accounting };
  }));
  const client = new AbortController();
  const pending = gw.post("/v1/messages", messages(true), client.signal).then(response => response.text()).catch(() => "");
  await started; client.abort(); await pending;
  for (let attempt = 0; attempt < 50 && !(await gw.rows()).length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  const [row, ...rest] = await gw.rows(); assert.equal(rest.length, 0);
  assert.deepEqual([row.status, row.inputTokens, row.nanoAiu, row.nanoAiuStatus], ["failed", 100, 2e9, "complete"]);
});

test("a Responses client never sees cache writes, while a Messages client gets them as cache_creation_input_tokens", async t => {
  const written = { input_tokens: 15, output_tokens: 2, total_tokens: 17, input_tokens_details: { cached_tokens: 5, cache_creation_tokens: 7 } };
  const gw = await gateway(t, [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }], fake(async function* () {
    yield { type: "text", text: "hi" }; yield { type: "done", usage: written, accounting: { cacheWriteTokens: 7 } };
  }));
  const responses = await (await gw.post("/v1/responses", { model: "alias", input: "hello" })).json() as { usage: unknown };
  assert.deepEqual(responses.usage, { input_tokens: 15, output_tokens: 2, total_tokens: 17, input_tokens_details: { cached_tokens: 5 } });
  const message = await (await gw.post("/v1/messages", messages(false))).json() as { usage: unknown };
  assert.deepEqual(message.usage, { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 });
  const rows = await gw.rows(); assert.equal(rows.length, 2);
  for (const row of rows) assert.deepEqual([row.inputTokens, row.cachedTokens, row.cacheWriteTokens], [15, 5, 7], "both rows record the cache writes");
});
