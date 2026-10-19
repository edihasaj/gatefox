import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gatewayToken } from "../config.js";
import { startGateway } from "../server.js";

test("existing Responses and Messages clients reach Grok and both OpenCode API formats through gateway providers", async t => {
  const env = "GATEWAY_API_PROVIDER_E2E_FIXTURE"; const previous = process.env[env]; process.env[env] = "fixture-upstream-key";
  const state = await mkdtemp(join(tmpdir(), "gateway-api-providers-"));
  const seen: { path: string; model: unknown; session?: string; authorization?: string; apiKey?: string }[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ path: req.url!, model: body.model, session: req.headers["x-opencode-session"] as string | undefined,
      authorization: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (req.url?.endsWith("/responses")) {
      emit({ type: "response.output_text.delta", delta: "api-provider-proof" });
      emit({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } });
    } else if (req.url?.endsWith("/chat/completions")) {
      emit({ choices: [{ index: 0, delta: { content: "api-provider-proof" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
      res.write("data: [DONE]\n\n");
    } else {
      assert.ok(req.url?.endsWith("/messages"));
      emit({ type: "message_start", message: { usage: { input_tokens: 2 } } });
      emit({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "api-provider-proof" } });
      emit({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      emit({ type: "message_stop" });
    }
    res.end();
  });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const mockBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(String(input)) : undefined;
    if (url && ["https://api.x.ai", "https://opencode.ai"].includes(url.origin)) return originalFetch(`${mockBase}${url.pathname}`, init);
    return originalFetch(input, init);
  });
  const gateway = await startGateway({ version: 1, port: 0, stateDirectory: state, providers: [
    { id: "grok", type: "responses-api", apiKeyEnv: env, baseUrl: "https://api.x.ai/v1", models: { "grok/main": "grok-4.7" } },
    { id: "opencode-chat", type: "chat-completions-api", apiKeyEnv: env, baseUrl: "https://opencode.ai/inference/go/openai/v1", models: { "opencode/chat": "fixture-chat" } },
    { id: "opencode-claude", type: "anthropic-api", apiKeyEnv: env, baseUrl: "https://opencode.ai/inference/go/anthropic/v1", models: { "opencode/claude": "fixture-claude" } },
  ] });
  t.after(async () => {
    gateway.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(done => gateway.close(() => done())), new Promise<void>(done => upstream.close(() => done()))]);
    await rm(state, { recursive: true, force: true });
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
  });
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(state)}`, "Content-Type": "application/json", "x-opencode-session": "conversation_1" };
  for (const model of ["grok/main", "opencode/chat", "opencode/claude"]) {
    const responses = await originalFetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model, input: "hello" }) });
    assert.equal(responses.status, 200);
    assert.equal((await responses.json() as { output_text: string }).output_text, "api-provider-proof");
    const messages = await originalFetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify({
      model, max_tokens: 100, messages: [{ role: "user", content: "hello" }],
    }) });
    assert.equal(messages.status, 200);
    assert.equal((await messages.json() as { content: { type: string; text: string }[] }).content[0].text, "api-provider-proof");
  }
  assert.equal(seen.length, 6);
  for (const request of seen) {
    if (request.path.startsWith("/inference/")) assert.equal(request.session, "conversation_1");
    else { assert.equal(request.path, "/v1/responses"); assert.equal(request.session, undefined); assert.equal(request.model, "grok-4.7"); }
    if (request.path.endsWith("/messages")) assert.equal(request.apiKey, "fixture-upstream-key");
    else assert.equal(request.authorization, "Bearer fixture-upstream-key");
  }
});

test("a Grok gateway custom-tool loop returns execution to the client and preserves encrypted reasoning on follow-up", async t => {
  const env = "GATEWAY_GROK_TOOL_E2E_FIXTURE"; const previous = process.env[env]; process.env[env] = "fixture-only";
  const state = await mkdtemp(join(tmpdir(), "gateway-grok-loop-"));
  const originalFetch = globalThis.fetch; const seen: Record<string, unknown>[] = [];
  const opaque = { type: "reasoning", id: "reasoning_1", encrypted_content: "opaque-provider-state", summary: [] };
  const rawInput = "*** Begin Patch\nfixture-only\n*** End Patch";
  let executionCount = 0;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (String(input) !== "https://api.x.ai/v1/responses") return originalFetch(input, init);
    const body = JSON.parse(String(init?.body)); seen.push(body);
    assert.equal(executionCount, seen.length === 1 ? 0 : 1);
    if (seen.length === 1) {
      const tools = body.tools as { type: string; name: string }[];
      assert.equal(tools.length, 1); assert.equal(tools[0].type, "function");
      const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: tools[0].name, arguments: JSON.stringify({ input: rawInput }), status: "completed" };
      return new Response([
        { type: "response.output_item.done", item: opaque },
        { type: "response.output_item.done", item: call },
        { type: "response.completed", response: { status: "completed", output: [opaque, call], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
    }
    assert.equal(body.instructions, "Keep caller instructions.");
    const replay = body.input as Record<string, unknown>[];
    assert.deepEqual(replay.find(item => item.type === "reasoning"), opaque);
    assert.equal(replay.find(item => item.type === "function_call")?.name, (seen[0].tools as { name: string }[])[0].name);
    assert.equal(replay.find(item => item.type === "function_call_output")?.output, "client-executed-proof");
    return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "tool-loop-proof" })}\n\n` +
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } })}\n\n`,
    { headers: { "Content-Type": "text/event-stream" } });
  });
  const gateway = await startGateway({ version: 1, port: 0, stateDirectory: state, providers: [
    { id: "grok", type: "responses-api", apiKeyEnv: env, baseUrl: "https://api.x.ai/v1", models: { "grok/main": "grok-4.7" } },
  ] });
  t.after(async () => {
    gateway.closeAllConnections(); await new Promise<void>(done => gateway.close(() => done()));
    await rm(state, { recursive: true, force: true });
    if (previous === undefined) delete process.env[env]; else process.env[env] = previous;
  });
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(state)}`, "Content-Type": "application/json" };
  const tools = [{ type: "namespace", name: "workspace", tools: [{ type: "custom", name: "patch", format: { type: "text" } }] }];
  const message = { role: "user", content: "Use the caller tool." };
  const request = (input: unknown) => originalFetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({
    model: "grok/main", instructions: "Keep caller instructions.", tools, input, store: false,
  }) });
  const first = await request([message]); assert.equal(first.status, 200);
  const result = await first.json() as { output: Record<string, unknown>[] };
  const call = result.output.find(item => item.type === "custom_tool_call")!;
  assert.ok(call); assert.equal(call.name, "patch"); assert.equal(call.namespace, "workspace"); assert.equal(call.input, rawInput);
  assert.equal(executionCount, 0);
  // This is the caller-side action, after the response has returned to the client.
  await writeFile(join(state, "caller-output"), "client-executed-proof", { mode: 0o600 }); executionCount++;
  const second = await request([message, ...result.output, {
    type: "custom_tool_call_output", call_id: call.call_id, output: await readFile(join(state, "caller-output"), "utf8"),
  }]);
  assert.equal(second.status, 200);
  assert.equal((await second.json() as { output_text: string }).output_text, "tool-loop-proof");
  assert.equal(executionCount, 1); assert.equal(seen.length, 2);
});
