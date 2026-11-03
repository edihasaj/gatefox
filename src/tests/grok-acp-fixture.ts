// A fake `grok` executable for tests: `grok agent ... stdio` speaking ACP, plus the MCP client a real Grok would be.
// The prompt text picks the scenario with its last [tag]. Nothing here runs inference.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createInterface } from "node:readline";

const log = (entry: Record<string, unknown>) => { if (process.env.GATEWAY_TEST_GROK_LOG) appendFileSync(process.env.GATEWAY_TEST_GROK_LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\n"); };
const args = process.argv.slice(2);
const profilePath = args[args.indexOf("--agent-profile") + 1];
log({ op: "spawn", args, home: process.env.GROK_HOME, summary: process.env.GROK_TURN_SUMMARY, title: process.env.GROK_TITLE_REFRESH, xai: process.env.XAI_API_KEY,
  profile: profilePath ? readFileSync(profilePath, "utf8") : undefined, cwd: process.cwd() });
if (process.env.GATEWAY_TEST_GROK_DIE_ON_START) process.exit(3);
let mcpUrl = ""; let sessionId = ""; let nextId = 1000; let promptId = 0;
const waiting = new Map<number, (message: Record<string, any>) => void>(); // eslint-disable-line @typescript-eslint/no-explicit-any
const send = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (value: Record<string, unknown>) => send({ method: "session/update", params: { sessionId, update: value } });
const chunk = (text: string, kind = "agent_message_chunk") => update({ sessionUpdate: kind, content: { type: "text", text } });
const ask = (rawInput: Record<string, unknown>, title: string) => new Promise<Record<string, any>>(resolve => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const id = nextId++; waiting.set(id, resolve);
  send({ id, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: `t${id}`, title, kind: "execute", rawInput },
    options: [{ optionId: "a", kind: "allow_once", name: "Allow" }, { optionId: "aa", kind: "allow_always", name: "Always" }, { optionId: "r", kind: "reject_once", name: "Reject" }] } });
});
const mcp = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, any>>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const url = new URL(mcpUrl); const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
  const call = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } }, response => {
    let text = ""; response.on("data", piece => { text += piece; }); response.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  });
  call.on("error", reject); call.end(body);
});
/** Posts a raw JSON-RPC body and waits only for the response to end (a 202 has no body). */
const mcpRaw = (frame: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
  const url = new URL(mcpUrl);
  const call = request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json" } }, response => {
    response.resume(); response.on("end", () => resolve());
  });
  call.on("error", reject); call.end(JSON.stringify({ jsonrpc: "2.0", ...frame }));
});
const selected = (reply: Record<string, any>) => reply.result?.outcome?.outcome === "selected" ? String(reply.result.outcome.optionId) : "cancelled"; // eslint-disable-line @typescript-eslint/no-explicit-any

async function useGateway(toolName: string, input: Record<string, unknown>): Promise<string> {
  update({ sessionUpdate: "tool_call", toolCallId: "u", title: "use_tool", status: "pending" });
  const outcome = selected(await ask({ variant: "UseTool", tool_name: `gateway__${toolName}`, tool_input: input }, "use_tool"));
  log({ op: "permission", variant: "UseTool", tool: `gateway__${toolName}`, outcome });
  if (outcome !== "a") return `denied:${outcome}`;
  const local = toolName.replace(/^gateway__/, "");
  const reply = await mcp("tools/call", { name: local, arguments: input });
  log({ op: "result", text: reply.result?.content?.[0]?.text, isError: reply.result?.isError, error: reply.error?.message });
  return String(reply.result?.content?.[0]?.text ?? `error:${reply.error?.message}`);
}

async function prompt(text: string): Promise<string> {
  const tag = [...text.matchAll(/\[(\w+)\]/g)].at(-1)?.[1] ?? "plain";
  log({ op: "prompt", tag, chars: text.length });
  if (tag === "crash") { chunk("partial"); process.exit(1); }
  if (tag === "stall") { chunk("started"); await new Promise(() => {}); }
  // A frame that is valid JSON but not an object; a real gateway must end the connection, not crash.
  // Also shape faults: an error whose message is an object that would throw if coerced to a string, and a numeric id with a string method.
  const frames: Record<string, string> = { nullframe: "null", arrayframe: "[]", numframe: "42",
    badmsg: `{"jsonrpc":"2.0","id":${promptId},"error":{"code":-32000,"message":{"toString":null}}}`,
    badcode: `{"jsonrpc":"2.0","id":${promptId},"error":{"code":"x","message":"y"}}`,
    badresult: `{"jsonrpc":"2.0","id":${promptId},"result":"done"}` };
  if (tag in frames) { process.stdout.write(frames[tag] + "\n"); await new Promise(() => {}); }
  if (tag === "auth") throw new Error("authentication required");
  // A first prompt that shows a sign of inference and then fails with a rejected sign-in and no text: the work may have been charged.
  if (tag === "authtool") { update({ sessionUpdate: "tool_call", toolCallId: "s1", title: "search_tool", kind: "search", status: "completed", rawInput: { variant: "SearchTool", query: "lookup" } }); throw new Error("authentication required"); }
  if (tag === "authupdate") { update({ sessionUpdate: "tool_call_update", toolCallId: "s1", status: "completed" }); throw new Error("authentication required"); }
  if (tag === "authinfo") { update({ sessionUpdate: "session_info_update", title: "x" }); throw new Error("authentication required"); }
  if (tag === "authusage") { update({ sessionUpdate: "usage_update", used: 10, size: 1000 }); throw new Error("authentication required"); }
  if (tag === "authperm") { await ask({ variant: "RunTerminalCommand", command: "touch x" }, "touch x"); throw new Error("authentication required"); }
  if (tag === "authmcp") { await mcp("tools/call", { name: "unlisted", arguments: {} }); throw new Error("authentication required"); }
  // A tool call without a usable id is still a sign of inference.
  if (tag === "authmcpnoid") { await mcpRaw({ method: "tools/call", params: { name: "unlisted", arguments: {} } }); throw new Error("authentication required"); }
  if (tag === "authmcpnull") { await mcpRaw({ id: null, method: "tools/call", params: { name: "unlisted", arguments: {} } }); throw new Error("authentication required"); }
  // Pure setup notifications prove nothing: the sign-in failure after them is still a clean first prompt.
  if (tag === "authsetup") { update({ sessionUpdate: "available_commands_update", availableCommands: [] }); update({ sessionUpdate: "current_mode_update", currentModeId: "default" }); throw new Error("authentication required"); }
  // A stop reason that is provider-controlled text: it must reach neither telemetry nor a message.
  if (tag === "stopcanary") { chunk("x"); return "CANARY_STOP_REASON_4711"; }
  if (tag === "plain") { chunk(`answer to ${tag}`); return "end_turn"; }
  const listed = await mcp("tools/list");
  const names: string[] = (listed.result?.tools ?? []).map((tool: { name: string }) => tool.name);
  log({ op: "listed", names, discover: (await mcp("server/discover")).error?.code });
  if (tag === "native") {
    const outcome = selected(await ask({ variant: "RunTerminalCommand", command: "touch native-ran" }, "touch native-ran"));
    log({ op: "permission", variant: "RunTerminalCommand", outcome });
    if (outcome === "a") writeFileSync("native-ran", "ran"); // a fail-open CLI would run it
    chunk(`native:${outcome}`); return "end_turn";
  }
  if (tag === "unknown") { chunk(`unknown:${await useGateway("tool_not_in_catalog", {})}`); return "end_turn"; }
  if (tag === "search") {
    const outcome = selected(await ask({ variant: "SearchTool", query: "lookup" }, "search_tool")); log({ op: "permission", variant: "SearchTool", outcome });
    chunk(`search:${outcome}`); return "end_turn";
  }
  if (tag === "tool" || tag === "think") {
    chunk("thinking about it", "agent_thought_chunk"); chunk("Looking it up. ");
    chunk(`got:${await useGateway(names[0], { id: "7" })}`); return "end_turn";
  }
  if (tag === "twice") {
    chunk(`first:${await useGateway(names[0], { id: "1" })}|`);
    chunk(`second:${await useGateway(names[0], { id: "2" })}`); return "end_turn";
  }
  if (tag === "parallel") {
    const [one, two] = await Promise.all([useGateway(names[0], { id: "a" }), useGateway(names[0], { id: "b" })]);
    chunk(`both:${one},${two}`); return "end_turn";
  }
  chunk(`unhandled ${tag}`); return "end_turn";
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  const message = JSON.parse(line) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (message.method === undefined) { waiting.get(message.id)?.(message); waiting.delete(message.id); return; }
  const reply = (result: Record<string, unknown>) => send({ id: message.id, result });
  if (message.method === "initialize") return reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
  if (message.method === "session/new") {
    mcpUrl = message.params.mcpServers[0].url; sessionId = "fixture-session";
    log({ op: "new", servers: message.params.mcpServers.map((server: Record<string, unknown>) => ({ type: server.type, name: server.name })), cwd: message.params.cwd });
    return reply({ sessionId });
  }
  if (message.method === "session/prompt") {
    const text = String(message.params.prompt?.[0]?.text ?? ""); promptId = message.id;
    void prompt(text).then(stopReason => reply({ stopReason }),
      () => send({ id: message.id, error: { code: -32000, message: "authentication required" } }));
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
lines.on("close", () => process.exit(0));
// A test whose parent is gone must not leave a fixture behind.
setInterval(() => { try { process.kill(process.ppid, 0); } catch { process.exit(0); } }, 1000).unref();
