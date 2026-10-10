#!/usr/bin/env node
/** Private, per-request virtual tool catalog. It never executes caller tools. */
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const tools = JSON.parse(await readFile(process.argv[2], "utf8")) as Array<Record<string, unknown>>;
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  let message: { id?: number | string; method?: string; params?: { protocolVersion?: string } };
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result: unknown;
  if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Gateway caller tools", version: "0.1.0" } };
  else if (message.method === "tools/list") result = { tools };
  else if (message.method === "ping") result = {};
  else if (message.method === "tools/call") return; // Parent captures native tool_use and stops the CLI. Never execute or fabricate a result.
  else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown method" } }) + "\n"); return; }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n");
});
lines.on("close", () => process.exit(0));
