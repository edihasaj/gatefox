#!/usr/bin/env node
// Live check of the Chat Completions shapes Codex compaction sends, against a real configured provider (local Qwen by default).
// It uses the package's own translator, prints only PASS/FAIL lines and fixed error codes, and never prints credentials,
// request bodies or model output beyond a length. Usage:
//   node scripts/e2e-chat-compaction.mjs --package INSTALLED_PACKAGE_OR_CHECKOUT --config GATEWAY_CONFIG [--provider qwen]
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const { values } = parseArgs({ options: { package: { type: "string" }, config: { type: "string" }, provider: { type: "string", default: "qwen" }, vision: { type: "boolean" } } });
if (!values.package || !values.config) { console.error("Pass --package and --config"); process.exit(2); }
const dist = resolve(values.package, "dist");
const load = name => import(pathToFileURL(resolve(dist, name)).href);
const { loadConfig } = await load("config.js");
const { ChatCompletionsAPI } = await load("providers/chat-completions-api.js");
const config = await loadConfig(resolve(values.config));
const provider = (config.providers || []).find(entry => entry.id === values.provider && entry.type === "chat-completions-api");
if (!provider) { console.error(`No chat-completions-api provider named ${values.provider}`); process.exit(2); }
const [alias, model] = Object.entries(provider.models)[0];
// --vision checks image input even before the live configuration lists it; otherwise the metadata decides.
const vision = values.vision || provider.modelMetadata?.[alias]?.inputModalities?.includes("image") === true;
if (values.vision) provider.modelMetadata = { ...provider.modelMetadata, [alias]: { ...provider.modelMetadata?.[alias], inputModalities: ["text", "image"] } };
/** A 64x64 PNG, left half red and right half blue. */
function redBluePng() {
  const w = 64, h = 64, raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w * 3 + 1) + 1 + x * 3 + (x < 32 ? 0 : 2)] = 255;
  const crc = bytes => { let c = ~0; for (const v of bytes) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
  return "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
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
if (vision) cases.push(["vision: a user image and a tool-result image reach the model", async () => {
  const image = redBluePng();
  const user = await run({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Name the two colors in this image, left then right, in at most five words." }, { type: "input_image", image_url: image }] }] });
  if (!/red/i.test(user) || !/blue/i.test(user)) throw new Error(`user image not understood (${user.length} chars)`);
  const tool = await run({ tools: [{ type: "function", name: "view_image", parameters: { type: "object", properties: { path: { type: "string" } } } }], input: [
    { type: "message", role: "user", content: "Open the screenshot." },
    { type: "function_call", call_id: "v1", name: "view_image", arguments: "{\"path\":\"/tmp/s.png\"}" },
    { type: "function_call_output", call_id: "v1", output: [{ type: "input_image", image_url: image }] },
    { type: "message", role: "user", content: "Which two colors did the screenshot show, left then right? At most five words." }] });
  if (!/red/i.test(tool) || !/blue/i.test(tool)) throw new Error(`tool image not understood (${tool.length} chars)`);
}]);
let failed = 0;
for (const [name, check] of cases) {
  try { await check(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}: ${error?.code ?? "error"} ${String(error?.message ?? "").slice(0, 120)}`); }
}
process.exit(failed ? 1 : 0);
