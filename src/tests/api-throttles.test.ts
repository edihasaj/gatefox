import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { ProviderConfig } from "../config.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { ProviderError, type Provider } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";

const privateMessage = "upstream secret or caller prompt must not escape";
const key = "GATEWAY_API_THROTTLE_FIXTURE_KEY";

/** Runs one request against an upstream that always answers 429 with the given headers and error body. */
async function throttled(make: (config: ProviderConfig) => Provider, type: ProviderConfig["type"], headers: Record<string, string>, error: Record<string, unknown>): Promise<ProviderError> {
  let hits = 0;
  const upstream = createServer((_request, response) => {
    hits++; response.writeHead(429, { "Content-Type": "application/json", ...headers });
    response.end(JSON.stringify({ type: "error", error: { message: privateMessage, ...error } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const previous = process.env[key]; process.env[key] = "fixture-only";
  const provider = make({ id: "fixture", type, apiKeyEnv: key, baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`, models: { alias: "upstream" } });
  try {
    let caught: unknown;
    try { for await (const _event of provider.infer({ model: "upstream", input: "fixture" }, new AbortController().signal)) {} }
    catch (failure) { caught = failure; }
    assert.ok(caught instanceof ProviderError); assert.ok(!JSON.stringify(caught).includes(privateMessage)); assert.ok(!caught.message.includes(privateMessage));
    assert.equal(hits, 1, "the provider itself sends one request; Codex owns the retry");
    return caught;
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    upstream.closeAllConnections(); upstream.close();
  }
}

for (const [name, make, type, throttleError] of [
  ["Anthropic API", (config: ProviderConfig) => new AnthropicAPI(config), "anthropic-api", { type: "rate_limit_error" }],
  ["Chat Completions API", (config: ProviderConfig) => new ChatCompletionsAPI(config), "chat-completions-api", { code: "limit_requests" }],
] as const) {
  test(`${name}: a per-minute 429 stays retryable for Codex; a 429 without a wait or throttle name is a final usage limit`, async () => {
    const short = await throttled(make, type, { "retry-after": "2" }, {});
    assert.equal(short.code, "rate_limit_exceeded"); assert.equal(short.status, 429); assert.equal(streamFailureCode(short), "rate_limit_exceeded");
    assert.equal(short.upstream?.retryAfterMs, 2000);
    const named = await throttled(make, type, {}, throttleError);
    assert.equal(named.code, "rate_limit_exceeded"); assert.equal(streamFailureCode(named), "rate_limit_exceeded");
    const limit = await throttled(make, type, {}, {});
    assert.equal(limit.code, "usage_limit"); assert.equal(limit.status, 429); assert.equal(streamFailureCode(limit), "invalid_prompt");
    const quota = await throttled(make, type, { "retry-after": "2" }, { code: "insufficient_quota" });
    assert.equal(quota.code, "usage_limit", "a named quota stays final even with a short wait");
  });
}
