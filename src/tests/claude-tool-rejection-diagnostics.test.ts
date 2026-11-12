import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responsesToChatRequest } from "../protocol/request.js";
import { claudeNativeToolName, claudeToolName } from "../providers/claude-tool-names.js";
import { claudeToolNameCategory } from "../providers/claude-tool-rejection.js";
import { ClaudeMessageStream } from "../providers/claude-stream.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { summarizeTelemetry } from "../diagnostics.js";

const tools = responsesToChatRequest({ model: "fixture", input: "fixture", tools: [
  { type: "namespace", name: "private_catalog", tools: [{ type: "function", name: "read" }] },
  { type: "namespace", name: "other_catalog", tools: [{ type: "function", name: "read" }] },
] }).tools!;

test("tool name categories distinguish native identities, caller aliases and forbidden shapes", () => {
  for (const [name, expected] of [
    [undefined, "missing_name"], [7, "nonstring_name"], ["", "empty_name"],
    [claudeNativeToolName(tools[0]), "registered_native_name"],
    [claudeToolName(tools[0]), "declared_caller_alias"], ["private_catalog.read", "declared_caller_alias"],
    ["read", "ambiguous_caller_alias"], ["tool_0", "retired_numeric_alias"],
    ["mcp__gateway__missing", "undeclared_gateway_name"], ["Glob", "native_file_search"],
    ["Grep", "native_file_search"], ["Bash", "native_command_tool"],
    ["multi_tool_use.parallel", "parallel_wrapper"], ["private_unrecognized_name", "unrecognized_name"],
  ]) assert.equal(claudeToolNameCategory(name, tools), expected);
});

test("the pre-reader observer diagnoses a rejected live alias once without retaining content", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-tool-diagnostic-"));
  configureTelemetry(root, "test");
  try {
    const stream = new ClaudeMessageStream({ tools, summaryVisible: false, nativeMcpOnly: true, threadKey: "abcd1234" });
    const frame = { type: "stream_event", event: { type: "content_block_start", content_block: {
      type: "tool_use", id: "private_call_id", name: "private_catalog.read", input: { private_argument: "private-value" },
    } } };
    stream.observeUsage(frame); stream.observeUsage(frame);
    await flushTelemetry();
    const events = (await readTelemetry(root, 0)).filter(row => row.event === "claude_tool_rejected");
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "declared_caller_alias");
    assert.equal(events[0].threadKey, "abcd1234");
    assert.equal(events[0].catalogTools, 2);
    assert.equal(events[0].callCount, 1);
    const summary = summarizeTelemetry(events, new Date(0));
    assert.ok((summary.recentProblems as Array<{ event: string }>).some(row => row.event === "claude_tool_rejected"));
    const encoded = JSON.stringify(events);
    for (const secret of ["private_catalog", "private_call_id", "private_argument", "private-value"]) assert.ok(!encoded.includes(secret));
    const compatible = new ClaudeMessageStream({ tools, summaryVisible: false });
    compatible.observeUsage(frame); // One-shot's exact caller aliases remain accepted.
    await flushTelemetry();
    assert.equal((await readTelemetry(root, 0)).filter(row => row.event === "claude_tool_rejected").length, 1);
  } finally { await flushTelemetry(); await rm(root, { recursive: true, force: true }); }
});
