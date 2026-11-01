import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { startClaudeDesktopInference, type NativeClassifierRequest, type NativeMessagesRunner } from "../claude-desktop-inference.js";
import type { ClaudeContextProxy } from "../claude-desktop-context-proxy.js";
import type { GatewayServer } from "../server.js";

const close = (server: Server) => new Promise<void>(resolve => server.listening ? server.close(() => resolve()) : resolve());

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port; await close(server); return port;
}

async function body(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function nativeMessage(model: string): Record<string, unknown> {
  return {
    id: "msg_native", type: "message", role: "assistant", model, content: [{ type: "text", text: "native" }],
    stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function stageOne(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "claude/sonnet", max_tokens: 64, stream: false, thinking: { type: "disabled" },
    stop_sequences: ["</severity>"], messages: [{ role: "user", content: "classifier input" }], ...overrides,
  };
}

async function fixture(runner: NativeMessagesRunner, options: {
  native?: Record<string, unknown>;
  nativeClassifierRequest?: NativeClassifierRequest;
  backendResponse?: (request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, bytes: Buffer) => Promise<void> | void;
  contextProxyFactory?: (provider: import("../config.js").ProviderConfig) => Promise<ClaudeContextProxy>;
  port?: number;
  tokenReader?: (stateDirectory: string) => Promise<string>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-claude-desktop-inference-"));
  const state = join(root, "state"); const authDirectory = join(root, "claude-auth");
  const port = options.port ?? await unusedPort(); const gatewayConfig = join(root, "gateway.json"); const nativeConfig = join(root, "native.json");
  const config: GatewayConfig = {
    version: 1, port, stateDirectory: state, providers: [
      { id: "claude", type: "claude-subscription", authDirectory, models: { "claude/sonnet": "claude-sonnet-5" } },
      { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "CLAUDE_DESKTOP_INFERENCE_TEST_KEY", models: { "qwen/flash": "qwen-flash" } },
    ],
  };
  await writeFile(gatewayConfig, JSON.stringify(config), { mode: 0o600 });
  await writeFile(nativeConfig, JSON.stringify({ command: "/usr/bin/true", authDirectory, models: { "claude/sonnet": "claude-sonnet-5" }, ...options.native }), { mode: 0o600 });
  const backendRequests: Array<{ url: string; headers: import("node:http").IncomingHttpHeaders; body: Buffer }> = [];
  let backendConfig: GatewayConfig | undefined;
  const backendFactory = async (configured: GatewayConfig): Promise<GatewayServer> => {
    backendConfig = configured;
    const backend = createServer(async (request, response) => {
      const bytes = await body(request);
      backendRequests.push({ url: request.url || "", headers: request.headers, body: bytes });
      if (options.backendResponse) {
        await options.backendResponse(request, response, bytes);
        return;
      }
      if (request.url?.startsWith("/health")) {
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ status: "ok", active: 0 }));
      } else {
        response.writeHead(201, { "x-backend": "yes", "content-type": "application/octet-stream" }); response.end(bytes);
      }
    }) as GatewayServer;
    backend.isIdle = () => true; backend.recordPending = () => 0; backend.restartWhenIdle = () => false;
    backend.listen(0, "127.0.0.1"); await once(backend, "listening");
    return backend;
  };
  const token = await gatewayToken(state);
  const running = await startClaudeDesktopInference(gatewayConfig, nativeConfig, {
    backendFactory, nativeRunner: runner, nativeClassifierRequest: options.nativeClassifierRequest,
    contextProxyFactory: options.contextProxyFactory, tokenReader: options.tokenReader,
  });
  return {
    root, state, authDirectory, gatewayConfig, nativeConfig, token, backendRequests, backendConfig: backendConfig!, running,
    url: `http://127.0.0.1:${running.port}`,
    stop: () => running.close(),
  };
}

const headers = (token: string) => ({
  authorization: `Bearer ${token}`, "content-type": "application/json", "x-claude-code-request-class": "auxiliary",
});

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

test("selects only an owned native Claude alias after frontend authentication and maps its returned model", async () => {
  const calls: Array<{ payload: Record<string, unknown>; model: string; options: Parameters<NativeMessagesRunner>[2] }> = [];
  const f = await fixture(async (payload, model, options) => { calls.push({ payload, model, options }); return nativeMessage(model); });
  try {
    const unauthorized = await fetch(`${f.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude/sonnet" }) });
    assert.equal(unauthorized.status, 401);
    const response = await fetch(`${f.url}/v1/messages?beta=true`, {
      method: "POST", headers: { ...headers(f.token), "x-api-key": f.token, "anthropic-beta": "first-party-classifier-2025-10-01" },
      body: JSON.stringify(stageOne({ messages: [{ role: "user", content: "hi" }] })),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { model: string }).model, "claude/sonnet");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, "claude-sonnet-5");
    assert.equal(calls[0]!.payload.model, "claude-sonnet-5");
    assert.equal(calls[0]!.options.authDirectory, f.authDirectory);
    assert.equal(calls[0]!.options.timeoutMs, 60000);
    assert.equal(calls[0]!.options.maxRequestBytes, 192 * 1024);
    assert.deepEqual(calls[0]!.options.headers, {
      "x-claude-code-request-class": "auxiliary",
      "anthropic-beta": "first-party-classifier-2025-10-01",
    });
    assert.equal(f.backendRequests.length, 0);
  } finally { await f.stop(); }
});

for (const scenario of ["cold", "unknown", "failed"] as const) test(`native auxiliary cache guard stops repeated ${scenario} input before another CLI`, async () => {
  let calls = 0;
  const inputUsage = { input_tokens: 70000, output_tokens: 1,
    ...(scenario === "unknown" ? {} : { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }) };
  const f = await fixture(async (_payload, model, options) => {
    calls++; options.observeCacheUsage?.(inputUsage);
    if (scenario === "failed") throw Object.assign(new Error("fixture failed after usage"), { status: 502 });
    return { ...nativeMessage(model), usage: inputUsage };
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`${f.url}/v1/messages`, { method: "POST", headers: headers(f.token), body: JSON.stringify(stageOne()) });
      const value = await response.json() as { error?: { message?: string } };
      assert.equal(response.status, attempt === 2 ? 400 : scenario === "failed" ? 502 : 200);
      if (attempt === 2) assert.match(value.error!.message!, scenario === "unknown" ? /did not report cache reuse/ : /cache reuse failed/);
    }
    assert.equal(calls, 2);
    assert.equal(f.backendRequests.length, 0);
  } finally { await f.stop(); }
});

test("native auxiliary guard preserves reported warm reuse and does not rewrite the request", async () => {
  let calls = 0;
  const payload = stageOne();
  const f = await fixture(async (received, model) => {
    calls++; assert.deepEqual(received, { ...payload, model });
    return { ...nativeMessage(model), usage: { input_tokens: 1000, output_tokens: 1,
      cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 } };
  });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(`${f.url}/v1/messages`, { method: "POST", headers: headers(f.token), body: JSON.stringify(payload) });
      assert.equal(response.status, 200); await response.text();
    }
    assert.equal(calls, 4);
  } finally { await f.stop(); }
});

test("derives auxiliary routing only for a missing request class and an observed classifier profile", async () => {
  let nativeCalls = 0;
  const f = await fixture(async (_payload, model) => { nativeCalls++; return nativeMessage(model); });
  try {
    const missingClass = await fetch(`${f.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
      body: JSON.stringify(stageOne()),
    });
    assert.equal(missingClass.status, 200);
    const explicitMain = await fetch(`${f.url}/v1/messages`, {
      method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-claude-code-request-class": "main" },
      body: JSON.stringify(stageOne()),
    });
    assert.equal(explicitMain.status, 201);
    assert.equal(nativeCalls, 1);
    assert.equal(f.backendRequests.length, 1);
  } finally { await f.stop(); }
});

test("uses only the two observed auxiliary classifier wire profiles", async () => {
  let nativeCalls = 0;
  const f = await fixture(async (_payload, model) => { nativeCalls++; return nativeMessage(model); });
  try {
    const stageTwo = stageOne({ max_tokens: 8192 });
    delete stageTwo.stop_sequences;
    const accepted = await fetch(`${f.url}/v1/messages`, {
      method: "POST", headers: headers(f.token), body: JSON.stringify(stageTwo),
    });
    assert.equal(accepted.status, 200);
    const unknown = await fetch(`${f.url}/v1/messages`, {
      method: "POST", headers: headers(f.token), body: JSON.stringify(stageOne({ stop_sequences: ["</unknown>"] })),
    });
    assert.equal(unknown.status, 201);
    assert.equal(nativeCalls, 1);
    assert.equal(f.backendRequests.length, 1);
  } finally { await f.stop(); }
});

test("proxies normal Messages requests with query, headers, and exact bytes while health exposes nativeActive", async () => {
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (_payload, model) => { entered(); await waiting; return nativeMessage(model); });
  try {
    const source = JSON.stringify({ model: "claude/sonnet", stream: true, messages: [], tools: [{ name: "tool" }] });
    const proxied = await fetch(`${f.url}/v1/messages?beta=true`, {
      method: "POST", headers: { ...headers(f.token), "x-forwarded-test": "kept" }, body: source,
    });
    assert.equal(proxied.status, 201); assert.equal(proxied.headers.get("x-backend"), "yes");
    assert.equal(await proxied.text(), source);
    assert.equal(f.backendRequests.length, 1);
    assert.equal(f.backendRequests[0]!.url, "/v1/messages?beta=true");
    assert.equal(f.backendRequests[0]!.headers["x-forwarded-test"], "kept");
    assert.equal(f.backendRequests[0]!.body.toString(), source);

    const native = fetch(`${f.url}/v1/messages`, { method: "POST", headers: headers(f.token), body: JSON.stringify(stageOne()) });
    await new Promise<void>(resolve => { entered = resolve; });
    const health = await fetch(`${f.url}/health`, { headers: { authorization: `Bearer ${f.token}` } });
    assert.deepEqual(await health.json(), { status: "ok", active: 0, nativeActive: 1 });
    release(); assert.equal((await native).status, 200);
  } finally { await f.stop(); }
});

test("uses context proxies only in the private backend clone and waits for them at shutdown", async () => {
  let closed = 0;
  const f = await fixture(async (_payload, model) => nativeMessage(model), {
    native: { contextProviders: ["qwen"] },
    contextProxyFactory: async provider => ({
      provider: { ...provider, baseUrl: "http://127.0.0.1:45678/v1", tailnet: false },
      isIdle: () => true,
      close: async () => { closed++; },
    }),
  });
  try {
    const qwen = f.backendConfig.providers.find(provider => provider.id === "qwen")!;
    assert.equal(qwen.baseUrl, "http://127.0.0.1:45678/v1");
    assert.equal(qwen.tailnet, false);
    const original = JSON.parse(await (await import("node:fs/promises")).readFile(f.gatewayConfig, "utf8")) as GatewayConfig;
    assert.equal(original.providers.find(provider => provider.id === "qwen")!.baseUrl, "http://127.0.0.1:1/v1");
  } finally {
    await f.stop();
  }
  assert.equal(closed, 1);
});

test("limits native Claude work to two active calls and rejects malformed native completions", async () => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let started = 0; let bothStarted!: () => void; const both = new Promise<void>(resolve => { bothStarted = resolve; });
  const f = await fixture(async (_payload, model) => {
    if (++started === 2) bothStarted();
    await waiting;
    return nativeMessage(model);
  });
  try {
    const request = () => fetch(`${f.url}/v1/messages`, { method: "POST", headers: headers(f.token), body: JSON.stringify(stageOne()) });
    const first = request(); const second = request(); await both;
    const third = await request();
    assert.equal(third.status, 429);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  } finally { await f.stop(); }

  const malformed = await fixture(async (_payload, model) => ({ ...nativeMessage(model), content: [{ type: "tool_use", id: "tool", name: "bad", input: {} }] }));
  try {
    const response = await fetch(`${malformed.url}/v1/messages`, { method: "POST", headers: headers(malformed.token), body: JSON.stringify(stageOne()) });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /Native Claude request failed/);
    assert.equal(malformed.backendRequests.length, 0);
  } finally { await malformed.stop(); }
});

test("cancels native work and returns only fixed native failure messages", async () => {
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void; const didAbort = new Promise<void>(resolve => { aborted = resolve; });
  const f = await fixture(async (_payload, model, options) => {
    started();
    await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => { aborted(); reject(Object.assign(new Error("secret native detail"), { status: 503 })); }, { once: true }));
    return nativeMessage(model);
  });
  try {
    const controller = new AbortController();
    const request = fetch(`${f.url}/v1/messages`, { method: "POST", headers: headers(f.token), signal: controller.signal, body: JSON.stringify(stageOne()) });
    await began;
    controller.abort();
    await assert.rejects(request, /abort/i); await didAbort;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.running.isIdle(), true);
  } finally { await f.stop(); }

  const failed = await fixture(async () => { throw Object.assign(new Error("private native details"), { status: 400 }); });
  try {
    const response = await fetch(`${failed.url}/v1/messages`, { method: "POST", headers: headers(failed.token), body: JSON.stringify(stageOne()) });
    assert.equal(response.status, 400);
    const reply = await response.text();
    assert.match(reply, /Native Claude request is unsupported/);
    assert.doesNotMatch(reply, /private native details/);
    assert.equal(failed.backendRequests.length, 0);
  } finally { await failed.stop(); }
});

test("does not proxy a disconnected request after delayed classifier rejection while the frontend remains available", async () => {
  let classifierEntered!: () => void; const classifierStarted = new Promise<void>(resolve => { classifierEntered = resolve; });
  let releaseClassifier!: () => void; const classifierWaiting = new Promise<void>(resolve => { releaseClassifier = resolve; });
  let backendEntered!: () => void; const backendStarted = new Promise<void>(resolve => { backendEntered = resolve; });
  let releaseBackend!: () => void; const backendWaiting = new Promise<void>(resolve => { releaseBackend = resolve; });
  const cancelledPayload = JSON.stringify(stageOne());
  const f = await fixture(async (_payload, model) => nativeMessage(model), {
    nativeClassifierRequest: async () => {
      classifierEntered();
      await classifierWaiting;
      return false;
    },
    backendResponse: async (request, response, bytes) => {
      if (request.url === "/v1/messages" && bytes.toString() === cancelledPayload) {
        backendEntered();
        await backendWaiting;
      }
      if (request.url?.startsWith("/health")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ok", active: 0 }));
      } else {
        response.writeHead(201, { "content-type": "application/octet-stream" });
        response.end(bytes);
      }
    },
  });
  try {
    const controller = new AbortController();
    const frontResponseClosed = new Promise<void>(resolve => {
      f.running.server.once("request", (_request, response) => response.once("close", resolve));
    });
    const request = fetch(`${f.url}/v1/messages`, {
      method: "POST", headers: headers(f.token), signal: controller.signal, body: cancelledPayload,
    });
    await classifierStarted;
    controller.abort();
    await assert.rejects(request, /abort/i);
    await frontResponseClosed;
    releaseClassifier();
    const outcome = await Promise.race([
      waitFor(() => f.running.isIdle(), "frontend did not become idle").then(() => "idle"),
      backendStarted.then(() => "backend"),
    ]);
    assert.equal(outcome, "idle");
    assert.equal(f.backendRequests.length, 0);
    assert.equal(f.running.server.listening, true);
    assert.equal(f.running.isIdle(), true);
    const health = await fetch(`${f.url}/health`, { headers: { authorization: `Bearer ${f.token}` } });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", active: 0, nativeActive: 0 });
    const ordinary = JSON.stringify({ model: "claude/sonnet", stream: true, messages: [], tools: [{ name: "tool" }] });
    const proxied = await fetch(`${f.url}/v1/messages`, { method: "POST", headers: headers(f.token), body: ordinary });
    assert.equal(proxied.status, 201);
    assert.equal(await proxied.text(), ordinary);
    assert.equal(f.backendRequests.length, 2);
    assert.equal(f.backendRequests[1]!.body.toString(), ordinary);
  } finally {
    releaseBackend();
    await f.stop();
  }
});

test("close waits for an aborted native runner to settle before reporting completion", async () => {
  let started!: () => void; const began = new Promise<void>(resolve => { started = resolve; });
  let letRunnerExit!: () => void; const runnerExit = new Promise<void>(resolve => { letRunnerExit = resolve; });
  const f = await fixture(async (_payload, _model, options) => {
    started();
    await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    await runnerExit;
    throw Object.assign(new Error("owned child ended"), { status: 503 });
  });
  try {
    const request = fetch(`${f.url}/v1/messages`, { method: "POST", headers: headers(f.token), body: JSON.stringify(stageOne()) });
    await began;
    let settled = false;
    const closing = f.running.close().then(() => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    letRunnerExit();
    await closing;
    await assert.rejects(request);
    assert.equal(f.running.isIdle(), true);
  } finally { await f.stop(); }
});

test("refuses native maps whose configured provider, upstream model, or auth directory differs", async () => {
  const f = await fixture(async (_payload, model) => nativeMessage(model));
  try {
    await writeFile(f.nativeConfig, JSON.stringify({ command: "/usr/bin/true", authDirectory: f.authDirectory, models: { "claude/sonnet": "claude-other" } }), { mode: 0o600 });
    await assert.rejects(startClaudeDesktopInference(f.gatewayConfig, f.nativeConfig, { nativeRunner: async (_payload, model) => nativeMessage(model) }), /ownership/);
    await writeFile(f.nativeConfig, JSON.stringify({ command: "/usr/bin/true", models: { "claude/sonnet": "claude-sonnet-5" } }), { mode: 0o600 });
    await assert.rejects(startClaudeDesktopInference(f.gatewayConfig, f.nativeConfig, { nativeRunner: async (_payload, model) => nativeMessage(model) }), /ownership/);
  } finally { await f.stop(); }
});

test("rolls back all owned startup resources when the token read or front bind fails", async () => {
  let tokenClosed = 0;
  await assert.rejects(fixture(async (_payload, model) => nativeMessage(model), {
    native: { contextProviders: ["qwen"] },
    contextProxyFactory: async provider => ({ provider, isIdle: () => true, close: async () => { tokenClosed++; } }),
    tokenReader: async () => { throw new Error("token unavailable"); },
  }), /token unavailable/);
  assert.equal(tokenClosed, 1);

  const occupied = createServer(); occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  const port = (occupied.address() as { port: number }).port;
  let bindClosed = 0;
  try {
    await assert.rejects(fixture(async (_payload, model) => nativeMessage(model), {
      port, native: { contextProviders: ["qwen"] },
      contextProxyFactory: async provider => ({ provider, isIdle: () => true, close: async () => { bindClosed++; } }),
    }), /EADDRINUSE/);
    assert.equal(bindClosed, 1);
  } finally { await close(occupied); }
});
