import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, gatewayToken } from "../dist/config.js";

const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, fixture: { type: "string" }, select: { type: "string" }, formats: { type: "string", default: "png" }, replay: { type: "boolean" } } });
if (!values.config || !values.output || !values.fixture) throw new Error("Required: --config PATH --fixture DIRECTORY --output PATH");
const config = await loadConfig(resolve(values.config)); const token = await gatewayToken(config.stateDirectory);
const base = `http://127.0.0.1:${config.port}`; const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const catalog = await (await fetch(base + "/v1/model-catalog", { headers })).json();
const selection = values.select?.split(",");
if (selection?.some(alias => !catalog.models.some(model => model.slug === alias))) throw new Error("Selected alias is absent from the catalog");
const models = selection ? catalog.models.filter(model => selection.includes(model.slug)) : catalog.models;
const types = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const formats = values.formats.split(","); if (formats.some(format => !types[format])) throw new Error("Formats: png,jpg,gif,webp");
const expected = JSON.parse(await readFile(join(values.fixture, "expected.json"), "utf8"));
const report = { checkedAt: new Date().toISOString(), loadedModelCount: catalog.models.length, results: [] };
const save = () => writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
async function run(model, format, name, input, tools) {
  const effort = model.supported_reasoning_levels?.find(level => level.effort === "low")?.effort;
  const request = { model: model.slug, input, tool_choice: "none", ...(tools ? { tools } : {}), ...(effort ? { reasoning: { effort, summary: "none" } } : {}) };
  const start = Date.now(); let result; let body;
  try {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers, signal: AbortSignal.timeout(90000), body: JSON.stringify(request) });
    body = await response.json(); const text = typeof body.output_text === "string" ? body.output_text : "";
    const visible = name === "follow-up" ? ["blue", "triangle"] : [...expected.colors, ...expected.shapes];
    result = { model: model.slug, format, name, httpStatus: response.status, completed: body.status === "completed", codeReadFromPixels: text.includes(expected.code), visualFactsReturned: visible.every(word => text.toLowerCase().includes(word)), codeAbsentFromRequest: !JSON.stringify(request).includes(expected.code), ...(body.error ? { errorCode: body.error.code, errorMessage: body.error.message } : {}) };
    result.passed = response.ok && result.completed && result.codeReadFromPixels && result.visualFactsReturned && (name === "follow-up" || result.codeAbsentFromRequest);
  } catch { result = { model: model.slug, format, name, passed: false, error: "request or stream failed" }; }
  result.durationMs = Date.now() - start; report.results.push(result); await save(); console.log(JSON.stringify(result)); return body;
}
for (const model of models) for (const format of formats) {
  const bytes = await readFile(join(values.fixture, "fixture." + format));
  const image = { type: "input_image", image_url: `data:${types[format]};base64,${bytes.toString("base64")}`, detail: "auto" };
  const initial = [{ role: "user", content: [{ type: "input_text", text: "Read the eight-digit code printed in this picture, then name each shape and its color. Do not use tools." }, image] }];
  const response = await run(model, format, "user-image", initial);
  if (values.replay && response?.status === "completed") {
    await run(model, format, "follow-up", [...initial, { role: "assistant", content: response.output_text }, { role: "user", content: "Repeat the picture's code and the rightmost shape with its color. Do not use tools." }]);
    const tools = [{ type: "function", name: "view_image", description: "Caller image viewer", parameters: { type: "object", properties: {} } }];
    await run(model, format, "tool-image", [{ role: "user", content: "Use the image returned by the caller's viewer. Read its eight-digit code, then name each shape and its color." }, { type: "function_call", call_id: "image_fixture_call", name: "view_image", arguments: "{}" }, { type: "function_call_output", call_id: "image_fixture_call", output: [image] }], tools);
  }
}
report.passed = report.results.length > 0 && report.results.every(result => result.passed); await save(); if (!report.passed) process.exitCode = 1;
