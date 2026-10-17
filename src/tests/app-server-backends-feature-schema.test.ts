import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppServerBackends } from "../app-server-backends.js";
import { canonicalJson, type ExecutionDescriptor } from "../execution-host-engine.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { featureFixture, startGatewayChat } from "./gateway-feature-fixture.js";

const table = { "features.async_compaction": { enabled: true, threshold: 3 } };

test("a gateway chat's resume config is trimmed to the pinned SDK schema before it reaches the gateway engine", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const id = await startGatewayChat(f.backend);
    await f.backend.request("thread/resume", { threadId: id, config: table });
    const seen = await f.backend.request("probe/features", { threadId: id });
    assert.deepEqual(seen.config, { "features.async_compaction": true });
    // The desktop's launch flag is trimmed for the gateway SDK only.
    assert.equal((seen.overrides as Record<string, unknown>)["features.async_compaction"], true);
  } finally { await f.clean(); }
});

test("a native chat's resume config and the native launch flags reach the native engine unchanged", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const started = await f.backend.request("thread/start", { model: "native" });
    const id = (started.thread as { id: string }).id;
    await f.backend.request("thread/resume", { threadId: id, config: table });
    const seen = await f.backend.native.request("probe/features", {});
    assert.deepEqual(seen.config, table);
    assert.deepEqual((seen.overrides as Record<string, unknown>)["features.async_compaction"], { enabled: true });
  } finally { await f.clean(); }
});

test("trimming a gateway request reports exactly its site and how many settings changed", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  configureTelemetry(f.value.stateDirectory, "test");
  try {
    const id = await startGatewayChat(f.backend);
    await f.backend.request("thread/resume", { threadId: id, config: { ...table, "features.multi_agent_v2.preserve_fork_prefix": true, "features.fast_mode": true } });
    await flushTelemetry();
    const events = (await readTelemetry(f.value.stateDirectory, Date.now() - 60_000)).filter(event => event.event === "gateway_features_trimmed")
      .map(({ at, host, component, pid, event, ...payload }) => ({ at: typeof at, host: typeof host, component, pid: typeof pid, event, payload }));
    const payloads = (site: string) => events.filter(event => event.payload.site === site).map(event => event.payload);
    assert.deepEqual(payloads("request"), [{ site: "request", count: 2 }]);
    // The executor launch flag was trimmed once as well.
    assert.deepEqual(payloads("spawn"), [{ site: "spawn", count: 1 }]);
    assert.deepEqual(events.map(event => event.event), Array(events.length).fill("gateway_features_trimmed"));
  } finally { await f.clean(); }
});

test("a shared gateway executor is acquired with trimmed launch flags and settings, and its revision hashes those values", { timeout: 10000 }, async () => {
  const settings = { features: { async_compaction: { enabled: true, threshold: 3 }, multi_agent_v2: { enabled: true, preserve_fork_prefix: true }, fast_mode: false } };
  const args = ["app-server", "--listen", "stdio://", "-c", 'features.async_compaction={"enabled":true}', "-c", "features.multi_agent_v2.preserve_fork_prefix=true", "-c", "features.fast_mode=false"];
  const f = await featureFixture(args, settings);
  const acquired: ExecutionDescriptor[] = [];
  // Stand in for the shared execution host; refusing the lease ends the request after the descriptor is captured.
  (f.backend as unknown as { pool: () => Promise<unknown> }).pool = async () => ({ release: async () => {}, find: async () => undefined,
    acquire: async (descriptor: ExecutionDescriptor) => { acquired.push(descriptor); throw new Error("lease refused by the test host"); } });
  try {
    await assert.rejects(f.backend.request("thread/start", { model: "claude/model", modelProvider: "subscription_gateway" }, { engine: "gateway" }), /lease refused by the test host/);
    assert.equal(acquired.length, 1);
    const [descriptor] = acquired;
    assert.deepEqual(descriptor.settings, { features: { async_compaction: true, multi_agent_v2: { enabled: true }, fast_mode: false } });
    assert.deepEqual(descriptor.args, ["app-server", "-c", "features.async_compaction=true", "-c", "features.fast_mode=false",
      "-c", 'model="claude/model"', "-c", 'model_provider="subscription_gateway"', "-c", "analytics.enabled=false", "-c", 'shell_environment_policy.set.HARNESS_GATEWAY_EXECUTOR="0"', "-c", "features.step_model_switching=true"]);
    const sdk = descriptor.gatewaySdkSha256 ? { gatewaySdkSha256: descriptor.gatewaySdkSha256 } : {};
    assert.equal(descriptor.revision, createHash("sha256").update(canonicalJson({ catalog: descriptor.catalog, settings: descriptor.settings, args: descriptor.args, ...sdk })).digest("hex"));
  } finally { await f.clean(); }
});
