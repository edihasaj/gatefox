import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayToken, type GatewayConfig } from "../config.js";
import { ProviderUsageStore, gatewayUsage, mergeGatewayUsage } from "../provider-usage.js";
import { startGateway } from "../server.js";
import { AppServerRouter } from "../app-server-router.js";
import { ProviderError } from "../providers/provider.js";

test("provider usage survives restart, follows its configured route, and preserves native quota and identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-provider-usage-"));
  const config: GatewayConfig = { version: 1, port: 0, stateDirectory: directory, providers: [{ id: "claude", type: "claude-subscription", authDirectory: join(directory, "own-auth"), models: { alias: "model" } }] };
  const now = Math.floor(Date.now() / 1000); const limit = { status: "rejected" as const, window: "five_hour" as const, resetsAt: now + 3600 };
  const server = await startGateway(config, (_provider, observe) => ({ async *infer() {
    await observe!(limit); throw new ProviderError("usage_limit", "Claude five-hour usage limit reached", 429);
  } }));
  const client = { ...config, port: (server.address() as { port: number }).port, providers: [], clientOnly: true };
  const token = await gatewayToken(directory); const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const base = `http://127.0.0.1:${client.port}`;
  try {
    assert.equal((await fetch(base + "/v1/provider-usage")).status, 401);
    assert.deepEqual(await gatewayUsage(client), []);
    const failed = await fetch(base + "/v1/responses", { method: "POST", headers, body: JSON.stringify({ model: "alias", input: "fixture" }) });
    assert.equal(failed.status, 429); await failed.json();
    const response = await fetch(base + "/v1/provider-usage", { headers }); assert.equal(response.headers.get("cache-control"), "no-store");
    const observations = await gatewayUsage(client);
    assert.equal(observations.length, 1); assert.equal(observations[0].resetsAt, limit.resetsAt);
    assert.ok(!JSON.stringify(observations).includes("own-auth"));
    const store = new ProviderUsageStore(directory); await store.restore(config.providers);
    assert.deepEqual(store.snapshot(config.providers), observations);
    assert.deepEqual(store.snapshot([{ ...config.providers[0], authDirectory: "different" }]), []);
    assert.deepEqual(store.snapshot([]), []);
    assert.equal((await stat(join(directory, "provider-usage.json"))).mode & 0o777, 0o600);
    const native = { accountId: "primary", ordinaryUsageAllowed: true, rateLimits: { limitId: "codex", primary: { usedPercent: 22 } }, rateLimitsByLimitId: { codex: { limitId: "codex" } }, rateLimitUpsell: null };
    const serialized = JSON.stringify(native);
    const router = new AppServerRouter(client, async () => native);
    const combined = await router.request("account/rateLimits/read", {});
    assert.equal(combined.rateLimits, native.rateLimits); assert.equal(combined.accountId, "primary"); assert.equal(combined.ordinaryUsageAllowed, true);
    assert.equal((combined.rateLimitsByLimitId as Record<string, unknown>).codex, native.rateLimitsByLimitId.codex);
    assert.deepEqual((combined.rateLimitsByLimitId as Record<string, unknown>)["gateway:claude:five_hour"], {
      limitId: "gateway:claude:five_hour", limitName: "Claude", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: limit.resetsAt }, secondary: null, credits: null, planType: null, rateLimitReachedType: null,
    });
    assert.equal(JSON.stringify(native), serialized);
    assert.equal(mergeGatewayUsage(native, observations, limit.resetsAt), native, "expired observation does not invent recovery or fresh usage");
    assert.equal(mergeGatewayUsage(native, [{ ...observations[0], status: "allowed" }]), native, "allowed without a percentage must not fabricate one");
    assert.equal(mergeGatewayUsage(native, [{ ...observations[0], observedAt: now - 86401 }]), native);
    const collision = { ...native, rateLimitsByLimitId: { "gateway:claude:five_hour": { original: true } } };
    assert.equal(mergeGatewayUsage(collision, observations), collision, "never replace a native limit ID");
    await store.record(config.providers[0], { ...limit, status: "allowed" });
    assert.equal(mergeGatewayUsage(native, store.snapshot(config.providers)), native);
    assert.ok(!(await readFile(join(directory, "provider-usage.json"), "utf8")).includes("own-auth"));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    assert.deepEqual(await router.request("account/rateLimits/read", {}), native, "gateway outage keeps native quota readable");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
