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
