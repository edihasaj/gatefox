import test from "node:test";
import assert from "node:assert/strict";
import { copilotUnknownNameClass } from "../providers/copilot-tool-rejection.js";
import { nativeCopilotCalls } from "../providers/copilot-turn.js";
import { normalizeResponsesTools } from "../protocol/request.js";
import { flushTelemetry, readTelemetry } from "../telemetry.js";
import { harness } from "./copilot-live-harness.js";

test("unknown Copilot calls distinguish malformed names, declared aliases and undeclared tools without exposing content", async () => {
  const h = await harness();
  try {
    const tools = normalizeResponsesTools([{ type: "namespace", name: "files", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] },
      { type: "namespace", name: "archive", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }]);
    const cases: Array<[unknown, string]> = [[undefined, "missing"], [17, "non_string"], ["", "empty"], ["files.read", "declared_alias"],
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
