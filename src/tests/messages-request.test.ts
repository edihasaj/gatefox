import test from "node:test";
import assert from "node:assert/strict";
import { ProviderError } from "../providers/provider.js";
import { messagesToResponses } from "../protocol/messages-request.js";
import { messagesProviderRequest } from "../protocol/messages-routing.js";

test("Messages service tiers reach the selected provider without changing effort", () => {
  const base = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }], output_config: { effort: "max" } };
  for (const service_tier of ["default", "priority", "flex"]) {
    const translated = messagesToResponses({ ...base, service_tier });
    assert.equal(translated.service_tier, service_tier);
    assert.deepEqual(translated.reasoning, { effort: "max" });
    for (const kind of ["claude-subscription", "codex-subscription", "responses-api"] as const) assert.equal(messagesProviderRequest(translated, kind).service_tier, service_tier);
    for (const kind of ["chat-completions-api", "anthropic-api", "grok-subscription"] as const) {
      if (service_tier === "default") assert.equal(messagesProviderRequest(translated, kind).service_tier, "default");
      else assert.throws(() => messagesProviderRequest(translated, kind), /does not support Messages service tiers/);
    }
  }
  for (const service_tier of [null, 1, "Fast", "priority ", "x".repeat(129)]) assert.throws(() => messagesToResponses({ ...base, service_tier }), ProviderError);
});

test("Messages request preserves ordered system blocks and native controls", () => {
  const request = messagesToResponses({
    model: "claude-test", max_tokens: 32, system: [{ type: "text", text: "Attribution", cache_control: { type: "ephemeral" } }, { type: "text", text: "Caller rules" }],
    messages: [{ role: "system", content: "Later rule" }, { role: "user", content: "hello" }],
    metadata: { user_id: "private-caller-id" }, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "high" },
    tools: [{ name: "lookup", description: "Find a record", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
  });
  assert.deepEqual(request.input, [
    { type: "message", role: "system", content: [{ type: "input_text", text: "Attribution" }] },
    { type: "message", role: "system", content: [{ type: "input_text", text: "Caller rules" }] },
    { type: "message", role: "system", content: [{ type: "input_text", text: "Later rule" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  ]);
  assert.equal(request.max_output_tokens, 32); assert.deepEqual(request.reasoning, { effort: "high", summary: "none" });
  assert.deepEqual(request.tool_choice, { type: "function", name: "lookup" }); assert.equal(request.parallel_tool_calls, false);
  assert.equal(JSON.stringify(request).includes("private-caller-id"), false);
});

test("Messages request replays tool results and rejects lossy semantics", () => {
  const request = messagesToResponses({ model: "m", max_tokens: 1, cache_control: null, tools: [{ type: "custom", name: "lookup", input_schema: { type: "object" }, cache_control: null }], messages: [
    { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", is_error: true, content: "failed" }] },
  ] });
  assert.deepEqual(request.input, [
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
    { type: "function_call_output", call_id: "call_1", name: "lookup", output: "[Tool error] failed" },
  ]);
  for (const value of [
    { model: "m", max_tokens: 1, messages: [{ role: "user", content: [{ type: "document", source: {} }] }] },
    { model: "m", max_tokens: 1, thinking: { type: "enabled", budget_tokens: 10 }, messages: [{ role: "user", content: "x" }] },
    { model: "m", max_tokens: 1, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "none" }] }, messages: [{ role: "user", content: "x" }] },
  ]) assert.throws(() => messagesToResponses(value), ProviderError);
  assert.equal(messagesToResponses({ model: "m", messages: [{ role: "user", content: "x" }] }, { countTokens: true }).model, "m");
});

test("native empty tool results and optional control fields preserve their no-op meaning", () => {
  const request = messagesToResponses({ model: "m", max_tokens: 1, stop_sequences: [], cache_control: null,
    tools: [{ type: null, name: "lookup", input_schema: { type: "object" } }], messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "empty", name: "lookup", input: {} }], cache_control: null },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "empty" }] },
    ] });
  assert.equal(request.stop, undefined);
  assert.equal((request.input as Array<{ output?: unknown }>)[1].output, "");
  const base = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "x" }] };
  assert.throws(() => messagesToResponses({ ...base, thinking: { type: "disabled" } }), ProviderError);
  assert.throws(() => messagesToResponses({ ...base, thinking: { type: "enabled" } }), ProviderError);
  assert.throws(() => messagesToResponses({ ...base, output_config: { format: { type: "json_schema" } } }), ProviderError);
  assert.throws(() => messagesToResponses({ ...base, context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }], unsupported: true } }), ProviderError);
});

test("per-message effort follows new user turns and preserves instruction text", () => {
  const user = { role: "user", content: "New input" };
  const assistant = { role: "assistant", content: "Earlier answer" };
  const override = (effort: string) => ({ role: "system", content: [], output_config: { effort } });
  const cases: Array<{ messages: unknown[]; expected: string }> = [
    { messages: [user], expected: "high" },
    { messages: [override("low"), user], expected: "low" },
    { messages: [user, override("medium")], expected: "medium" },
    { messages: [user, assistant, override("low")], expected: "high" },
    { messages: [user, assistant, override("low"), user], expected: "low" },
    { messages: [user, override("low"), assistant, user], expected: "low" },
    { messages: [user, assistant, override("low"), override("max"), user], expected: "max" },
    { messages: [user, assistant, override("low"), user, override("xhigh")], expected: "xhigh" },
    { messages: [user, override("low"), { role: "system", content: [], output_config: null }, { role: "system", content: [], output_config: {} }], expected: "low" },
  ];
  for (const { messages, expected } of cases) {
    const result = messagesToResponses({ model: "m", max_tokens: 1, output_config: { effort: "high" }, messages });
    assert.deepEqual(result.reasoning, { effort: expected });
  }
  const pending = messagesToResponses({ model: "m", max_tokens: 1, messages: [user, assistant, override("low")] });
  assert.equal(pending.reasoning, undefined);
  const preserved = messagesToResponses({ model: "m", max_tokens: 1, messages: [user,
    { role: "system", content: [{ type: "text", text: "Keep these instructions", cache_control: { type: "ephemeral" } }], output_config: { effort: "medium" } },
  ] });
  assert.deepEqual(preserved.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "New input" }] },
    { type: "message", role: "system", content: [{ type: "input_text", text: "Keep these instructions" }] },
  ]);
  assert.deepEqual(preserved.reasoning, { effort: "medium" });
});

test("tool-result-only turns defer effort changes while mixed new input activates them", () => {
  const toolResult = { type: "tool_result", tool_use_id: "call", content: "found" };
  const history = [
    { role: "user", content: "Look it up" },
    { role: "system", content: [], output_config: { effort: "low" } },
    { role: "assistant", content: [{ type: "tool_use", id: "call", name: "lookup", input: {} }] },
    { role: "system", content: [], output_config: { effort: "high" } },
  ];
  const base = { model: "m", max_tokens: 1, tools: [{ name: "lookup", input_schema: { type: "object" } }] };
  const toolOnly = [...history, { role: "user", content: [toolResult] }, { role: "system", content: [], output_config: { effort: "max" } }];
  assert.deepEqual(messagesToResponses({ ...base, messages: toolOnly }).reasoning, { effort: "low" });
  assert.deepEqual(messagesToResponses({ ...base, messages: [...toolOnly, { role: "user", content: "Next task" }] }).reasoning, { effort: "max" });
  assert.deepEqual(messagesToResponses({ ...base, messages: [...history, { role: "user", content: [toolResult, { type: "text", text: "New instruction" }] }] }).reasoning, { effort: "high" });
});

test("display updates are advisory while unsupported effort and safeguards fail closed", () => {
  const base = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "Task" }] };
  const result = messagesToResponses({ ...base, thinking: { type: "adaptive", display: "updates" } });
  assert.deepEqual(result.reasoning, { summary: "none" });
  for (const output_config of [{ effort: "adaptive" }, { effort: 1 }, { effort: null }, { budget: 100 }, { format: { type: "json_schema" } }]) {
    assert.throws(() => messagesToResponses({ ...base, messages: [...base.messages, { role: "system", content: [], output_config }] }), ProviderError);
  }
  for (const role of ["user", "assistant"]) {
    assert.throws(() => messagesToResponses({ ...base, messages: [{ role, content: "Text", output_config: { effort: "low" } }] }), ProviderError);
  }
  assert.throws(() => messagesToResponses({ ...base, thinking: { type: "adaptive", display: "unknown" } }), ProviderError);
  assert.throws(() => messagesToResponses({ ...base, safeguards: { enabled: true } }), ProviderError);
  assert.throws(() => messagesToResponses({ ...base, safeguards: { enabled: false } }), ProviderError);
});
