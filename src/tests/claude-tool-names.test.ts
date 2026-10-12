import test from "node:test";
import assert from "node:assert/strict";
import { responsesToChatRequest } from "../protocol/request.js";
import { nativeClaudeCalls } from "../providers/claude-calls.js";
import { claudeNativeToolName, claudeToolName, claudeToolHistory } from "../providers/claude-tool-names.js";

const catalog = () => responsesToChatRequest({ model: "test", input: "fixture", tools: [
  { type: "namespace", name: "files", tools: [{ type: "function", name: "read" }, { type: "custom", name: "patch" }] },
  { type: "namespace", name: "network", tools: [{ type: "function", name: "read" }] },
] }).tools!;

test("Claude native names retain caller identity when catalogs reorder, shrink or grow", () => {
  const tools = catalog(); const name = claudeNativeToolName(tools[1]);
  assert.equal(claudeNativeToolName([tools[1]][0]), name);
  const call = { id: "actual-call", name, input: { input: "patch bytes" } };
  const result = nativeClaudeCalls([call], [tools[1], tools[2], tools[0]])[0];
  assert.equal(result.function.name, "files.patch"); assert.equal(result.id, "actual-call");
  assert.deepEqual(result.responseTool, { type: "custom", name: "patch", namespace: "files" });
  assert.notEqual(claudeNativeToolName(tools[0]), claudeNativeToolName(tools[2]));
});
test("exact caller aliases resolve while ambiguous local names, stale indices and foreign tools fail", () => {
  const tools = catalog(); const call = { id: "call", input: {} };
  for (const name of ["files.read", "filesread", "mcp__files__read"]) assert.equal(nativeClaudeCalls([{ ...call, name }], tools)[0].function.name, "files.read");
  assert.equal(nativeClaudeCalls([{ ...call, name: claudeToolName(tools[0]) }], tools)[0].function.name, "files.read");
  assert.equal(nativeClaudeCalls([{ ...call, name: "read" }], [tools[0]])[0].function.name, "files.read");
  for (const name of ["read", "mcp__gateway__tool_0", "Bash", "mcp__foreign__read"]) assert.throws(() => nativeClaudeCalls([{ ...call, name }], tools));
});
test("Codex flat tools and its explicit functions namespace retain one native binding", () => {
  const flat = responsesToChatRequest({ model: "test", input: "fixture", tools: [{ type: "function", name: "exec_command" }] }).tools![0];
  const explicit = responsesToChatRequest({ model: "test", input: "fixture", tools: [{ type: "namespace", name: "functions", tools: [{ type: "function", name: "exec_command" }] }] }).tools![0];
  assert.equal(claudeNativeToolName(flat), claudeNativeToolName(explicit));
  assert.equal(nativeClaudeCalls([{ id: "real-call", name: "functions.exec_command", input: { cmd: "fixture" } }], [flat])[0].function.name, "exec_command");
});
test("Claude history uses registered tool names and preserves call IDs, arguments, results and content", () => {
  const tools = catalog(); const messages = responsesToChatRequest({ model: "test", input: [
    { type: "custom_tool_call", name: "patch", namespace: "files", call_id: "previous", input: "raw patch text" },
    { type: "custom_tool_call_output", call_id: "previous", output: "actual caller result" },
    { role: "user", content: "Continue; raw patch text remains unchanged" },
  ] }).messages;
  const before = structuredClone(messages); const replay = claudeToolHistory(messages, tools);
  assert.equal(replay[0].tool_calls![0].function.name, claudeNativeToolName(tools[1]));
  assert.equal(replay[1].name, claudeNativeToolName(tools[1]));
  assert.equal(replay[0].tool_calls![0].id, "previous");
  assert.equal(replay[0].tool_calls![0].function.arguments, messages[0].tool_calls![0].function.arguments);
  assert.equal(replay[1].content, "actual caller result"); assert.equal(replay[2].content, messages[2].content);
  assert.deepEqual(messages, before);
});
