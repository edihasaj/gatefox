import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, gatewayToken } from "../config.js";
import { createGatewayHandler } from "../server.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { unsupportedCompactionMessage } from "../provider-failure.js";
import { flushRecords } from "../usage-ledger.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";

class FakeResponse extends EventEmitter {
  status = 0; headersSent = false; writableEnded = false; writableNeedDrain = false; destroyed = false; private readonly chunks: Buffer[] = [];
  setHeader(): void {} writeHead(status: number): this { this.status = status; this.headersSent = true; return this; }
  write(chunk: string): boolean { this.chunks.push(Buffer.from(chunk)); return true; }
  end(value?: string): void { if (value !== undefined) this.chunks.push(Buffer.from(value)); this.writableEnded = true; this.emit("finish"); }
  body(): string { return Buffer.concat(this.chunks).toString(); }
}

async function gateway(invoke: (request: ResponsesRequest) => AsyncGenerator<InferenceEvent>, extra: { maxConcurrent?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-control-items-"));
  configureTelemetry(directory, "gateway");
  const providerCalls: ResponsesRequest[] = [];
  const handler = await createGatewayHandler(validateConfig({ version: 1, port: 0, stateDirectory: directory,
    ...extra, providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] }),
  () => ({ infer: request => { providerCalls.push(request); return invoke(request); } }));
  const token = await gatewayToken(directory);
  const post = async (value: unknown) => {
    const res = new FakeResponse();
    const finished = new Promise<void>(resolve => res.once("finish", () => resolve()));
    handler.handle({ method: "POST", url: "/v1/responses", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(value)); } } as unknown as IncomingMessage, res as unknown as ServerResponse);
    await finished; await flushTelemetry(); return res;
  };
  const events = async () => (await readTelemetry(directory, Date.now() - 60000));
  // A finished request's usage-ledger write can still be pending; the folder goes only after it lands.
  const close = async () => { await flushRecords(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); };
  return { post, handler, token, providerCalls, events, close };
}
const succeed = async function* (): AsyncGenerator<InferenceEvent> {
  yield { type: "text", text: "OK" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
};
const sseData = (bytes: string): Array<Record<string, unknown>> => bytes.split("\n\n")
  .map(block => block.split("\n").find(line => line.startsWith("data: ")))
  .filter((line): line is string => line !== undefined)
  .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>);

test("configuration_update items are dropped before translation and counted in telemetry", async () => {
  const run = await gateway(succeed);
  try {
    const response = await run.post({ model: "alias", input: [
      { type: "message", role: "user", content: "hello" },
      { type: "configuration_update", model: "private-config-value", reasoning: { effort: "high" } },
      { type: "message", role: "user", content: "again" },
      { type: "configuration_update", instructions: "private second config" },
    ] });
    assert.equal(response.status, 200, response.body());
    assert.equal(run.providerCalls.length, 1);
    const sent = run.providerCalls[0].input as Array<Record<string, unknown>>;
    assert.deepEqual(sent.map(item => item.type), ["message", "message"], "the provider sees only the conversation");
    const completed = (await run.events()).find(event => event.event === "request_completed");
    assert.equal(completed?.droppedControlItems, 2);
    assert.ok(!JSON.stringify(await run.events()).includes("private-config") && !JSON.stringify(await run.events()).includes("private second config"), "telemetry carries the count, never the item content");
  } finally { await run.close(); }
});

test("a request without control items completes without the droppedControlItems field", async () => {
  const run = await gateway(succeed);
  try {
    assert.equal((await run.post({ model: "alias", input: [{ type: "message", role: "user", content: "hello" }] })).status, 200);
    const completed = (await run.events()).find(event => event.event === "request_completed");
    assert.equal("droppedControlItems" in (completed ?? {}), false);
  } finally { await run.close(); }
});

test("compaction_trigger fails as a final invalid_prompt in a stream, without a provider", async () => {
  const run = await gateway(succeed);
  try {
    const response = await run.post({ model: "alias", stream: true, input: [{ type: "message", role: "user", content: "hi" }, { type: "compaction_trigger" }] });
    assert.equal(response.status, 200, "a validated stream reports its failure inside the SSE");
    const events = sseData(response.body());
    assert.equal(events.at(-1)?.type, "response.failed");
    const error = (events.at(-1)!.response as Record<string, unknown>).error as { code: string; message: string };
    assert.equal(error.code, "invalid_prompt");
    assert.equal(error.message, "This gateway serves compaction inside the gateway executor; this Codex build sent remote compaction, which the gateway does not support yet.");
    assert.equal(error.message, unsupportedCompactionMessage);
    assert.equal(run.providerCalls.length, 0, "no provider is invoked for a control item the gateway does not serve");
    const failed = (await run.events()).filter(event => event.event === "request_failed");
    assert.equal(failed.at(-1)?.code, "invalid_request");
    assert.equal(failed.at(-1)?.translation_reason, "unsupported_compaction");
    assert.ok(!JSON.stringify(failed).includes("compaction_trigger"), "telemetry never carries the item content");
  } finally { await run.close(); }
});

test("compaction_trigger returns HTTP 400 for a nonstream request", async () => {
  const run = await gateway(succeed);
  try {
    const response = await run.post({ model: "alias", input: [{ type: "compaction_trigger" }] });
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body()), { error: { code: "invalid_request", message: unsupportedCompactionMessage } });
    assert.equal(run.providerCalls.length, 0);
    const failed = (await run.events()).find(event => event.event === "request_failed");
    assert.equal(failed?.translation_reason, "unsupported_compaction");
  } finally { await run.close(); }
});

test("a compaction_trigger beside a configuration_update still fails without counting the drop", async () => {
  const run = await gateway(succeed);
  try {
    const response = await run.post({ model: "alias", input: [{ type: "configuration_update", model: "m" }, { type: "compaction_trigger" }] });
    assert.equal(response.status, 400);
    assert.equal(run.providerCalls.length, 0);
  } finally { await run.close(); }
});

test("a malformed client_metadata or non-object input item never crashes the handler or reaches a provider", async () => {
  const run = await gateway(succeed);
  try {
    for (const client_metadata of [null, [], [{ mcp_attribution: {} }], "text", 7]) {
      const response = await run.post({ model: "alias", input: [{ type: "message", role: "user", content: "hi" }], client_metadata });
      assert.ok(response.status === 200 || response.status === 400, `client_metadata ${JSON.stringify(client_metadata)} answered ${response.status}`);
    }
    for (const input of [[null], [7], ["text"], [[{ type: "configuration_update" }]], [null, { type: "configuration_update" }, { type: "compaction_trigger" }]]) {
      const response = await run.post({ model: "alias", input });
      assert.equal(response.status, 400, `${JSON.stringify(input)} answered ${response.status}: ${response.body()}`);
    }
    for (const input of [{ type: "configuration_update" }, 7, null]) assert.ok([200, 400].includes((await run.post({ model: "alias", input })).status));
    assert.ok(run.providerCalls.every(call => Array.isArray(call.input) ? call.input.every(item => item !== null && typeof item === "object" && !Array.isArray(item)) : true));
  } finally { await run.close(); }
});

test("over capacity a compaction meets the same retryable 429 before its body is read, and its final refusal once a slot is free", async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = async function* (): AsyncGenerator<InferenceEvent> { await gate; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; };
  const run = await gateway(blocked, { maxConcurrent: 1 });
  const hold: Array<Promise<FakeResponse>> = [];
  try {
    // One running request and a full admission queue of 32.
    for (let index = 0; index < 33; index++) hold.push(run.post({ model: "alias", input: "queued" }));
    await new Promise<void>(resolve => { const poll = () => run.providerCalls.length === 1 ? setTimeout(resolve, 50) : setTimeout(poll, 10); poll(); });
    const compaction = [{ type: "message", role: "user", content: "hi" }, { type: "compaction_trigger" }];
    const late = await run.post({ model: "alias", input: compaction });
    assert.equal(late.status, 429, "an overload never buffers a body to look for a compaction");
    release(); await Promise.allSettled(hold);
    const after = await run.post({ model: "alias", input: compaction });
    assert.equal(after.status, 400, "with a free slot the compaction gets its final refusal");
    assert.deepEqual(JSON.parse(after.body()), { error: { code: "invalid_request", message: unsupportedCompactionMessage } });
    assert.equal(run.providerCalls.length, 33, "no provider ran for the compaction");
  } finally { release(); await Promise.allSettled(hold); await run.close(); }
});

test("a refused compaction writes the provider_failure line with translation_reason and no item content", async t => {
  const lines: string[] = []; t.mock.method(console, "error", (line: unknown) => { lines.push(String(line)); });
  const run = await gateway(succeed);
  try {
    await run.post({ model: "alias", input: [{ type: "compaction_trigger", encrypted_content: "private-compaction-state" }] });
    const record = lines.map(line => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).find(entry => entry.event === "provider_failure");
    assert.equal(record?.code, "invalid_request");
    assert.equal(record?.translation_reason, "unsupported_compaction");
    assert.ok(!lines.join("\n").includes("private-compaction-state"));
  } finally { await run.close(); }
});
