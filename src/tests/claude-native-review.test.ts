import assert from "node:assert/strict";
import test from "node:test";
import { completedNativeMessage, nativeReviewHeaders, nativeReviewTarget, serveNativeReview, type NativeRuntime } from "../claude-native-review.js";
import type { GatewayConfig } from "../config.js";
import { ProviderError } from "../providers/provider.js";

const claude = (id: string, extra = {}) => ({ id, type: "claude-subscription" as const, authDirectory: "/tmp/fixture-auth", models: { [`${id}/sonnet`]: "claude-sonnet-5" }, ...extra });
const config = (providers: unknown[]) => ({ version: 1, port: 0, stateDirectory: "/tmp/unused", providers }) as unknown as GatewayConfig;
const wire = { model: "claude-sonnet-5", max_tokens: 64, stop_sequences: ["</severity>"], thinking: { type: "disabled" }, messages: [{ role: "user", content: "review" }] };
const auxiliary = { "x-claude-code-request-class": "auxiliary" };
const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "<severity>9" }], stop_reason: "stop_sequence", stop_sequence: "</severity>", usage: { input_tokens: 1, output_tokens: 1 } };

test("only the exact classifier on one real Claude route reaches the native reviewer", async () => {
  const target = await nativeReviewTarget(config([claude("claude")]), wire, auxiliary);
  assert.equal(target?.provider.id, "claude"); assert.equal(target?.nativeModel, "claude-sonnet-5");
  for (const [name, value, headers] of [
    ["a changed stop sequence", { ...wire, stop_sequences: ["</verdict>"] }, auxiliary],
    ["a request with tools", { ...wire, tools: [{ name: "t" }] }, auxiliary],
    ["a streamed request", { ...wire, stream: true }, auxiliary],
    ["thinking left on", { ...wire, thinking: { type: "adaptive" } }, auxiliary],
    ["the main conversation", wire, { "x-claude-code-request-class": "main" }],
    ["a subagent", wire, { "x-claude-code-request-class": "subagent" }],
    ["a repeated class header", wire, { "x-claude-code-request-class": ["auxiliary", "main"] }],
    ["something other than a request", "text", auxiliary],
  ] as const) assert.equal(await nativeReviewTarget(config([claude("claude")]), value, headers as never), undefined, name);
});

test("no other model stands in as the safety reviewer", async () => {
  const qwen = { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:1/v1", models: { "qwen/q": "claude-sonnet-5" } };
  assert.equal(await nativeReviewTarget(config([qwen]), wire, auxiliary), undefined, "a chat route that claims the name does not qualify");
  assert.equal(await nativeReviewTarget(config([]), wire, auxiliary), undefined, "without Claude, the client keeps denying");
  assert.equal(await nativeReviewTarget(config([claude("one"), claude("two")]), wire, auxiliary), undefined, "two accounts are never chosen between silently");
  const chosen = await nativeReviewTarget(config([claude("one"), claude("two", { defaultForBareModels: true })]), wire, auxiliary);
  assert.equal(chosen?.provider.id, "two");
});

test("a broken reply is a failure and never a verdict", () => {
  assert.ok(completedNativeMessage(message, "claude-sonnet-5"));
  for (const broken of [{ ...message, stop_reason: "max_tokens" }, { ...message, model: "other" }, { ...message, content: [] }, { ...message, content: [{ type: "tool_use" }] },
    { ...message, stop_reason: "end_turn", stop_sequence: "x" }, { ...message, usage: {} }, null]) assert.equal(completedNativeMessage(broken, "claude-sonnet-5"), undefined, JSON.stringify(broken));
});

const target = async () => (await nativeReviewTarget(config([claude("claude")]), wire, auxiliary))!;
const runtime = (run: NativeRuntime["runNativeMessages"]): (() => Promise<NativeRuntime>) => async () => ({ runNativeMessages: run });


test("the review reply passes through unchanged, and runner errors never reach the client", async t => {
  const review = await target();
  const stubbedCommand = process.env.PATH; t.after(() => { process.env.PATH = stubbedCommand; });
  await serveNativeReview(review, auxiliary, new AbortController().signal, runtime(async () => message)).then(
    reply => assert.deepEqual(reply, message),
    (error: ProviderError) => assert.equal(error.code, "upstream_unavailable", "a host with no Claude CLI fails closed"));
  await assert.rejects(serveNativeReview(review, auxiliary, new AbortController().signal, runtime(async () => { throw Object.assign(new Error("private prompt text"), { status: 502 }); })),
    (error: ProviderError) => { assert.equal(error.message.includes("private"), false); return true; });
  await assert.rejects(serveNativeReview(review, auxiliary, new AbortController().signal, async () => ({})), { code: "upstream_unavailable" });
});

test("review headers carry only the side-request class and a printable beta list", () => {
  assert.deepEqual(nativeReviewHeaders({ "anthropic-beta": "a,b" }), { "x-claude-code-request-class": "auxiliary", "anthropic-beta": "a,b" });
  assert.equal(nativeReviewHeaders({ "anthropic-beta": "x".repeat(5000) }), undefined);
});
