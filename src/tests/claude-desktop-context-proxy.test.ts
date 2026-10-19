import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { startClaudeContextProxy } from "../claude-desktop-context-proxy.js";
import type { ProviderConfig } from "../config.js";

const token = "fixture-context-proxy-token";

const close = (server: Server) => new Promise<void>(resolve => {
  if (!server.listening) resolve();
  else server.close(() => resolve());
});

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}

function provider(baseUrl = "http://127.0.0.1:1/v1"): ProviderConfig {
  return {
    id: "qwen",
    type: "chat-completions-api",
    baseUrl,
    apiKeyEnv: "CONTEXT_PROXY_FIXTURE_KEY",
    models: { "qwen/flash": "qwen-flash" },
  };
}

const authorization = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("condition did not become true");
}

test("forwards only the fixed endpoint with exact bytes, query, response headers, and configured bearer", async () => {
  const seen: Array<{ url: string; body: Buffer; authorization: string | undefined }> = [];
  const upstream = await listen(async (request, response) => {
    seen.push({ url: request.url || "", body: await readBody(request), authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "kept" });
    response.end(Buffer.from("data: first\n\ndata: [DONE]\n\n"));
  });
  const original = provider(upstream.baseUrl);
  const proxy = await startClaudeContextProxy(original, { credentialReader: async () => token });
  try {
    const body = Buffer.from('{"model":"qwen-flash","stream":true}');
    const response = await fetch(`${proxy.provider.baseUrl}/chat/completions?trace=1`, {
      method: "POST",
      headers: { ...authorization, "x-client-header": "kept" },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-upstream"), "kept");
    assert.equal(await response.text(), "data: first\n\ndata: [DONE]\n\n");
    assert.deepEqual(seen, [{
      url: "/v1/chat/completions?trace=1",
      body,
      authorization: `Bearer ${token}`,
    }]);
    assert.equal(proxy.provider.tailnet, false);
    assert.equal(original.baseUrl, upstream.baseUrl);
    assert.equal(original.tailnet, undefined);
    assert.equal(proxy.isIdle(), true);
  } finally {
    await proxy.close();
    await close(upstream.server);
  }
});

test("requires proxy authentication and rejects other methods or paths before calling upstream", async () => {
  let calls = 0;
  const proxy = await startClaudeContextProxy(provider(), {
    credentialReader: async () => token,
    fetch: async () => { calls++; return new Response("unused"); },
  });
  try {
    const base = proxy.provider.baseUrl;
    assert.equal((await fetch(`${base}/chat/completions`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/v1/other`, { method: "POST", headers: authorization, body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/chat/completions`, { method: "GET", headers: authorization })).status, 404);
    assert.equal(calls, 0);
  } finally {
    await proxy.close();
  }
});

test("sanitizes an unavailable credential reader without starting upstream work", async () => {
  let calls = 0;
  const proxy = await startClaudeContextProxy(provider(), {
    credentialReader: async () => { throw new Error("private credential failure"); },
    fetch: async () => { calls++; return new Response("unused"); },
  });
  try {
    const response = await fetch(`${proxy.provider.baseUrl}/chat/completions`, {
      method: "POST", headers: authorization, body: "{}",
    });
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /private credential failure/);
    assert.equal(calls, 0);
    assert.equal(proxy.isIdle(), true);
  } finally {
    await proxy.close();
  }
});

test("normalizes only the trusted numeric vLLM input-token overflow", async () => {
  const trusted = JSON.stringify({
    error: {
      message: "This model's maximum context length is 500000 tokens. However, you requested 1 output tokens and your prompt contains at least 500000 input tokens, for a total of at least 500001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=500000)",
      type: "BadRequestError",
      param: "input_tokens",
      code: 400,
    },
  });
  const cases = [
    { status: 400, body: trusted, translated: true },
    { status: 400, body: JSON.stringify({ error: { message: "max_tokens=500001 cannot be greater than max_model_len=max_total_tokens=500000. Please request fewer output tokens. (parameter=max_tokens, value=500001)", type: "BadRequestError", param: "max_tokens", code: 400 } }), translated: false },
    { status: 400, body: trusted.replace("BadRequestError", "OtherError"), translated: false },
    { status: 400, body: trusted.replace("maximum context length is 500000", "maximum context length is 499999"), translated: false },
    { status: 400, body: trusted.replace("requested 1 output", "requested 2 output"), translated: false },
    { status: 400, body: trusted.replace("value=500000", "value=499999"), translated: false },
    { status: 400, body: trusted.replace("This model's maximum context length", "The input is too long"), translated: false },
    { status: 400, body: "{not-json", translated: false },
    { status: 500, body: trusted, translated: false },
    { status: 400, body: "x".repeat(64 * 1024 + 1), translated: false },
  ];
  for (const item of cases) {
    const proxy = await startClaudeContextProxy(provider(), {
      credentialReader: async () => token,
      fetch: async () => new Response(item.body, {
        status: item.status,
        headers: { "content-type": "application/json", "x-fixture": "yes" },
      }),
    });
    try {
      const response = await fetch(`${proxy.provider.baseUrl}/chat/completions`, {
        method: "POST", headers: authorization, body: "{}",
      });
      const body = await response.text();
      assert.equal(response.status, item.status);
      assert.equal(response.headers.get("x-fixture"), "yes");
      if (item.translated) {
        assert.deepEqual(JSON.parse(body), {
          error: {
            code: "context_length_exceeded",
            message: "The request exceeds the model's context window",
          },
        });
        assert.doesNotMatch(body, /500000|500001/);
      } else {
        assert.equal(body, item.body);
      }
    } finally {
      await proxy.close();
    }
  }
});

test("translated chunked errors remove hop-by-hop and content-encoding headers", async () => {
  const trusted = JSON.stringify({
    error: {
      message: "This model's maximum context length is 500000 tokens. However, you requested 1 output tokens and your prompt contains at least 500000 input tokens, for a total of at least 500001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=500000)",
      type: "BadRequestError",
      param: "input_tokens",
      code: 400,
    },
  });
  const proxy = await startClaudeContextProxy(provider(), {
    credentialReader: async () => token,
    fetch: async () => new Response(trusted, {
      status: 400,
      headers: {
        connection: "x-private",
        "content-encoding": "gzip",
        "transfer-encoding": "chunked",
        "x-private": "must-not-forward",
      },
    }),
  });
  try {
    const response = await fetch(`${proxy.provider.baseUrl}/chat/completions`, {
      method: "POST", headers: authorization, body: "{}",
    });
    const body = await response.text();
    assert.equal(response.headers.get("transfer-encoding"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("x-private"), null);
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
  } finally {
    await proxy.close();
  }
});

test("a direct gzip backend that ignores identity cannot double-decompress SSE or a translated 400", async () => {
  const trusted = JSON.stringify({
    error: {
      message: "This model's maximum context length is 500000 tokens. However, you requested 1 output tokens and your prompt contains at least 500000 input tokens, for a total of at least 500001 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=500000)",
      type: "BadRequestError",
      param: "input_tokens",
      code: 400,
    },
  });
  const seenAcceptEncoding: string[] = [];
  const upstream = await listen(async (request, response) => {
    seenAcceptEncoding.push(String(request.headers["accept-encoding"]));
    const isError = request.url?.includes("error");
    response.writeHead(isError ? 400 : 200, {
      connection: "x-hop",
      "content-encoding": "gzip",
      "content-type": isError ? "application/json" : "text/event-stream",
      "transfer-encoding": "chunked",
      "x-hop": "must-not-forward",
    });
    response.end(gzipSync(Buffer.from(isError ? trusted : "data: decoded\n\n")));
  });
  const proxy = await startClaudeContextProxy(provider(upstream.baseUrl), {
    credentialReader: async () => token,
  });
  try {
    const base = proxy.provider.baseUrl;
    const stream = await fetch(`${base}/chat/completions`, {
      method: "POST", headers: authorization, body: "{}",
    });
    assert.equal(await stream.text(), "data: decoded\n\n");
    assert.equal(stream.headers.get("content-encoding"), null);
    assert.equal(stream.headers.get("x-hop"), null);

    const error = await fetch(`${base}/chat/completions?error=1`, {
      method: "POST", headers: authorization, body: "{}",
    });
    assert.deepEqual(await error.json(), {
      error: {
        code: "context_length_exceeded",
        message: "The request exceeds the model's context window",
      },
    });
    assert.equal(error.headers.get("content-encoding"), null);
    assert.equal(error.headers.get("transfer-encoding"), null);
    assert.equal(error.headers.get("x-hop"), null);
    assert.deepEqual(seenAcceptEncoding, ["identity", "identity"]);
  } finally {
    await proxy.close();
    await close(upstream.server);
  }
});

test("client disconnect aborts the original request and returns to idle", async () => {
  let entered!: () => void;
  const began = new Promise<void>(resolve => { entered = resolve; });
  let aborted!: () => void;
  const didAbort = new Promise<void>(resolve => { aborted = resolve; });
  const proxy = await startClaudeContextProxy(provider(), {
    credentialReader: async () => token,
    fetch: async (_url, init) => {
      entered();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted();
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  try {
    const port = Number(new URL(proxy.provider.baseUrl!).port);
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/v1/chat/completions",
      headers: { ...authorization, "content-length": "2" },
    });
    client.on("error", () => {});
    client.end("{}");
    await began;
    client.destroy();
    await didAbort;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(proxy.isIdle(), true);
  } finally {
    await proxy.close();
  }
});

test("an aborted upload and an owned close leave no active proxy request", async () => {
  let calls = 0;
  let authenticated!: () => void;
  const didAuthenticate = new Promise<void>(resolve => { authenticated = resolve; });
  const proxy = await startClaudeContextProxy(provider(), {
    credentialReader: async () => {
      authenticated();
      return token;
    },
    fetch: async () => { calls++; return new Response("unused"); },
  });
  const port = Number(new URL(proxy.provider.baseUrl!).port);
  const client = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: "/v1/chat/completions",
    headers: { ...authorization, "content-length": "1048576" },
  });
  client.on("error", () => {});
  try {
    client.write("{");
    await didAuthenticate;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(proxy.isIdle(), false);
    client.destroy();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 0);
    assert.equal(proxy.isIdle(), true);
    await proxy.close();
    await proxy.close();
  } finally {
    client.destroy();
    await proxy.close();
  }
});

test("a delayed credential cannot start upstream work after disconnect or close", async () => {
  for (const action of ["disconnect", "close"] as const) {
    let release!: (value: string) => void;
    const credential = new Promise<string>(resolve => { release = resolve; });
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    let calls = 0;
    const proxy = await startClaudeContextProxy(provider(), {
      credentialReader: async () => {
        started();
        return credential;
      },
      fetch: async () => {
        calls++;
        return new Response("unexpected");
      },
    });
    const client = httpRequest({
      host: "127.0.0.1",
      port: Number(new URL(proxy.provider.baseUrl!).port),
      method: "POST",
      path: "/v1/chat/completions",
      headers: { ...authorization, "content-length": "2" },
    });
    client.on("error", () => {});
    try {
      client.end("{}");
      await didStart;
      if (action === "close") await proxy.close();
      else {
        client.destroy();
        await waitFor(() => proxy.isIdle());
      }
      release(token);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 0);
      assert.equal(proxy.isIdle(), true);
    } finally {
      client.destroy();
      await proxy.close();
    }
  }
});
