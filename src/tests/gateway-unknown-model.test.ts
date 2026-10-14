import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig, gatewayToken } from "../config.js";
import { startGateway, unknownModelMessage } from "../server.js";

test("a chat left on a removed model learns which model is off and what to do", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-unknown-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory, maxConcurrent: 2,
    providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }],
  });
  let calls = 0;
  const server = await startGateway(config, () => ({ async *infer() { calls++; yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; } }));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`;
    const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "copilot/gpt-6.1-sol", input: "Hi" }) });
    assert.equal(response.status, 404);
    const text = await response.text();
    assert.match(text, /copilot\/gpt-6\.1-sol/); assert.match(text, /Choose another model for this chat/);
    assert.equal(calls, 0);
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
});

test("the echoed alias keeps only alias characters and is capped", () => {
  const message = unknownModelMessage(`evil"\n<script>${"x".repeat(200)}`);
  assert.ok(!message.includes("<") && !message.includes("\n") && !message.includes('evil"'));
  const shown = /Model "([^"]*)"/.exec(message)?.[1] ?? "";
  assert.ok(shown.length <= 80);
});
