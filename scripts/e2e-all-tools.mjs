import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { loadConfig } from "../dist/config.js";

const { values } = parseArgs({ options: { config: { type: "string" }, codex: { type: "string" }, "work-dir": { type: "string" }, output: { type: "string" }, select: { type: "string" } } });
for (const key of ["config", "codex", "work-dir", "output"]) if (!values[key]) throw new Error(`Required: --${key}`);
const configPath = resolve(values.config); const config = await loadConfig(configPath);
const root = resolve(values["work-dir"]); await mkdir(root, { recursive: true });
const all = config.providers.flatMap(provider => Object.keys(provider.models));
const selected = values.select?.split(",") || all;
if (selected.some(model => !all.includes(model))) throw new Error("Selected alias is absent from the configured catalog");
const report = { checkedAt: new Date().toISOString(), results: [] };
for (const model of selected) {
  const name = model.replace(/[^a-z0-9_-]/gi, "_"); const output = join(root, name + ".json");
  const child = spawn(process.execPath, [new URL("./e2e-codex.mjs", import.meta.url).pathname, "--config", configPath, "--model", model, "--codex", resolve(values.codex), "--work-dir", join(root, name), "--output", output], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => { try { const event = JSON.parse(line); console.log(JSON.stringify({ model, name: event.name, status: event.status, passed: event.passed })); } catch {} });
  const exitCode = await new Promise(resolve => { child.once("error", () => resolve(null)); child.once("close", resolve); });
  lines.close();
  const result = await readFile(output, "utf8").then(JSON.parse, () => ({ results: [] }));
  const verified = result.results.find(entry => entry.name === "verification");
  report.results.push({ model, passed: exitCode === 0 && verified?.passed === true, exitCode, phases: result.results.map(entry => ({ name: entry.name, status: entry.status, passed: entry.passed, supported: entry.supported, error: entry.error })) });
  await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
report.passed = report.results.length === selected.length && report.results.every(result => result.passed);
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); if (!report.passed) process.exitCode = 1;
