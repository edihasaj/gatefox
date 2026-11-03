import test from "node:test";
import assert from "node:assert/strict";
import { copilotUnknownNameClass } from "../providers/copilot-tool-rejection.js";
import { nativeCopilotCalls, nativeToolMap } from "../providers/copilot-turn.js";
import { claudeToolName } from "../providers/claude-tool-names.js";
import { normalizeResponsesTools } from "../protocol/request.js";
import { flushTelemetry, readTelemetry } from "../telemetry.js";
import { harness } from "./copilot-live-harness.js";

test("unknown Copilot calls distinguish malformed names, declared aliases and undeclared tools without exposing content", async () => {
  const h = await harness();
  try {
    const tools = normalizeResponsesTools([{ type: "namespace", name: "files", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
      { type: "namespace", name: "archive", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }]);
    const cases: Array<[unknown, string]> = [[undefined, "missing"], [17, "non_string"], ["", "empty"],
      ["read", "ambiguous_alias"], ["tool_retired_0123456789abcdef", "undeclared_native_shape"], ["SENTINEL_PRIVATE_TOOL", "undeclared"]];
    for (const [name, expected] of cases) {
      assert.equal(copilotUnknownNameClass(name, tools), expected);
      assert.throws(() => nativeCopilotCalls([{ name, toolCallId: "call", arguments: { secret: "SENTINEL_ARGUMENT" } }], tools), /unknown tool/);
    }
    await flushTelemetry();
    const events = (await readTelemetry(h.directory, 0)).filter(row => row.event === "copilot_tool_rejected");
    assert.deepEqual(events.map(row => row.nameClass), cases.map(([, expected]) => expected));
    assert.ok(events.every(row => row.catalogCount === 2 && row.callCount === 1 && row.reason === "unknown_tool"));
    assert.ok(!JSON.stringify(events).includes("SENTINEL"));
    assert.ok(!JSON.stringify(events).includes("files.read"));
  } finally { await h.restore(); }
});


test("Copilot accepts exact unique caller aliases and preserves caller identities, IDs and arguments", () => {
  const tools = normalizeResponsesTools([
    { type: "namespace", name: "files", tools: [{ type: "function", name: "read", parameters: { type: "object" } }, { type: "custom", name: "patch" }] },
    { type: "namespace", name: "archive", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
  ]);
  const before = structuredClone(tools);
  const args = { path: "literal $value\nsecond line" };
  for (const catalog of [tools, nativeToolMap(tools)]) for (const name of ["files.read", "filesread", "mcp__files__read"]) {
    assert.equal(copilotUnknownNameClass(name, tools), "declared_alias");
    const calls = nativeCopilotCalls([{ name, toolCallId: "same-id", arguments: args }], catalog);
    assert.deepEqual(calls, [{ id: "same-id", type: "function", responseTool: { type: "function", namespace: "files", name: "read" }, function: { name: "files.read", arguments: JSON.stringify(args) } }]);
  }
  const patch = nativeCopilotCalls([{ name: "patch", toolCallId: "patch-id", arguments: { input: "raw patch\n" } }], tools)[0];
  assert.deepEqual(patch.responseTool, { type: "custom", name: "patch", namespace: "files" });
  assert.equal(patch.function.arguments, JSON.stringify({ input: "raw patch\n" }));
  assert.deepEqual(tools, before);
  assert.throws(() => nativeCopilotCalls([{ name: "read", toolCallId: "ambiguous", arguments: {} }], tools), /unknown tool/);
  assert.throws(() => nativeCopilotCalls([{ name: "mcp__foreign__read", toolCallId: "foreign", arguments: {} }], tools), /unknown tool/);
});


test("Copilot refuses a caller alias that collides with another declared tool's native wire identity", () => {
  const first = normalizeResponsesTools([{ type: "function", name: "inspect" }]);
  const collidingName = claudeToolName(first[0]);
  const second = normalizeResponsesTools([{ type: "function", name: collidingName }]);
  assert.throws(() => nativeCopilotCalls([{ name: collidingName, toolCallId: "collision", arguments: {} }], [...first, ...second]), /unknown tool/);
});
