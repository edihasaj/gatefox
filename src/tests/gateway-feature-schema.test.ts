import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionArgs } from "../execution-host-engine.js";
import { gatewayEngineHome } from "../gateway-engine-home.js";
import { trimGatewayFeatureArgs, trimGatewayFeatureConfig, trimGatewayFeatureRequest } from "../gateway-feature-schema.js";

test("a table for a non-structured feature becomes its boolean enabled value", () => {
  assert.deepEqual(trimGatewayFeatureConfig({ features: { async_compaction: { enabled: true, threshold: 3 } } }), { features: { async_compaction: true } });
});

test("a non-structured table without a boolean enabled value is removed", () => {
  assert.deepEqual(trimGatewayFeatureConfig({ "features.async_compaction": { mode: "x" }, model: "m" }), { model: "m" });
  assert.deepEqual(trimGatewayFeatureConfig({ features: { async_compaction: { enabled: "yes" }, fast_mode: true, odd: "text", list: [1] } }), { features: { fast_mode: true } });
});

test("structured tables keep only the fields the pinned SDK accepts", () => {
  assert.deepEqual(trimGatewayFeatureConfig({ features: { multi_agent_v2: { enabled: true, preserve_fork_prefix: true } } }), { features: { multi_agent_v2: { enabled: true } } });
  assert.deepEqual(trimGatewayFeatureConfig({ "features.multi_agent_v2.preserve_fork_prefix": true, "features.multi_agent_v2.wait_agent_enabled": true }), { "features.multi_agent_v2.wait_agent_enabled": true });
});

test("dotted enabled keys of unknown features collapse to the feature boolean", () => {
  assert.deepEqual(trimGatewayFeatureConfig({ "features.newthing.enabled": false, "features.newthing.level": 3 }), { "features.newthing": false });
});

test("settings the pinned schema accepts are returned unchanged and never mutated", () => {
  const input = { model: "m", features: { fast_mode: true, hooks: false, code_mode: { enabled: true, excluded_tool_namespaces: ["a"] }, apps_mcp_path_override: { path: "x" } },
    "features.guardianv2": { enabled: true }, profiles: { w: { features: { sleep_tool: { mode: "m" } }, model: "p" } } };
  const copy = structuredClone(input);
  assert.deepEqual(trimGatewayFeatureConfig(input), copy);
  assert.deepEqual(input, copy);
});

test("the input is not mutated when entries are trimmed", () => {
  const input = { features: { async_compaction: { enabled: true }, multi_agent_v2: { enabled: true, nope: 1 } } };
  const copy = structuredClone(input);
  trimGatewayFeatureConfig(input);
  assert.deepEqual(input, copy);
});

test("profile feature settings are trimmed in dotted and nested forms", () => {
  assert.deepEqual(trimGatewayFeatureConfig({ "profiles.w.features.async_compaction": { enabled: false }, "profiles.w.features.other": { mode: "x" } }), { "profiles.w.features.async_compaction": false });
  // Keys inside a profile's table are literal for the SDK, so only its `features` table is trimmed.
  assert.deepEqual(trimGatewayFeatureConfig({ profiles: { w: { features: { async_compaction: { enabled: true } }, "features.multi_agent_v2.preserve_fork_prefix": true } } }),
    { profiles: { w: { features: { async_compaction: true }, "features.multi_agent_v2.preserve_fork_prefix": true } } });
});

test("trimming counts changed entries so telemetry can report a number", () => {
  const stats = { count: 0 };
  trimGatewayFeatureConfig({ features: { async_compaction: { enabled: true }, fast_mode: true, multi_agent_v2: { enabled: true, x: 1 } } }, stats);
  assert.equal(stats.count, 2);
  const clean = { count: 0 };
  trimGatewayFeatureConfig({ features: { fast_mode: true } }, clean);
  assert.equal(clean.count, 0);
});

test("requests trim thread config but leave every other method alone", () => {
  const config = { "features.async_compaction": { enabled: true } };
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    assert.deepEqual(trimGatewayFeatureRequest(method, { threadId: "t", config }), { threadId: "t", config: { "features.async_compaction": true } });
  }
  // A runtime enablement map has no thread id, so it is routed to the native engine and is never trimmed here.
  const enablement = { enablement: { async_compaction: { enabled: true }, fast_mode: false } };
  assert.equal(trimGatewayFeatureRequest("experimentalFeature/enablement/set", enablement), enablement);
  const other = { config };
  assert.equal(trimGatewayFeatureRequest("turn/start", other), other);
  const clean = { config: { features: { fast_mode: true } } };
  assert.equal(trimGatewayFeatureRequest("thread/resume", clean), clean);
});

test("JSON and inline TOML overrides of non-structured features collapse to a boolean", () => {
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'features.async_compaction={"enabled":true}']), ["-c", "features.async_compaction=true"]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.async_compaction={ enabled = true, x = 1 }"]), ["-c", "features.async_compaction=true"]);
  assert.deepEqual(trimGatewayFeatureArgs(["--config=features.async_compaction={ enabled = false }"]), ["--config=features.async_compaction=false"]);
});

test("overrides with fields the pinned SDK rejects are removed with their flag", () => {
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.multi_agent_v2.preserve_fork_prefix=true"]), []);
  assert.deepEqual(trimGatewayFeatureArgs(["--config=features.multi_agent_v2.preserve_fork_prefix=true", "--listen", "stdio://"]), ["--listen", "stdio://"]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.async_compaction={ x = 1 }", "-c", "features.noise=notvalid"]), []);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.multi_agent_v2.wait_agent_enabled=true"]), ["-c", "features.multi_agent_v2.wait_agent_enabled=true"]);
});

test("container and structured table overrides are trimmed in both value syntaxes", () => {
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'features={"async_compaction":{"enabled":true},"fast_mode":true}']), ["-c", "features={ async_compaction = true, fast_mode = true }"]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.multi_agent_v2={ enabled = true, preserve_fork_prefix = true }"]), ["-c", "features.multi_agent_v2={ enabled = true }"]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'profiles.w.features.async_compaction={"enabled":true}']), ["-c", "profiles.w.features.async_compaction=true"]);
});

test("unrelated and already valid arguments are unchanged", () => {
  const args = ["app-server", "--listen", "stdio://", "-c", "features.fast_mode=true", "-c", 'model_providers.x.name="y"', "--config=model=\"m\"", "--disable", "hooks",
    "-c", "features.code_mode={ enabled = true, default_exec_yield_time_ms = 5 }", "-c"];
  assert.deepEqual(trimGatewayFeatureArgs(args), args);
});

test("shared gateway execution hosts trim feature tables from the SDK launch arguments", () => {
  const args = executionArgs(["app-server", "-c", 'features.async_compaction={"enabled":true}', "-c", "features.multi_agent_v2.preserve_fork_prefix=true"], "/tmp/s.sock", "/tmp/catalog.json");
  assert.deepEqual(args, ["app-server", "-c", "features.async_compaction=true", "--listen", "unix:///tmp/s.sock", "-c", 'model_catalog_json="/tmp/catalog.json"']);
});

test("the private gateway home snapshot carries only features the pinned SDK accepts", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-feature-home-"));
  try {
    const home = await gatewayEngineHome(join(root, "state"), { model: "m", features: { async_compaction: { enabled: true }, multi_agent_v2: { enabled: true, preserve_fork_prefix: true } } }, { nativeHome: join(root, "native") });
    const lines = (await readFile(join(home, "config.toml"), "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(lines, ['"model" = "m"', '"features" = { "async_compaction" = true, "multi_agent_v2" = { "enabled" = true } }', `"sqlite_home" = ${JSON.stringify(join(root, "native"))}`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
