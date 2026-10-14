import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, gatewayToken } from "../config.js";
import { maxRequestBytes, startGateway } from "../server.js";

async function setup(seen: number[]) {
  const directory = await mkdtemp(join(tmpdir(), "gateway-size-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, maxConcurrent: 2,
    providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }],
  });
  const server = await startGateway(config, () => ({ async *infer(request) {
    seen.push(JSON.stringify(request).length);
    yield { type: "text", text: "OK" }; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return { url, headers, close };
}

test("a long chat with screenshots above 10 MiB still reaches the provider, as it does natively", async () => {
  const seen: number[] = []; const gateway = await setup(seen);
  try {
    const text = "x".repeat(12 * 1024 * 1024);
    const response = await fetch(gateway.url, { method: "POST", headers: gateway.headers, body: JSON.stringify({ model: "alias", input: text }) });
    assert.equal(response.status, 200, "the gateway must not be stricter than the upstream request limit");
    assert.equal(seen.length, 1); assert.ok(seen[0] > 12 * 1024 * 1024);
  } finally { await gateway.close(); }
});

test("a request above the gateway limit is refused before inference with a fixed 413", async () => {
  const seen: number[] = []; const gateway = await setup(seen);
  try {
    assert.ok(maxRequestBytes >= 64 * 1024 * 1024);
    const body = JSON.stringify({ model: "alias", input: "y".repeat(maxRequestBytes) });
    const response = await fetch(gateway.url, { method: "POST", headers: gateway.headers, body });
    assert.equal(response.status, 413);
    const text = await response.text(); assert.ok(!text.includes("yyyy"), "the refusal never echoes request content");
    assert.equal(seen.length, 0);
  } finally { await gateway.close(); }
});
