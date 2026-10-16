import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken, validateConfig, type ProviderKind } from "../config.js";
import { startGateway } from "../server.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import type { ResponsesRequest, WireEvent } from "../protocol/types.js";

const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const input = { model: "alias", max_tokens: 128, messages: [{ role: "user", content: "hello" }] };
async function fixture(provider: Provider, kind: ProviderKind = "responses-api", options = {}) {
  const state = await mkdtemp(join(tmpdir(), "gateway-messages-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{
    id: "test", type: kind, models: { alias: "upstream" },
    ...(["responses-api", "anthropic-api", "chat-completions-api"].includes(kind) ? { baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_UNUSED_KEY" } : {}),
    ...(kind === "codex-subscription" ? { credentialFile: join(state, "unused") } : {}),
  }] });
  const server = await startGateway(config, () => provider, undefined, { onFailure() {}, ...options });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = await gatewayToken(state);
  const headers = { "Content-Type": "application/json", "x-api-key": token };
  return { server, base, token, headers,
    post: (body: unknown = input, path = "/v1/messages?beta=true", override: Record<string, string> = headers) => fetch(base + path, { method: "POST", headers: override, body: JSON.stringify(body) }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
const textProvider: Provider = { async *infer() { yield { type: "text", text: "hello" }; yield { type: "done", usage }; } };
const collect = async (response: Response): Promise<WireEvent[]> => {
  const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event); return events;
};

test("Messages authenticates x-api-key and bearer, uses native errors, and rejects conflicting credentials", async () => {
  const gateway = await fixture(textProvider);
  try {
    const unauth = await gateway.post(input, "/v1/messages", { "Content-Type": "application/json", "x-api-key": "wrong" });
    assert.equal(unauth.status, 401);
    const error = await unauth.json() as any;
    assert.equal(error.error.type, "authentication_error");
    assert.equal(error.request_id, unauth.headers.get("request-id"));
    assert.ok(error.request_id);
    const conflict = await gateway.post(input, "/v1/messages", { ...gateway.headers, Authorization: "Bearer wrong" });
    assert.equal(conflict.status, 401);
    const reverseConflict = await gateway.post(input, "/v1/messages", { ...gateway.headers, "x-api-key": "wrong", Authorization: `Bearer ${gateway.token}` });
    assert.equal(reverseConflict.status, 401);
    const bothValid = await gateway.post(input, "/v1/messages", { ...gateway.headers, Authorization: `Bearer ${gateway.token}` });
    assert.equal(bothValid.status, 200);
    assert.equal((await gateway.post()).status, 200);
    const bearer = await fetch(gateway.base + "/v1/messages", { method: "POST", headers: { Authorization: `Bearer ${gateway.token}` }, body: JSON.stringify(input) });
    assert.equal(bearer.status, 200);
    const cross = await gateway.post(input, "/v1/messages", { ...gateway.headers, Origin: "https://example.com" });
    assert.equal(cross.status, 403);
    assert.equal((await cross.json() as any).type, "error");
  } finally { await gateway.close(); }
});

test("Messages validates before inference and count_tokens explicitly supports client estimation fallback", async () => {
  let calls = 0;
  const gateway = await fixture({ async *infer() { calls++; yield { type: "done", usage }; } });
  try {
    const invalid = await gateway.post({ ...input, messages: [{ role: "user", content: [{ type: "document", source: {} }] }] });
    assert.equal(invalid.status, 400); assert.equal((await invalid.json() as any).error.type, "invalid_request_error");
    assert.equal((await gateway.post({ ...input, model: "missing" })).status, 404);
    const count = await gateway.post({ model: "alias", messages: input.messages }, "/v1/messages/count_tokens?beta=true");
    assert.equal(count.status, 501); assert.equal((await count.json() as any).type, "error");
    const malformed = await fetch(gateway.base + "/v1/messages", { method: "POST", headers: gateway.headers, body: "{" });
    assert.equal(malformed.status, 400); assert.equal((await malformed.json() as any).error.type, "invalid_request_error");
    assert.equal(calls, 0);
  } finally { await gateway.close(); }
});

test("Messages JSON preserves model alias, usage, instructions and generation cap", async () => {
  let seen: ResponsesRequest | undefined;
  const gateway = await fixture({ async *infer(request) { seen = request; yield { type: "text", text: "hello" }; yield { type: "done", usage }; } });
  try {
    const response = await gateway.post({ ...input, system: [{ type: "text", text: "Keep caller instructions" }] });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.type, "message"); assert.equal(body.model, "alias"); assert.equal(body.role, "assistant");
    assert.equal(body.content[0].text, "hello"); assert.equal(body.stop_reason, "end_turn");
    assert.equal(body.usage.input_tokens, 10); assert.equal(body.usage.output_tokens, 2);
    assert.equal(seen!.model, "upstream"); assert.equal(seen!.max_output_tokens, 128);
    assert.match(JSON.stringify(seen), /Keep caller instructions/);
  } finally { await gateway.close(); }
});

test("Messages SSE emits native events and replays tool calls and results to the same route", async () => {
  const requests: ResponsesRequest[] = [];
  const gateway = await fixture({ async *infer(request) {
    requests.push(request);
    if (requests.length === 1) {
      yield { type: "text", text: "Checking" };
      yield { type: "tool", call: { type: "function", id: "call_123", function: { name: "lookup", arguments: '{"value":7}' } } };
    } else { yield { type: "text", text: "Result is 14" }; }
    yield { type: "done", usage };
  } });
  try {
    const tools = [{ name: "lookup", input_schema: { type: "object", properties: { value: { type: "integer" } } } }];
    const response = await gateway.post({ ...input, tools, stream: true });
    assert.equal(response.status, 200);
    const events = await collect(response);
    assert.equal(events[0].type, "message_start"); assert.equal(events.at(-1)!.type, "message_stop");
    assert.equal((events.at(-2)!.delta as any).stop_reason, "tool_use");
    const blocks = events.filter(event => event.type === "content_block_start").map(event => event.content_block as any);
    const call = blocks.find(block => block.type === "tool_use");
    assert.equal(call.id, "call_123"); assert.equal(call.name, "lookup");
    const second = await gateway.post({ ...input, tools, messages: [...input.messages,
      { role: "assistant", content: [{ type: "tool_use", id: call.id, name: call.name, input: { value: 7 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "14" }] },
    ] });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as any).content[0].text, "Result is 14");
    assert.equal(requests.length, 2);
    assert.ok((requests[1].input as any[]).some(item => item.type === "function_call_output" && item.call_id === "call_123" && item.output === "14"));
  } finally { await gateway.close(); }
});

test("Messages failures produce SSE error without success and preserve nonstream HTTP status", async () => {
  let failure = new ProviderError("usage_limit", "Limit reached", 429);
  const gateway = await fixture({ async *infer() { yield { type: "text", text: "partial" }; throw failure; } });
  try {
    const events = await collect(await gateway.post({ ...input, stream: true }));
    assert.equal(events.at(-1)!.type, "error"); assert.equal((events.at(-1)!.error as any).type, "rate_limit_error");
    assert.equal(events.some(event => event.type === "message_stop"), false);
    assert.equal((await gateway.post()).status, 429);
    failure = new ProviderError("upstream_error", "Provider permission refused", 403);
    const permission = await collect(await gateway.post({ ...input, stream: true }));
    assert.equal((permission.at(-1)!.error as any).type, "permission_error");
    assert.ok(permission.at(-1)!.request_id);
  } finally { await gateway.close(); }
});

test("Messages quiet streams use ping and disconnect cancels upstream", async () => {
  let cancelled = false;
  const gateway = await fixture({ async *infer(_request, signal) {
    try { await delay(1000, undefined, { signal }); yield { type: "done", usage }; }
    finally { cancelled = signal.aborted; }
  } }, "responses-api", { heartbeatMs: 5 });
  try {
    const response = await gateway.post({ ...input, stream: true });
    const reader = response.body!.getReader(); let frames = "";
    while (!frames.includes("event: ping")) { const chunk = await reader.read(); frames += new TextDecoder().decode(chunk.value); }
    await reader.cancel();
    for (let i = 0; i < 50 && !cancelled; i++) await delay(10);
    assert.equal(cancelled, true);
  } finally { await gateway.close(); }
});

test("Messages subscription limits are explicitly provider-managed and other unsupported constraints fail", async () => {
  let seen: ResponsesRequest | undefined;
  const gateway = await fixture({ async *infer(request) { seen = request; yield { type: "text", text: "ok" }; yield { type: "done", usage }; } }, "codex-subscription");
  try {
    const response = await gateway.post();
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-gateway-output-limit"), "provider-managed");
    assert.equal(seen!.max_output_tokens, undefined);
    const rejected = await gateway.post({ ...input, stop_sequences: ["end"] });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json() as any).error.type, "invalid_request_error");
  } finally { await gateway.close(); }
});
