import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderConfig } from "../config.js";
import { ChatCompletionsAPI } from "../providers/chat-completions-api.js";
import { chatContextFailure } from "../providers/context-errors.js";
import { chatRejection } from "../providers/chat-rejections.js";
import { ChatOverflowGuard, overflowGuardLimit } from "../providers/chat-overflow-guard.js";

// vLLM's actual overflow body, as returned by the local Qwen server on 30 October 2026.
const vllm = { error: { message: "This model's maximum context length is 262144 tokens. However, you requested 0 output tokens and your prompt contains at least 262145 input tokens, for a total of at least 262145 tokens. Please reduce the length of the input prompt or the number of requested output tokens. (parameter=input_tokens, value=262145)", type: "BadRequestError", param: "input_tokens", code: 400 } };

test("vLLM's and OpenAI's maximum-context 400s are context overflows, with their counts", () => {
  const failure = chatContextFailure(vllm);
  assert.equal(failure?.code, "context_length_exceeded");
  assert.deepEqual((failure?.upstream as { contextTokens?: unknown } | undefined)?.contextTokens, { used: 262145, maximum: 262144 });
  assert.equal(chatContextFailure({ error: { message: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens." } })?.code, "context_length_exceeded");
  assert.equal(chatContextFailure({ error: { code: "context_length_exceeded", message: "too long" } })?.code, "context_length_exceeded");
  assert.equal(chatContextFailure({ error: { message: "tool_choice requires tools", type: "BadRequestError", code: 400 } }), undefined, "other 400s stay ordinary");
  assert.equal(chatContextFailure("maximum context length is 10 tokens"), undefined, "only an error envelope counts");
});

test("the Chat transport reports vLLM's overflow as context_length_exceeded so Codex can trim and retry", async t => {
  const key = "GATEWAY_CHAT_OVERFLOW_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let body = vllm as unknown;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(body), { status: 400, headers: { "Content-Type": "application/json" } }));
  const config: ProviderConfig = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const run = () => (async () => { for await (const _ of new ChatCompletionsAPI(config).infer({ model: "fixture", input: "long" }, new AbortController().signal)) { /* fails first */ } })();
  await assert.rejects(run(), (error: unknown) => (error as { code?: string }).code === "context_length_exceeded" && !/262145|reduce the length/.test((error as Error).message));
  body = { error: { message: "Invalid tool schema", type: "BadRequestError", code: 400 } };
  await assert.rejects(run(), (error: unknown) => (error as { code?: string }).code === "upstream_error", "an unrelated 400 keeps its old classification");
  // vLLM's answer when the prompt fills the window exactly (probed on the Spark router on 10 November 2026).
  body = { error: { message: "max_tokens must be at least 1, got 0. (parameter=max_tokens, value=0)", type: "BadRequestError", param: "max_tokens", code: 400 } };
  await assert.rejects(run(), (error: unknown) => (error as { code?: string }).code === "context_length_exceeded", "a full window is an overflow, not an upstream error");
});

test("every 400 recorded as context_length reaches the client as context_length_exceeded", () => {
  const bodies = [
    vllm,
    { error: { message: "Request exceeds the model's context window", type: "BadRequestError", code: 400 } },
    { error: { message: "This model's maximum context length was exceeded", type: "BadRequestError", code: 400 } },
    { error: { message: "max_tokens must be at least 1, got 0. (parameter=max_tokens, value=0)", type: "BadRequestError", param: "max_tokens", code: 400 } },
  ];
  for (const body of bodies) {
    assert.equal(chatRejection(body).reason, "context_length");
    assert.equal(chatContextFailure(body)?.code, "context_length_exceeded");
  }
  const ordinary = { error: { message: "max_tokens must be at least 1, got -3.", type: "BadRequestError", param: "max_tokens", code: 400 } };
  assert.equal(chatRejection(ordinary).reason, "output_tokens");
  assert.equal(chatContextFailure(ordinary), undefined, "only a zero remaining budget means the window is full");
});

test("the overflow guard counts consecutive overflows per conversation, expires and resets on success", () => {
  let now = 0; const guard = new ChatOverflowGuard(3, 1000, () => now);
  for (let i = 0; i < 3; i++) { assert.equal(guard.exhausted("a"), false); guard.overflow("a"); }
  assert.equal(guard.exhausted("a"), true);
  assert.equal(guard.exhausted("b"), false, "other conversations are independent");
  assert.equal(guard.exhausted(undefined), false, "requests without a conversation are never held");
  now = 2000; assert.equal(guard.exhausted("a"), false, "the count expires after a quiet window");
  guard.overflow("a"); guard.overflow("a"); guard.success("a"); guard.overflow("a");
  assert.equal(guard.exhausted("a"), false, "a completed request resets the count");
});

test("a conversation that keeps overflowing stops reaching the provider after the guard limit", async t => {
  const key = "GATEWAY_CHAT_GUARD_FIXTURE"; const previous = process.env[key]; process.env[key] = "fixture-only";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return new Response(JSON.stringify(vllm), { status: 400, headers: { "Content-Type": "application/json" } }); });
  const config: ProviderConfig = { id: "qwen-guard", type: "chat-completions-api", baseUrl: "http://127.0.0.1:4000/v1", apiKeyEnv: key, models: { "qwen/flash": "fixture" } };
  const run = (threadId: string) => (async () => { for await (const _ of new ChatCompletionsAPI(config).infer({ model: "fixture", input: "long" }, new AbortController().signal, { threadId })) { /* fails */ } })();
  for (let i = 0; i < overflowGuardLimit; i++) await assert.rejects(run("guard-thread"), (error: unknown) => (error as { code?: string }).code === "context_length_exceeded");
  assert.equal(calls, overflowGuardLimit);
  await assert.rejects(run("guard-thread"), (error: unknown) => (error as { code?: string; status?: number }).code === "invalid_request" && /fresh worker/.test((error as Error).message));
  assert.equal(calls, overflowGuardLimit, "the held request never reached the provider");
  await assert.rejects(run("other-thread"), (error: unknown) => (error as { code?: string }).code === "context_length_exceeded");
  assert.equal(calls, overflowGuardLimit + 1, "another conversation still reaches the provider");
});
