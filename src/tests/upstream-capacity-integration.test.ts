import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AdmissionRegistry } from "../admission-registry.js";
import { AvailabilityService } from "../availability/service.js";
import { gatewayToken, validateConfig } from "../config.js";
import { routeFingerprint } from "../model-refresh.js";
import { startGateway } from "../server.js";

async function eventually(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (await check()) return; await delay(10); }
  assert.fail(message);
}

test("discovery changes admission and availability in memory while old numeric configuration stays valid", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-capacity-"));
  const config = validateConfig({ version: 1, port: 0, stateDirectory: root, maxConcurrent: 8, providers: [
    { id: "qwen", type: "chat-completions-api", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "UNUSED_TEST_KEY", models: { qwen: "qwen" }, capacityDiscovery: true },
    { id: "other", type: "claude-subscription", models: { other: "other" } },
  ] });
  const original = JSON.stringify(config); let current = config;
  assert.equal(routeFingerprint(config.providers[0]), routeFingerprint({ ...config.providers[0], capacityDiscovery: false }));
  let limit: number | undefined = 20; let polls = 0; let calls = 0;
  let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
  const admissions = new AdmissionRegistry();
  const availability = new AvailabilityService({ probe: async () => ({ status: "healthy", observedAt: Date.now(),
    endpoints: { healthy: 1, total: 1 }, servedModels: ["qwen"], missingModels: [] }) });
  const server = await startGateway(config, () => ({ async *infer() {
    calls++; await held; yield { type: "text", text: "ok" };
    yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  } }), async () => current, { admissionRegistry: admissions, availability, onFailure() {}, upstreamCapacity: {
    intervalMs: 10, probe: async () => { polls++; return limit === undefined ? undefined : { limit, observedAt: Date.now() }; },
  } });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(root)}`, "Content-Type": "application/json" };
  const pending: Promise<Response>[] = [];
  const post = () => fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "qwen", input: "hello" }) });
  const report = async () => (await (await fetch(base + "/v1/availability?wait=1000", { headers })).json()) as {
    providers: { id: string; status: string; load: { running: number; queued: number; limit: number } }[];
  };
  try {
    await eventually(() => admissions.limit("qwen") === 20, "automatic capacity must reach twenty");
    pending.push(...Array.from({ length: 16 }, post));
    await eventually(() => calls === 16, "sixteen requests must run despite numeric fallback eight");
    let rows = (await report()).providers;
    assert.equal(rows.find(row => row.id === "qwen")!.status, "available");
    assert.equal(rows.find(row => row.id === "qwen")!.load.limit, 20);
    assert.equal(rows.find(row => row.id === "other")!.load.limit, 8);
    pending.push(...Array.from({ length: 5 }, post));
    await eventually(() => calls === 20 && admissions.load("qwen").queued === 1, "the twenty-first request must queue");
    rows = (await report()).providers;
    assert.equal(rows.find(row => row.id === "qwen")!.status, "busy");
    limit = 10;
    await eventually(() => admissions.limit("qwen") === 10, "a worker drain must lower the limit");
    assert.equal(admissions.load("qwen").running, 20, "existing calls are never cancelled by a decrease");
    release();
    const responses = await Promise.all(pending);
    assert.ok(responses.every(response => response.status === 200));
    await Promise.all(responses.map(response => response.text()));
    limit = undefined;
    await eventually(() => admissions.limit("qwen") === 8, "failed discovery must restore fallback eight");
    assert.equal(JSON.stringify(config), original, "no numeric limit is written into the configuration");
    current = { ...config, providers: config.providers.map(provider => provider.id === "qwen" ? { ...provider, capacityDiscovery: false } : provider) };
    await report(); await delay(20); const stopped = polls; await delay(30);
    assert.equal(polls, stopped, "opting out must stop polling");
  } finally {
    release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
