#!/usr/bin/env node
// A scripted stand-in for `copilot --headless --stdio` that speaks the live-session protocol: external tool
// requests that wait for `session.tools.handlePendingToolCall`, a model call per user turn or delivered result,
// and a prompt log under the configDir like the real CLI keeps. It records what it was asked in a log file.
// The scripted model reads only the markers in the latest user text, such as [tool], [hang] or [late:model.call_start].
// Like CLI 1.0.97 it announces `session.start` and `session.managed_settings_resolved` right after answering
// `session.create`, confirms `session.model.switchTo` with `session.model_change` before it answers (and
// `session.info` after), and follows `assistant.idle` with `session.idle`.
import { copilotFrames, record } from "../providers/copilot-rpc.js";
import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
const frame = (value: unknown) => { const body = JSON.stringify(value); return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`; };
/** One write, so the messages can reach the gateway as one chunk. */
const send = (...values: unknown[]) => { process.stdout.write(values.map(frame).join("")); };
const log = (entry: Record<string, unknown>) => { if (process.env.GATEWAY_COPILOT_LIVE_LOG) appendFileSync(process.env.GATEWAY_COPILOT_LIVE_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
let sessionId = ""; let config: Record<string, unknown> = {}; let calls = 0; let sequence = 0;
/** How the next tool result is answered: refused, with a JSON-RPC error, or never. */
let rejectNext = false; let errorNext = false; let silentNext = false;
const pending = new Map<string, { toolCallId: string }>(); const delivered: unknown[] = [];
const eventMessage = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", method: "session.event", params: { sessionId, event: { type, data, ...extra } } });
const event = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => send(eventMessage(type, data, extra));
/** The name the gateway gave the caller's first tool. */
const toolName = () => String((config.availableTools as string[] | undefined)?.[0]);
const usageMessage = () => {
  calls++;
  return eventMessage("assistant.usage", { isByok: false, initiator: calls === 1 ? "user" : "agent", inputTokens: 100 * calls, outputTokens: 5, cacheReadTokens: calls === 1 ? 0 : 100 * (calls - 1), cacheWriteTokens: calls === 1 ? 100 : 10, reasoningTokens: 1, copilotUsage: { totalNanoAiu: calls === 1 ? 1e9 : 1e8 } });
};
const usage = () => send(usageMessage());
const message = (data: Record<string, unknown>) => event("assistant.message", { model: config.model, providerId: "copilot", content: "", toolRequests: [], ...data });
const env = (name: string) => process.env[`GATEWAY_COPILOT_LIVE_${name}`];
/** The end of a finished turn as CLI 1.0.97 sends it: `assistant.idle`, then `session.idle` a moment later, both ephemeral. */
const idle = () => { event("assistant.idle", {}, { ephemeral: true }); setTimeout(() => event("session.idle", {}, { ephemeral: true }), 5); };
const later = (ms: number, run: () => void) => { if (ms > 0) setTimeout(run, ms); else run(); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Earlier CLI processes of this test that are still running, and the gateway folders next to this one: what a new session starts beside. */
function surroundings(directory: string) {
  const path = env("LOG"); const earlier = path && existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).pid as number) : [];
  return { alivePeers: [...new Set(earlier)].filter(pid => pid !== process.pid && alive(pid)), folders: readdirSync(dirname(directory)).filter(name => name.startsWith("gateway-copilot-") && name !== basename(directory)) };
}
/** What a file attachment points at, so a test can check the bytes without the log holding them. */
const fileOf = (attachment: Record<string, unknown>) => {
  const path = String(attachment.path);
  try { const info = statSync(path); return { path, mode: info.mode & 0o777, sha: createHash("sha256").update(readFileSync(path)).digest("hex") }; } catch { return { path, missing: true }; }
};
if (env("IGNORE_TERM")) process.on("SIGTERM", () => log({ op: "sigterm" }));

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
  // Output, then nothing: a request that is running when its session closes.
  if (marker("stall")) { usage(); event("assistant.message_delta", { deltaContent: "partial" }); return; }
  rejectNext = marker("reject"); errorNext = marker("rpcerror"); silentNext = marker("nodeliver");
  if (marker("die") && process.env.GATEWAY_COPILOT_LIVE_DIE && !existsSync(process.env.GATEWAY_COPILOT_LIVE_DIE)) { writeFileSync(process.env.GATEWAY_COPILOT_LIVE_DIE, "x"); process.exit(1); }
  if (marker("permission")) { event("permission.requested", { requestId: "permission" }); return; }
  if (marker("lateusage")) { event("assistant.message_delta", { deltaContent: "partial" }); setTimeout(usage, 100); return; }
  if (marker("lateusage2")) { event("assistant.message_delta", { deltaContent: "partial" }); setTimeout(() => { usage(); usage(); }, 100); return; }
  // Text, then 100 ms later more text and the call's usage in one write, then nothing.
  if (marker("deltausage")) { event("assistant.message_delta", { deltaContent: "a" }); setTimeout(() => send(eventMessage("assistant.message_delta", { deltaContent: "b" }), usageMessage()), 100); return; }
  // An answer too large for a client that does not read to take at once, then the call's usage, then nothing.
  if (marker("bigusage")) { event("assistant.message_delta", { deltaContent: "x".repeat(7 * 1024 * 1024) }); usage(); log({ op: "bigusage_sent" }); return; }
  usage();
  // An answer that takes a while: its text arrives at once, the rest 400 ms later.
  if (marker("slow")) { event("assistant.message_delta", { deltaContent: `answer ${calls}` }); setTimeout(() => { message({ content: `answer ${calls}` }); idle(); }, 400); return; }
  if (marker("nativemsg")) { message({ toolRequests: [{ toolCallId: "call_native", name: "shell", arguments: {}, type: "function" }] }); return; }
  const foreign = marker("foreignreq") ? "request" : marker("foreignstart") ? "start" : marker("native") ? "both" : undefined;
  const count = foreign ? 1 : Number(/\[tools:(\d+)\]/.exec(text)?.[1] ?? (marker("tool") ? 1 : 0));
  if (marker("next") || count) {
    const ids = Array.from({ length: marker("next") ? 1 : count }, () => `call_${process.pid}_${++sequence}`);
    message({ toolRequests: ids.map(toolCallId => ({ toolCallId, name: toolName(), arguments: { id: toolCallId }, type: "function" })) });
    // A request for a call the model never announced, ahead of the announced ones.
    if (marker("extrareq")) event("external_tool.requested", { requestId: `rq_extra_${process.pid}`, toolCallId: "call_extra", toolName: toolName(), arguments: {} });
    for (const toolCallId of ids) {
      const requestId = `rq_${process.pid}_${++sequence}`; pending.set(requestId, { toolCallId });
      event("tool.execution_start", { toolCallId, toolName: foreign === "start" || foreign === "both" ? "shell" : toolName() });
      // A tool call whose pending request never comes.
      if (marker("norequest")) continue;
      event("external_tool.requested", { requestId, toolCallId, toolName: foreign === "request" || foreign === "both" ? "shell" : toolName(), arguments: { id: toolCallId } });
    }
    late(text, ids[0]);
    return;
  }
  event("assistant.message_delta", { deltaContent: `answer ${calls}` }); message({ content: `answer ${calls}` });
  if (!marker("noidle")) idle();
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
    log({ op: "create", directory, args: process.argv.slice(2), tmpdir: process.env.TMPDIR, params, ...surroundings(directory) });
    // An event of the given type just before `session.create` answers, while the gateway is still starting a live
    // session: in the same write as the answer, or on its own when the answer is delayed.
    const boot = env("BOOT_EVENT") && directory.includes("-live-") ? [eventMessage(env("BOOT_EVENT")!, {})] : [];
    const delay = Number(env("SLOW_CREATE") ?? 0);
    if (delay > 0) send(...boot);
    later(delay, () => send(...(delay > 0 ? [] : boot), { jsonrpc: "2.0", id, result: { sessionId } },
      eventMessage("session.start", { sessionId, version: 1, producer: "copilot-agent", copilotVersion: "1.0.97" }), eventMessage("session.managed_settings_resolved", {}, { ephemeral: true })));
  } else if (frame.method === "session.sendMessages") {
    const messages = params.messages as Array<{ prompt: string; attachments?: Array<Record<string, unknown>> }>;
    log({ op: frame.method, prompts: messages.map(entry => entry.prompt), attachments: messages.map(entry => entry.attachments), files: messages.map(entry => (entry.attachments ?? []).map(fileOf)) }); ok({ messageIds: ["fixture"] });
    respond(messages.at(-1)!.prompt);
  } else if (frame.method === "session.tools.handlePendingToolCall") {
    const requestId = String(params.requestId); const known = pending.get(requestId);
    log({ op: "deliver", requestId, toolCallId: known?.toolCallId, result: params.result });
    if (silentNext) continue;
    if (errorNext) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: "refused" } }); continue; }
    if (!known || rejectNext) { ok({ success: false }); continue; }
    pending.delete(requestId); delivered.push(params.result); ok({ success: true });
    event("external_tool.completed", { requestId });
    if (!pending.size) {
      const results = delivered.splice(0).map(value => typeof value === "string" ? value : String(record(value).textResultForLlm));
      respond(results.some(value => value.includes("NEXT")) ? "[next]" : `final ${results.join("|")}`);
    }
  } else if (frame.method === "session.abort") { log({ op: "abort" }); later(Number(env("SLOW_ABORT") ?? 0), () => ok({ success: true })); }
  else if (frame.method === "session.model.switchTo") {
    log({ op: "switch", effort: params.reasoningEffort });
    const changed = eventMessage("session.model_change", { source: "sdk", previousModel: config.model, newModel: params.modelId, previousReasoningEffort: config.reasoningEffort, reasoningEffort: env("SWITCH_EFFORT") ?? params.reasoningEffort });
    config.reasoningEffort = params.reasoningEffort;
    // The confirmation and the answer in one write, so the gateway reads them together and the confirmation is routed after the
    // change has returned, possibly after the next request attached.
    if (env("SWITCH_ONE_WRITE")) { send(changed, { jsonrpc: "2.0", id, result: { status: "applied", deferred: false } }, eventMessage("session.info", { infoType: "model" }, { ephemeral: true })); continue; }
    // The real CLI announces the change before it answers.
    send(changed);
    // A slow answer keeps the thread's request waiting inside its placement. The CLI then reports the new state.
    setTimeout(() => { ok({ status: "applied", deferred: false }); event("session.info", { infoType: "model" }, { ephemeral: true }); }, Number(env("SLOW_SWITCH") ?? 0));
  }
  else if (frame.method === "session.delete") { log({ op: "delete" }); ok({ success: true }); }
  else send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unsupported" } });
}
log({ op: "stdin_closed" });
// A CLI that ignores SIGTERM also outlives its input; only SIGKILL ends it.
if (env("IGNORE_TERM")) setInterval(() => {}, 1000);
