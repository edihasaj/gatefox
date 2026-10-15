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
  } else if (message.method === "session.sendMessages") {
    // The receipt also keeps what was sent, so a test can read the history format.
    if (process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT) await writeFile(process.env.GATEWAY_COPILOT_FIXTURE_RECEIPT, JSON.stringify({ ...config, sentMessages: params.messages }));
    send({ jsonrpc: "2.0", id: message.id, result: { messageIds: ["fixture"] } });
    if (mode === "hang") continue;
    if (mode === "error") { event("session.error", { message: "private-token diagnostic" }); continue; }
    if (mode === "rate-limit") { event("session.error", { errorType: "rate_limit", statusCode: 429, message: "Sorry, you have hit a rate limit. Please wait a moment (private-token)" }); continue; }
    if (mode === "usage-limit") { event("session.error", { errorType: "rate_limit", statusCode: 429, message: "You have exceeded your monthly premium request quota (private-token)" }); continue; }
    if (mode === "context-code") { event("session.error", { errorType: "context_length_exceeded", message: "private-token diagnostic" }); continue; }
    if (mode === "context-prose") { event("session.error", { errorType: "notification", message: "The user quoted prompt is too long" }); continue; }
    if (mode === "external") { event("external_tool.requested", { requestId: "external", toolName: String((config.availableTools as string[])[0]), toolCallId: "call_external", arguments: {} }); continue; }
    if (mode === "permission") { event("permission.requested", { requestId: "permission" }); continue; }
    event("assistant.reasoning_delta", { deltaContent: "checking", reasoningId: "r1" });
    if (mode === "billing") {
      event("assistant.usage", { isByok: false, inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 10, reasoningTokens: 3, copilotUsage: { totalNanoAiu: 2e9 } });
      event("assistant.usage", { isByok: false, inputTokens: 50, outputTokens: 2, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 1, copilotUsage: { totalNanoAiu: 1e9 } });
    } else if (mode === "mixed") {
      event("assistant.usage", { isByok: false, inputTokens: 100, outputTokens: 5, copilotUsage: { totalNanoAiu: 2e9 } });
      event("assistant.usage", { isByok: false, inputTokens: 50, outputTokens: 2, aiCreditsStatus: "unavailable" });
    } else if (mode === "partial") event("assistant.usage", { isByok: false, inputTokens: 40, outputTokens: 4, aiCreditsStatus: "partial", copilotUsage: { totalNanoAiu: 5e8 } });
    else if (mode === "unpriced") event("assistant.usage", { isByok: false, inputTokens: 11, outputTokens: 2, aiCreditsStatus: "unavailable" });
    else event("assistant.usage", { isByok: mode === "byok", inputTokens: 11, outputTokens: 2 });
    const tool = mode === "tool" || mode === "foreign-tool";
    const text = tool ? "" : "fixture-proof";
    if (text) event("assistant.message_delta", { deltaContent: text });
    event("assistant.message", { content: mode === "inconsistent" ? "different" : text, model: mode === "model-switch" ? "other" : config.model, ...(mode === "provider-absent" ? {} : { providerId: mode === "provider-switch" ? "byok" : "copilot" }), toolRequests: tool ? [{ toolCallId: "call_fixture", name: mode === "foreign-tool" ? "shell" : String((config.availableTools as string[])[0]), arguments: { input: "patch-proof" }, type: "function" }] : [] });
    event("assistant.idle");
  } else if (message.method === "session.delete") send({ jsonrpc: "2.0", id: message.id, result: { success: true } });
  else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "private-token diagnostic" } });
}
