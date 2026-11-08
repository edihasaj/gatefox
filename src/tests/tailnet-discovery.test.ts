import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModels } from "../catalog.js";
import { writePrivateJson, type ProviderConfig } from "../config.js";
import { refreshModelMetadata } from "../model-refresh.js";
import { classifyProviderFailure, providerFailureDiagnostic } from "../provider-failure.js";
import { ProviderError } from "../providers/provider.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { TailnetSeams } from "../tailnet.js";

process.env.TAILNET_DISCOVERY_KEY = "discovery-secret";

/** A loopback listener that serves a model list and records every request it sees. */
async function models() {
  const requests: Array<{ path?: string; authorization?: string }> = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "qwen", max_model_len: 65536 }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { requests, port: (server.address() as { port: number }).port, close: () => { server.closeAllConnections(); server.close(); } };
}
const provider = (extra: Partial<ProviderConfig> = {}): ProviderConfig => ({ id: "qwen", type: "chat-completions-api", baseUrl: "http://dgx.example:4000/v1", tailnet: true, apiKeyEnv: "TAILNET_DISCOVERY_KEY", models: { "qwen/flash": "qwen" }, ...extra });

test("discovery sends a tailnet provider's key only to a Tailscale address", async () => {
  const target = await models();
  const seams = (answers: string[]): TailnetSeams => ({ resolve: async () => answers, dial: () => ({ host: "127.0.0.1", port: target.port }) });
  try {
    // Public, private and loopback answers, and IP literals, never reach the listener (the dial seam would deliver them).
    for (const answers of [["203.0.113.5"], ["192.168.1.10"], ["127.0.0.1"], ["::1"]]) await assert.rejects(discoverModels(provider(), { tailnet: seams(answers) }), { code: "provider_unreachable" }, answers.join());
    await assert.rejects(discoverModels(provider({ baseUrl: "http://127.0.0.1:4000/v1" }), { tailnet: seams([]) }), { code: "provider_unreachable" });
    await assert.rejects(discoverModels(provider({ baseUrl: "http://localhost.:4000/v1" }), { tailnet: seams(["127.0.0.1"]) }), { code: "provider_unreachable" });
    assert.deepEqual(target.requests, [], "the key was not delivered anywhere");
    // A tailnet answer is served with the key, on the same checked transport.
    const found = await discoverModels(provider(), { tailnet: seams(["100.64.10.57"]) });
    assert.deepEqual(found.map(entry => [entry.model, entry.metadata.contextWindow]), [["qwen", 65536]]);
    assert.deepEqual(target.requests, [{ path: "/v1/models", authorization: "Bearer discovery-secret" }]);
  } finally { target.close(); }
});

test("model refresh skips a tailnet provider whose host resolves outside the tailnet and never reaches the listener", async () => {
  const target = await models(); const directory = await mkdtemp(join(tmpdir(), "gateway-tailnet-refresh-")); const path = join(directory, "gateway.json");
  configureTelemetry(directory, "test"); const since = Date.now() - 1000;
  await writePrivateJson(path, { version: 1, port: 3457, stateDirectory: directory, providers: [provider()] });
  try {
    const seams = (answers: string[]): TailnetSeams => ({ resolve: async () => answers, dial: () => ({ host: "127.0.0.1", port: target.port }) });
    for (const answers of [["203.0.113.5"], ["127.0.0.1"]]) assert.deepEqual(await refreshModelMetadata(path, undefined, seams(answers)), [], answers.join());
    assert.deepEqual(target.requests, []);
    await flushTelemetry(); const events = await readTelemetry(directory, since);
    assert.equal(events.filter(event => event.event === "model_metadata_skipped" && event.reason === "discovery_failed").length, 2);
    assert.equal(events.filter(event => event.event === "provider_address_refused").length, 2);
    // On the tailnet the refresh reads the catalog and records the context window, with the key.
    assert.deepEqual(await refreshModelMetadata(path, undefined, seams(["100.64.10.57"])), ["qwen"]);
    assert.equal(JSON.parse(await readFile(path, "utf8")).providers[0].modelMetadata["qwen/flash"].contextWindow, 65536);
    assert.deepEqual((target.requests as Array<{ authorization?: string }>).map(request => request.authorization), ["Bearer discovery-secret"]);
  } finally { target.close(); }
});

test("an address refusal keeps its own class and a down router stays the retryable 503", () => {
  const refusal = new ProviderError("provider_unreachable", "Provider address is not on the tailnet; the request was not sent", 502);
  assert.equal(classifyProviderFailure(refusal, undefined), refusal);
  assert.equal(providerFailureDiagnostic({ requestId: "r", durationMs: 1, failure: refusal }).code, "provider_unreachable");
  const down = new ProviderError("upstream_unavailable", "Provider connection failed or disconnected; retry when its connection is available", 503);
  assert.equal(classifyProviderFailure(down, undefined).status, 503);
});
