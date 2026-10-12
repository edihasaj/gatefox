import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile, chmod, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateConfig, gatewayToken, validBearer } from "../config.js";
import { startGateway } from "../server.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import { readEvents } from "../protocol/sse.js";
import { ResponsesWriter } from "../protocol/responses.js";
import { nativeClaudeCalls, nativeClaudeReasoning } from "../providers/claude-calls.js";
import { claudeNativeToolName } from "../providers/claude-tool-names.js";
import { responsesToChatRequest } from "../protocol/request.js";
import { remoteCodexSettings, readClientToken, endpointURL } from "../codex-config.js";
import { reasoningScope, restoreReasoning, wrapReasoning } from "../protocol/reasoning-state.js";
import type { WireEvent, InferenceEvent } from "../protocol/types.js";

async function setup(factory: () => Provider, maxConcurrent = 4) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-test-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, maxConcurrent,
    providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }],
  });
  const server = await startGateway(config, factory);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = await gatewayToken(directory);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return { server, url, headers, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("client token creation is atomic under concurrent starts and owner-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-token-"));
  const tokens = await Promise.all(Array.from({ length: 12 }, () => gatewayToken(directory)));
  assert.equal(new Set(tokens).size, 1);
  assert.equal((await stat(join(directory, "client-token"))).mode & 0o777, 0o600);
  assert.equal(validBearer(`Bearer ${tokens[0]}`, tokens[0]), true);
  assert.equal(validBearer("Bearer wrong", tokens[0]), false);
});

test("routing authenticates first, rejects malformed requests, and never silently switches providers", async () => {
  let calls = 0;
  const gateway = await setup(() => ({ async *infer(request) { calls++; assert.equal(request.model, "actual"); yield { type: "text", text: "OK" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; } }));
  try {
    assert.equal((await fetch(`${gateway.url}/v1/models`)).status, 401);
    assert.equal((await fetch(`${gateway.url}/v1/models`, { headers: { ...gateway.headers, Origin: "https://example.test" } })).status, 403);
    const post = (value: unknown) => fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers, body: JSON.stringify(value) });
    assert.equal((await post({ model: "missing", input: "Hi" })).status, 404);
    assert.equal((await post({ model: "alias", input: "Hi", tools: [{ type: "web_search" }] })).status, 400);
    assert.equal((await post({ model: "alias", input: "Hi", tool_choice: "invalid" })).status, 400);
    assert.equal(calls, 0);
    const response = await post({ model: "alias", input: "Hi" });
    const body = await response.json() as { model: string; output_text: string; status: string };
    assert.equal(body.model, "alias"); assert.equal(body.output_text, "OK"); assert.equal(body.status, "completed"); assert.equal(calls, 1);
  } finally { await gateway.close(); }
});

test("stream text matches the completed response and failures never produce completed events", async () => {
  let fail = false;
  const gateway = await setup(() => ({ async *infer() { yield { type: "text", text: "Hello " }; yield { type: "text", text: "world" }; if (fail) throw new ProviderError("usage_limit", "Limit reached", 429); yield { type: "done", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } }; } }));
  try {
    const collect = async () => {
      const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers, body: JSON.stringify({ model: "alias", input: "Hi", stream: true }) });
      const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event); return events;
    };
    const events = await collect();
    const text = events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join("");
    assert.equal((events.at(-1)!.response as { output_text: string }).output_text, text);
    assert.equal(events.at(-1)!.type, "response.completed");
    fail = true; const failures = await collect();
    assert.equal(failures.at(-1)!.type, "response.failed"); assert.equal(failures.some(e => e.type === "response.completed"), false);
  } finally { await gateway.close(); }
});

test("subscription failures before first output terminate SSE and retain nonstream HTTP status", async () => {
  const gateway = await setup(() => ({ async *infer() { throw new ProviderError("authentication", "Login needed", 401); } }));
  try {
    const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers, body: JSON.stringify({ model: "alias", input: "Hi", stream: true }) });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const events: WireEvent[] = []; for await (const event of readEvents(response.body!)) events.push(event);
    assert.equal(events.at(-1)!.type, "response.failed");
    assert.equal(((events.at(-1)!.response as Record<string, unknown>).error as { code: string }).code, "authentication");
    assert.equal(events.some(event => event.type === "response.completed"), false);
    const plain = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers, body: JSON.stringify({ model: "alias", input: "Hi" }) });
    assert.equal(plain.status, 401); assert.equal((await plain.json() as { error: { code: string } }).error.code, "authentication");
  } finally { await gateway.close(); }
});

test("remote setup imports the protected public catalog without copying provider credentials", async () => {
  const gateway = await setup(() => ({ async *infer() { throw new Error("No inference expected"); } }));
  const directory = await mkdtemp(join(tmpdir(), "gateway-remote-"));
  const token = await gatewayToken(directory);
  const tokenFile = join(directory, "client-token"); const catalogPath = join(directory, "catalog.json");
  try {
    await assert.rejects(remoteCodexSettings("alias", `${gateway.url}/v1`, tokenFile, catalogPath), /HTTP 401/);
    const remoteToken = gateway.headers.Authorization.slice(7);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tokenFile, remoteToken, { mode: 0o600 });
    const settings = await remoteCodexSettings("alias", `${gateway.url}/v1`, tokenFile, catalogPath);
    const snapshot = JSON.parse(await readFile(catalogPath, "utf8")) as { models: Array<{ slug: string }> };
    assert.equal(snapshot.models[0].slug, "alias");
    assert.ok(settings.includes('"--file"')); assert.ok(!settings.includes(token)); assert.ok(!settings.includes(remoteToken));
    assert.equal((await stat(catalogPath)).mode & 0o777, 0o600);
    await assert.rejects(remoteCodexSettings("missing", `${gateway.url}/v1`, tokenFile, catalogPath), /Selected model/);
    await assert.rejects(remoteCodexSettings("alias", `${gateway.url}/v1`, tokenFile, tokenFile), /overwrite/);
    if (process.platform !== "win32") { await chmod(tokenFile, 0o644); await assert.rejects(readClientToken(tokenFile), /private file/); }
    assert.throws(() => endpointURL("http://example.com/v1"));
    assert.throws(() => endpointURL("https://user:secret@example.com/v1"));
  } finally { await gateway.close(); }
});

test("disconnect releases capacity, aborts inference, and permits recovery", async () => {
  let aborted = false; let first = true;
  const gateway = await setup(() => ({ async *infer(_request, signal): AsyncGenerator<InferenceEvent> {
    if (!first) { yield { type: "text", text: "recovered" }; yield { type: "done", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }; return; }
    first = false; yield { type: "text", text: "started" };
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
  } }), 1);
  try {
    const control = new AbortController();
    const response = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers, signal: control.signal, body: JSON.stringify({ model: "alias", input: "Hi", stream: true }) });
    try { for await (const event of readEvents(response.body!)) if (event.type === "response.output_text.delta") { control.abort(); break; } }
    catch (error) { if ((error as Error).name !== "AbortError") throw error; }
    for (let attempt = 0; attempt < 20 && !aborted; attempt++) await delay(10);
    assert.equal(aborted, true);
    const recovered = await fetch(`${gateway.url}/v1/responses`, { method: "POST", headers: gateway.headers, body: JSON.stringify({ model: "alias", input: "Hi" }) });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json() as { output_text: string }).output_text, "recovered");
  } finally { await gateway.close(); }
});

test("SSE parsing handles split UTF-8, CRLF, comments, and rejects truncated frames", async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"type":"response.output_text.delta","delta":"🌲"}\r\n\r\n');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const events: WireEvent[] = []; for await (const event of readEvents(chunks())) events.push(event);
  assert.equal(events[0].delta, "🌲");
  async function* bad() { yield new TextEncoder().encode('data: {"type":"response.completed"}'); }
  await assert.rejects(async () => { for await (const _ of readEvents(bad())) {} }, /incomplete/);
});

test("tool frames never leak as text and tool-only responses have no empty message", () => {
  const request = responsesToChatRequest({ model: "x", input: "Read", tools: [{ type: "function", name: "read_file" }] });
  const calls = nativeClaudeCalls([{ id: "toolu_read", name: claudeNativeToolName(request.tools![0]), input: {} }], request.tools!); const events: WireEvent[] = [];
  const writer = new ResponsesWriter("x", event => events.push(event)); writer.begin(); writer.accept({ type: "tool", call: calls[0] }); writer.accept({ type: "done", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
  assert.equal((writer.result().output as Array<{ type: string }>)[0].type, "function_call");
  assert.equal(events.some(e => e.type === "response.output_text.delta"), false);
});

test("reasoning streams separately from text and preserves opaque replay state", () => {
  const events: WireEvent[] = [];
  const writer = new ResponsesWriter("x", event => events.push(event));
  writer.begin();
  writer.accept({ type: "reasoning-state", item: { type: "reasoning", id: "rs_test", summary: [] } });
  writer.accept({ type: "reasoning", id: "rs_test", text: "Checking ", summaryIndex: 0 });
  writer.accept({ type: "reasoning", id: "rs_test", text: "the arithmetic.", summaryIndex: 0 });
  writer.accept({ type: "reasoning-state", item: { type: "reasoning", id: "rs_test", encrypted_content: "opaque-test", summary: [] } });
  writer.accept({ type: "text", text: "42" });
  writer.accept({ type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  const reasoning = (writer.result().output as Array<Record<string, unknown>>)[0];
  assert.equal(reasoning.id, "rs_test"); assert.equal(reasoning.encrypted_content, "opaque-test");
  assert.deepEqual(reasoning.summary, [{ type: "summary_text", text: "Checking the arithmetic." }]);
  assert.equal(events.filter(event => event.type === "response.reasoning_summary_text.delta").map(event => event.delta).join(""), "Checking the arithmetic.");
  assert.equal(writer.result().output_text, "42");
  assert.equal((events[0].response as { output: unknown[] }).output.length, 0);
});

test("Claude token-only thinking deltas create reasoning progress without invented text", () => {
  const event = nativeClaudeReasoning({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "", estimated_tokens: 64 } });
  assert.deepEqual(event, { type: "reasoning", text: "", estimatedTokens: 64 });
  const events: WireEvent[] = []; const writer = new ResponsesWriter("x", value => events.push(value));
  writer.begin(); writer.accept(event!);
  assert.equal((events[1].item as { type: string }).type, "reasoning");
  assert.equal(events.at(-1)!.delta, ""); assert.equal(events.at(-1)!.estimated_tokens, 64);
  assert.equal(writer.result().output_text, "");
  assert.equal(nativeClaudeReasoning({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "" } }), undefined);
});

test("opaque reasoning replays only to its source account and foreign summaries remain semantic history", () => {
  const first = reasoningScope({ id: "first", type: "codex-subscription", credentialFile: "/private/first.json", models: { a: "m" } });
  const second = reasoningScope({ id: "second", type: "codex-subscription", credentialFile: "/private/second.json", models: { a: "m" } });
  const original = { type: "reasoning" as const, id: "rs_native", encrypted_content: "opaque-upstream", summary: [{ type: "summary_text" as const, text: "A short summary" }] };
  const wrapped = wrapReasoning(original, first) as typeof original;
  assert.notEqual(wrapped.encrypted_content, original.encrypted_content);
  const request = { model: "m", input: [wrapped, { type: "reasoning" as const, summary: [] }] };
  assert.deepEqual(restoreReasoning(request, first).input, [original]);
  assert.deepEqual(restoreReasoning(request, second).input, [{ type: "message", role: "assistant", content: "A short summary" }]);
  assert.equal(original.encrypted_content, "opaque-upstream");
  assert.throws(() => restoreReasoning({ model: "m", input: [{ type: "reasoning", encrypted_content: `gws1:${first}:!` }] }, first), /Malformed/);
});

test("configuration rejects duplicate routes and credential-bearing or insecure upstream URLs", () => {
  for (const providers of [
    [{ id: "a", type: "claude-subscription", models: { x: "one" } }, { id: "b", type: "claude-subscription", models: { x: "two" } }],
    [{ id: "a", type: "responses-api", models: { x: "one" }, baseUrl: "http://example.com/v1", apiKeyEnv: "GATEWAY_TEST_KEY" }],
    [{ id: "a", type: "responses-api", models: { x: "one" }, baseUrl: "https://user:password@example.com/v1", apiKeyEnv: "GATEWAY_TEST_KEY" }],
  ]) assert.throws(() => validateConfig({ version: 1, port: 1, providers }));
});


test("local token helpers reject symlinks and permissive token files without rewriting them", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-token-boundary-"));
  const token = join(directory, "client-token"); const target = join(directory, "target");
  await writeFile(target, "x".repeat(43), { mode: 0o600 });
  await symlink(target, token);
  await assert.rejects(gatewayToken(directory));
  assert.equal(await readFile(target, "utf8"), "x".repeat(43));
  const other = await mkdtemp(join(tmpdir(), "gateway-token-mode-"));
  await writeFile(join(other, "client-token"), "x".repeat(43), { mode: 0o644 });
  await assert.rejects(gatewayToken(other), /private file/);
  assert.equal((await stat(join(other, "client-token"))).mode & 0o777, 0o644);
});
