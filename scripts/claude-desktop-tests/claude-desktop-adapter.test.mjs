import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { startAdapter, validateConfig } from "../claude-desktop-adapter.mjs";

const resources = [];

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  resources.push(() => new Promise((resolve) => server.close(resolve)));
  return { server, port: server.address().port };
}

function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: options.path ?? "/", method: options.method ?? "GET",
      headers: options.headers,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (options.body !== undefined) req.end(options.body);
    else req.end();
  });
}

async function adapter(stubHandler, extra = {}) {
  const upstream = await listen(stubHandler);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-"));
  const tokenFile = path.join(folder, "token");
  fs.writeFileSync(tokenFile, "adapter-secret\n", { mode: 0o600 });
  const { auditFile: requestedAudit, models: requestedModels, ...other } = extra;
  const auditFile = requestedAudit === true ? path.join(folder, "audit", "requests.jsonl") : requestedAudit;
  const started = await startAdapter({ config: {
    listenPort: 0, upstream: `http://127.0.0.1:${upstream.port}`, tokenFile,
    models: requestedModels ?? [{ id: "claude-alias", upstream: "upstream-model", displayName: "Claude Alias", contextWindow: 200000 }],
    ...other, ...(auditFile === undefined ? {} : { auditFile }),
  } });
  resources.push(() => started.close());
  resources.push(() => fs.rmSync(folder, { recursive: true, force: true }));
  return { ...started, auditFile };
}

function credentials(kind = "bearer") {
  return kind === "key" ? { "x-api-key": "adapter-secret" } : { authorization: "Bearer adapter-secret" };
}

afterEach(async () => {
  while (resources.length) await resources.pop()();
});

test("validates config and authenticates every local endpoint", async () => {
  assert.throws(() => validateConfig({ listenPort: 9, upstream: "https://127.0.0.1:9", tokenFile: "/tmp/t", models: [] }), /invalid config/);
  assert.throws(() => validateConfig({
    listenPort: 9, upstream: "http://127.0.0.1:9", tokenFile: "/tmp/t",
    models: [{ id: "same", upstream: "one", displayName: "One" }, { id: "same", upstream: "two", displayName: "Two" }],
  }), /duplicate model/);
  assert.throws(() => validateConfig({
    listenPort: 9, upstream: "http://127.0.0.1:9", tokenFile: "relative",
    models: [{ id: "valid", upstream: "one", displayName: "One" }],
  }), /tokenFile/);
  const started = await adapter((_req, res) => res.end());
  const denied = await request(started.port, { path: "/health" });
  assert.equal(denied.status, 401);
  const conflict = await request(started.port, { path: "/health", headers: { authorization: "Bearer adapter-secret", "x-api-key": "different" } });
  assert.equal(conflict.status, 401);
  const healthy = await request(started.port, { path: "/health", headers: credentials("key") });
  assert.deepEqual(JSON.parse(healthy.body), { status: "ok", models: 1 });
});

test("serves Anthropic model catalog and model detail", async () => {
  const started = await adapter((_req, res) => res.end());
  const list = await request(started.port, { path: "/v1/models", headers: credentials() });
  assert.equal(list.status, 200);
  assert.deepEqual(JSON.parse(list.body).data[0], {
    id: "claude-alias", type: "model", display_name: "Claude Alias",
    created_at: "2026-01-01T00:00:00Z", context_window: 200000,
  });
  const detail = await request(started.port, { path: "/v1/models/claude-alias", headers: credentials() });
  assert.equal(JSON.parse(detail.body).id, "claude-alias");
  const missing = await request(started.port, { path: "/v1/models/not-configured", headers: credentials() });
  assert.equal(missing.status, 404);
});

test("explicit picker variants select effort and speed through tool continuation history", async () => {
  let received;
  const started = await adapter((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "claude/opus", content: [] }));
    });
  }, { models: [{ id: "claude-variant", upstream: "claude/opus", displayName: "Opus · Max · Fast", reasoningEffort: "max", serviceTier: "priority" }] });
  const system = { role: "system", content: "Keep the instruction", output_config: { effort: "low" } };
  const reply = await request(started.port, { path: "/v1/messages", method: "POST", headers: credentials(), body: JSON.stringify({
    model: "claude-variant", output_config: { effort: "medium" }, service_tier: "default", thinking: { type: "adaptive", display: "omitted" },
    messages: [system, { role: "user", content: "Hello" }],
  }) });
  assert.equal(reply.status, 200);
  assert.equal(received.model, "claude/opus");
  assert.deepEqual(received.output_config, { effort: "max" });
  assert.equal(received.service_tier, "priority");
  assert.deepEqual(received.messages[0], { ...system, output_config: { effort: "max" } });
  assert.deepEqual(received.thinking, { type: "adaptive", display: "omitted" });
  assert.equal(JSON.parse(reply.body).model, "claude-variant");
  const thinking = await request(started.port, { path: "/v1/messages", method: "POST", headers: credentials(), body: JSON.stringify({
    model: "claude-variant", max_tokens: 1024, thinking: { type: "disabled" }, messages: [{ role: "user", content: "Think about this" }],
  }) });
  assert.equal(thinking.status, 200);
  assert.deepEqual(received.thinking, { type: "adaptive" });
  assert.deepEqual(received.output_config, { effort: "max" });
  const review = { model: "claude-variant", max_tokens: 64, thinking: { type: "disabled" },
    stop_sequences: ["</severity>"], messages: [{ role: "user", content: "Review the action" }] };
  const reviewed = await request(started.port, { path: "/v1/messages", method: "POST", headers: credentials(), body: JSON.stringify(review) });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(received, { ...review, model: "claude/opus" });
});

test("forwards only the top-level model and preserves the query and all other JSON", async () => {
  let received;
  const started = await adapter((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = { url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "upstream-model", content: [{ type: "text", text: "ok" }] }));
    });
  });
  const body = JSON.stringify({ model: "claude-alias", stream: false, nested: { model: "leave-me" }, messages: [{ role: "user", content: "private body" }] });
  const reply = await request(started.port, {
    path: "/v1/messages?beta=true&x=%2F", method: "POST",
    headers: { ...credentials(), "x-custom": "retained", "content-type": "application/json" }, body,
  });
  assert.equal(received.url, "/v1/messages?beta=true&x=%2F");
  assert.equal(received.headers["x-custom"], "retained");
  assert.equal(received.body.model, "upstream-model");
  assert.equal(received.body.nested.model, "leave-me");
  assert.equal(JSON.parse(reply.body).model, "claude-alias");
  assert.equal(reply.headers["content-length"], undefined);
});

test("forwards to an IPv6 loopback upstream", async (t) => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      assert.equal(JSON.parse(Buffer.concat(chunks)).model, "upstream-model");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "upstream-model", content: [] }));
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    });
  } catch (failure) {
    if (["EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH"].includes(failure.code)) {
      t.skip(`IPv6 loopback is unavailable (${failure.code})`);
      return;
    }
    throw failure;
  }
  resources.push(() => new Promise((resolve) => server.close(resolve)));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-ipv6-"));
  const tokenFile = path.join(folder, "token");
  fs.writeFileSync(tokenFile, "adapter-secret\n", { mode: 0o600 });
  const config = {
    listenPort: 0, upstream: `http://[::1]:${server.address().port}`, tokenFile,
    models: [{ id: "claude-alias", upstream: "upstream-model", displayName: "Claude Alias" }],
  };
  const validated = validateConfig(config);
  assert.equal(validated.upstream, config.upstream);
  assert.equal(validated.upstreamTarget.hostname, "::1");
  const started = await startAdapter({ config });
  resources.push(() => started.close());
  resources.push(() => fs.rmSync(folder, { recursive: true, force: true }));
  const reply = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-alias", messages: [] }),
  });
  assert.equal(reply.status, 200);
  assert.equal(JSON.parse(reply.body).model, "claude-alias");
});

test("preserves optional tool omission only for the opt-in route", async () => {
  const schema = { type: "object", properties: {
    optional: { type: "string" }, explicitNullable: { type: ["string", "null"] }, required: { type: "string" },
  }, required: ["required"] };
  const seen = [];
  const started = await adapter((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks));
      seen.push(payload);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "upstream-model", content: [{
        type: "tool_use", name: "call", input: { optional: null, explicitNullable: null, required: null },
      }] }));
    });
  }, { models: [
    { id: "opt-in", upstream: "upstream-model", displayName: "Opt in", preserveOptionalToolArguments: true },
    { id: "plain", upstream: "upstream-model", displayName: "Plain" },
  ] });
  for (const model of ["opt-in", "plain"]) {
    await request(started.port, {
      path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
      body: JSON.stringify({ model, tools: [{ name: "call", input_schema: schema }], messages: [] }),
    });
  }
  assert.deepEqual(seen[0].tools[0].input_schema.properties.optional, {
    anyOf: [{ type: "string" }, { type: "null" }],
  });
  assert.deepEqual(seen[1].tools[0].input_schema, schema);
  const optedIn = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: "opt-in", tools: [{ name: "call", input_schema: schema }], messages: [] }),
  });
  const plain = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: "plain", tools: [{ name: "call", input_schema: schema }], messages: [] }),
  });
  assert.deepEqual(JSON.parse(optedIn.body).content[0].input, { explicitNullable: null, required: null });
  assert.deepEqual(JSON.parse(plain.body).content[0].input, { optional: null, explicitNullable: null, required: null });
});

test("rewrites fragmented multiline CRLF SSE message_start and preserves ping frames", async () => {
  const started = await adapter((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": ping\r\n\r\n");
    const event = "event: message_start\r\n: retain this comment\r\ndata: {\"type\":\"message_start\",\r\ndata: \"message\":{\"model\":\"upstream-model\",\"id\":\"x\"}}\r\n\r\n";
    for (const piece of [event.slice(0, 17), event.slice(17, 57), event.slice(57)]) res.write(piece);
    res.end("event: message_delta\r\ndata: {\"type\":\"message_delta\",\"delta\":{\"text\":\"hello\"}}\r\n\r\n");
  });
  const reply = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-alias", stream: true, messages: [] }),
  });
  assert.equal(reply.status, 200);
  assert.match(reply.body, /^: ping\r\n\r\n/);
  assert.match(reply.body, /: retain this comment\r\n/);
  assert.match(reply.body, /"model":"claude-alias"/);
  const rewritten = /event: message_start\r\n: retain this comment\r\ndata: (.+?)\r\n\r\n/.exec(reply.body);
  assert.equal(JSON.parse(rewritten[1]).message.model, "claude-alias");
  assert.equal((rewritten[0].match(/(?:^|\r\n)data:/g) ?? []).length, 1);
  assert.match(reply.body, /event: message_delta\r\ndata: \{"type":"message_delta"/);
});

test("preserves upstream errors and aborts an upstream request when the client cancels", async () => {
  let responseCancelled;
  const responseCancelledPromise = new Promise((resolve) => { responseCancelled = resolve; });
  const started = await adapter((req, res) => {
    if (req.url.includes("error")) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {\"type\":\"ping\"}\n\n");
    res.on("close", () => {
      if (!res.writableEnded) responseCancelled();
    });
  });
  const failure = await request(started.port, {
    path: "/v1/messages/error", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-alias", messages: [] }),
  });
  assert.equal(failure.status, 404); // unknown paths never reach upstream
  const errorReply = await request(started.port, {
    path: "/v1/messages?error=1", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-alias", messages: [] }),
  });
  assert.equal(errorReply.status, 429);
  await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: started.port, path: "/v1/messages", method: "POST",
      headers: { ...credentials(), "content-type": "application/json" },
    });
    req.on("response", (res) => res.once("data", () => {
      res.destroy();
      resolve();
    }));
    req.on("error", (failure) => failure.code === "ECONNRESET" ? resolve() : reject(failure));
    req.end(JSON.stringify({ model: "claude-alias", messages: [] }));
  });
  await Promise.race([
    responseCancelledPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("upstream SSE was not cancelled")), 500)),
  ]);
});

test("audits only known response model names", async () => {
  const malicious = "untrusted-model-with-private-request-content";
  const started = await adapter((req, res) => {
    if (req.url.includes("stream=1")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: {"type":"message_start","message":{"model":"${malicious}"}}\n\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", model: malicious }));
  }, { auditFile: true });
  for (const suffix of ["", "?stream=1"]) {
    await request(started.port, {
      path: `/v1/messages${suffix}`, method: "POST",
      headers: { ...credentials(), "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-alias", messages: [] }),
    });
  }
  const entries = fs.readFileSync(started.auditFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 2);
  assert.equal(entries.every((entry) => entry.observedUpstreamResponseModel === "unexpected"), true);
  assert.equal(fs.readFileSync(started.auditFile, "utf8").includes(malicious), false);
});

const BRIDGE = "claude-opus-5[hg-route-42]";
const LEGACY = "claude-hg-route-42";

test("accepts only the native-control bridge ID shape", () => {
  const config = (id) => ({
    listenPort: 9, upstream: "http://127.0.0.1:9", tokenFile: "/tmp/t",
    models: [{ id, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: ["low", "high"] }],
  });
  assert.equal(validateConfig(config(BRIDGE)).models[0].id, BRIDGE);
  assert.equal(validateConfig(config("claude-alias")).models[0].supportedEfforts.length, 2);
  assert.throws(() => validateConfig(config("claude-opus-5[gpt-5]")), /id is invalid/);
  assert.throws(() => validateConfig(config("claude-opus-5[hg-route-1][2]")), /id is invalid/);
  assert.throws(() => validateConfig(config("claude-hg-route-1[a]")), /id is invalid/);
  assert.throws(() => validateConfig(config("gpt-5[hg-route-1]")), /id is invalid/);
  assert.throws(() => validateConfig(config("claude-opus-5[hg-route-]")), /id is invalid/);
  assert.throws(() => validateConfig(config("claude-opus-5[hg-route-1x]")), /id is invalid/);
  assert.throws(() => validateConfig({
    listenPort: 9, upstream: "http://127.0.0.1:9", tokenFile: "/tmp/t",
    models: [{ id: BRIDGE, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: [] }],
  }), /supportedEfforts/);
  for (const supportedEfforts of [["ultra"], ["high", "high"], ["low", 5], "low"]) {
    assert.throws(() => validateConfig({
      listenPort: 9, upstream: "http://127.0.0.1:9", tokenFile: "/tmp/t",
      models: [{ id: BRIDGE, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts }],
    }), /supportedEfforts/);
  }
  assert.deepEqual(validateConfig({
    listenPort: 9, upstream: "http://127.0.0.1:9", tokenFile: "/tmp/t",
    models: [{ id: BRIDGE, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: ["max", "low"] }],
  }).models[0].supportedEfforts, ["low", "max"]);
});

test("clamps the native slider to the route's supported efforts without touching thinking", async () => {
  const cases = [
    { supported: ["low", "medium", "high", "xhigh"], sent: "max", expected: "xhigh", system: "xhigh" },
    { supported: ["low", "high"], sent: "medium", expected: "low", system: "high" },
    { supported: ["high", "xhigh"], sent: "low", expected: "high", system: "xhigh" },
    { supported: ["medium", "max"], sent: "ultra", expected: "medium", system: "max" },
    { supported: ["low", "medium", "high", "xhigh", "max"], sent: "max", expected: "max", system: "max" },
  ];
  for (const [index, testCase] of cases.entries()) {
    let received;
    const started = await adapter((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        received = JSON.parse(Buffer.concat(chunks));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", model: received.model, content: [] }));
      });
    }, { models: [{ id: `claude-opus-5[hg-route-${index}]`, upstream: `codex/gpt-${index}`, displayName: "GPT One", supportedEfforts: testCase.supported }] });
    const reply = await request(started.port, {
      path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
      body: JSON.stringify({
        model: `claude-opus-5[hg-route-${index}]`, output_config: { effort: testCase.sent, other: "keep" },
        thinking: { type: "adaptive", display: "omitted" }, max_tokens: 1024,
        messages: [{ role: "system", content: "history", output_config: { effort: "max" } }, { role: "user", content: "go" }],
      }),
    });
    assert.equal(reply.status, 200, testCase.sent);
    assert.equal(received.model, `codex/gpt-${index}`);
    assert.deepEqual(received.output_config, { effort: testCase.expected, other: "keep" });
    assert.deepEqual(received.messages[0].output_config, { effort: testCase.system });
    assert.equal(received.messages[1].output_config, undefined);
    assert.deepEqual(received.thinking, { type: "adaptive", display: "omitted" });
    assert.equal(JSON.parse(reply.body).model, `claude-opus-5[hg-route-${index}]`);
  }
});

test("sends no effort the client did not choose and keeps an Auto review untouched", async () => {
  let received;
  const started = await adapter((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: received.model, content: [] }));
    });
  }, { models: [
    { id: BRIDGE, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: ["low", "high"] },
    { id: LEGACY, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: ["low", "high"] },
  ] });
  const bare = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: BRIDGE, max_tokens: 64, messages: [{ role: "user", content: "go" }] }),
  });
  assert.equal(bare.status, 200);
  assert.equal("output_config" in received, false);
  // The saved-chat alias already names a native-shaped ID, so its review keeps its own controls.
  const review = { model: LEGACY, max_tokens: 64, output_config: { effort: "max" }, thinking: { type: "disabled" },
    stop_sequences: ["</severity>"], messages: [{ role: "user", content: "Review the action" }] };
  const reviewed = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify(review),
  });
  assert.equal(reviewed.status, 200);
  assert.deepEqual(received, { ...review, model: "codex/gpt" });
});

test("keeps an auxiliary review untouched on a bridge row and still clamps its ordinary requests", async () => {
  let received;
  const started = await adapter((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: received.model, content: [] }));
    });
  }, { models: [{ id: BRIDGE, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: ["low", "medium", "high", "xhigh"] }] });
  const review = { model: BRIDGE, max_tokens: 64, output_config: { effort: "max" }, thinking: { type: "disabled" },
    stop_sequences: ["</severity>"], messages: [{ role: "user", content: "Review the action" }] };
  const reviewed = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify(review),
  });
  assert.equal(reviewed.status, 200);
  // The app's own review keeps Max even though the row's slider stops at Extra high.
  assert.deepEqual(received, { ...review, model: "codex/gpt" });
  assert.equal(received.output_config.effort, "max");
  assert.deepEqual(received.thinking, { type: "disabled" });
  const ordinary = await request(started.port, {
    path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
    body: JSON.stringify({ model: BRIDGE, max_tokens: 1024, thinking: { type: "adaptive" },
      output_config: { effort: "max" }, messages: [{ role: "user", content: "go" }] }),
  });
  assert.equal(ordinary.status, 200);
  assert.equal(received.model, "codex/gpt");
  assert.equal(received.output_config.effort, "xhigh");
  assert.deepEqual(received.thinking, { type: "adaptive" });
});

test("routes a saved chat on the retired opaque ID and reports the bridge ID in JSON and SSE", async () => {
  const seen = [];
  const started = await adapter((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const payload = JSON.parse(Buffer.concat(chunks));
      seen.push(payload);
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: {"type":"message_start","message":{"model":"codex/gpt","id":"x"}}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: payload.model, content: [] }));
    });
  }, { models: [
    { id: BRIDGE, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: ["low", "high"] },
    { id: LEGACY, upstream: "codex/gpt", displayName: "GPT One", supportedEfforts: ["low", "high"] },
  ] });
  const listed = await request(started.port, { path: "/v1/models", headers: credentials() });
  assert.deepEqual(JSON.parse(listed.body).data.map((row) => row.id), [BRIDGE, LEGACY]);
  const detail = await request(started.port, { path: `/v1/models/${encodeURIComponent(BRIDGE)}`, headers: credentials() });
  assert.equal(JSON.parse(detail.body).id, BRIDGE);
  for (const id of [BRIDGE, LEGACY]) {
    const json = await request(started.port, {
      path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
      body: JSON.stringify({ model: id, output_config: { effort: "xhigh" }, messages: [] }),
    });
    assert.equal(JSON.parse(json.body).model, id);
    assert.equal(seen.at(-1).model, "codex/gpt");
    assert.equal(seen.at(-1).output_config.effort, "high");
    const stream = await request(started.port, {
      path: "/v1/messages", method: "POST", headers: { ...credentials(), "content-type": "application/json" },
      body: JSON.stringify({ model: id, stream: true, messages: [] }),
    });
    assert.match(stream.body, new RegExp(`"model":\\s*"${id.replace(/[\[\]()]/g, (char) => `\\${char}`)}"`));
  }
});
