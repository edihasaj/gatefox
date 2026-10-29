import test from "node:test";
import assert from "node:assert/strict";
import { AdmissionRegistry } from "../admission-registry.js";
import type { GatewayConfig, ProviderConfig } from "../config.js";

const provider = (maxConcurrent = 1): ProviderConfig => ({ id: "a", type: "claude-subscription", maxConcurrent, models: { a: "upstream" } });
const config = (providers: ProviderConfig[]): GatewayConfig => ({ version: 1, port: 0, stateDirectory: "/state", maxConcurrent: 4, providers });

test("a removed provider stays until its retained snapshot releases", () => {
  const registry = new AdmissionRegistry(); const configured = [provider()];
  registry.configure(config(configured)); const release = registry.retain(configured);
  registry.configure(config([]));
  assert.equal(registry.size(), 1);
  release();
  assert.equal(registry.size(), 0);
});

test("removed admissions do not accumulate across reload cycles", () => {
  const registry = new AdmissionRegistry();
  for (let cycle = 0; cycle < 32; cycle++) {
    const configured = [provider()];
    registry.configure(config(configured)); const release = registry.retain(configured);
    registry.configure(config([])); release();
    assert.equal(registry.size(), 0);
  }
});

test("a re-added provider updates the retained admission's limit", async () => {
  const registry = new AdmissionRegistry(); const firstConfig = [provider(1)];
  registry.configure(config(firstConfig)); const queue = registry.admission("a");
  const releaseSnapshot = registry.retain(firstConfig);
  const first = await queue.acquire(new AbortController().signal);
  registry.configure(config([])); registry.configure(config([provider(2)]));
  assert.strictEqual(registry.admission("a"), queue);
  const second = await queue.acquire(new AbortController().signal);
  assert.equal(queue.running, 2);
  first(); second(); releaseSnapshot();
});

test("discovery updates admission and flood limits without rewriting configured limits", async () => {
  const registry = new AdmissionRegistry();
  const upstream = { ...provider(), maxConcurrent: undefined, capacityDiscovery: true };
  const initial = config([upstream]); registry.configure(initial);
  assert.equal(registry.limit("a"), 4);
  registry.setDiscoveredLimit("a", 20);
  assert.equal(registry.limit("a"), 20);
  assert.equal(registry.maximumActive(initial), 52);
  assert.equal(upstream.maxConcurrent, undefined);
  registry.configure({ ...initial });
  assert.equal(registry.limit("a"), 20, "unrelated reload keeps a fresh observation");
  registry.setDiscoveredLimit("a", undefined);
  assert.equal(registry.limit("a"), 4, "failed discovery restores the configured fallback");
});

test("explicit ceilings, opt-out, identity changes and invalid observations remain bounded", () => {
  const registry = new AdmissionRegistry();
  registry.configure(config([{ ...provider(12), capacityDiscovery: true }]));
  registry.setDiscoveredLimit("a", 20);
  assert.equal(registry.limit("a"), 12);
  registry.setDiscoveredLimit("a", 10);
  assert.equal(registry.limit("a"), 10);
  for (const invalid of [-1, 65, 1.5, Number.NaN]) {
    registry.setDiscoveredLimit("a", invalid);
    assert.equal(registry.limit("a"), 12);
  }
  registry.setDiscoveredLimit("a", 10);
  registry.configure(config([{ ...provider(12), capacityDiscovery: true, baseUrl: "http://127.0.0.1:9000/v1" }]));
  assert.equal(registry.limit("a"), 12, "a new endpoint cannot inherit another endpoint's capacity");
  registry.configure(config([provider(8)])); registry.setDiscoveredLimit("a", 20);
  assert.equal(registry.limit("a"), 8, "static providers ignore observations");
});

test("a discovered decrease lets existing work finish while new work waits", async () => {
  const registry = new AdmissionRegistry(); registry.configure(config([{ ...provider(4), capacityDiscovery: true }]));
  const queue = registry.admission("a");
  const first = await queue.acquire(new AbortController().signal);
  const second = await queue.acquire(new AbortController().signal);
  registry.setDiscoveredLimit("a", 0);
  assert.equal(registry.limit("a"), 0); assert.equal(queue.running, 2);
  const waiting = queue.acquire(new AbortController().signal);
  assert.equal(queue.queued, 1);
  first(); second(); assert.equal(queue.running, 0); assert.equal(queue.queued, 1);
  registry.setDiscoveredLimit("a", 1);
  const release = await waiting; assert.equal(queue.running, 1); release();
});

test("an opted-in provider added during a legacy hold starts with zero admission", async () => {
  const registry = new AdmissionRegistry(); registry.holdUntilLegacyDrains(true);
  registry.configure(config([{ ...provider(8), capacityDiscovery: true }]));
  const queue = registry.admission("a");
  assert.equal(registry.limit("a"), 0);
  const waiting = queue.acquire(new AbortController().signal);
  assert.equal(queue.running, 0); assert.equal(queue.queued, 1);
  registry.holdUntilLegacyDrains(false);
  const release = await waiting; assert.equal(queue.running, 1); release();
});

test("source expiry belongs to the shared queue and rejects invalid timestamps", async () => {
  const registry = new AdmissionRegistry();
  registry.configure(config([{ ...provider(), maxConcurrent: undefined, capacityDiscovery: true }]));
  registry.setDiscoveredLimit("a", 20, Date.now() - 29_950);
  assert.equal(registry.limit("a"), 20);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(registry.limit("a"), 4);
  for (const observedAt of [Date.now() - 30_001, Date.now() + 6000, Number.NaN, Number.POSITIVE_INFINITY]) {
    registry.setDiscoveredLimit("a", 20, observedAt);
    assert.equal(registry.limit("a"), 4);
  }
});
