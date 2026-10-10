import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { gatewayToken } from "../config.js";
import { startGateway } from "../server.js";

test("idle restart refuses both active inference and a request still uploading its body", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gateway-idle-"));
  let began: () => void = () => {}; let release: () => void = () => {};
  const started = new Promise<void>(resolve => { began = resolve; }); const released = new Promise<void>(resolve => { release = resolve; });
  const server = await startGateway({ version: 1, port: 0, stateDirectory, providers: [{ id: "test", type: "claude-subscription", models: { test: "test" } }] }, () => ({ async *infer() {
    began(); await released; yield { type: "text", text: "one-completion" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } }));
  const port = (server.address() as { port: number }).port; const base = `http://127.0.0.1:${port}`; const token = await gatewayToken(stateDirectory);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }; let socket;
  try {
    const request = fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "test", input: "hello" }) }); await started;
    assert.equal(server.restartWhenIdle(() => assert.fail("must not close active inference")), false);
    release(); const response = await request; assert.equal(response.status, 200); assert.equal((await response.json() as { output_text: string }).output_text, "one-completion");
    socket = connect(port, "127.0.0.1"); await once(socket, "connect");
    socket.write(`POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
    // Wait until this connection's headers are processed, rather than assuming
    // ordering between independent connections.
    let health: { active: number; idleRestart: boolean };
    for (let attempt = 0; ; attempt++) {
      health = await (await fetch(base + "/health")).json() as typeof health;
      if (health.active === 1) break;
      assert.ok(attempt < 100, "upload did not enter the request handler"); await delay(10);
    }
    assert.equal(health.idleRestart, true);
    assert.equal(server.restartWhenIdle(() => assert.fail("must not close partial uploads")), false);
    const closed = once(socket, "close"); socket.destroy(); await closed;
    await fetch(base + "/health");
    await new Promise<void>(resolve => { assert.equal(server.restartWhenIdle(resolve), true); });
    await assert.rejects(fetch(base + "/health"));
  } finally { socket?.destroy(); release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("idle restart also refuses catalog work before an inference controller exists", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "gateway-idle-catalog-"));
  const config = { version: 1 as const, port: 0, stateDirectory, providers: [{ id: "test", type: "claude-subscription" as const, models: { test: "test" } }] };
  let began: () => void = () => {}; let release: () => void = () => {};
  const started = new Promise<void>(resolve => { began = resolve; }); const released = new Promise<void>(resolve => { release = resolve; });
  const server = await startGateway(config, () => ({ async *infer() {} }), async () => { began(); await released; return config; });
  try {
    const token = await gatewayToken(stateDirectory);
    const response = fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/model-catalog`, { headers: { Authorization: `Bearer ${token}` } });
    await started;
    assert.equal(server.restartWhenIdle(() => assert.fail("must not close catalog work")), false);
    release(); assert.equal((await response).status, 200);
    await new Promise<void>(resolve => { assert.equal(server.restartWhenIdle(resolve), true); });
  } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
