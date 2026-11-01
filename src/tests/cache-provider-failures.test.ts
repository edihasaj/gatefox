import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ResponsesAPI } from "../providers/responses-api.js";
import { AnthropicAPI } from "../providers/anthropic-api.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import type { Provider } from "../providers/provider.js";
import { cacheGuardedInference } from "../cache-guarded-inference.js";

const cases = [
  { name: "Responses charged throttles do not retry internally", kind: "responses", code: "rate_limit_exceeded", events: [
    { type: "response.failed", response: { error: { code: "rate_limit_exceeded" }, usage: { input_tokens: 200000, output_tokens: 0, total_tokens: 200000, input_tokens_details: { cached_tokens: 10000 } } } },
  ] },
  { name: "Chat Completions usage survives a rejected model identity", kind: "chat", code: "model_route", events: [
    { model: "wrong-model", choices: [], usage: { prompt_tokens: 200000, completion_tokens: 0, total_tokens: 200000, prompt_tokens_details: { cached_tokens: 10000 } } },
  ] },
  { name: "Anthropic reported large input remains unknown when cache fields are absent", kind: "anthropic", code: "inference_failed", events: [
    { type: "message_start", message: { usage: { input_tokens: 200000 } } }, { type: "error", error: { type: "api_error" } },
  ] },
  { name: "Anthropic incomplete cache totals cannot manufacture a healthy cache hit", kind: "anthropic", code: "inference_failed", events: [
    { type: "message_start", message: { usage: { input_tokens: 1000, cache_read_input_tokens: 100000 } } }, { type: "error", error: { type: "api_error" } },
  ] },
  { name: "Chat Completions invalid cache coverage stays unknown", kind: "chat", code: "model_route", events: [
    { model: "wrong-model", choices: [], usage: { prompt_tokens: 200000, completion_tokens: 0, total_tokens: 200000, prompt_tokens_details: { cached_tokens: 300000 } } },
  ] },
  { name: "Chat Completions terminal usage cannot clamp invalid cache coverage into a healthy hit", kind: "chat", code: "", events: [
    { model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200000, completion_tokens: 1, total_tokens: 200001, prompt_tokens_details: { cached_tokens: 300000 } } }, "[DONE]",
  ] },
];

for (const scenario of cases) test(scenario.name, async () => {
  let calls = 0;
  const upstream = createServer((request, response) => {
    request.resume(); calls++; response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(scenario.events.map(event => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\n\n`).join(""));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const key = "CACHE_PROVIDER_FAILURE_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  const baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
  const common = { id: "fixture", baseUrl, apiKeyEnv: key, models: { m: "m" } };
  const provider: Provider = scenario.kind === "responses" ? new ResponsesAPI({ ...common, type: "responses-api" })
    : scenario.kind === "chat" ? new ChatCompletionsAPI({ ...common, type: "chat-completions-api" })
      : new AnthropicAPI({ ...common, type: "anthropic-api" });
  const turn = async () => {
    for await (const _ of cacheGuardedInference(provider, { model: "m", input: "history" }, new AbortController().signal,
      { threadId: "thread" }, scenario.name)) {}
  };
  try {
    if (scenario.code) {
      await assert.rejects(turn(), { code: scenario.code }); await assert.rejects(turn(), { code: scenario.code });
    } else { await turn(); await turn(); }
    await assert.rejects(turn(), { code: "invalid_request", status: 400 });
    assert.equal(calls, 2, "only two actual upstream attempts can consume input");
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
