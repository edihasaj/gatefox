import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startGateway } from "../server.js";
import { gatewayToken, validateConfig, type ProviderKind } from "../config.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import { cacheGuardedInference } from "../cache-guarded-inference.js";
import { contextCacheBudget } from "../context-cache-budget.js";

const usage = { input_tokens: 200000, output_tokens: 1, total_tokens: 200001, input_tokens_details: { cached_tokens: 10000 } };
const kinds: ProviderKind[] = ["claude-subscription", "codex-subscription", "copilot-subscription", "grok-subscription",
  "responses-api", "chat-completions-api", "anthropic-api"];

for (const kind of kinds) test(`all-provider cache safety covers ${kind} through Responses and Messages`, async () => {
  const state = await mkdtemp(join(tmpdir(), "cache-fleet-")); let calls = 0;
  const provider: Provider = { async *infer() { calls++; yield { type: "text", text: "ok" }; yield { type: "done", usage }; } };
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{
    id: "test", type: kind, models: { alias: "upstream" },
    ...(["responses-api", "chat-completions-api", "anthropic-api"].includes(kind) ? { baseUrl: "https://metered.invalid/v1", apiKeyEnv: "UNUSED_CACHE_GUARD_KEY" } : {}),
    ...(kind === "codex-subscription" ? { credentialFile: join(state, "unused") } : {}),
  }] });
  const server = await startGateway(config, () => provider, undefined, { onFailure() {} });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = await gatewayToken(state);
  try {
    for (const protocol of ["responses", "messages"]) for (const stream of [false, true]) {
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "thread-id": `${protocol}-${stream}` };
      const body = protocol === "responses" ? { model: "alias", input: "Repeated history", stream }
        : { model: "alias", max_tokens: 10, messages: [{ role: "user", content: "Repeated history" }], stream };
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetch(base + "/v1/" + protocol, { method: "POST", headers, body: JSON.stringify(body) });
        const text = await response.text();
        if (!stream) assert.equal(response.status, attempt < 2 ? 200 : 400);
        else if (attempt === 2) {
          const frames = text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
          if (protocol === "responses") assert.equal(frames.at(-1).response.error.code, "invalid_prompt");
          else assert.ok(frames.some(frame => frame.type === "error" && frame.error.type === "invalid_request_error"));
        }
      }
    }
    assert.equal(calls, 8, "neither ingress protocol or streaming mode spends on its third cold request");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

for (const [label, row] of [["loopback", { baseUrl: "http://127.0.0.1:1/v1" }], ["tailnet", { baseUrl: "http://models.example.ts.net:4000/v1", tailnet: true }]] as const) {
  test(`a ${label} self-hosted model keeps working through repeated cache misses`, async () => {
    const state = await mkdtemp(join(tmpdir(), "cache-local-")); let calls = 0;
    const provider: Provider = { async *infer() { calls++; yield { type: "text", text: "ok" }; yield { type: "done", usage }; } };
    const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{ id: "local", type: "chat-completions-api", models: { alias: "upstream" }, apiKeyEnv: "UNUSED_CACHE_GUARD_KEY", selfHosted: true, ...row }] });
    const server = await startGateway(config, () => provider, undefined, { onFailure() {} });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const token = await gatewayToken(state);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetch(base + "/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "thread-id": "local-worker" },
          body: JSON.stringify({ model: "alias", input: "Repeated history", stream: false }) });
        assert.equal(response.status, 200);
      }
      assert.equal(calls, 5, "a local cache miss never stops the worker");
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}

test("a local address alone stays stopped, because it can be a proxy to a metered upstream", async () => {
  const state = await mkdtemp(join(tmpdir(), "cache-proxy-")); let calls = 0;
  const provider: Provider = { async *infer() { calls++; yield { type: "text", text: "ok" }; yield { type: "done", usage }; } };
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state, providers: [{ id: "proxy", type: "responses-api", models: { alias: "gpt-paid" }, baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "UNUSED_CACHE_GUARD_KEY" }] });
  const server = await startGateway(config, () => provider, undefined, { onFailure() {} });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = await gatewayToken(state);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(base + "/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "thread-id": "proxy-worker" },
        body: JSON.stringify({ model: "alias", input: "Repeated history", stream: false }) });
      assert.equal(response.status, attempt < 2 ? 200 : 400);
    }
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("selfHosted is refused away from a loopback or tailnet inference provider", () => {
  const row = { id: "x", models: { alias: "upstream" }, apiKeyEnv: "UNUSED_CACHE_GUARD_KEY", selfHosted: true };
  assert.throws(() => validateConfig({ version: 1, port: 0, stateDirectory: "/tmp/unused", providers: [{ ...row, type: "responses-api", baseUrl: "https://openrouter.ai/api/v1" }] }), /selfHosted requires/);
  assert.throws(() => validateConfig({ version: 1, port: 0, stateDirectory: "/tmp/unused", providers: [{ id: "x", type: "codex-subscription", models: { alias: "upstream" }, credentialFile: "/tmp/unused/c", selfHosted: true }] }), /selfHosted/);
});

test("a metered provider on the same request shape still stops, so only an advisory budget continues", () => {
  const scope = "advisory-scope"; const cold = { read: 0, uncached: 200000, input: 200000 };
  for (const advisory of [true, false]) {
    const budget = contextCacheBudget(scope + advisory, "thread", "model", 1000, { advisory });
    budget.record(cold); budget.record(cold);
    if (advisory) budget.beforeRequest("provider");
    else assert.throws(() => budget.beforeRequest("provider"), { code: "invalid_request" });
  }
});

test("shared guard retains measured cache costs when any provider fails", async () => {
  let calls = 0;
  const provider: Provider = { async *infer(_request, _signal, context) {
    calls++; context?.observeCacheUsage?.({ inputTokens: 200000, cachedTokens: 10000 });
    throw new ProviderError("upstream_error", "Provider failed after reported input usage", 502);
  } };
  const turn = async () => {
    for await (const _ of cacheGuardedInference(provider, { model: "m", input: "history" }, new AbortController().signal, { threadId: "failure" }, "shared-failure")) {}
  };
  await assert.rejects(turn(), { code: "upstream_error" }); await assert.rejects(turn(), { code: "upstream_error" });
  await assert.rejects(turn(), { code: "invalid_request" }); assert.equal(calls, 2);
});

test("unknown cache metrics never become a fake zero but repeated large unverified inputs also stop", () => {
  const budget = contextCacheBudget("unknown-metrics", "thread", "m", 1000);
  budget.record({ input: 200000 }); budget.record({ input: 200000 });
  assert.throws(() => budget.beforeRequest("provider"), error => error instanceof ProviderError && /did not report cache reuse/.test(error.message));
});

test("shared guard reports a final streaming error rather than a reconnectable failure", async () => {
  const state = await mkdtemp(join(tmpdir(), "cache-stream-")); let calls = 0;
  const provider: Provider = { async *infer() { calls++; yield { type: "done", usage }; } };
  const config = validateConfig({ version: 1, port: 0, stateDirectory: state,
    providers: [{ id: "p", type: "claude-subscription", models: { alias: "m" } }] });
  const server = await startGateway(config, () => provider, undefined, { onFailure() {} });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const token = await gatewayToken(state);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(base + "/v1/responses", { method: "POST", headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", "thread-id": "stream" },
        body: JSON.stringify({ model: "alias", input: "history", stream: true }) });
      const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: ") && !line.includes("[DONE]"))
        .map(line => JSON.parse(line.slice(6)) as { type: string; response?: { error?: { code?: string } } });
      assert.equal(frames.at(-1)?.type, attempt < 2 ? "response.completed" : "response.failed");
      if (attempt === 2) assert.equal(frames.at(-1)?.response?.error?.code, "invalid_prompt");
    }
    assert.equal(calls, 2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("compaction has a separate bounded budget and can recover an ordinary blocked chat", async () => {
  let calls = 0;
  const provider: Provider = { async *infer() { calls++; yield { type: "done", usage }; } };
  const turn = async (input: string, compaction = false) => {
    for await (const _ of cacheGuardedInference(provider, { model: "m", input }, new AbortController().signal,
      { threadId: "compact", ...(compaction ? { requestKind: "compaction" } : {}) }, "bounded-compaction")) {}
  };
  await turn("a".repeat(1000)); await turn("a".repeat(1000));
  await assert.rejects(turn("a".repeat(1000)), { code: "invalid_request" });
  await turn("a".repeat(1000), true); await turn("a".repeat(1000), true);
  await assert.rejects(turn("a".repeat(1000), true), { code: "invalid_request" });
  await turn("Short compacted conversation"); assert.equal(calls, 5);
});

test("a client's side requests neither trip nor inherit the conversation's cache stop", async () => {
  const provider: Provider = { async *infer() { yield { type: "done", usage }; } };
  const turn = async (auxiliary = false) => {
    for await (const _ of cacheGuardedInference(provider, { model: "m", input: "a".repeat(1000) }, new AbortController().signal,
      { sessionId: "side", ...(auxiliary ? { requestKind: "auxiliary" as const } : {}) }, "bounded-side-requests")) {}
  };
  await turn(); await turn();
  await assert.rejects(turn(), { code: "invalid_request" });
  await turn(true);
  await assert.rejects(turn(), { code: "invalid_request" }, "a side request does not clear the conversation's stop");
});
