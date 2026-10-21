#!/usr/bin/env node
/**
 * The caller-tool catalog the Grok CLI reaches through its own search_tool and use_tool. It reads
 * the per-request catalog named by GATEWAY_GROK_CATALOG and never answers tools/call: the gateway
 * reads the streamed use_tool block, returns the call to its caller, and stops the CLI. It imports
 * only Node built-ins.
 */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const path = process.env.GATEWAY_GROK_CATALOG;
const tools = path ? JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>> : [];
const send = (message: Record<string, unknown>) => { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); };
// Deadman: if the gateway that started this request is gone, nobody can stop the CLI waiting on
// an unanswered tools/call, so stop it (our parent) and exit.
const owner = Number(process.env.GATEWAY_GROK_OWNER);
if (Number.isInteger(owner) && owner > 1) setInterval(() => {
  try { process.kill(owner, 0); } catch {
    try { if (process.ppid > 1) process.kill(process.ppid, "SIGKILL"); } catch { /* Already gone. */ }
    process.exit(1);
  }
}, 2000).unref();
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Gateway caller tools", version: "0.1.0" } } });
  else if (message.method === "tools/list") send({ id: message.id, result: { tools } });
  else if (message.method === "ping") send({ id: message.id, result: {} });
  // Never execute or fabricate a result: only the caller runs tools.
  else if (message.method === "tools/call") return;
  else send({ id: message.id, error: { code: -32601, message: "Unknown method" } });
});
lines.on("close", () => process.exit(0));
