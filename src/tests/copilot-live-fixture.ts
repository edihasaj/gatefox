#!/usr/bin/env node
// A scripted stand-in for `copilot --headless --stdio` that speaks the live-session protocol: external tool
// requests that wait for `session.tools.handlePendingToolCall`, a model call per user turn or delivered result,
// and a prompt log under the configDir like the real CLI keeps. It records what it was asked in a log file.
import { copilotFrames, record } from "../providers/copilot-rpc.js";
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const send = (value: unknown) => { const body = JSON.stringify(value); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
const log = (entry: Record<string, unknown>) => { if (process.env.GATEWAY_COPILOT_LIVE_LOG) appendFileSync(process.env.GATEWAY_COPILOT_LIVE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
let sessionId = ""; let config: Record<string, unknown> = {}; let calls = 0; let sequence = 0;
const pending = new Map<string, { toolCallId: string }>(); const delivered: string[] = [];
const event = (type: string, data: Record<string, unknown> = {}) => send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type, data } } });
const usage = () => {
  calls++;
  event("assistant.usage", { isByok: false, inputTokens: 100 * calls, outputTokens: 5, cacheReadTokens: calls === 1 ? 0 : 100 * (calls - 1), cacheWriteTokens: calls === 1 ? 100 : 10, reasoningTokens: 1, copilotUsage: { totalNanoAiu: calls === 1 ? 1e9 : 1e8 } });
};
const message = (data: Record<string, unknown>) => event("assistant.message", { model: config.model, providerId: "copilot", content: "", toolRequests: [], ...data });

/** The scripted model: it reads only the markers in the latest user text or delivered tool results. */
function respond(text: string): void {
  const marker = (name: string) => text.includes(`[${name}]`);
  if (marker("hang")) return;
  if (marker("die") && process.env.GATEWAY_COPILOT_LIVE_DIE && !existsSync(process.env.GATEWAY_COPILOT_LIVE_DIE)) { writeFileSync(process.env.GATEWAY_COPILOT_LIVE_DIE, "x"); process.exit(1); }
  if (marker("permission")) { event("permission.requested", { requestId: "permission" }); return; }
  usage();
  if (marker("nativemsg")) { message({ toolRequests: [{ toolCallId: "call_native", name: "shell", arguments: {}, type: "function" }] }); return; }
  const count = marker("native") ? 1 : Number(/\[tools:(\d)\]/.exec(text)?.[1] ?? (marker("tool") ? 1 : 0));
  if (marker("next") || count) {
    const ids = Array.from({ length: marker("next") ? 1 : count }, () => `call_${process.pid}_${++sequence}`);
    message({ toolRequests: ids.map(toolCallId => ({ toolCallId, name: "gateway_tool_0", arguments: { id: toolCallId }, type: "function" })) });
    for (const toolCallId of ids) {
      const requestId = `rq_${process.pid}_${++sequence}`; pending.set(requestId, { toolCallId });
      const toolName = marker("native") ? "shell" : "gateway_tool_0";
      event("tool.execution_start", { toolCallId, toolName }); event("external_tool.requested", { requestId, toolCallId, toolName, arguments: { id: toolCallId } });
    }
    return;
  }
  event("assistant.message_delta", { deltaContent: `answer ${calls}` }); message({ content: `answer ${calls}` }); event("assistant.idle");
}

for await (const frame of copilotFrames(process.stdin)) {
  const params = record(frame.params); const id = frame.id; const ok = (result: Record<string, unknown> = {}) => send({ jsonrpc: "2.0", id, result });
  if (frame.method === "connect") ok({ protocolVersion: 3 });
  else if (frame.method === "auth.getStatus") ok({ isAuthenticated: true });
  else if (frame.method === "session.create") {
    config = params; sessionId = String(params.sessionId);
    const directory = String(params.configDir);
    // The real CLI logs the conversation under the configDir even with the session store off.
    mkdirSync(join(directory, "session-state", sessionId), { recursive: true }); writeFileSync(join(directory, "session-state", sessionId, "events.jsonl"), "PROMPT-LOG\n");
    log({ op: "create", directory, tmpdir: process.env.TMPDIR, params });
    ok({ sessionId });
  } else if (frame.method === "session.send" || frame.method === "session.sendMessages") {
    const prompts = frame.method === "session.send" ? [String(params.prompt)] : (params.messages as Array<{ prompt: string }>).map(entry => entry.prompt);
    log({ op: frame.method, prompts }); ok({ messageId: "fixture" });
    respond(prompts.at(-1)!);
  } else if (frame.method === "session.tools.handlePendingToolCall") {
    const requestId = String(params.requestId); const known = pending.get(requestId);
    log({ op: "deliver", requestId, toolCallId: known?.toolCallId, result: params.result });
    if (!known) { ok({ success: false }); continue; }
    pending.delete(requestId); delivered.push(String(params.result)); ok({ success: true });
    event("external_tool.completed", { requestId });
    if (!pending.size) { const results = delivered.splice(0); respond(results.some(value => value.includes("NEXT")) ? "[next]" : `final ${results.join("|")}`); }
  } else if (frame.method === "session.model.switchTo") { log({ op: "switch", effort: params.reasoningEffort }); ok({ status: "applied", deferred: false }); }
  else if (frame.method === "session.delete") ok({ success: true });
  else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
}
log({ op: "stdin_closed" });
