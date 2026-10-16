import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, validateConfig } from "../config.js";
import { startGateway, type GatewayFailure } from "../server.js";
import { anthropicError } from "../protocol/messages.js";
import { readEvents } from "../protocol/sse.js";
import { anthropicContextFailure, claudeContextFailure, contextWindowFailure } from "../providers/context-errors.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import type { WireEvent } from "../protocol/types.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { flushUsageLedger, gatewayMarkedId, gatewayMarkerPrefixes, isGatewayMarkedId, readUsageLedger, resetUsageLedger } from "../usage-ledger.js";

// Claude Code recognizes a context overflow only by this text, and reads the token gap from it.
const claudeCodeOverflow = /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i;
const limit = "the request exceeds the model's context window";
const messagesBody = { model: "alias", max_tokens: 64, messages: [{ role: "user", content: "hello" }] };
const events = async (response: Response): Promise<WireEvent[]> => { const result: WireEvent[] = []; for await (const event of readEvents(response.body!)) result.push(event); return result; };

async function gateway(t: TestContext, provider: Provider, providerType = "responses-api") {
  const directory = await mkdtemp(join(tmpdir(), "gateway-messages-errors-")); resetUsageLedger(); configureTelemetry(directory, "test");
  const failures: GatewayFailure[] = [];
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "test", type: providerType, models: { alias: "upstream" },
    ...(providerType === "responses-api" ? { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_UNUSED_KEY" } : {}) }] });
  const server = await startGateway(config, () => provider, undefined, { onFailure: failure => { failures.push(failure); } });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; const token = await gatewayToken(directory);
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(path.startsWith("/v1/messages") ? { "x-api-key": token } : { Authorization: `Bearer ${token}` }) } });
  t.after(async () => { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await flushUsageLedger(); await flushTelemetry();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { directory, post, failures };
}
const failing = (error: ProviderError): Provider => ({ async *infer() { throw error; } });

test("a context overflow is a Claude Code prompt-too-long error, with the token gap when the provider reported it", () => {
  const known = anthropicError("context_length_exceeded", limit, 400, { used: 250000, maximum: 200000 });
  assert.deepEqual(known, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } });
  assert.deepEqual(claudeCodeOverflow.exec(known.error.message)?.slice(1), ["250000", "200000"]);
  const unknown = anthropicError("context_length_exceeded", limit, 400);
  assert.deepEqual(unknown, { type: "error", error: { type: "invalid_request_error", message: `prompt is too long: ${limit}` } });
  assert.match(unknown.error.message, /prompt is too long/i); assert.equal(claudeCodeOverflow.test(unknown.error.message), false);
  // Other failures keep their own text, and counts alone never relabel them.
  assert.deepEqual(anthropicError("invalid_request", "Bad", 400, { used: 1, maximum: 2 }), { type: "error", error: { type: "invalid_request_error", message: "Bad" } });
});

test("providers keep the counts of a native prompt-too-long message and nothing else", () => {
  const counts = (error: ProviderError | undefined) => error?.upstream?.contextTokens;
  const wire = (message: string) => ({ error: { type: "invalid_request_error", message } });
  assert.deepEqual(counts(anthropicContextFailure(wire("prompt is too long: 200001 tokens > 200000 maximum"))), { used: 200001, maximum: 200000 });
  assert.equal(counts(anthropicContextFailure(wire("prompt is too long"))), undefined);
  assert.equal(counts(anthropicContextFailure({ error: { code: "context_length_exceeded", message: "private-token 1 tokens > 2 maximum" } })), undefined);
  const result = { type: "result", is_error: true, subtype: "error_during_execution" };
  assert.deepEqual(counts(claudeContextFailure({ ...result, result: "Prompt is too long: 300 tokens > 200 maximum" })), { used: 300, maximum: 200 });
  assert.equal(counts(claudeContextFailure({ ...result, result: "Prompt is too long" })), undefined);
  assert.equal(contextWindowFailure().message, `The request exceeds the model's context window`, "the gateway's own text is unchanged");
  assert.equal(contextWindowFailure({ used: 3, maximum: 2 }).message, `The request exceeds the model's context window`);
});

test("Messages answers a context overflow with prompt-too-long on the JSON and the SSE path; Responses keeps its own text", async t => {
  for (const [counts, expected] of [[{ used: 250000, maximum: 200000 }, "prompt is too long: 250000 tokens > 200000 maximum"], [undefined, `prompt is too long: ${limit}`]] as const) {
    const gw = await gateway(t, failing(contextWindowFailure(counts)));
    const json = await gw.post("/v1/messages", messagesBody); const body = await json.json() as { type: string; error: { type: string; message: string }; request_id: string };
    assert.equal(json.status, 400); assert.equal(body.type, "error"); assert.equal(body.error.type, "invalid_request_error"); assert.equal(body.error.message, expected);
    assert.equal(body.request_id, json.headers.get("request-id"));
    const stream = await gw.post("/v1/messages", { ...messagesBody, stream: true }); const frames = await events(stream);
    const error = frames.at(-1)!; assert.equal(error.type, "error"); assert.deepEqual(error.error, { type: "invalid_request_error", message: expected });
    assert.equal(frames.some(event => event.type === "message_stop"), false);
    assert.equal(claudeCodeOverflow.test(expected), counts !== undefined);
    // Responses errors are unchanged: the gateway's code and its own text.
    const responses = await gw.post("/v1/responses", { model: "alias", input: "hello" });
    assert.equal(responses.status, 400); assert.deepEqual(await responses.json(), { error: { code: "context_length_exceeded", message: "The request exceeds the model's context window" } });
  }
});

test("count_tokens is declined without failure telemetry or a stderr diagnostic", async t => {
  const gw = await gateway(t, { async *infer() { throw new Error("count_tokens must not reach a provider"); } });
  const count = await gw.post("/v1/messages/count_tokens?beta=true", { model: "alias", messages: messagesBody.messages });
  assert.equal(count.status, 501); const body = await count.json() as { type: string; error: { type: string }; request_id: string };
  assert.equal(body.type, "error"); assert.equal(body.error.type, "invalid_request_error"); assert.equal(body.request_id, count.headers.get("request-id"));
  assert.deepEqual(gw.failures, [], "no failure diagnostic");
  await flushTelemetry(); await flushUsageLedger();
  const seen = (await readTelemetry(gw.directory, 0)).filter(event => event.event.startsWith("request_"));
  assert.deepEqual(seen.map(event => event.event), ["request_unsupported"], "no request_failed");
  assert.deepEqual([seen[0].route, seen[0].endpoint, seen[0].requestId], ["/v1/messages/count_tokens", "count_tokens", count.headers.get("x-request-id")]);
  assert.deepEqual(Object.keys(seen[0]).sort(), ["at", "component", "endpoint", "event", "host", "pid", "requestId", "route"].sort(), "fixed fields only");
  assert.deepEqual(await readUsageLedger(gw.directory, 0), [], "the ledger records no spend for it");
  // A real failure on the same route still records request_failed and its diagnostic.
  const failed = await gateway(t, failing(new ProviderError("provider_failed", "x", 502)));
  assert.equal((await failed.post("/v1/messages", messagesBody)).status, 502);
  await flushTelemetry(); assert.equal(failed.failures.length, 1);
  assert.deepEqual((await readTelemetry(failed.directory, 0)).filter(event => event.event.startsWith("request_")).map(event => event.event), ["request_failed"]);
});

test("the gateway marker prefixes name both protocols", () => {
  assert.deepEqual([...gatewayMarkerPrefixes], ["resp_gl_", "msg_gl_"]);
  assert.equal(gatewayMarkedId("responses", "0a1b-2c"), "resp_gl_0a1b2c"); assert.equal(gatewayMarkedId("messages", "0a1b-2c"), "msg_gl_0a1b2c");
  assert.ok(isGatewayMarkedId("resp_gl_ab") && isGatewayMarkedId("msg_gl_ab")); assert.ok(!isGatewayMarkedId("msg_ab") && !isGatewayMarkedId("resp_ab"));
});
