import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, gatewayToken, type ProviderConfig } from "../config.js";
import { createGatewayHandler, startGateway } from "../server.js";
import { stripOpenAIInternal } from "../protocol/openai-internal.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { ResponsesAPI } from "../providers/responses-api.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";

const passthrough = { thread_id: "thr_01", turn_id: "turn_01" };
const encryptedArgs = "gAAAAAB3fixture-encrypted-args";
const attribution = { server: "mcp.example", connection_id: "conn_01" };
const cleanRequest = (): ResponsesRequest => ({
  model: "alias",
  input: [
    { type: "message", role: "user", content: "hello" },
    { type: "function_call", call_id: "call_1", name: "search", arguments: "{\"q\":\"x\"}" },
    { type: "reasoning", summary: [{ type: "summary_text", text: "planning" }], encrypted_content: "opaque" } as never,
    { type: "function_call_output", call_id: "call_1", output: "done" },
  ],
  client_metadata: { "x-codex-turn-metadata": "{\"turn_id\":\"turn-1\"}", session_id: "sess-1" },
  prompt_cache_key: "thread-1",
});
const dirtyRequest = (): ResponsesRequest => {
  const request = JSON.parse(JSON.stringify(cleanRequest())) as ResponsesRequest;
  (request.input as Array<Record<string, unknown>>).forEach((item, index) => { item.internal_chat_message_metadata_passthrough = passthrough; if (index === 1) item.encrypted_function_args = encryptedArgs; });
  Object.assign(request.client_metadata as Record<string, unknown>, { mcp_attribution: attribution });
  return request;
};
const internalFields = (value: unknown): string[] => {
  const text = JSON.stringify(value);
  return ["internal_chat_message_metadata_passthrough", "encrypted_function_args", JSON.stringify(passthrough), JSON.stringify(attribution)]
    .filter(needle => text.includes(needle));
};

test("the strip helper returns the same object when nothing is removed", () => {
  const clean = cleanRequest();
  const prepared = stripOpenAIInternal(clean);
  assert.equal(prepared.request, clean, "no copy, no reordering: the route forwards exactly what the caller sent");
  assert.equal(prepared.droppedControlItems, 0);
  assert.equal(prepared.unsupportedCompaction, false);
  assert.equal(stripOpenAIInternal({ model: "m", input: "text" }).request.input, "text");
});

test("the strip helper removes only the internal fields and keeps key order", () => {
  const prepared = stripOpenAIInternal(dirtyRequest());
  assert.deepEqual(internalFields(prepared.request), []);
  assert.equal(JSON.stringify(prepared.request), JSON.stringify(cleanRequest()), "removing the fields yields the byte order of a request that never carried them");
  const metadata = prepared.request.client_metadata as Record<string, unknown>;
  assert.deepEqual(Object.keys(metadata), ["x-codex-turn-metadata", "session_id"], "other client_metadata keys are kept");
  const call = (prepared.request.input as Array<Record<string, unknown>>)[1];
  assert.equal(call.arguments, "{\"q\":\"x\"}", "the plaintext arguments the caller owns stay intact");
  assert.equal(call.encrypted_function_args, undefined);
  const reasoning = (prepared.request.input as Array<Record<string, unknown>>)[2];
  assert.equal(reasoning.encrypted_content, "opaque", "reasoning replay state is not an internal transport field");
});

class FakeResponse extends EventEmitter {
  status = 0; headersSent = false; writableEnded = false; destroyed = false; private readonly chunks: Buffer[] = [];
  setHeader(): void {} writeHead(status: number): this { this.status = status; this.headersSent = true; return this; }
  write(chunk: string): boolean { this.chunks.push(Buffer.from(chunk)); return true; }
  end(value?: string): void { if (value !== undefined) this.chunks.push(Buffer.from(value)); this.writableEnded = true; this.emit("finish"); }
  body(): string { return Buffer.concat(this.chunks).toString(); }
}

test("Claude, Responses and Copilot routes all receive the request without the internal fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-strip-"));
  const seen = new Map<string, ResponsesRequest>();
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [
    { id: "cl", type: "claude-subscription", models: { claude: "upstream" } },
    { id: "cp", type: "copilot-subscription", models: { copilot: "upstream" } },
    { id: "rs", type: "responses-api", baseUrl: "https://upstream.invalid/v1", apiKeyEnv: "STRIP_TEST_KEY", models: { responses: "upstream" } },
  ] });
  const gateway = await startGateway(config, provider => ({ async *infer(request): AsyncGenerator<InferenceEvent> {
    seen.set(provider.id, request);
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } }), undefined, { copilotTempBase: directory });
  try {
    const token = await gatewayToken(directory);
    const url = `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`;
    for (const alias of ["claude", "copilot", "responses"]) {
      const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ ...dirtyRequest(), model: alias }) });
      assert.equal(response.status, 200, alias);
    }
    assert.deepEqual([...seen.keys()].sort(), ["cl", "cp", "rs"]);
    for (const [id, request] of seen) assert.deepEqual(internalFields(request), [], `${id} saw internal fields`);
    for (const request of seen.values()) {
      const metadata = request.client_metadata as Record<string, unknown>;
      assert.equal(metadata.session_id, "sess-1"); assert.equal(metadata["x-codex-turn-metadata"], "{\"turn_id\":\"turn-1\"}");
    }
  } finally { await new Promise<void>(resolve => { gateway.closeAllConnections(); gateway.close(() => resolve()); }); await rm(directory, { recursive: true, force: true }); }
});

// The Responses provider serializes what it forwards; a request that carried only removed fields must reach upstream byte-identical.
test("a Responses upstream receives byte-identical bodies with and without the internal fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-strip-bytes-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    bodies.push(String(options.body));
    const event = (data: Record<string, unknown>) => `data: ${JSON.stringify(data)}\n\n`;
    return new Response(event({ type: "response.completed", response: { id: "r", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  try {
    const provider = new ResponsesAPI({ id: "api", type: "responses-api", baseUrl: "https://upstream.invalid/v1", apiKeyEnv: "STRIP_BYTES_KEY", models: { "api/upstream": "upstream" } } as unknown as ProviderConfig);
    process.env.STRIP_BYTES_KEY = "fixture-only"; t.after(() => { delete process.env.STRIP_BYTES_KEY; });
    const send = async (request: ResponsesRequest) => {
      const handler = await createGatewayHandler(validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "api", type: "responses-api", baseUrl: "https://upstream.invalid/v1", apiKeyEnv: "STRIP_BYTES_KEY", models: { alias: "upstream" } }] }), () => provider);
      const res = new FakeResponse();
      const finished = new Promise<void>(resolve => res.once("finish", () => resolve()));
      handler.handle({ method: "POST", url: "/v1/responses", headers: { authorization: `Bearer ${await gatewayToken(directory)}`, "content-type": "application/json" },
        [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(request)); } } as unknown as IncomingMessage, res as unknown as ServerResponse);
      await finished; assert.equal(res.status, 200, res.body());
    };
    await send({ ...cleanRequest(), model: "alias" });
    await send({ ...dirtyRequest(), model: "alias" });
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1], bodies[0], "the stripped request reaches upstream exactly as the clean one");
    assert.ok(!bodies[0].includes("mcp_attribution") && !bodies[0].includes("encrypted_function_args"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a chat-completions upstream receives the request without the internal fields", async () => {
  const bodies: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    bodies.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    emit({ model: "qwen", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] });
    emit({ model: "qwen", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    emit({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const directory = await mkdtemp(join(tmpdir(), "gateway-strip-chat-")); process.env.GATEWAY_STRIP_CHAT_KEY = "fixture-key";
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [{ id: "local", type: "chat-completions-api",
    baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: "GATEWAY_STRIP_CHAT_KEY", models: { "local/qwen": "qwen" } }] });
  const gateway = await startGateway(config);
  try {
    const token = await gatewayToken(directory);
    const dirty = { ...dirtyRequest(), model: "local/qwen", tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }] } as ResponsesRequest;
    dirty.input = (dirty.input as Array<Record<string, unknown>>).filter(item => item.type !== "reasoning") as ResponsesRequest["input"];
    (dirty.input as Array<Record<string, unknown>>).splice(1, 0, { type: "configuration_update", model: "private-config-value" });
    const response = await fetch(`http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(dirty) });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(bodies.length, 1);
    assert.deepEqual(internalFields(bodies[0]), [], "the chat upstream saw internal fields");
    assert.ok(!bodies[0].includes("private-config-value") && !bodies[0].includes("configuration_update"), "control items never reach the chat upstream");
    assert.ok(bodies[0].includes("hello") && bodies[0].includes("call_1"), "the conversation itself is intact");
  } finally { await new Promise<void>(resolve => { gateway.closeAllConnections(); gateway.close(() => resolve()); }); upstream.close(); delete process.env.GATEWAY_STRIP_CHAT_KEY; await rm(directory, { recursive: true, force: true }); }
});

test("malformed client_metadata and non-object items pass through the strip helper untouched", () => {
  for (const client_metadata of [null, [], [{ mcp_attribution: attribution }], "text", 7, true]) {
    const request = { model: "m", input: [{ type: "message", role: "user", content: "x" }], client_metadata } as unknown as ResponsesRequest;
    const prepared = stripOpenAIInternal(request);
    assert.equal(prepared.request, request, `client_metadata ${JSON.stringify(client_metadata)} is neither read as a map nor copied`);
  }
  const odd = [null, 7, "text", true, [{ internal_chat_message_metadata_passthrough: passthrough }], { type: 7 }, { type: ["configuration_update"] }];
  const request = { model: "m", input: odd } as unknown as ResponsesRequest;
  const prepared = stripOpenAIInternal(request);
  assert.equal(prepared.request, request, "items that are not objects are left for translation to reject");
  assert.equal(prepared.droppedControlItems, 0); assert.equal(prepared.unsupportedCompaction, false);
  // A real internal item between odd ones is still cleaned, and the odd ones keep their place.
  const mixed = stripOpenAIInternal({ model: "m", input: [null, { type: "message", role: "user", content: "x", internal_chat_message_metadata_passthrough: passthrough }, 7, { type: "configuration_update" }] } as unknown as ResponsesRequest);
  assert.deepEqual(mixed.request.input, [null, { type: "message", role: "user", content: "x" }, 7]);
  assert.equal(mixed.droppedControlItems, 1);
  for (const input of [null, 7, "text", { type: "compaction_trigger" }]) {
    const raw = { model: "m", input } as unknown as ResponsesRequest;
    assert.equal(stripOpenAIInternal(raw).request, raw);
  }
});

test("Codex app context outputs without a call ID become user context every provider can translate", () => {
  // The exact shape a Codex 26.1103 app sent on 10 November 2026 (internal metadata trimmed).
  const page = { type: "function_call_output", id: "fco_1", name: "codex_apps_open_page", namespace: "agent", output: "{\"page_id\":null}",
    internal_chat_message_metadata_passthrough: { turn_id: "t" } };
  const request = { model: "claude-secondary/claude-sonnet-5-5", input: [{ type: "message", role: "user", content: "hi" }, page] } as unknown as ResponsesRequest;
  const prepared = stripOpenAIInternal(request);
  assert.equal(prepared.contextOutputs, 1);
  assert.deepEqual((prepared.request.input as unknown[])[1], { type: "message", role: "user",
    content: [{ type: "input_text", text: "<external_codex_apps_open_page>{\"page_id\":null}</external_codex_apps_open_page>" }] });
  assert.doesNotThrow(() => responsesToChatRequest(prepared.request));
  assert.throws(() => responsesToChatRequest(request), "the raw item still has no call ID to pair");
  const paired = { model: "m", input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{}" }, { type: "function_call_output", call_id: "c", output: "ok" }] } as unknown as ResponsesRequest;
  assert.equal(stripOpenAIInternal(paired).request, paired, "ordinary tool outputs are untouched");
});
