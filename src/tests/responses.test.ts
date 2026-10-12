import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChatRequest, ResponsesTranslationError } from "../protocol/request.js";
import { responseToolItems, responseToolFrames, ResponsesWriter } from "../protocol/responses.js";
import { nativeClaudeCalls } from "../providers/claude-calls.js";
import { claudeNativeToolName } from "../providers/claude-tool-names.js";
import { ProviderError } from "../providers/provider.js";
import type { ResponsesRequest, ResponsesTool, WireEvent } from "../protocol/types.js";

for (const tool of [{ type: "function", name: "fetch", parameters: { type: "object" } }, { type: "custom", name: "patch" }] as ResponsesTool[]) {
  test(`caller-dispatched ${tool.type} tools keep their original identity`, () => {
    const compiled = responsesToChatRequest({ model: "test", input: "execute", tools: [tool], tool_choice: "required" });
    const custom = tool.type === "custom"; const payload = custom ? { input: "raw\npatch" } : { path: "one" };
    const calls = nativeClaudeCalls([{ id: "native-call", name: claudeNativeToolName(compiled.tools![0]), input: payload }], compiled.tools!);
    const item = responseToolItems(calls)[0];
    assert.equal(item.type, custom ? "custom_tool_call" : "function_call");
    assert.equal(item.call_id, "native-call"); assert.equal(item.name, "name" in tool ? tool.name : undefined);
    if (custom) assert.equal(item.input, "raw\npatch"); else assert.deepEqual(JSON.parse(String(item.arguments)), payload);
    const frames = responseToolFrames(calls, 3).map(value => JSON.parse(value));
    assert.deepEqual(frames.map(frame => frame.output_index), [3, 3, 3]);
    assert.equal(frames[2].item.call_id, "native-call");
    assert.equal(frames[1].type, custom ? "response.custom_tool_call_input.done" : "response.function_call_arguments.done");
  });
}

test("namespace compilation and forced selection retain a reversible caller identity", () => {
  const request: ResponsesRequest = { model: "test", input: "run", tools: [{ type: "namespace", name: "storage", tools: [{ type: "function", name: "fetch" }] }], tool_choice: { type: "function", namespace: "storage", name: "fetch" } };
  const compiled = responsesToChatRequest(request);
  assert.deepEqual(compiled.tool_choice, { type: "function", function: { name: "storage.fetch" } });
  const call = nativeClaudeCalls([{ id: "c", name: claudeNativeToolName(compiled.tools![0]), input: {} }], compiled.tools!);
  assert.equal(responseToolItems(call)[0].namespace, "storage"); assert.equal(responseToolItems(call)[0].name, "fetch");
});

test("mixed function and raw-tool replay preserves ordering and result association", () => {
  const compiled = responsesToChatRequest({ model: "test", instructions: "caller rules", input: [
    { role: "developer", content: "scope" },
    { type: "function_call", name: "fetch", namespace: "storage", arguments: "{}", call_id: "one" },
    { type: "function_call_output", call_id: "one", output: [{ type: "input_text", text: "proof" }] },
    { type: "custom_tool_call", name: "patch", input: "a\nb", call_id: "two" },
    { type: "custom_tool_call_output", call_id: "two", output: "saved" },
  ] });
  assert.deepEqual(compiled.messages.map(message => message.role), ["system", "developer", "assistant", "tool", "assistant", "tool"]);
  assert.equal(compiled.messages[3].name, "storage.fetch"); assert.equal(compiled.messages[3].tool_call_id, "one");
  assert.equal(compiled.messages[3].content, "proof");
  assert.deepEqual(JSON.parse(compiled.messages[4].tool_calls![0].function.arguments), { input: "a\nb" });
  assert.equal(compiled.messages[5].name, "patch"); assert.equal(compiled.messages[5].tool_call_id, "two");
});

test("opaque reasoning remains transport state while provider-exposed summaries remain text", () => {
  const input: ResponsesRequest["input"] = [{ type: "reasoning", encrypted_content: "opaque", summary: [] }, { type: "reasoning", summary: [{ type: "summary_text", text: "visible summary" }] }, { role: "user", content: "continue" }];
  assert.deepEqual(responsesToChatRequest({ model: "test", input }).messages, [{ role: "assistant", content: "visible summary" }, { role: "user", content: "continue" }]);
});

const invalid = [
  { input: [{ role: "unknown", content: "text" }] }, { input: [{ type: "function_call_output", output: "result" }] },
  { input: [{ type: "custom_tool_call", call_id: "one", name: "patch", input: {} }] }, { tools: [{ type: "web_search" }] },
  { tools: [{ type: "function", name: "same" }, { type: "function", name: "same" }] }, { tool_choice: { type: "function", name: "missing" } },
  { tools: [{ type: "namespace", name: "group", tools: [{ type: "namespace", name: "nested", tools: [] }] }] },
];
test("invalid roles, unsupported capabilities, duplicate definitions and unavailable forced tools fail before inference", () => {
  for (const options of invalid) assert.throws(() => responsesToChatRequest({ model: "test", input: "hello", ...options } as ResponsesRequest), ResponsesTranslationError);
});

test("native calls must belong to the supplied catalog and carry distinct IDs and valid raw inputs", () => {
  const compiled = responsesToChatRequest({ model: "test", input: "hello", tools: [{ type: "custom", name: "patch" }] });
  const valid = { id: "one", name: claudeNativeToolName(compiled.tools![0]), input: { input: "raw" } };
  assert.throws(() => nativeClaudeCalls([valid, valid], compiled.tools!), ProviderError);
  assert.throws(() => nativeClaudeCalls([{ ...valid, name: "Bash" }], compiled.tools!), ProviderError);
  assert.throws(() => nativeClaudeCalls([{ ...valid, input: { input: {} } }], compiled.tools!), ProviderError);
});

test("Claude tool rejections distinguish internal helpers from malformed caller calls without exposing inputs", () => {
  const compiled = responsesToChatRequest({ model: "test", input: "hello", tools: [{ type: "custom", name: "patch" }] });
  const valid = { id: "one", name: claudeNativeToolName(compiled.tools![0]), input: { input: "raw" } };
  for (const [blocks, reason] of [
    [[{ ...valid, name: "ToolSearch" }], "native_tool_search"],
    [[{ ...valid, name: "WaitForMcpServers" }], "native_mcp_wait"],
    [[{ ...valid, name: "private-caller-data" }], "unknown_tool"],
    [[valid, valid], "duplicate_tool_id"],
    [[{ ...valid, input: { input: {} } }], "nontext_custom_input"],
    [[{ ...valid, id: undefined }], "malformed_tool_call"],
  ] as const) {
    assert.throws(() => nativeClaudeCalls([...blocks], compiled.tools!), error => {
      assert.ok(error instanceof ProviderError); assert.equal(error.code, "invalid_tool_call");
      assert.deepEqual(error.upstream, { code: reason, event: "claude.tool_use" });
      assert.ok(!JSON.stringify(error).includes("private-caller-data")); return true;
    });
  }
});

test("one output ledger preserves text/tool/text order and ends exactly once", () => {
  const events: WireEvent[] = []; const writer = new ResponsesWriter("test", event => events.push(event)); writer.begin();
  writer.accept({ type: "text", text: "before" });
  writer.accept({ type: "tool", call: { type: "function", id: "one", function: { name: "fetch", arguments: "{}" } } });
  writer.accept({ type: "text", text: "after" }); writer.accept({ type: "done", usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } });
  const result = writer.result() as { output_text: string; output: Array<{ type: string; id: string }> };
  assert.equal(result.output_text, "beforeafter"); assert.deepEqual(result.output.map(item => item.type), ["message", "function_call", "message"]);
  assert.equal(new Set(result.output.map(item => item.id)).size, 3);
  assert.deepEqual(events.map(event => event.sequence_number), events.map((_, index) => index));
  writer.fail("late", "failure"); assert.equal(events.filter(event => event.type === "response.completed").length, 1);
  assert.equal(events.filter(event => event.type === "response.failed").length, 0);
  assert.throws(() => writer.accept({ type: "text", text: "late" }));
});
