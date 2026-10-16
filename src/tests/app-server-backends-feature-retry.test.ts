import test from "node:test";
import assert from "node:assert/strict";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { engineOf, featureFixture, startGatewayChat } from "./gateway-feature-fixture.js";

type Fixture = Awaited<ReturnType<typeof featureFixture>>;
const log = async (f: Fixture, id: string) => (await f.backend.request("probe/log", { threadId: id })).log as Array<{ method: string; config: Record<string, unknown> }>;
/** Count the compaction hooks of the engine holding a chat. */
function spy(f: Fixture, id: string) {
  const engine = engineOf(f.backend, id); const calls = { before: 0, after: 0 };
  const compaction = engine.compaction!; const before = compaction.before.bind(compaction); const after = compaction.after.bind(compaction);
  compaction.before = (...args) => { calls.before++; return before(...args); };
  compaction.after = (...args) => { calls.after++; return after(...args); };
  return { engine, calls };
}
const failing = (extra: Record<string, unknown>) => ({ "fail.mode": "until-boolean", ...extra });

test("a rejected feature table is retried once in its strict form and the caller gets the result", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  configureTelemetry(f.value.stateDirectory, "test");
  try {
    const id = await startGatewayChat(f.backend);
    const { engine, calls } = spy(f, id);
    // guardianv2 is a structured feature the static schema accepts, so only the engine can refuse the new range.
    const config = failing({ features: { guardianv2: { enabled: true, review_threshold: 7 }, multi_agent_v2: { enabled: false, wait_agent_enabled: true }, fast_mode: true, tool_registry: { error_on_tool_collisions: true } },
      "features.code_mode": { enabled: true, default_exec_yield_time_ms: 5 }, "features.token_budget.guidance_message": "x", "profiles.w": { features: { sleep_tool: { enabled: true, mode: "always_on" } } } });
    const result = await f.backend.request("thread/resume", { threadId: id, config });
    // Read the hooks before probing: the probe is itself a request through them.
    const hooks = { ...calls }; const held = engine.requests;
    assert.deepEqual((result.thread as { id: string }).id, id);
    const seen = await log(f, id);
    assert.deepEqual(seen.map(entry => entry.method), ["thread/resume", "thread/resume"]);
    assert.deepEqual(seen[0].config, config);
    // The reviewer is turned off in the strict form, so actions return to the user's own approval.
    assert.deepEqual(seen[1].config, failing({ features: { guardianv2: false, multi_agent_v2: false, fast_mode: true },
      "features.code_mode": true, "profiles.w": { features: { sleep_tool: true } } }));
    // One reserved request accounted once; compaction saw the request once and finished it once.
    assert.equal(held, 0);
    assert.deepEqual(hooks, { before: 1, after: 1 });
    await flushTelemetry();
    const retried = (await readTelemetry(f.value.stateDirectory, Date.now() - 60_000)).filter(event => event.event === "gateway_features_trimmed" && event.site === "retry")
      .map(({ at, host, component, pid, ...payload }) => payload);
    assert.deepEqual(retried, [{ event: "gateway_features_trimmed", site: "retry", count: 6 }]);
  } finally { await f.clean(); }
});

test("thread start and fork are retried the same way", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const id = await startGatewayChat(f.backend);
    const config = failing({ features: { multi_agent_v2: { enabled: true, message_board_remote: { url: "x" } } } });
    const started = await f.backend.request("thread/start", { model: "claude/model", modelProvider: "subscription_gateway", config });
    assert.equal(typeof (started.thread as { id: string }).id, "string");
    await f.backend.request("thread/fork", { threadId: id, config });
    const seen = await log(f, id);
    assert.deepEqual(seen.map(entry => entry.method), ["thread/start", "thread/start", "thread/fork", "thread/fork"]);
    assert.deepEqual(seen.map(entry => entry.config.features), [{ multi_agent_v2: { enabled: true, message_board_remote: { url: "x" } } }, { multi_agent_v2: true },
      { multi_agent_v2: { enabled: true, message_board_remote: { url: "x" } } }, { multi_agent_v2: true }]);
  } finally { await f.clean(); }
});

test("a table without a boolean enabled field is removed in the retry", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const id = await startGatewayChat(f.backend);
    await f.backend.request("thread/resume", { threadId: id, config: failing({ features: { context_management: { experimental_mode: true }, fast_mode: false } }) });
    assert.deepEqual((await log(f, id)).map(entry => entry.config.features), [{ context_management: { experimental_mode: true }, fast_mode: false }, { fast_mode: false }]);
  } finally { await f.clean(); }
});

test("a second failure surfaces the original error and creates nothing", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const id = await startGatewayChat(f.backend);
    const { engine, calls } = spy(f, id);
    const config = { "fail.mode": "always", features: { guardianv2: { enabled: true, review_threshold: 7 } } };
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config }), (error: Error & { code?: number }) => {
      assert.equal(error.message, "failed to load configuration: attempt 1\nin `features`\n");
      assert.equal(error.code, -32600);
      return true;
    });
    const hooks = { ...calls }; const held = engine.requests;
    assert.deepEqual((await log(f, id)).map(entry => entry.config.features), [{ guardianv2: { enabled: true, review_threshold: 7 } }, { guardianv2: false }]);
    assert.equal(held, 0);
    assert.deepEqual(hooks, { before: 1, after: 0 });
  } finally { await f.clean(); }
});

test("an error that is not a configuration load failure is not retried", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const id = await startGatewayChat(f.backend);
    const config = { "fail.mode": "other", features: { guardianv2: { enabled: true, review_threshold: 7 } } };
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config }), /Unknown fixture thread/);
    assert.deepEqual((await log(f, id)).map(entry => entry.config), [config]);
    // The same message under another code is not the SDK's configuration error either.
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config: { ...config, "fail.mode": "wrong-code" } }), /failed to load configuration: attempt 2/);
    assert.equal((await log(f, id)).length, 2);
    // A configuration failure outside the features (here model_providers) is not about features.
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config: { ...config, "fail.mode": "other-path" } }), /attempt 3\nin `model_providers`/);
    // An unavailable cloud configuration bundle names features but is not caused by them; a retry could strip settings for nothing.
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config: { ...config, "fail.mode": "cloud" } }), /attempt 4\nin `features`/);
    assert.equal((await log(f, id)).length, 4, "neither was retried");
    assert.equal(engineOf(f.backend, id).requests, 0);
  } finally { await f.clean(); }
});

test("a configuration failure with only boolean features is not retried", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const id = await startGatewayChat(f.backend);
    const config = { "fail.mode": "always", "features.fast_mode": true, features: { hooks: false }, model: "m" };
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config }), /failed to load configuration: attempt 1/);
    assert.deepEqual((await log(f, id)).map(entry => entry.config), [config]);
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config: { "fail.mode": "always" } }), /attempt 2/);
    assert.equal((await log(f, id)).length, 2);
  } finally { await f.clean(); }
});

test("a native chat's request is never retried or changed", { timeout: 10000 }, async () => {
  const f = await featureFixture();
  try {
    const started = await f.backend.request("thread/start", { model: "native" });
    const id = (started.thread as { id: string }).id;
    const config = { "fail.mode": "until-boolean", features: { guardianv2: { enabled: true, review_threshold: 7 } } };
    await assert.rejects(f.backend.request("thread/resume", { threadId: id, config }), /failed to load configuration: attempt 1/);
    assert.deepEqual((await f.backend.native.request("probe/log", {})).log, [{ method: "thread/resume", config }]);
  } finally { await f.clean(); }
});
