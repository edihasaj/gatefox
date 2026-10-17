import test from "node:test";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responsesInputToMessages, responsesToChatRequest, ResponsesTranslationError, translationItemType, type TranslationReason } from "../protocol/request.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import { gatewayToken, validateConfig, type ProviderConfig } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { summarizeTelemetry } from "../diagnostics.js";
import { createGatewayHandler } from "../server.js";
import type { InferenceEvent, ResponsesAgentMessageItem, ResponsesInputItem, ResponsesRequest } from "../protocol/types.js";

const encrypted = "gAAAAAB3fixture-opaque-state-not-text";
const agentMessage = (content: string | Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): ResponsesAgentMessageItem => ({
  type: "agent_message", id: "amsg_01A2B3", author: "codex", recipient: "worker", content,
  internal_chat_message_metadata_passthrough: { thread_id: "thr_01", turn_id: "turn_01" }, ...extra,
});
const request = (input: ResponsesInputItem[]): ResponsesRequest => ({ model: "upstream", input });

/** The socket is outside this test's interest; only the handler's failure metadata is. */
class FakeResponse extends EventEmitter {
  status = 0; headersSent = false; writableEnded = false; writableNeedDrain = false; destroyed = false; private readonly chunks: Buffer[] = [];
  setHeader(): void {} writeHead(status: number): this { this.status = status; this.headersSent = true; return this; }
  write(chunk: string): boolean { this.chunks.push(Buffer.from(chunk)); return true; }
  end(value?: string): void { if (value !== undefined) this.chunks.push(Buffer.from(value)); this.writableEnded = true; this.emit("finish"); }
  body(): string { return Buffer.concat(this.chunks).toString(); }
}

function rejection(run: () => unknown): [TranslationReason, string | undefined] {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  assert.ok(error instanceof ResponsesTranslationError, `expected a translation failure, got ${String(error)}`);
  return [error.reason, error.itemType];
}

test("an agent message replays as user text, verbatim and without its encrypted state", () => {
  const chat = responsesToChatRequest(request([
    agentMessage("delegate the release notes"),
    agentMessage([{ type: "input_text", text: "context from the parent" }, { type: "encrypted_content", encrypted_content: encrypted }, { type: "output_text", text: "trailing text" }]),
  ]));
  assert.deepEqual(chat.messages, [{ role: "user", content: "delegate the release notes" }, { role: "user", content: "context from the parent\ntrailing text" }],
    "no author or recipient labels, no prose, and encrypted parts contribute nothing");
  assert.ok(!JSON.stringify(chat).includes(encrypted), "the opaque token never reaches a translated request");
  assert.ok(!JSON.stringify(chat).includes("codex") && !JSON.stringify(chat).includes("worker"));
});

test("an agent message with no text produces no transcript entry", () => {
  for (const content of [[{ type: "encrypted_content", encrypted_content: encrypted }], []]) {
    assert.deepEqual(responsesInputToMessages([agentMessage(content)]), []);
  }
  assert.deepEqual(responsesToChatRequest(request([{ type: "message", role: "user", content: "prior turn" }, agentMessage([{ type: "encrypted_content", encrypted_content: encrypted }])])).messages,
    [{ role: "user", content: "prior turn" }], "an encrypted-only delegation stays out of the conversation");
});

test("unsupported agent-message content fails as unsupported_content before any provider runs", () => {
  for (const content of [[{ type: "input_image", image_url: "data:image/png;base64,AAAA" }], [{ type: "encrypted_content", encrypted_content: encrypted }, { type: "input_image", image_url: "https://private.invalid/x.png" }], [{ type: "refusal", refusal: "no" }], [{ type: "input_text" }], [{ type: "input_text", text: 42 }], 42]) {
    assert.deepEqual(rejection(() => responsesToChatRequest(request([agentMessage(content as never)]))), ["unsupported_content", undefined], JSON.stringify(content));
  }
  assert.deepEqual(rejection(() => responsesToChatRequest(request([agentMessage("ok"), agentMessage([{ type: "input_image", image_url: "data:image/png;base64,AAAA" }])]))), ["unsupported_content", undefined]);
});

test("a non-object agent-message part fails the request instead of being dropped", () => {
  for (const content of [["bare"], [null], [[{ type: "input_text", text: "x" }]], [{ type: "input_text", text: "context" }, "bare"], [{ type: "encrypted_content", encrypted_content: encrypted }, null]]) {
    assert.deepEqual(rejection(() => responsesToChatRequest(request([agentMessage(content as never)]))), ["invalid_shape", undefined], JSON.stringify(content));
  }
});

test("a nested function tool with a non-string description reports its own type", () => {
  assert.deepEqual(rejection(() => responsesToChatRequest({ model: "m", input: "hi", tools: [{ type: "function", function: { name: "a", description: 5 } }] } as unknown as ResponsesRequest)), ["unsupported_tool", "function"]);
});

test("reasons label every translation rejection the gateway can produce", () => {
  assert.deepEqual(rejection(() => responsesToChatRequest(request([{ type: "foo_bar" } as unknown as ResponsesInputItem]))), ["unsupported_input_item", "other"]);
  assert.deepEqual(rejection(() => responsesToChatRequest(request([{ type: "web_search_call", id: "ws_1" } as unknown as ResponsesInputItem]))), ["unsupported_input_item", "web_search_call"]);
  assert.deepEqual(rejection(() => responsesToChatRequest(request([{ type: "agent_message", content: "delegation" } as unknown as ResponsesInputItem, { type: "message", role: "captain", content: "x" } as unknown as ResponsesInputItem]))), ["unsupported_role", "message"]);
  assert.deepEqual(rejection(() => responsesToChatRequest({ model: "m", input: "hi", tools: [{ type: "web_search" }] } as unknown as ResponsesRequest)), ["unsupported_tool", "web_search"]);
  // A repeated declaration merges (last wins) instead of failing the request; see tool-merge.test.ts.
  assert.deepEqual(responsesToChatRequest({ model: "m", input: "hi", tools: [{ type: "function", name: "same" }, { type: "function", name: "same" }] } as unknown as ResponsesRequest).tools!.map(tool => tool.function.name), ["same"]);
  assert.deepEqual(rejection(() => responsesToChatRequest({ model: "m", input: "hi", tools: "nope" } as unknown as ResponsesRequest)), ["invalid_shape", undefined]);
  assert.deepEqual(rejection(() => responsesToChatRequest({ model: "m", input: "hi", tool_choice: { type: "function", name: "missing" } } as unknown as ResponsesRequest)), ["unsupported_tool_choice", undefined]);
  assert.deepEqual(rejection(() => responsesToChatRequest({ model: "m", input: "hi", instructions: { text: "nope" } } as unknown as ResponsesRequest)), ["invalid_instructions", undefined]);
  assert.deepEqual(rejection(() => responsesToChatRequest(request([{ type: "message", role: "user", content: [{ type: "input_image", image_url: "https://private.invalid/x.png" }] }]))), ["invalid_image", undefined]);
  assert.deepEqual(translationItemType("apply_patch"), "apply_patch"); assert.deepEqual(translationItemType(undefined), "other"); assert.deepEqual(translationItemType("Bearer sk-fixture"), "other");
});

for (const type of ["codex-subscription", "responses-api"]) test(`the ${type} route sends an agent message as one user text message`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-agent-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const bodies: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(JSON.parse(String(options.body)) as Record<string, unknown>);
    const event = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`;
    return new Response(event({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const config = type === "codex-subscription" ? { id: "codex", type, credentialFile, models: { "codex/upstream": "upstream" } } : { id: "api", type, baseUrl: "https://upstream.invalid/v1", apiKeyEnv: "AGENT_TEST_KEY", models: { "api/upstream": "upstream" } };
    process.env.AGENT_TEST_KEY = "fixture-only"; t.after(() => { delete process.env.AGENT_TEST_KEY; });
    const provider = new ResponsesAPI(config as unknown as ProviderConfig);
    const reasoning: ResponsesInputItem = { type: "reasoning", summary: [{ type: "summary_text", text: "planning" }], encrypted_content: "opaque" };
    const call: ResponsesInputItem = { type: "function_call", call_id: "call_1", name: "other_tool", arguments: "{}" };
    const user: ResponsesInputItem = { type: "message", role: "user", content: "hello" };
    const history: ResponsesInputItem[] = [reasoning, agentMessage([{ type: "input_text", text: "review the diff" }, { type: "encrypted_content", encrypted_content: encrypted }]), agentMessage([{ type: "encrypted_content", encrypted_content: encrypted }]), call, user];
    const events: InferenceEvent[] = [];
    for await (const event of provider.infer(request(history), new AbortController().signal)) events.push(event);
    assert.equal(events.at(-1)?.type, "done");
    const sent = bodies[0].input as Array<Record<string, unknown>>;
    assert.ok(!sent.some(entry => entry.type === "agent_message"));
    assert.ok(!JSON.stringify(bodies[0]).includes(encrypted));
    assert.equal(sent.length, 4, "the encrypted-only message produces no item");
    assert.deepEqual(sent[1], { type: "message", role: "user", content: [{ type: "input_text", text: "review the diff" }] });
    assert.deepEqual([sent[0], sent[2], sent[3]], [reasoning, call, user]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a rejected request records its reason in telemetry and diagnostics, never the request text", async t => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-agent-telemetry-"));
  configureTelemetry(directory, "gateway");
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] });
  const handler = await createGatewayHandler(config, () => ({ async *infer() { assert.fail("a rejected request must never reach a provider"); } }));
  const authorization = `Bearer ${await gatewayToken(directory)}`;
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  const post = async (value: unknown) => {
    const res = new FakeResponse();
    const finished = new Promise<void>(resolve => res.once("finish", () => resolve()));
    handler.handle({ method: "POST", url: "/v1/responses", headers: { authorization, "content-type": "application/json" },
      [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(value)); } } as unknown as IncomingMessage, res as unknown as ServerResponse);
    await finished; await flushTelemetry(); return res;
  };
  try {
    const rejected = await post({ model: "alias", input: [{ type: "agent_message", author: "private-author", content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] });
    assert.equal(rejected.status, 400);
    assert.deepEqual(JSON.parse(rejected.body()), { error: { code: "invalid_request", message: "Responses request contains invalid or unsupported data" } });
    const unknown = await post({ model: "alias", input: [{ type: "mystery_item", author: "private-author", content: "private conversation text" }] });
    assert.equal(unknown.status, 400);
    const accepted = await post({ model: "alias", input: [{ type: "agent_message", author: "private-author", content: [{ type: "encrypted_content", encrypted_content: encrypted }] }] });
    assert.equal(accepted.status, 502, "an accepted agent message reaches the provider, which the fixture refuses");
    const events = (await readTelemetry(directory, Date.now() - 60000)).filter(event => event.event === "request_failed");
    assert.deepEqual(events.map(event => [event.code, event.reason, event.itemType]), [["invalid_request", "unsupported_content", undefined], ["invalid_request", "unsupported_input_item", "other"], ["provider_failed", undefined, undefined]]);
    const summary = summarizeTelemetry(events, new Date(Date.now() - 60000)) as { requests: Record<string, Record<string, number>>; recentProblems: Array<Record<string, unknown>> };
    const { cacheHit, firstEventMsP50, firstEventMsP95, ...counts } = summary.requests.alias;
    assert.deepEqual(counts, { "failed:invalid_request:unsupported_content": 1, "failed:invalid_request:unsupported_input_item": 1, "failed:provider_failed": 1 }, "one 400 class per rejected shape, kept apart by reason");
    assert.equal(summary.recentProblems.length, 3);
    assert.ok(!JSON.stringify([events, summary, lines]).includes("private conversation text") && !JSON.stringify([events, summary, lines]).includes("private-author"));
    assert.deepEqual(lines.map(line => { const record = JSON.parse(line) as Record<string, unknown>; return [record.code, record.reason, record.itemType]; }),
      [["invalid_request", "unsupported_content", undefined], ["invalid_request", "unsupported_input_item", "other"], ["provider_failed", undefined, undefined]]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
