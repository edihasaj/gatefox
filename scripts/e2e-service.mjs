// Explicit opt-in: uses the gateway LaunchAgent only when none is installed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken } from "../dist/config.js";

assert.equal(process.platform, "darwin", "This check requires a real macOS user session");
assert.ok(process.argv.includes("--install-test-service"), "Pass --install-test-service to authorize the temporary LaunchAgent");
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const service = async (action, config) => JSON.parse((await exec(process.execPath, [cli, "service", action, ...(config ? ["--config", config] : [])])).stdout);
assert.equal((await service("status")).installed, false, "Refusing to replace an installed gateway");
const plist = join(homedir(), "Library/LaunchAgents/com.edihasaj.subscription-gateway.plist");
assert.equal(await access(plist).then(() => true, () => false), false, "Refusing to replace an existing LaunchAgent file");
const state = await mkdtemp(join(tmpdir(), "gateway-service-check-"));
const config = join(state, "gateway.json");
let started; let release; let calls = 0; let installed = false; let socket;
const upstream = createServer(async (req, res) => {
  for await (const ignored of req) { void ignored; }
  calls++; res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (started) { started(); await new Promise(resolve => { release = resolve; }); }
  const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  emit({ type: "response.output_text.delta", delta: "service-proof" });
  emit({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
  res.end();
});
await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = upstream.address().port;
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const keyFile = join(state, "fixture-key"); await writeFile(keyFile, "fixture-only", { mode: 0o600 });
await writeFile(config, JSON.stringify({ version: 1, port, stateDirectory: state, providers: [{ id: "test", type: "responses-api", baseUrl: `http://127.0.0.1:${upstreamPort}`, credentialFile: keyFile, models: { test: "test" } }] }), { mode: 0o600 });
const upgradeConfig = join(state, "upgraded.json"); await writeFile(upgradeConfig, await readFile(config), { mode: 0o600 });
const token = await gatewayToken(state);
const base = `http://127.0.0.1:${port}`;
async function waitFor(check) {
  for (let attempt = 0; attempt < 150; attempt++) { const value = await check().catch(() => false); if (value) return value; await delay(100); }
  throw new Error("Service did not reach the expected state");
}
const inference = () => fetch(base + "/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", input: "test" }) });
try {
  await service("install", config); installed = true;
  await waitFor(async () => (await (await fetch(base + "/health")).json()).idleRestart === true);
  const before = await service("status");
  const began = new Promise(resolve => { started = resolve; }); const response = inference();
  await Promise.race([began, response.then(async result => { throw new Error(`Inference ended before reaching the fixture: HTTP ${result.status}`); }), delay(10000).then(() => { throw new Error("Fixture inference did not start"); })]);
  await assert.rejects(service("restart", config), /active inference/);
  await assert.rejects(service("install", upgradeConfig), /active gateway work/);
  assert.equal((await service("status")).pid, before.pid);
  started = undefined; release(); assert.equal((await (await response).json()).output_text, "service-proof");
  socket = connect(port, "127.0.0.1"); await once(socket, "connect");
  socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await waitFor(async () => (await (await fetch(base + "/health")).json()).active === 1);
  await assert.rejects(service("restart", config), /active inference/);
  assert.equal((await service("status")).pid, before.pid);
  socket.destroy(); await delay(100);
  await service("restart", config);
  const after = await waitFor(async () => { const status = await service("status"); return status.pid && status.pid !== before.pid ? status : false; });
  await waitFor(async () => (await fetch(base + "/health")).ok);
  assert.equal((await (await inference()).json()).output_text, "service-proof");
  await service("install", upgradeConfig);
  const upgraded = await waitFor(async () => { const value = await service("status"); return value.pid && value.pid !== after.pid ? value : false; });
  await waitFor(async () => (await fetch(base + "/health")).ok);
  assert.equal((await (await inference()).json()).output_text, "service-proof");
  assert.equal(await gatewayToken(state), token); assert.equal(calls, 3);
  console.log(JSON.stringify({ activeInferenceProtected: true, partialUploadProtected: true, idleRestartChangedPid: after.pid !== before.pid, idleUpgradeChangedPid: upgraded.pid !== after.pid, upgradeConfigApplied: (await readFile(plist,"utf8")).includes(upgradeConfig), recoveryCompleted: true, clientTokenPreserved: true, upstreamCalls: calls }));
} finally {
  socket?.destroy(); release?.();
  if (installed) await service("uninstall", config);
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
