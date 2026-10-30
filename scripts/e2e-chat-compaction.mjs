#!/usr/bin/env node
// Live check of the Chat Completions shapes Codex compaction sends, against a real configured provider (local Qwen by default).
// It uses the package's own translator, prints only PASS/FAIL lines and fixed error codes, and never prints credentials,
// request bodies or model output beyond a length. Usage:
//   node scripts/e2e-chat-compaction.mjs --package INSTALLED_PACKAGE_OR_CHECKOUT --config GATEWAY_CONFIG [--provider qwen]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({ options: { package: { type: "string" }, config: { type: "string" }, provider: { type: "string", default: "qwen" } } });
if (!values.package || !values.config) { console.error("Pass --package and --config"); process.exit(2); }
const dist = resolve(values.package, "dist");
const load = name => import(pathToFileURL(resolve(dist, name)).href);
const { loadConfig } = await load("config.js");
const { ChatCompletionsAPI } = await load("providers/chat-completions-api.js");
const config = await loadConfig(resolve(values.config));
const provider = (config.providers || []).find(entry => entry.id === values.provider && entry.type === "chat-completions-api");
if (!provider) { console.error(`No chat-completions-api provider named ${values.provider}`); process.exit(2); }
const model = Object.values(provider.models)[0];
const tools = [{ type: "function", name: "exec_command", parameters: { type: "object", properties: { cmd: { type: "string" } } } }];
const history = [
  { type: "message", role: "user", content: "Check uptime, then save a note." },
  { type: "function_call", call_id: "call_exec", name: "exec_command", arguments: "{\"cmd\":\"uptime\"}" },
  { type: "function_call_output", call_id: "call_exec", output: "up 3 days" },
  { type: "function_call", call_id: "call_mcp", name: "mcp__recall__report_correction", arguments: "{\"text\":\"use uv\"}" },
  { type: "function_call_output", call_id: "call_mcp", output: "saved" },
  { type: "message", role: "user", content: "Summarize the conversation in one sentence." },
];

async function run(request) {
  let text = "";
  for await (const event of new ChatCompletionsAPI(provider).infer({ model, reasoning: { effort: "medium" }, ...request }, AbortSignal.timeout(120000))) text += event.delta ?? event.text ?? "";
  return text.trim();
}
const cases = [
  ["compaction: no tools, tool_choice auto, parallel calls, undeclared historical tool", async () => {
    const text = await run({ input: history, tool_choice: "auto", parallel_tool_calls: true }); if (!text) throw new Error("empty answer");
  }],
  ["turn: declared tools with an undeclared historical tool", async () => {
    await run({ input: history, tools, tool_choice: "auto" });
  }],
  ["overflow: an oversized prompt is context_length_exceeded", async () => {
    try { await run({ input: "lorem ipsum dolor sit amet ".repeat(70000) }); } catch (error) { if (error.code === "context_length_exceeded") return; throw error; }
    throw new Error("an oversized prompt was accepted");
  }],
];
let failed = 0;
for (const [name, check] of cases) {
  try { await check(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error?.code ?? "error"} ${String(error?.message ?? "").slice(0, 120)}`); }
}
process.exit(failed ? 1 : 0);
