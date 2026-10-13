#!/usr/bin/env node
/**
 * Private virtual tool catalog for one Claude CLI process. It never executes caller tools.
 * One-shot mode (no relay file) never answers tools/call: the gateway stops the CLI first.
 * Relay mode (argv[3] names a 0600 file with the relay socket and key) forwards each call's
 * RPC id, tool name and tool_use id to the gateway, never its arguments, and answers with
 * the caller's own output when the gateway sends it. Losing the relay kills the CLI, since
 * nobody could answer its calls any more. This file is copied next to each live session,
 * so it imports only Node built-ins.
 */
import { readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";

const tools = JSON.parse(await readFile(process.argv[2], "utf8")) as Array<Record<string, unknown>>;
const send = (message: Record<string, unknown>) => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); };
let relay: Socket | undefined;
if (process.argv[3]) {
  const { socket, key } = JSON.parse(await readFile(process.argv[3], "utf8")) as { socket: string; key: string };
  const parent = process.ppid;
  const lost = () => {
    try { if (parent > 1 && process.ppid === parent) process.kill(parent, "SIGKILL"); } catch { /* Already gone. */ }
    process.exit(1);
  };
  relay = connect(socket); relay.setEncoding("utf8");
  relay.on("error", lost); relay.on("close", lost);
  relay.write(JSON.stringify({ hello: key }) + "\n");
  let buffer = "";
  relay.on("data", (chunk: string) => {
    let start = 0;
    for (let end = chunk.indexOf("\n"); end >= 0; start = end + 1, end = chunk.indexOf("\n", start)) {
      const line = buffer + chunk.slice(start, end); buffer = "";
      try {
        const frame = JSON.parse(line) as { result?: number | string; content?: unknown };
        if (frame.result !== undefined && Array.isArray(frame.content)) send({ id: frame.result, result: { content: frame.content } });
      } catch { /* A malformed frame is ignored. */ }
    }
    buffer += chunk.slice(start);
    if (buffer.length > 16 * 1024 * 1024) lost();
  });
}
// Caller outputs can be large; the CLI otherwise moves long results into files the model cannot read.
const catalog = relay ? tools.map(tool => ({ ...tool, _meta: { "anthropic/maxResultSizeChars": 2000000 } })) : tools;
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message: { id?: number | string; method?: string; params?: { protocolVersion?: string; name?: unknown; _meta?: Record<string, unknown> } };
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result: unknown;
  if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Gateway caller tools", version: "0.1.0" } };
  else if (message.method === "tools/list") result = { tools: catalog };
  else if (message.method === "ping") result = {};
  else if (message.method === "tools/call") {
    const toolUseId = message.params?._meta?.["claudecode/toolUseId"];
    // Never execute or fabricate a result: only the caller's output, via the gateway, answers a call.
    relay?.write(JSON.stringify({ call: message.id, name: message.params?.name, ...(typeof toolUseId === "string" ? { toolUseId } : {}) }) + "\n");
    return;
  } else { send({ id: message.id, error: { code: -32601, message: "Unknown method" } }); return; }
  send({ id: message.id, result });
});
lines.on("close", () => process.exit(0));
