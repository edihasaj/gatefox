#!/usr/bin/env node
import { copilotFrames, record } from "../providers/copilot-rpc.js";
import { writeFile } from "node:fs/promises";
const send = (value: unknown) => { const body = JSON.stringify(value); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
let sessionId = ""; let config: Record<string, unknown> = {};
const mode = process.env.GATEWAY_COPILOT_FIXTURE_MODE;
const event = (type: string, data: Record<string, unknown> = {}) => send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type, data } } });
for await (const message of copilotFrames(process.stdin)) {
  const params = record(message.params);
  if (message.method === "connect") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: mode === "protocol" ? 2 : 3 } });
  else if (message.method === "auth.getStatus") send({ jsonrpc: "2.0", id: message.id, result: { isAuthenticated: mode !== "auth" } });
  else if (message.method === "session.create") {
    config = params; sessionId = String(params.sessionId);
    if (process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT) await writeFile(process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT, JSON.stringify(params));
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId } });
  } else if (message.method === "session.send") {
    send({ jsonrpc: "2.0", id: message.id, result: { messageId: "fixture" } });
    if (mode === "hang") continue;
    if (mode === "error") { event("session.error", { message: "private-token diagnostic" }); continue; }
    if (mode === "permission") { event("permission.requested", { requestId: "permission" }); continue; }
    event("assistant.reasoning_delta", { deltaContent: "checking", reasoningId: "r1" });
    event("assistant.usage", { isByok: mode === "byok", inputTokens: 11, outputTokens: 2 });
    const tool = mode === "tool" || mode === "foreign-tool";
    const text = tool ? "" : "fixture-proof";
    if (text) event("assistant.message_delta", { deltaContent: text });
    event("assistant.message", { content: mode === "inconsistent" ? "different" : text, model: mode === "model-switch" ? "other" : config.model, ...(mode === "provider-absent" ? {} : { providerId: mode === "provider-switch" ? "byok" : "copilot" }), toolRequests: tool ? [{ toolCallId: "call_fixture", name: mode === "foreign-tool" ? "shell" : "gateway_tool_0", arguments: { input: "patch-proof" }, type: "function" }] : [] });
    event("assistant.idle");
  } else if (message.method === "session.delete") send({ jsonrpc: "2.0", id: message.id, result: { success: true } });
  else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "private-token diagnostic" } });
}
