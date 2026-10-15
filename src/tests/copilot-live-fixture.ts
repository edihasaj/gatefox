#!/usr/bin/env node
// A scripted stand-in for `copilot --headless --stdio` that speaks the live-session protocol: external tool
// requests that wait for `session.tools.handlePendingToolCall`, a model call per user turn or delivered result,
// and a prompt log under the configDir like the real CLI keeps. It records what it was asked in a log file.
// The scripted model reads only the markers in the latest user text, such as [tool], [hang] or [late:model.call_start].
import { copilotFrames, record } from "../providers/copilot-rpc.js";
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const send = (value: unknown) => { const body = JSON.stringify(value); process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
const log = (entry: Record<string, unknown>) => { if (process.env.GATEWAY_COPILOT_LIVE_LOG) appendFileSync(process.env.GATEWAY_COPILOT_LIVE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
let sessionId = ""; let config: Record<string, unknown> = {}; let calls = 0; let sequence = 0; let rejectNext = false;
const pending = new Map<string, { toolCallId: string }>(); const delivered: unknown[] = [];
const event = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => send({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type, data, ...extra } } });
/** The name the gateway gave the caller's first tool. */
const toolName = () => String((config.availableTools as string[] | undefined)?.[0]);
const usage = () => {
  calls++;
  event("assistant.usage", { isByok: false, initiator: calls === 1 ? "user" : "agent", inputTokens: 100 * calls, outputTokens: 5, cacheReadTokens: calls === 1 ? 0 : 100 * (calls - 1), cacheWriteTokens: calls === 1 ? 100 : 10, reasoningTokens: 1, copilotUsage: { totalNanoAiu: calls === 1 ? 1e9 : 1e8 } });
};
const message = (data: Record<string, unknown>) => event("assistant.message", { model: config.model, providerId: "copilot", content: "", toolRequests: [], ...data });

/** What the scripted model does after a tool call was handed over: events that must never arrive between requests. */
function late(text: string, toolCallId: string): void {
  const match = /\[late(agent|ghost)?:([A-Za-z._]+)\]/.exec(text); if (!match) return;
  const [, kind, type] = match;
  setTimeout(() => {
    if (kind === "ghost") event(type, { toolCallId: "call_ghost", toolName: toolName(), requestId: "rq_ghost" });
    else event(type, { toolCallId, success: false, error: "received no response within 1800 seconds" }, kind === "agent" ? { agentId: "sub" } : {});
  }, 300);
}

function respond(text: string): void {
  const marker = (name: string) => text.includes(`[${name}]`);
  if (marker("hang")) return;
  rejectNext = marker("reject");
  if (marker("die") && process.env.GATEWAY_COPILOT_LIVE_DIE && !existsSync(process.env.GATEWAY_COPILOT_LIVE_DIE)) { writeFileSync(process.env.GATEWAY_COPILOT_LIVE_DIE, "x"); process.exit(1); }
  if (marker("permission")) { event("permission.requested", { requestId: "permission" }); return; }
  if (marker("lateusage")) { event("assistant.message_delta", { deltaContent: "partial" }); setTimeout(usage, 100); return; }
  usage();
  if (marker("nativemsg")) { message({ toolRequests: [{ toolCallId: "call_native", name: "shell", arguments: {}, type: "function" }] }); return; }
  const foreign = marker("foreignreq") ? "request" : marker("foreignstart") ? "start" : marker("native") ? "both" : undefined;
  const count = foreign ? 1 : Number(/\[tools:(\d)\]/.exec(text)?.[1] ?? (marker("tool") ? 1 : 0));
  if (marker("next") || count) {
    const ids = Array.from({ length: marker("next") ? 1 : count }, () => `call_${process.pid}_${++sequence}`);
    message({ toolRequests: ids.map(toolCallId => ({ toolCallId, name: toolName(), arguments: { id: toolCallId }, type: "function" })) });
    // A request for a call the model never announced, ahead of the announced ones.
    if (marker("extrareq")) event("external_tool.requested", { requestId: `rq_extra_${process.pid}`, toolCallId: "call_extra", toolName: toolName(), arguments: {} });
    for (const toolCallId of ids) {
      const requestId = `rq_${process.pid}_${++sequence}`; pending.set(requestId, { toolCallId });
      event("tool.execution_start", { toolCallId, toolName: foreign === "start" || foreign === "both" ? "shell" : toolName() });
      event("external_tool.requested", { requestId, toolCallId, toolName: foreign === "request" || foreign === "both" ? "shell" : toolName(), arguments: { id: toolCallId } });
    }
    late(text, ids[0]);
    return;
  }
  event("assistant.message_delta", { deltaContent: `answer ${calls}` }); message({ content: `answer ${calls}` });
  if (!marker("noidle")) event("assistant.idle");
}

for await (const frame of copilotFrames(process.stdin)) {
  const params = record(frame.params); const id = frame.id; const ok = (result: Record<string, unknown> = {}) => send({ jsonrpc: "2.0", id, result });
  if (frame.method === "connect") ok({ protocolVersion: 3 });
  else if (frame.method === "auth.getStatus") ok({ isAuthenticated: true });
  else if (frame.method === "session.create") {
    // The first process to find this marker missing never answers `session.create`.
    if (process.env.GATEWAY_COPILOT_LIVE_STALL && !existsSync(process.env.GATEWAY_COPILOT_LIVE_STALL)) { writeFileSync(process.env.GATEWAY_COPILOT_LIVE_STALL, "x"); log({ op: "stalled" }); continue; }
    config = params; sessionId = String(params.sessionId);
    const directory = String(params.configDir);
    // The real CLI logs the conversation under the configDir even with the session store off.
    mkdirSync(join(directory, "session-state", sessionId), { recursive: true }); writeFileSync(join(directory, "session-state", sessionId, "events.jsonl"), "PROMPT-LOG\n");
    // A helper process in the CLI's process group, to show that ending the session ends the group.
    if (process.env.GATEWAY_COPILOT_LIVE_CHILD) log({ op: "child", child: spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid });
    log({ op: "create", directory, tmpdir: process.env.TMPDIR, params });
    ok({ sessionId });
  } else if (frame.method === "session.sendMessages") {
    const messages = params.messages as Array<{ prompt: string; attachments?: unknown[] }>;
    log({ op: frame.method, prompts: messages.map(entry => entry.prompt), attachments: messages.map(entry => entry.attachments) }); ok({ messageIds: ["fixture"] });
    respond(messages.at(-1)!.prompt);
  } else if (frame.method === "session.tools.handlePendingToolCall") {
    const requestId = String(params.requestId); const known = pending.get(requestId);
    log({ op: "deliver", requestId, toolCallId: known?.toolCallId, result: params.result });
    if (!known || rejectNext) { ok({ success: false }); continue; }
    pending.delete(requestId); delivered.push(params.result); ok({ success: true });
    event("external_tool.completed", { requestId });
    if (!pending.size) {
      const results = delivered.splice(0).map(value => typeof value === "string" ? value : String(record(value).textResultForLlm));
      respond(results.some(value => value.includes("NEXT")) ? "[next]" : `final ${results.join("|")}`);
    }
  } else if (frame.method === "session.abort") { log({ op: "abort" }); ok({ success: true }); }
  else if (frame.method === "session.model.switchTo") {
    log({ op: "switch", effort: params.reasoningEffort });
    // A slow answer keeps the thread's request waiting inside its placement.
    setTimeout(() => ok({ status: "applied", deferred: false }), Number(process.env.GATEWAY_COPILOT_LIVE_SLOW_SWITCH ?? 0));
  }
  else if (frame.method === "session.delete") ok({ success: true });
  else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
}
log({ op: "stdin_closed" });
