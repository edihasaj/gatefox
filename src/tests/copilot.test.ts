import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { copilotFrames } from "../providers/copilot-rpc.js";
import { copilotEnvironment } from "../providers/copilot-client.js";
import { nativeCopilotModels } from "../providers/copilot-models.js";
import { CopilotSubscription, copilotEffort, nativeCopilotCalls, validateCopilotServiceTier } from "../providers/copilot.js";
import type { ProviderConfig } from "../config.js";
import type { InferenceEvent, ResponsesRequest } from "../protocol/types.js";
import { ProviderError } from "../providers/provider.js";
import { streamFailureCode } from "../provider-failure.js";

const provider: ProviderConfig = { id: "copilot", type: "copilot-subscription", models: { alias: "fixture" }, modelMetadata: { alias: { reasoningEfforts: ["low", "high", "max"] } } };
const collect = async (input: AsyncIterable<InferenceEvent>) => { const events = []; for await (const event of input) events.push(event); return events; };
const frames = async (chunks: Buffer[]) => { const messages = []; for await (const message of copilotFrames(Readable.from(chunks))) messages.push(message); return messages; };

test("Copilot RPC handles split UTF-8 frames and rejects unbounded, ambiguous, or incomplete framing", async () => {
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

test("Copilot rejects unsupported service tiers and preserves ordinary defaults", () => {
  const request: ResponsesRequest = { model: "fixture", input: "hello", reasoning: { effort: "high" } };
  for (const service_tier of [undefined, null, "auto", "default"]) assert.doesNotThrow(() => validateCopilotServiceTier({ ...request, service_tier }));
  for (const service_tier of ["priority", "fast"]) {
    assert.throws(() => validateCopilotServiceTier({ ...request, service_tier }), error => error instanceof ProviderError && error.code === "invalid_request" && error.status === 400 && /Copilot Fast mode is unavailable/.test(error.message));
  }
  // Flex is served as Standard, so it is not one of the tiers Copilot rejects.
  assert.doesNotThrow(() => validateCopilotServiceTier({ ...request, service_tier: "flex" }));
  for (const service_tier of ["scale", "unknown", false, {}]) assert.throws(() => validateCopilotServiceTier({ ...request, service_tier }), error => error instanceof ProviderError && error.code === "invalid_request" && error.status === 400);
});

test("Copilot native calls preserve custom-tool identities and reject native actions or duplicate IDs", () => {
  const tools = [{ type: "function" as const, function: { name: "tools.patch", responseTool: { type: "custom" as const, name: "patch", namespace: "tools" } } }];
  const call = { name: "gateway_tool_0", type: "function", toolCallId: "call1", arguments: { input: "patch" } };
  assert.deepEqual(nativeCopilotCalls([call], tools)[0].responseTool, tools[0].function.responseTool);
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

test("Copilot SDK inference streams, confines tools, sanitizes failures, and releases cancelled workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-copilot-fixture-"));
  // Preserve module resolution when the fixture is launched as an executable.
  const fixture = fileURLToPath(new URL("./copilot-fixture.js", import.meta.url));
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  await writeFile(join(directory, "copilot"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`); await chmod(join(directory, "copilot"), 0o700);
  const previous = { PATH: process.env.PATH, mode: process.env.GATEWAY_COPILOT_FIXTURE_MODE, receipt: process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT };
  process.env.PATH = directory + delimiter + process.env.PATH; process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT = join(directory, "receipt.json");
  const request: ResponsesRequest = { model: "fixture", input: "hello", reasoning: { effort: "high", summary: "auto" } };
  try {
    const adapter = new CopilotSubscription(provider);
    const normal = await collect(adapter.infer(request, new AbortController().signal));
    assert.deepEqual(normal.map(event => event.type), ["reasoning", "text", "done"]);
    const last = normal.at(-1); assert.equal(last?.type === "done" && last.usage.total_tokens, 13);
    const receipt = JSON.parse(await readFile(join(directory, "receipt.json"), "utf8"));
    assert.deepEqual(receipt.availableTools, []); assert.deepEqual(receipt.allowedModels, ["fixture"]); assert.equal(receipt.enableConfigDiscovery, false); assert.equal(receipt.enableFileHooks, false); assert.equal(receipt.reasoningSummary, "concise");
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
    }
    process.env.GATEWAY_COPILOT_FIXTURE_MODE = "provider-absent";
    assert.equal((await collect(adapter.infer(request, new AbortController().signal))).at(-1)?.type, "done");
    process.env.GATEWAY_COPILOT_FIXTURE_MODE = "tool";
    const custom = await collect(adapter.infer({ ...request, tools: [{ type: "custom", name: "patch" }], tool_choice: "required" }, new AbortController().signal));
    assert.equal(custom.find(event => event.type === "tool")?.call.responseTool?.type, "custom");
    for (const mode of ["protocol", "auth", "byok", "model-switch", "provider-switch", "inconsistent", "error", "permission", "foreign-tool"]) {
      process.env.GATEWAY_COPILOT_FIXTURE_MODE = mode;
      await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof Error && !error.message.includes("private-token"));
    }
    process.env.GATEWAY_COPILOT_FIXTURE_MODE = "context-code";
    await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof ProviderError && error.code === "context_length_exceeded" && error.status === 400 && !error.message.includes("private-token"));
    // A plain rate limit stays retryable for Codex; quota wording is a final usage limit.
    for (const [mode, code, wire] of [["rate-limit", "rate_limit_exceeded", "rate_limit_exceeded"], ["usage-limit", "usage_limit", "invalid_prompt"]]) {
      process.env.GATEWAY_COPILOT_FIXTURE_MODE = mode;
      await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof ProviderError && error.code === code && error.status === 429 &&
        streamFailureCode(error) === wire && !error.message.includes("private-token"));
    }
    process.env.GATEWAY_COPILOT_FIXTURE_MODE = "context-prose";
    await assert.rejects(collect(adapter.infer(request, new AbortController().signal)), error => error instanceof ProviderError && error.code === "inference_failed");
    process.env.GATEWAY_COPILOT_FIXTURE_MODE = "hang";
    const control = new AbortController(); const timer = setTimeout(() => control.abort(), 300);
    try { await assert.rejects(collect(adapter.infer(request, control.signal)), /cancelled/); } finally { clearTimeout(timer); }
    delete process.env.GATEWAY_COPILOT_FIXTURE_MODE;
    assert.equal((await collect(adapter.infer(request, new AbortController().signal))).at(-1)?.type, "done");
  } finally {
    for (const [key, value] of [["PATH", previous.PATH], ["GATEWAY_COPILOT_FIXTURE_MODE", previous.mode], ["GATEWAY_COPILOT_FIXTURE_RECEIPT", previous.receipt]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
  }
});
