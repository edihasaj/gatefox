import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixtureCli } from "./copilot-fixture-cli.js";
import { copilotFrames } from "../providers/copilot-rpc.js";
import { copilotEnvironment } from "../providers/copilot-client.js";
import { nativeCopilotModels } from "../providers/copilot-models.js";
import { CopilotSubscription, copilotEffort, nativeCopilotCalls, validateCopilotServiceTier } from "../providers/copilot.js";
import type { ProviderConfig } from "../config.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { ProviderError } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";
import { claudeToolName } from "../providers/claude-tool-names.js";

const provider: ProviderConfig = { id: "copilot", type: "copilot-subscription", models: { alias: "fixture" }, modelMetadata: { alias: { reasoningEfforts: ["low", "high", "max"] } } };
const collect = async (input: AsyncIterable<InferenceEvent>) => { const events = []; for await (const event of input) events.push(event); return events; };
const frames = async (chunks: Buffer[]) => { const messages = []; for await (const message of copilotFrames(Readable.from(chunks))) messages.push(message); return messages; };

test("Copilot RPC handles split UTF-8 frames and rejects unbounded, ambiguous, or incomplete framing", { timeout: 30000 }, async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ë🙂" }); const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  assert.deepEqual(await frames([...frame].map(byte => Buffer.from([byte]))), [{ jsonrpc: "2.0", id: 1, result: "ë🙂" }]);
  for (const malformed of ["x".repeat(8193), "Content-Length: 16777217\r\n\r\n", "Content-Length: 1\r\nContent-Length: 1\r\n\r\n0", "Content-Length: 8\r\n\r\n{}", "Content-Length: 1\r\n\r\nx", "Content-Length: 2\r\n\r\n{}"])
    await assert.rejects(frames([Buffer.from(malformed)]));
});

test("Copilot discovery respects policy and default context limits without guessing reasoning levels", () => {
  const model = { id: "test", name: "Test", policy: { state: "enabled" }, capabilities: { limits: { max_context_window_tokens: 1000000, max_prompt_tokens: 936000 } }, billing: { tokenPrices: { contextMax: 200000 } }, supportedReasoningEfforts: ["low", "high", "max"] };
  const entries = nativeCopilotModels([model, { id: "auto" }, { ...model, id: "disabled", policy: { state: "disabled" } }]);
  assert.deepEqual(entries, [{ model: "test", metadata: { displayName: "Test", inputModalities: ["text"], contextWindow: 200000, reasoningEfforts: ["low", "high", "max"], serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null } }]);
  assert.equal(nativeCopilotModels([model, model]).length, 1);
  assert.throws(() => nativeCopilotModels([model, { ...model, name: "Conflicting" }]), /conflicting duplicate/);
  assert.throws(() => nativeCopilotModels([{ ...model, supportedReasoningEfforts: ["ultra"] }]), /reasoning/);
  assert.deepEqual(nativeCopilotModels([{ ...model, id: "gpt-6.1-sol", supportedReasoningEfforts: ["none", "low", "max"] }])[0].metadata.reasoningEfforts, ["low", "max"]);
  assert.equal(copilotEffort(provider, { model: "fixture", input: "", reasoning: { effort: "max" } }), "max");
  assert.throws(() => copilotEffort(provider, { model: "fixture", input: "", reasoning: { effort: "medium" } }), /reasoning/);
});

test("Copilot rejects Fast and unknown service tiers, runs Flex as Standard and preserves ordinary defaults", () => {
  const request: ResponsesRequest = { model: "fixture", input: "hello", reasoning: { effort: "high" } };
  // Flex is not refused: a native Codex chat that moved to this row keeps sending it, and the turn runs as Standard.
  for (const service_tier of [undefined, null, "auto", "default", "flex"]) assert.doesNotThrow(() => validateCopilotServiceTier({ ...request, service_tier }));
  for (const service_tier of ["priority", "fast"]) {
    assert.throws(() => validateCopilotServiceTier({ ...request, service_tier }), error => error instanceof ProviderError && error.code === "invalid_request" && error.status === 400 && /Copilot Fast mode is unavailable/.test(error.message));
  }
  for (const service_tier of ["scale", "unknown", false, {}]) assert.throws(() => validateCopilotServiceTier({ ...request, service_tier }), error => error instanceof ProviderError && error.code === "invalid_request" && error.status === 400);
});

test("Copilot native calls preserve custom-tool identities and reject native actions or duplicate IDs", () => {
  const tools = [{ type: "function" as const, function: { name: "tools.patch", responseTool: { type: "custom" as const, name: "patch", namespace: "tools" } } }];
  const call = { name: claudeToolName(tools[0]), type: "function", toolCallId: "call1", arguments: { input: "patch" } };
  assert.deepEqual(nativeCopilotCalls([call], tools)[0].responseTool, tools[0].function.responseTool);
  const { type: _type, ...withoutType } = call;
  assert.deepEqual(nativeCopilotCalls([withoutType], tools)[0], nativeCopilotCalls([call], tools)[0], "Copilot defaults an absent type to function");
  assert.throws(() => nativeCopilotCalls([{ ...call, type: null }], tools), /malformed/);
  assert.throws(() => nativeCopilotCalls([{ ...call, type: "custom" }], tools), /malformed/);
  assert.throws(() => nativeCopilotCalls([{ ...call, name: "shell" }], tools), /unknown/);
  assert.throws(() => nativeCopilotCalls([call, call], tools), /duplicate/);
  assert.throws(() => nativeCopilotCalls([{ ...call, arguments: { input: {} } }], tools), /string/);
});

test("Copilot environment excludes BYOK and inherited account selectors", () => {
  const values = { COPILOT_PROVIDER_BASE_URL: "https://private.invalid", COPILOT_PROVIDER_API_KEY: "fixture-only", COPILOT_MODEL: "other", GH_TOKEN: "fixture-only", COPILOT_HOME: "/other" };
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try { Object.assign(process.env, values); const env = copilotEnvironment("/explicit/account"); for (const key of Object.keys(values).filter(key => key !== "COPILOT_HOME")) assert.equal(env[key], undefined); assert.equal(env.COPILOT_HOME, "/explicit/account"); }
  finally { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test("Copilot SDK inference streams, confines tools, sanitizes failures, and releases cancelled workers", { timeout: 20000 }, async () => {
  const fixture = await fixtureCli("gateway-test-copilot-fixture-"); const { directory } = fixture;
  const request: ResponsesRequest = { model: "fixture", input: "hello", reasoning: { effort: "high", summary: "auto" } };
  try {
    const adapter = new CopilotSubscription(provider);
    const normal = await collect(adapter.infer(request, new AbortController().signal));
    assert.deepEqual(normal.map(event => event.type), ["reasoning", "usage", "text", "done"]);
    const last = normal.at(-1); assert.equal(last?.type === "done" && last.usage.total_tokens, 13);
    const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
    assert.deepEqual(receipt.availableTools, []); assert.deepEqual(receipt.allowedModels, ["fixture"]); assert.equal(receipt.enableConfigDiscovery, false); assert.equal(receipt.enableFileHooks, false); assert.equal(receipt.reasoningSummary, "concise");
    assert.deepEqual([receipt.toolSearch, receipt.largeOutput], [{ enabled: false }, { enabled: false }]);
    assert.equal(receipt.sentMessages.length, 1); assert.match(receipt.sentMessages[0].prompt, /^<<item 1 user>>\nhello\n<<\/item>>$/);
    for (const service_tier of ["priority", "fast"]) {
      await writeFile(join(directory, "receipt.json"), "worker-not-started");
      await assert.rejects(collect(adapter.infer({ ...request, service_tier }, new AbortController().signal)), error => error instanceof ProviderError && error.code === "invalid_request" && error.status === 400);
      assert.equal(await readFile(join(directory, "receipt.json"), "utf8"), "worker-not-started");
    }
    for (const service_tier of ["auto", "default", "flex"]) {
      assert.equal((await collect(adapter.infer({ ...request, service_tier }, new AbortController().signal))).at(-1)?.type, "done");
      const ordinary = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
      assert.equal(ordinary.reasoningEffort, "high"); assert.deepEqual(ordinary.allowedModels, ["fixture"]);
      assert.equal(ordinary.serviceTier, undefined); assert.equal(ordinary.capi, undefined);
      assert.deepEqual(Object.keys(ordinary).filter(key => /tier/i.test(key)), [], `${service_tier}: no tier of any name reaches session.create`);
    }
    fixture.mode("provider-absent");
    assert.equal((await collect(adapter.infer(request, new AbortController().signal))).at(-1)?.type, "done");
    fixture.mode("tool");
    const custom = await collect(adapter.infer({ ...request, tools: [{ type: "custom", name: "patch" }], tool_choice: "required" }, new AbortController().signal));
    assert.equal(custom.find(event => event.type === "tool")?.call.responseTool?.type, "custom");
    for (const mode of ["protocol", "auth", "byok", "model-switch", "provider-switch", "inconsistent", "error", "permission", "foreign-tool"]) {
      fixture.mode(mode);
      await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof Error && !error.message.includes("private-token"));
    }
    fixture.mode("context-code");
    await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof ProviderError && error.code === "context_length_exceeded" && error.status === 400 && !error.message.includes("private-token"));
    // A plain rate limit stays retryable for Codex; quota wording is a final usage limit.
    for (const [mode, code, wire] of [["rate-limit", "rate_limit_exceeded", "rate_limit_exceeded"], ["usage-limit", "usage_limit", "invalid_prompt"]]) {
      fixture.mode(mode);
      await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof ProviderError && error.code === code && error.status === 429 &&
        streamFailureCode(error) === wire && !error.message.includes("private-token"));
    }
    fixture.mode("context-prose");
    await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof ProviderError && error.code === "inference_failed");
    fixture.mode("hang");
    const control = new AbortController(); const timer = setTimeout(() => control.abort(), 300);
    try { await assert.rejects(collect(adapter.infer(request, control.signal)), /cancelled/); } finally { clearTimeout(timer); }
    fixture.mode(undefined);
    assert.equal((await collect(adapter.infer(request, new AbortController().signal))).at(-1)?.type, "done");
  } finally { await fixture.restore(); }
});
