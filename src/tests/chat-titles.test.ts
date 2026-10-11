import test from "node:test";
import assert from "node:assert/strict";
import { handleTitleCall, withTitleTool, titleTool } from "../chat-titles.js";

test("agent title tools rename and read only their bound current chat", async () => {
  let name: string | null = null; const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const backend = async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); if (method === "thread/name/set") name = String(params.name); return { thread: { name } }; };
  const read = await handleTitleCall({ threadId: "current", arguments: { operation: "read" } }, backend); assert.equal(read.success, true);
  const renamed = await handleTitleCall({ threadId: "current", arguments: { operation: "rename", title: "  Agent title  " } }, backend); assert.equal(renamed.success, true); assert.equal(name, "Agent title");
  assert.ok(calls.every(call => call.params.threadId === "current"));
  await assert.rejects(handleTitleCall({ threadId: "current", arguments: { operation: "rename", title: "other", threadId: "unrelated" } }, backend), /Invalid/);
  await assert.rejects(handleTitleCall({ threadId: "current", arguments: { operation: "rename", title: "\n" } }, backend), /printable/);
  assert.throws(() => withTitleTool({ dynamicTools: [{ name: titleTool }] }), /reserved/);
  assert.equal((withTitleTool({ dynamicTools: [{ name: "caller_tool" }] }).dynamicTools as Array<{ name: string }>)[0]!.name, "caller_tool");
});
