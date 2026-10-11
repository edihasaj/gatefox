import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import assert from "node:assert/strict";
import { AppServerConnection } from "../dist/app-server-connection.js";
import { remoteCodexSettings } from "../dist/codex-config.js";

const { values } = parseArgs({ options: { endpoint: { type: "string" }, "token-file": { type: "string" }, models: { type: "string" }, codex: { type: "string" }, image: { type: "string" }, expected: { type: "string" }, "work-dir": { type: "string" }, output: { type: "string" } } });
for (const key of ["endpoint", "token-file", "models", "codex", "image", "expected", "work-dir", "output"]) if (!values[key]) throw new Error(`Required: --${key}`);
const directory = resolve(values["work-dir"]); const home = join(directory, "codex-home"); const workspace = join(directory, "workspace");
await mkdir(home, { recursive: true }); await mkdir(workspace, { recursive: true });
const imagePath = join(workspace, "fixture.png"); await writeFile(imagePath, await readFile(resolve(values.image)), { mode: 0o600 });
const code = values.expected; const results = []; const save = () => writeFile(resolve(values.output), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2) + "\n", { mode: 0o600 });
let connection; let notifications = []; let completed = new Map(); let waiters = new Map(); let interrupt; let effort;
async function connect(model) {
  await writeFile(join(home, "config.toml"), await remoteCodexSettings(model, values.endpoint, resolve(values["token-file"]), join(home, "models.json")), { mode: 0o600 });
  const catalog = JSON.parse(await readFile(join(home, "models.json"), "utf8"));
  effort = catalog.models.find(entry => entry.slug === model)?.supported_reasoning_levels?.find(level => level.effort === "low")?.effort;
  notifications = []; completed = new Map(); waiters = new Map();
  connection = new AppServerConnection(resolve(values.codex), ["app-server", "--listen", "stdio://"], async message => {
    if (message.id !== undefined) { connection.send({ id: message.id, error: { code: -32601, message: "Unsupported test-client request" } }); return; }
    notifications.push(message);
    if (interrupt && message.method === "item/agentMessage/delta") {
      const control = interrupt; interrupt = undefined;
      connection.request("turn/interrupt", { threadId: control.threadId, turnId: control.turnId }).then(() => { control.acknowledged = true; }).catch(() => { control.acknowledged = false; });
    }
    if (message.method === "turn/completed") { const turn = message.params.turn; completed.set(turn.id, turn); waiters.get(turn.id)?.(turn); }
  }, () => {}, { ...process.env, CODEX_HOME: home });
  await connection.request("initialize", { clientInfo: { name: "gateway_image_e2e", version: "0.1.0" } }); connection.send({ method: "initialized", params: {} });
}
async function turn(threadId, model, input, cancel = false) {
  const offset = notifications.length;
  const response = await connection.request("turn/start", { threadId, model, input, ...(effort ? { effort } : {}) });
  const control = { threadId, turnId: response.turn.id, acknowledged: false }; if (cancel) interrupt = control;
  const turn = completed.get(response.turn.id) || await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Image test turn timed out")), 120000);
    waiters.set(response.turn.id, value => { clearTimeout(timer); resolve(value); });
  });
  const events = notifications.slice(offset); const items = events.filter(event => event.method === "item/completed").map(event => event.params.item);
  return { turn, items, text: events.filter(event => event.method === "item/agentMessage/delta").map(event => event.params.delta).join(""), control };
}
const text = value => [{ type: "text", text: value }];
async function start(model) { return (await connection.request("thread/start", { model, modelProvider: "subscription_gateway", cwd: workspace, approvalPolicy: "never", sandbox: "read-only" })).thread.id; }
async function record(model, name, data) { results.push({ model, name, ...data }); await save(); console.log(JSON.stringify(results.at(-1))); }
try {
  for (const model of values.models.split(",")) {
    await connect(model); const id = await start(model);
    const prompt = "Read the eight-digit code from the attached picture and list each colored shape. Do not use tools."; assert.equal(prompt.includes(code), false);
    const image = await turn(id, model, [...text(prompt), { type: "localImage", path: imagePath }]);
    assert.equal(image.turn.status, "completed"); assert.ok(image.text.includes(code)); assert.ok(image.text.toLowerCase().includes("triangle"));
    assert.equal(image.items.some(item => ["commandExecution", "fileChange", "imageView"].includes(item.type)), false);
    await record(model, "native-user-image", { passed: true, codeReadFromPixels: true, promptContainedCode: false, toolCalls: 0 });
    const paused = await turn(id, model, text("Write 200 numbered paragraphs about trees. Begin immediately. Do not use tools."), true);
    assert.equal(paused.turn.status, "interrupted"); assert.equal(paused.control.acknowledged, true);
    await record(model, "stop", { passed: true, status: paused.turn.status });
    connection.stop(); await connection.exited; await connect(model);
    await connection.request("thread/resume", { threadId: id, model, modelProvider: "subscription_gateway", cwd: workspace, approvalPolicy: "never", sandbox: "read-only" });
    const resumed = await turn(id, model, text("Repeat the picture's code and the rightmost shape's color. Do not use tools."));
    assert.equal(resumed.turn.status, "completed"); assert.ok(resumed.text.includes(code)); assert.ok(resumed.text.toLowerCase().includes("blue"));
    await record(model, "resume-after-engine-restart", { passed: true, imageHistoryPreserved: true });
    const toolId = await start(model);
    const viewed = await turn(toolId, model, text(`Use view_image to open ${imagePath}. Read its eight-digit code and list the colored shapes. Do not guess, use shell commands, or read another file.`));
    assert.equal(viewed.turn.status, "completed"); assert.ok(viewed.text.includes(code));
    assert.ok(viewed.items.some(item => item.type === "imageView" && item.path === imagePath));
    await record(model, "native-view-image-tool", { passed: true, actualImageViewExecuted: true, codeReadFromPixels: true });
    connection.stop(); await connection.exited;
  }
  await record("all", "verification", { passed: true, pauseMeaning: "interrupt active turn; resume saved chat with a new turn" });
} catch (error) { await record("all", "verification", { passed: false, error: error.message }); process.exitCode = 1; }
finally { connection?.stop(); if (connection) await connection.exited; }
