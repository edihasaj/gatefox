import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, gatewayToken } from "../dist/config.js";

const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, select: { type: "string" } } });
if (!values.config || !values.output) throw new Error("Required: --config PATH --output PATH");
const config = await loadConfig(resolve(values.config));
const token = await gatewayToken(config.stateDirectory);
const base = `http://127.0.0.1:${config.port}`;
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const catalogResponse = await fetch(base + "/v1/model-catalog", { headers });
if (!catalogResponse.ok) throw new Error("Authenticated catalog fetch failed");
const catalog = await catalogResponse.json();
const selection = values.select?.split(",");
if (selection?.some(alias => !catalog.models.some(model => model.slug === alias))) throw new Error("Selected alias is absent from the loaded catalog");
const models = selection ? catalog.models.filter(model => selection.includes(model.slug)) : catalog.models;
const report = { checkedAt: new Date().toISOString(), test: "one real text inference per loaded model", loadedModelCount: catalog.models.length, results: [] };
const save = () => writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
for (const model of models) {
  const proof = "model-proof-" + randomUUID(); const start = Date.now();
  const effort = model.supported_reasoning_levels?.find(level => level.effort === "none")?.effort || model.supported_reasoning_levels?.[0]?.effort;
  let result;
  try {
    const response = await fetch(base + "/v1/responses", { method: "POST", headers, signal: AbortSignal.timeout(90000), body: JSON.stringify({ model: model.slug, input: `Reply with exactly this text: ${proof}. Do not use tools.`, tool_choice: "none", ...(effort ? { reasoning: { effort, summary: "none" } } : {}) }) });
    const body = await response.json();
    result = { model: model.slug, name: model.display_name, effort: effort || null, httpStatus: response.status, completed: body.status === "completed", proofReturned: typeof body.output_text === "string" && body.output_text.includes(proof), ...(body.error ? { errorCode: body.error.code, errorMessage: typeof body.error.message === "string" ? body.error.message.slice(0, 256) : undefined } : {}) };
    result.passed = response.ok && result.completed && result.proofReturned;
  } catch (error) { result = { model: model.slug, passed: false, error: error?.name === "TimeoutError" ? "timeout" : "request or stream failed" }; }
  result.durationMs = Date.now() - start; report.results.push(result); await save(); console.log(JSON.stringify(result));
}
for (let attempt = 0; attempt < 30; attempt++) {
  const health = await (await fetch(base + "/health")).json();
  if (health.active === 0) { report.activeAfterTests = 0; break; }
  await delay(100);
}
report.passed = report.results.length === models.length && report.results.every(result => result.passed) && report.activeAfterTests === 0;
await save(); if (!report.passed) process.exitCode = 1;
