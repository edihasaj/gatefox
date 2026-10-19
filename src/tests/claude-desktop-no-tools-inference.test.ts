import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startClaudeContextProxy } from "../claude-desktop-context-proxy.js";
import { startClaudeDesktopInference } from "../claude-desktop-inference.js";
import { gatewayToken } from "../config.js";
import type { NoToolsOutputRecovery } from "../claude-desktop-no-tools.js";
import type { ProviderConfig } from "../config.js";

const token = "no-tools-context-proxy-fixture-token";
const recovery = { model: "qwen3.8-flash-next", codec: {} } as unknown as NoToolsOutputRecovery;

async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler); server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; await close(server); return port;
}
const provider = (baseUrl: string): ProviderConfig => ({
  id: "qwen", type: "chat-completions-api", baseUrl, apiKeyEnv: "NO_TOOLS_CONTEXT_PROXY_KEY",
  models: { "qwen/flash": "qwen3.8-flash-next" },
});
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const eligible = JSON.stringify({ model: "qwen3.8-flash-next", stream: true, messages: [{ role: "user", content: "fixture" }] });
const tools = JSON.stringify({ model: "qwen3.8-flash-next", stream: true, messages: [{ role: "user", content: "fixture" }], tools: [{ type: "function" }], tool_choice: "none" });

test("keeps the normal path byte-for-byte while exposing the no-tools path only privately", async () => {
  const seen: Array<{ path: string; body: Buffer }> = [];
  const upstream = await listen(async (request, response) => {
    seen.push({ path: request.url || "", body: await read(request) });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
  });
  const proxy = await startClaudeContextProxy(provider(upstream.baseUrl), { credentialReader: async () => token, noToolsOutputRecovery: recovery });
  try {
    assert.ok(proxy.noToolsBaseUrl);
    const normal = await fetch(`${proxy.provider.baseUrl}/chat/completions?normal=1`, { method: "POST", headers, body: eligible });
    assert.equal(normal.status, 200);
    assert.equal(await normal.text(), "data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
    assert.deepEqual(seen[0], { path: "/v1/chat/completions?normal=1", body: Buffer.from(eligible) });

    const scopedTools = await fetch(`${proxy.noToolsBaseUrl}/chat/completions?tools=1`, { method: "POST", headers, body: tools });
    assert.equal(scopedTools.status, 200);
    assert.equal(await scopedTools.text(), "data: {\"choices\":[]}\n\ndata: [DONE]\n\n");
    assert.deepEqual(seen[1], { path: "/v1/chat/completions?tools=1", body: Buffer.from(tools) });
    assert.equal((await fetch(`${proxy.provider.baseUrl}/claude-no-tools/v1/chat/completions`, { method: "POST", headers, body: eligible })).status, 404);
  } finally {
    await proxy.close(); await close(upstream.server);
  }
});

test("fails closed for a scoped instrumented response with an unsupported HTTP-200 format", async () => {
  const upstream = await listen(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ prompt_token_ids: [1, 2], choices: [] }));
  });
  const proxy = await startClaudeContextProxy(provider(upstream.baseUrl), { credentialReader: async () => token, noToolsOutputRecovery: recovery });
  try {
    const response = await fetch(`${proxy.noToolsBaseUrl}/chat/completions`, { method: "POST", headers, body: eligible });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /prompt_token_ids|1,2/);
  } finally {
    await proxy.close(); await close(upstream.server);
  }
});

test("rejects a misleading scoped MIME type before diagnostic token metadata can relay", async () => {
  const upstream = await listen(async (_request, response) => {
    response.writeHead(200, { "content-type": "application/json; note=text/event-stream" });
    response.end(JSON.stringify({ prompt_token_ids: [1, 2], choices: [] }));
  });
  const proxy = await startClaudeContextProxy(provider(upstream.baseUrl), { credentialReader: async () => token, noToolsOutputRecovery: recovery });
  try {
    const response = await fetch(`${proxy.noToolsBaseUrl}/chat/completions`, { method: "POST", headers, body: eligible });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /prompt_token_ids|1,2/);
  } finally {
    await proxy.close(); await close(upstream.server);
  }
});

test("validates every configured no-tools tokenizer before allocating a context proxy", async t => {
  const root = await mkdtemp(join(tmpdir(), "gateway-no-tools-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gateway = join(root, "gateway.json"), native = join(root, "native.json");
  await writeFile(gateway, JSON.stringify({
    version: 1, port: 41234, stateDirectory: join(root, "state"), providers: [
      { id: "claude", type: "claude-subscription", authDirectory: join(root, "auth"), models: { "claude/sonnet": "claude-sonnet-5" } },
      { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "NO_TOOLS_CONTEXT_PROXY_KEY", models: { "qwen/flash": "qwen3.8-flash-next" } },
    ],
  }));
  await writeFile(native, JSON.stringify({
    command: "/usr/bin/true", authDirectory: join(root, "auth"), models: { "claude/sonnet": "claude-sonnet-5" },
    contextProviders: ["qwen"], emptyCompletionRecoveryProviders: ["qwen"],
    noToolsOutputRecoveryProviders: { qwen: join(root, "missing-tokenizer.json") },
  }));
  let proxies = 0, tokens = 0;
  await assert.rejects(startClaudeDesktopInference(gateway, native, {
    contextProxyFactory: async () => { proxies++; throw new Error("context proxy must not allocate"); },
    tokenReader: async () => { tokens++; return token; },
  }));
  assert.equal(proxies, 0);
  assert.equal(tokens, 0);
});

test("rejects no-tools entries that omit either required recovery membership before allocation", async t => {
  for (const nativeOverrides of [{ contextProviders: [] }, { emptyCompletionRecoveryProviders: [] }]) {
    const root = await mkdtemp(join(tmpdir(), "gateway-no-tools-membership-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const gateway = join(root, "gateway.json"), native = join(root, "native.json");
    await writeFile(gateway, JSON.stringify({
      version: 1, port: 41234, stateDirectory: join(root, "state"), providers: [
        { id: "claude", type: "claude-subscription", authDirectory: join(root, "auth"), models: { "claude/sonnet": "claude-sonnet-5" } },
        { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "NO_TOOLS_CONTEXT_PROXY_KEY", models: { "qwen/flash": "qwen3.8-flash-next" } },
      ],
    }));
    await writeFile(native, JSON.stringify({
      command: "/usr/bin/true", authDirectory: join(root, "auth"), models: { "claude/sonnet": "claude-sonnet-5" },
      contextProviders: ["qwen"], emptyCompletionRecoveryProviders: ["qwen"], noToolsOutputRecoveryProviders: { qwen: join(root, "missing-tokenizer.json") },
      ...nativeOverrides,
    }));
    let proxies = 0;
    await assert.rejects(startClaudeDesktopInference(gateway, native, {
      contextProxyFactory: async () => { proxies++; throw new Error("context proxy must not allocate"); },
    }), /opted-in context and empty-completion Chat provider/);
    assert.equal(proxies, 0);
  }
});

const tokenizerAsset = process.env.CLAUDE_QWEN_TOKENIZER_ASSET;
test("uses the scoped proxy only for private Messages requests", { skip: !tokenizerAsset }, async t => {
  const root = await mkdtemp(join(tmpdir(), "gateway-no-tools-factory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const seen: Buffer[] = [];
  const upstream = await listen(async (request, response) => {
    seen.push(await read(request));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"object":"chat.completion.chunk","model":"qwen3.8-flash-next","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      'data: {"object":"chat.completion.chunk","model":"qwen3.8-flash-next","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]", "",
    ].join("\n\n"));
  });
  const gateway = join(root, "gateway.json"), native = join(root, "native.json"), state = join(root, "state"), port = await unusedPort();
  const previousKey = process.env.NO_TOOLS_CONTEXT_PROXY_KEY;
  process.env.NO_TOOLS_CONTEXT_PROXY_KEY = token;
  t.after(() => { if (previousKey === undefined) delete process.env.NO_TOOLS_CONTEXT_PROXY_KEY; else process.env.NO_TOOLS_CONTEXT_PROXY_KEY = previousKey; });
  await writeFile(gateway, JSON.stringify({
    version: 1, port, stateDirectory: state, providers: [
      { id: "claude", type: "claude-subscription", authDirectory: join(root, "auth"), models: { "claude/sonnet": "claude-sonnet-5" } },
      { id: "qwen", type: "chat-completions-api", baseUrl: upstream.baseUrl, apiKeyEnv: "NO_TOOLS_CONTEXT_PROXY_KEY", models: { "qwen/flash": "qwen3.8-flash-next" } },
    ],
  }));
  await writeFile(native, JSON.stringify({
    command: "/usr/bin/true", authDirectory: join(root, "auth"), models: { "claude/sonnet": "claude-sonnet-5" },
    contextProviders: ["qwen"], emptyCompletionRecoveryProviders: ["qwen"], noToolsOutputRecoveryProviders: { qwen: tokenizerAsset },
  }));
  const credential = await gatewayToken(state);
  const running = await startClaudeDesktopInference(gateway, native, { tokenReader: async () => credential });
  t.after(async () => { await running.close(); await close(upstream.server); });
  const base = `http://127.0.0.1:${running.port}`;
  const messages = await fetch(`${base}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({
    model: "qwen/flash", stream: true, max_tokens: 32, messages: [{ role: "user", content: "fixture" }],
  }) });
  const messagesBody = await messages.text();
  assert.equal(messages.status, 200, messagesBody);
  const responses = await fetch(`${base}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: JSON.stringify({
    model: "qwen/flash", stream: true, input: "fixture",
  }) });
  const responsesBody = await responses.text();
  assert.equal(responses.status, 200, responsesBody);
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[0]!.toString()).return_token_ids, true);
  assert.equal(Object.hasOwn(JSON.parse(seen[1]!.toString()), "return_token_ids"), false);
});
