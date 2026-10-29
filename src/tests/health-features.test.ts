import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config.js";
import { startGateway, gatewayFeatures } from "../server.js";
import type { InferenceEvent } from "../protocol/types.js";

test("/health advertises the features this release guarantees", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-health-features-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: directory,
    providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] });
  const server = await startGateway(config, () => ({ async *infer(): AsyncGenerator<InferenceEvent> { yield { type: "done", usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }; } }));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/health`);
    assert.equal(response.status, 200);
    const health = await response.json() as Record<string, unknown>;
    assert.deepEqual(health.features, ["responses-ws-426", "openai-internal-strip", "native-identity-v1", "managed-worker-routing-v1"]);
    assert.deepEqual(gatewayFeatures, health.features, "the advertised list is the exported one");
    assert.equal(health.status, "ok");
    assert.equal(health.idleRestart, true); assert.equal(health.idleUpgrade, true);
    assert.deepEqual([health.active, health.running, health.queued], [0, 0, 0]);
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); await rm(directory, { recursive: true, force: true }); }
});
