import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatCompletionsAPI, type ChatCompletionRecoveryPolicy } from "../providers/chat-completions-api.js";
import type { InferenceContext } from "../providers/provider.js";
import { MessagesWriter } from "../protocol/messages.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startClaudeDesktopInference } from "../claude-desktop-inference.js";
import { flushRecords } from "../usage-ledger.js";

type Frame = Record<string, unknown> | "[DONE]";

async function close(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; await close(server); return port;
}

async function fixture(frames: (attempt: number) => Frame[], policy: ChatCompletionRecoveryPolicy | false = { models: ["qwen-flash"], timeoutMs: 200 }) {
  let attempts = 0; const bodies: string[] = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString("utf8")); attempts++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of frames(attempts)) response.write(frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const key = `GATEWAY_EMPTY_RECOVERY_${Math.random().toString(16).slice(2)}`; process.env[key] = "fixture";
  const provider = new ChatCompletionsAPI({
    id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    apiKeyEnv: key, models: { "qwen/flash": "qwen-flash" },
  }, undefined, policy || undefined);
  return {
    provider, bodies, attempts: () => attempts,
    close: async () => { delete process.env[key]; await close(upstream); },
  };
}

const request: ResponsesRequest = { model: "qwen-flash", input: "reply", stream: false };
const terminal = (delta: Record<string, unknown>, finish_reason: string | null = null): Frame =>
  ({ model: "qwen-flash", choices: [{ index: 0, delta, finish_reason }] });
const usage = (input: number, output: number): Frame => ({ choices: [], usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
const empty = (reasoning = "private"): Frame[] => [terminal({ reasoning_content: reasoning }), terminal({}, "stop"), usage(193_000, 1), "[DONE]"];
const text = (value: string): Frame[] => [terminal({ content: value }), terminal({}, "stop"), usage(193_000, 2), "[DONE]"];

async function collect(provider: ChatCompletionsAPI, context: InferenceContext = { clientProtocol: "messages" }, overrides: Partial<ResponsesRequest> = {}): Promise<{ events: InferenceEvent[]; error?: unknown }> {
  const events: InferenceEvent[] = [];
  try { for await (const event of provider.infer({ ...request, ...overrides }, new AbortController().signal, context)) events.push(event); return { events }; }
  catch (error) { return { events, error }; }
}

test("retries a clean reasoning-only empty Messages completion once with exact request bytes and cumulative spend", async () => {
  const recovery: Array<{ outcome: string; attempt: number }> = [];
  const f = await fixture(attempt => attempt === 1 ? empty() : text("recovered"), {
    models: ["qwen-flash"], timeoutMs: 200,
    onRecovery: event => recovery.push({ outcome: event.outcome, attempt: event.attempt }),
  });
  try {
    const result = await collect(f.provider);
    assert.equal(result.error, undefined); assert.equal(f.attempts(), 2); assert.equal(f.bodies[0], f.bodies[1]);
    assert.deepEqual(result.events.filter(event => event.type === "text").map(event => (event as Extract<InferenceEvent, { type: "text" }>).text), ["recovered"]);
    const done = result.events.at(-1) as Extract<InferenceEvent, { type: "done" }>;
    assert.deepEqual(done.usage, { input_tokens: 386_000, output_tokens: 3, total_tokens: 386_003 });
    assert.deepEqual(done.clientUsage, { input_tokens: 193_000, output_tokens: 2, total_tokens: 193_002 });
    assert.deepEqual(recovery, [{ outcome: "retry", attempt: 1 }, { outcome: "recovered", attempt: 2 }]);
  } finally { await f.close(); }
  const legacyReasoning = await fixture(attempt => attempt === 1
    ? [terminal({ reasoning: "private" }), terminal({}, "stop"), usage(1, 1), "[DONE]"]
    : text("legacy reasoning recovered"));
  try {
    const result = await collect(legacyReasoning.provider, undefined, { reasoning: { summary: "none" } });
    assert.equal(result.error, undefined); assert.equal(legacyReasoning.attempts(), 2);
  } finally { await legacyReasoning.close(); }
});

test("null usage chunks are ignored until a numeric usage snapshot arrives", async () => {
  const withNullUsage = (content: string): Frame[] => [
    { model: "qwen-flash", choices: [{ index: 0, delta: { content }, finish_reason: null }], usage: null },
    { model: "qwen-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null },
    usage(4, 2), "[DONE]",
  ];
  const visible = await fixture(() => withNullUsage("visible"));
  const retry = await fixture(attempt => attempt === 1 ? [
    { model: "qwen-flash", choices: [{ index: 0, delta: { reasoning_content: "private" }, finish_reason: null }], usage: null },
    { model: "qwen-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null }, usage(3, 1), "[DONE]",
  ] : withNullUsage("recovered"));
  try {
    const normal = await collect(visible.provider);
    assert.equal(visible.attempts(), 1); assert.equal(normal.error, undefined);
    assert.deepEqual((normal.events.at(-1) as Extract<InferenceEvent, { type: "done" }>).usage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
    const result = await collect(retry.provider, undefined, { reasoning: { summary: "none" } });
    const done = result.events.at(-1) as Extract<InferenceEvent, { type: "done" }>;
    assert.equal(retry.attempts(), 2); assert.equal(result.error, undefined);
    assert.deepEqual(done.usage, { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    assert.deepEqual(done.clientUsage, { input_tokens: 4, output_tokens: 2, total_tokens: 6 });
  } finally { await Promise.all([visible.close(), retry.close()]); }
});

test("observed vLLM null-only metadata can recover, but non-null metadata fails closed", async () => {
  const metadata = (value: null | "not-null"): Frame[] => [
    { model: "qwen-flash", prompt_token_ids: value, prompt_text: value, choices: [{ index: 0, delta: { reasoning_content: "private" }, finish_reason: null, stop_reason: value, token_ids: value }] },
    { model: "qwen-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop", stop_reason: value, token_ids: value }] },
    usage(3, 1), "[DONE]",
  ];
  const allowed = await fixture(attempt => attempt === 1 ? metadata(null) : text("recovered"));
  try {
    const result = await collect(allowed.provider, undefined, { reasoning: { summary: "none" } });
    assert.equal(result.error, undefined); assert.equal(allowed.attempts(), 2); assert.equal(allowed.bodies[0], allowed.bodies[1]);
  } finally { await allowed.close(); }
  for (const frames of [
    [{ model: "qwen-flash", prompt_token_ids: "bad", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"],
    [{ model: "qwen-flash", prompt_text: "bad", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"],
    [{ model: "qwen-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop", stop_reason: "bad" }] }, usage(1, 1), "[DONE]"],
    [{ model: "qwen-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop", token_ids: "bad" }] }, usage(1, 1), "[DONE]"],
  ] as Frame[][]) {
    const rejected = await fixture(() => frames);
    try {
      const result = await collect(rejected.provider);
      assert.equal(rejected.attempts(), 1); assert.equal((result.error as { code?: string }).code, "incomplete");
    } finally { await rejected.close(); }
  }
});

test("allows an auto tool response after an empty completion but never retries twice-empty", async () => {
  const tool = (attempt: number): Frame[] => attempt === 1 ? empty() : [
    terminal({ tool_calls: [{ index: 0, id: "call_1", function: { name: "tool_0", arguments: "{}" } }] }),
    terminal({}, "tool_calls"), usage(2, 1), "[DONE]",
  ];
  const f = await fixture(tool);
  const exhausted = await fixture(() => empty(""));
  try {
    const tools = await collect(f.provider, undefined, { tools: [{ type: "function", name: "tool" }] });
    assert.equal(f.attempts(), 2); assert.equal(tools.events.some(event => event.type === "tool"), true);
    const failed = await collect(exhausted.provider);
    assert.equal(exhausted.attempts(), 2); assert.equal((failed.error as { code?: string }).code, "incomplete");
    assert.equal(failed.events.some(event => event.type === "done"), false);
  } finally { await Promise.all([f.close(), exhausted.close()]); }
});

test("visible output, whitespace, tool fragments, filters, malformed tails, and non-Messages paths retain one request", async () => {
  const one = async (frames: Frame[], context: InferenceContext = { clientProtocol: "messages" }) => {
    const f = await fixture(() => frames);
    try { await collect(f.provider, context); assert.equal(f.attempts(), 1); } finally { await f.close(); }
  };
  await one(text("visible"));
  await one(text(" "));
  await one([terminal({ tool_calls: [{ index: 0 }] }), terminal({}, "stop"), usage(1, 1), "[DONE]"]);
  await one([terminal({}), terminal({}, "content_filter"), usage(1, 1), "[DONE]"]);
  await one([terminal({}), terminal({}, "stop"), usage(1, 1), "[DONE]", "[DONE]"]);
  await one([{ model: "qwen-flash", content_filter_results: {}, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", prompt_filter_results: [{ content_filter_results: { hate: { filtered: true } } }], choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, refusal: "refused", delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, message: { role: "assistant", content: "discarded" }, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, delta: { function_call: { name: "tool" } }, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, delta: { reasoning: { invalid: true } }, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, delta: { audio: "unknown semantic output" }, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, unknown_answer: true, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", unknown_semantic_output: true, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, delta: [], finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ model: "qwen-flash", choices: [{ index: 0, delta: { tool_calls: {} }, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage(1, 1), "[DONE]"]);
  await one([terminal({}), terminal({}, "stop"), { choices: [], usage: { prompt_tokens: "bad", completion_tokens: -1, total_tokens: 0 } }, "[DONE]"]);
  await one([terminal({}), terminal({}, "stop"), usage(1, 1)]);
  await one(empty(), { clientProtocol: "responses" });
  const stopped = await fixture(() => empty(""));
  try { await collect(stopped.provider, undefined, { stop: [""] }); assert.equal(stopped.attempts(), 1); } finally { await stopped.close(); }
  const otherModel = await fixture(() => empty(""), { models: ["other-model"] });
  try { const result = await collect(otherModel.provider); assert.equal(otherModel.attempts(), 1); assert.equal(result.events.at(-1)?.type, "done"); } finally { await otherModel.close(); }
  const defaultProvider = await fixture(() => empty(), false);
  try {
    const defaultResult = await collect(defaultProvider.provider);
    assert.equal(defaultProvider.attempts(), 1); assert.equal(defaultResult.events.at(-1)?.type, "done");
  } finally { await defaultProvider.close(); }
});

test("Messages uses a retry's final context usage while server accounting retains total spend", () => {
  const wire: Array<Record<string, unknown>> = []; const writer = new MessagesWriter("qwen/flash", event => wire.push(event));
  writer.begin();
  writer.accept({ type: "done", usage: { input_tokens: 386_000, output_tokens: 3, total_tokens: 386_003 },
    clientUsage: { input_tokens: 193_000, output_tokens: 2, total_tokens: 193_002 } });
  const delta = wire.find(event => event.type === "message_delta")!;
  assert.deepEqual(delta.usage, { input_tokens: 193_000, output_tokens: 2 });
});

test("the private Claude factory alone enables an allowlisted provider recovery", async () => {
  let attempts = 0;
  const upstream = createServer((_request, response) => {
    attempts++; response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of attempts % 2 ? empty() : text("private recovery")) response.write(frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const root = await mkdtemp(join(tmpdir(), "gateway-empty-private-")); const state = join(root, "state"); const authDirectory = join(root, "claude");
  const gatewayConfig = join(root, "gateway.json"); const nativeConfig = join(root, "native.json");
  const key = "GATEWAY_EMPTY_PRIVATE_KEY"; process.env[key] = "fixture";
  const config: GatewayConfig = { version: 1, port: await unusedPort(), stateDirectory: state, providers: [
    { id: "claude", type: "claude-subscription", authDirectory, models: { "claude/sonnet": "claude-sonnet-5" } },
    { id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: key, models: { "qwen/flash": "qwen-flash" } },
  ] };
  await writeFile(gatewayConfig, JSON.stringify(config));
  await writeFile(nativeConfig, JSON.stringify({ command: "/usr/bin/true", authDirectory, models: { "claude/sonnet": "claude-sonnet-5" }, emptyCompletionRecoveryProviders: ["qwen"] }));
  const running = await startClaudeDesktopInference(gatewayConfig, nativeConfig);
  try {
    const token = await gatewayToken(state);
    const response = await fetch(`http://127.0.0.1:${running.port}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen/flash", max_tokens: 8, stream: false, messages: [{ role: "user", content: "reply" }] }),
    });
    const body = await response.json() as { content: Array<{ text: string }>; usage: { input_tokens: number } };
    assert.equal(response.status, 200); assert.equal(attempts, 2); assert.equal(body.content[0]!.text, "private recovery");
    assert.equal(body.usage.input_tokens, 193_000);
    const streamed = await fetch(`http://127.0.0.1:${running.port}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen/flash", max_tokens: 8, stream: true, messages: [{ role: "user", content: "reply" }] }),
    });
    const wire = await streamed.text();
    assert.equal(streamed.status, 200); assert.match(wire, /"input_tokens":193000/); assert.equal(attempts, 4);
    await flushRecords();
    const ledger = (await readdir(join(state, "usage"))).find(name => name.endsWith(".jsonl"))!;
    const rows = await readFile(join(state, "usage", ledger), "utf8");
    assert.equal((rows.match(/"inputTokens":386000/g) || []).length, 2);
  } finally { delete process.env[key]; await running.close(); await close(upstream); }
});

test("an invalid recovery allowlist is rejected before a private context proxy can start", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-empty-invalid-")); const configPath = join(root, "gateway.json"); const nativePath = join(root, "native.json");
  const config: GatewayConfig = { version: 1, port: 3456, stateDirectory: join(root, "state"), providers: [
    { id: "claude", type: "claude-subscription", authDirectory: join(root, "claude"), models: { "claude/sonnet": "claude-sonnet-5" } },
    { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "GATEWAY_EMPTY_INVALID_KEY", models: { "qwen/flash": "qwen-flash" } },
  ] };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(nativePath, JSON.stringify({ command: "/usr/bin/true", authDirectory: join(root, "claude"), models: { "claude/sonnet": "claude-sonnet-5" },
    contextProviders: ["qwen"], emptyCompletionRecoveryProviders: ["missing"] }));
  let started = false;
  await assert.rejects(startClaudeDesktopInference(configPath, nativePath, {
    contextProxyFactory: async () => { started = true; throw new Error("must not start"); },
  }), /emptyCompletionRecoveryProviders/);
  assert.equal(started, false);
});

test("cancellation after first usage prevents a second request and cancellation during retry closes its connection", async () => {
  const between = await fixture(() => empty(""));
  try {
    const controller = new AbortController(); const source = between.provider.infer({ ...request, reasoning: { summary: "none" } }, controller.signal, { clientProtocol: "messages" })[Symbol.asyncIterator]();
    assert.equal((await source.next()).value?.type, "usage"); controller.abort(); await source.next();
    assert.equal(between.attempts(), 1);
  } finally { await between.close(); }

  let attempts = 0; let entered!: () => void; const second = new Promise<void>(resolve => { entered = resolve; }); let closed = false;
  const upstream = createServer((_request, response) => {
    attempts++;
    if (attempts === 1) { for (const frame of empty("")) response.write(frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`); response.end(); return; }
    entered(); response.on("close", () => { closed = true; });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const key = "GATEWAY_EMPTY_CANCEL_KEY"; process.env[key] = "fixture";
  const provider = new ChatCompletionsAPI({ id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: key, models: { "qwen/flash": "qwen-flash" } },
    undefined, { models: ["qwen-flash"], timeoutMs: 200 });
  try {
    const controller = new AbortController(); const source = provider.infer({ ...request, reasoning: { summary: "none" } }, controller.signal, { clientProtocol: "messages" })[Symbol.asyncIterator]();
    await source.next(); const waiting = source.next(); await second; controller.abort(); await assert.rejects(waiting);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(attempts, 2); assert.equal(closed, true);
  } finally { delete process.env[key]; await close(upstream); }
});

test("HTTP rejections stay final and retry spend survives a failed second stream", async () => {
  for (const status of [401, 429, 400]) {
    let attempts = 0;
    const upstream = createServer((_request, response) => {
      attempts++; response.writeHead(status, { "content-type": "application/json" });
      response.end(status === 400 ? '{"error":{"code":"context_length_exceeded"}}' : "{}");
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const key = `GATEWAY_EMPTY_STATUS_${status}`; process.env[key] = "fixture";
    const provider = new ChatCompletionsAPI({ id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: key, models: { "qwen/flash": "qwen-flash" } },
      undefined, { models: ["qwen-flash"] });
    try {
      const result = await collect(provider); assert.equal(attempts, 1); assert.equal((result.error as { status?: number }).status, status);
      if (status === 400) assert.equal((result.error as { code?: string }).code, "context_length_exceeded");
    }
    finally { delete process.env[key]; await close(upstream); }
  }
  const failed = await fixture(attempt => attempt === 1 ? empty("") : [usage(7, 3)]);
  try {
    const result = await collect(failed.provider);
    assert.equal(failed.attempts(), 2); assert.equal((result.error as { code?: string }).code, "incomplete");
    assert.deepEqual((result.events.at(-1) as Extract<InferenceEvent, { type: "usage" }>).usage, { input_tokens: 193_007, output_tokens: 4, total_tokens: 193_011 });
  } finally { await failed.close(); }
});

test("the first ordinary request has no recovery deadline, but empty EOF and returned iterators close upstream streams", async () => {
  let slowCalls = 0;
  const slow = createServer((_request, response) => {
    slowCalls++; setTimeout(() => { for (const frame of text("slow")) response.write(frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`); response.end(); }, 25);
  });
  slow.listen(0, "127.0.0.1"); await once(slow, "listening");
  const key = "GATEWAY_EMPTY_SLOW_KEY"; process.env[key] = "fixture";
  const provider = new ChatCompletionsAPI({ id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(slow.address() as { port: number }).port}/v1`, apiKeyEnv: key, models: { "qwen/flash": "qwen-flash" } },
    undefined, { models: ["qwen-flash"], timeoutMs: 5 });
  try { assert.equal((await collect(provider)).error, undefined); assert.equal(slowCalls, 1); }
  finally { delete process.env[key]; await close(slow); }

  let closed = false;
  const stalled = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of empty("")) response.write(frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`);
    response.on("close", () => { closed = !response.writableEnded; });
  });
  stalled.listen(0, "127.0.0.1"); await once(stalled, "listening");
  const stalledKey = "GATEWAY_EMPTY_STALL_KEY"; process.env[stalledKey] = "fixture";
  const recovery = new ChatCompletionsAPI({ id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(stalled.address() as { port: number }).port}/v1`, apiKeyEnv: stalledKey, models: { "qwen/flash": "qwen-flash" } },
    undefined, { models: ["qwen-flash"], timeoutMs: 5 });
  try {
    const result = await collect(recovery); assert.equal((result.error as { code?: string }).code, "incomplete");
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, true);
  } finally { delete process.env[stalledKey]; await close(stalled); }
});

test("the recovery request deadline is a typed timeout after a clean empty first completion", async () => {
  let attempts = 0;
  const upstream = createServer((_request, response) => {
    attempts++;
    if (attempts === 1) { for (const frame of empty("")) response.write(frame === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(frame)}\n\n`); response.end(); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const key = "GATEWAY_EMPTY_RETRY_TIMEOUT_KEY"; process.env[key] = "fixture";
  const provider = new ChatCompletionsAPI({ id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: key, models: { "qwen/flash": "qwen-flash" } },
    undefined, { models: ["qwen-flash"], timeoutMs: 5 });
  try {
    const result = await collect(provider);
    assert.equal(attempts, 2); assert.equal((result.error as { code?: string; status?: number }).code, "timeout");
    assert.equal((result.error as { status?: number }).status, 504);
  } finally { delete process.env[key]; await close(upstream); }
});

test("default output cancellation closes the body, and later invalid tools still follow an earlier valid tool", async () => {
  let cancelled = false;
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(terminal({ content: "first" }))}\n\n`);
    response.on("close", () => { cancelled = !response.writableEnded; });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const key = "GATEWAY_EMPTY_RETURN_KEY"; process.env[key] = "fixture";
  const normal = new ChatCompletionsAPI({ id: "qwen", type: "chat-completions-api", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, apiKeyEnv: key, models: { "qwen/flash": "qwen-flash" } });
  try {
    const source = normal.infer(request, new AbortController().signal, { clientProtocol: "messages" })[Symbol.asyncIterator]();
    assert.equal((await source.next()).value?.type, "text"); await source.return(undefined as never);
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(cancelled, true);
  } finally { delete process.env[key]; await close(upstream); }

  const tools = await fixture(() => [
    terminal({ tool_calls: [{ index: 0, id: "call_1", function: { name: "tool_0", arguments: "{}" } }, { index: 1, id: "call_1", function: { name: "tool_0", arguments: "{}" } }] }),
    terminal({}, "tool_calls"), usage(1, 1), "[DONE]",
  ], false);
  try {
    const source = tools.provider.infer({ ...request, tools: [{ type: "function", name: "tool" }] }, new AbortController().signal)[Symbol.asyncIterator]();
    assert.equal((await source.next()).value?.type, "tool"); await assert.rejects(source.next(), { code: "invalid_tool_call" });
  } finally { await tools.close(); }
});
