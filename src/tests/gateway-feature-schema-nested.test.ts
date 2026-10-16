import test from "node:test";
import assert from "node:assert/strict";
import { strictGatewayFeatureRequest, trimGatewayFeatureArgs, trimGatewayFeatureConfig } from "../gateway-feature-schema.js";

const trim = (input: Record<string, unknown>) => trimGatewayFeatureConfig(input);

test("nested strict sub-tables keep only their own fields in table form", () => {
  const stats = { count: 0 };
  assert.deepEqual(trimGatewayFeatureConfig({ features: {
    guardianv2: { enabled: true, transcript: { include_images: true, max_recent_non_user_entries: 3, bogus: 1 }, review_scope: { computer_use_only: true, nope: 1 } },
    multi_agent_v2: { enabled: true, message_board_remote: { url: "u", bearer_token_env_var: "E", bogus: 1 } },
    network_proxy: { enabled: true, credentials: { openai: { env: ["A"], url_prefixes: ["https://x"], bogus: 1 } }, domains: { "example.com": "allow" } },
  } }, stats), { features: {
    guardianv2: { enabled: true, transcript: { include_images: true, max_recent_non_user_entries: 3 }, review_scope: { computer_use_only: true } },
    multi_agent_v2: { enabled: true, message_board_remote: { url: "u", bearer_token_env_var: "E" } },
    // network_proxy limits network access, so it is never trimmed: an unreadable value fails closed with the SDK's error.
    network_proxy: { enabled: true, credentials: { openai: { env: ["A"], url_prefixes: ["https://x"], bogus: 1 } }, domains: { "example.com": "allow" } },
  } });
  // One count per feature entry, however many nested fields were removed.
  assert.equal(stats.count, 2);
});

test("trimming never widens permissions: network_proxy is never changed, and the strict form turns the reviewer off", () => {
  const limited = { enabled: true, mode: "limited", domains: { "example.com": "allow" }, future_limit: 3 };
  const config = { features: { network_proxy: limited, guardianv2: { enabled: true, review_threshold: 7 } }, "features.network_proxy.mode": "limited",
    "features.guardianv2.review_scope.computer_use_only": true, "profiles.w": { features: { network_proxy: limited, guardianv2: true } } };
  const copy = structuredClone(config);
  // The normal form leaves network_proxy exactly as sent, however unreadable, and still trims the reviewer's known fields.
  assert.deepEqual(trim(config), config);
  const stats = { count: 0 };
  // The strict form never reduces network_proxy to a boolean (the SDK's default mode is Full); the reviewer is turned off.
  assert.deepEqual(strictGatewayFeatureRequest("thread/resume", { threadId: "t", config }, stats), { threadId: "t", config: {
    features: { network_proxy: limited, guardianv2: false }, "features.network_proxy.mode": "limited", "features.guardianv2": false,
    "profiles.w": { features: { network_proxy: limited, guardianv2: false } } } });
  assert.equal(stats.count, 3);
  assert.deepEqual(config, copy);
  // multi_agent_v2 carries the caller's limits: the strict form keeps them instead of the SDK's looser defaults.
  const agents = { features: { multi_agent_v2: { enabled: true, max_concurrent_threads_per_session: 1, expose_spawn_agent_model_overrides: false, preserve_fork_prefix: true } },
    "features.multi_agent_v2.max_wait_timeout_ms": 5 };
  assert.deepEqual(strictGatewayFeatureRequest("thread/resume", { config: agents }), { config: {
    features: { multi_agent_v2: { enabled: true, max_concurrent_threads_per_session: 1, expose_spawn_agent_model_overrides: false } }, "features.multi_agent_v2.max_wait_timeout_ms": 5 } });
});

test("nested sub-table fields are checked in the dotted form too", () => {
  assert.deepEqual(trim({
    "features.guardianv2.transcript.bogus": 1, "features.guardianv2.transcript.include_images": true,
    "features.guardianv2.review_scope.nope": true, "features.guardianv2.review_scope.sandboxed_exec_commands": false,
    "features.multi_agent_v2.message_board_remote.url": "u", "features.multi_agent_v2.message_board_remote.bogus": "x",
    "features.network_proxy.credentials.openai.bogus": 1, "features.network_proxy.credentials.openai.env": ["A"],
    'features.network_proxy.domains."example.com"': "allow",
    "profiles.w.features.guardianv2.transcript.bogus": 1,
  }), {
    "features.guardianv2.transcript.include_images": true, "features.guardianv2.review_scope.sandboxed_exec_commands": false,
    "features.multi_agent_v2.message_board_remote.url": "u",
    "features.network_proxy.credentials.openai.bogus": 1, "features.network_proxy.credentials.openai.env": ["A"],
    'features.network_proxy.domains."example.com"': "allow",
  });
  // A sub-table assigned whole is trimmed by its own schema.
  assert.deepEqual(trim({ "features.guardianv2.transcript": { sources: ["reasoning"], bogus: 1 }, "features.guardianv2": { enabled: true, nope: 1 } }),
    { "features.guardianv2.transcript": { sources: ["reasoning"] }, "features.guardianv2": { enabled: true } });
});

test("nested sub-table overrides are trimmed in every argument spelling", () => {
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.guardianv2.transcript.bogus=1", "-c", "features.guardianv2.transcript.include_images=true",
    "-c", "features.guardianv2.review_scope={ computer_use_only = true, nope = 1 }", "--config=features.multi_agent_v2.message_board_remote.bogus=\"x\"",
    "-c", "features.multi_agent_v2={ enabled = true, message_board_remote = { url = \"u\", bogus = 1 } }"],
  ), ["-c", "features.guardianv2.transcript.include_images=true", "-c", "features.guardianv2.review_scope={ computer_use_only = true }",
    "-c", 'features.multi_agent_v2={ enabled = true, message_board_remote = { url = "u" } }']);
});

test("tool_registry is a table only: a boolean or any other value is dropped", () => {
  const stats = { count: 0 };
  assert.deepEqual(trimGatewayFeatureConfig({ features: { tool_registry: true, fast_mode: true }, "features.tool_registry": false, model: "m" }, stats), { features: { fast_mode: true }, model: "m" });
  assert.equal(stats.count, 2);
  assert.deepEqual(trim({ features: { tool_registry: { error_on_tool_collisions: true, bogus: 1 } } }), { features: { tool_registry: { error_on_tool_collisions: true } } });
  assert.deepEqual(trim({ "features.tool_registry": { turn_metadata_includes_tool_info: false }, "features.tool_registry.error_on_tool_collisions": true, "features.tool_registry.bogus": 1 }),
    { "features.tool_registry": { turn_metadata_includes_tool_info: false }, "features.tool_registry.error_on_tool_collisions": true });
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.tool_registry=true", "-c", "features.tool_registry={ error_on_tool_collisions = true }", "-c", "features.tool_registry.bogus=1"]),
    ["-c", "features.tool_registry={ error_on_tool_collisions = true }"]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'features={"tool_registry":true,"fast_mode":false}']), ["-c", "features={ fast_mode = false }"]);
});

test("bare dotted keys in inline TOML expand to nested tables before they are checked", () => {
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features={ multi_agent_v2.enabled = true, multi_agent_v2.preserve_fork_prefix = true, async_compaction.enabled = true, fast_mode = false }"]),
    ["-c", "features={ multi_agent_v2 = { enabled = true }, async_compaction = true, fast_mode = false }"]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.guardianv2={ transcript.include_images = true, transcript.bogus = 1 }"]), ["-c", "features.guardianv2={ transcript = { include_images = true } }"]);
  // Valid dotted input is rewritten only when something was removed.
  const valid = "features.multi_agent_v2={ enabled = true, message_board_remote.url = \"u\" }";
  assert.deepEqual(trimGatewayFeatureArgs(["-c", valid]), ["-c", valid]);
});

test("a literal key with a dot stays as it was", () => {
  const input = { features: { "fast_mode.enabled": false, "a.b": true } };
  assert.equal(trimGatewayFeatureConfig(input), input);
  assert.deepEqual(trim({ features: { "fast_mode.enabled": false, async_compaction: { enabled: true } } }), { features: { "fast_mode.enabled": false, async_compaction: true } });
  // The same holds for a quoted key inside inline TOML, which is one segment.
  const quoted = 'features={ "fast_mode.enabled" = false }';
  assert.deepEqual(trimGatewayFeatureArgs(["-c", quoted]), ["-c", quoted]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'features={ "fast_mode.enabled" = false, async_compaction = { enabled = true } }']), ["-c", 'features={ "fast_mode.enabled" = false, async_compaction = true }']);
});

test("override keys are split on every dot and never unquoted, as the pinned SDK applies them", () => {
  // codex-rs/config/src/overrides.rs splits an override key with `path.split('.')`: a quoted segment keeps its quote characters,
  // so `"multi_agent_v2"` is an unknown feature name, not multi_agent_v2. Nothing is respelled.
  assert.deepEqual(trim({ 'features."multi_agent_v2".preserve_fork_prefix': true, 'features.multi_agent_v2."wait_agent_enabled"': true,
    "features.'guardianv2'.thread_context": true, 'features."newthing".enabled': false, 'features."guardianv2"."transcript".bogus': 1 }), { 'features."newthing"': false });
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'features."multi_agent_v2".preserve_fork_prefix=true', "-c", 'features.multi_agent_v2."wait_agent_enabled"=true',
    "-c", 'features."newthing".enabled=false', "-c", "features.'multi_agent_v2'.bogus=1", "-c", "features . fast_mode=true"]),
  ["-c", 'features."newthing"=false', "-c", "features . fast_mode=true"]);
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'profiles."w".features.async_compaction={ enabled = true }', "-c", 'profiles."a.b".features.async_compaction={ enabled = true }']),
    ["-c", 'profiles."w".features.async_compaction=true', "-c", 'profiles."a.b".features.async_compaction={ enabled = true }']);
  // A space is part of the name too: this is a feature called "not a key" holding a table, which the SDK would reject.
  assert.deepEqual(trim({ "features.not a key": { x: 1 }, "mcp_servers.my server.command": "x" }), { "mcp_servers.my server.command": "x" });
});

test("override tables are always written as inline TOML, never JSON", () => {
  assert.deepEqual(trimGatewayFeatureArgs(["-c", 'features.code_mode={"enabled":true,"nope":1,"excluded_tool_namespaces":["a","b"],"default_exec_yield_time_ms":5}']),
    ["-c", 'features.code_mode={ enabled = true, excluded_tool_namespaces = ["a", "b"], default_exec_yield_time_ms = 5 }']);
  assert.deepEqual(trimGatewayFeatureArgs(["--config=features={\"guardianv2\":{\"enabled\":true,\"transcript\":{\"bogus\":1}},\"x\":{\"mode\":\"y\"}}"]), ["--config=features={ guardianv2 = { enabled = true, transcript = {} } }"]);
});

test("apps_mcp_path_override accepts a boolean or only enabled and path", () => {
  assert.deepEqual(trim({ features: { apps_mcp_path_override: { enabled: true, path: "/x", bogus: 1 } } }), { features: { apps_mcp_path_override: { enabled: true, path: "/x" } } });
  assert.deepEqual(trim({ features: { apps_mcp_path_override: false }, "features.apps_mcp_path_override.bogus": 1, "features.apps_mcp_path_override.path": "/x" }),
    { features: { apps_mcp_path_override: false }, "features.apps_mcp_path_override.path": "/x" });
  assert.deepEqual(trim({ features: { apps_mcp_path_override: "text" } }), { features: {} });
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "features.apps_mcp_path_override={ enabled = true, bogus = 1 }"]), ["-c", "features.apps_mcp_path_override={ enabled = true }"]);
});

test("a flat profile key holds the same feature settings as a nested profile", () => {
  // Inside a profile's table the SDK keeps keys literal, so a dotted key there is not a feature path and is left alone.
  assert.deepEqual(trim({ "profiles.w": { features: { async_compaction: { enabled: true } }, "features.multi_agent_v2.preserve_fork_prefix": true, model: "m" } }),
    { "profiles.w": { features: { async_compaction: true }, "features.multi_agent_v2.preserve_fork_prefix": true, model: "m" } });
  assert.deepEqual(trim({ 'profiles."a.b"': { "features.async_compaction": { enabled: false } }, "profiles.w.model": "m", "profiles.w.features": { x: { y: 1 }, fast_mode: true } }),
    { 'profiles."a.b"': { "features.async_compaction": { enabled: false } }, "profiles.w.model": "m", "profiles.w.features": { fast_mode: true } });
  assert.deepEqual(trimGatewayFeatureArgs(["-c", "profiles.w={ features = { async_compaction = { enabled = true } } }", "-c", 'profiles.w.model="m"']),
    ["-c", "profiles.w={ features = { async_compaction = true } }", "-c", 'profiles.w.model="m"']);
});

test("the strict retry form reduces features to booleans in every spelling, except settings that carry limits", () => {
  const stats = { count: 0 };
  const params = { threadId: "t", config: { model: "m", features: { guardianv2: { enabled: true, review_threshold: 7 }, multi_agent_v2: { wait_agent_enabled: true }, tool_registry: { error_on_tool_collisions: true }, fast_mode: false },
    "features.code_mode": { enabled: false, default_exec_yield_time_ms: 5 }, "features.sleep_tool.mode": "always_on", "features.token_budget.enabled": true, "features.hooks": true,
    "profiles.w": { features: { sleep_tool: { enabled: true } } }, profiles: { v: { "features.network_proxy": { proxy_url: "x" } } } } };
  const copy = structuredClone(params);
  assert.deepEqual(strictGatewayFeatureRequest("thread/resume", params, stats), { threadId: "t", config: { model: "m", features: { guardianv2: false, multi_agent_v2: { wait_agent_enabled: true }, fast_mode: false },
    "features.code_mode": false, "features.token_budget": true, "features.hooks": true, "profiles.w": { features: { sleep_tool: true } }, profiles: { v: { "features.network_proxy": { proxy_url: "x" } } } } });
  assert.deepEqual(params, copy);
  assert.equal(stats.count, 6);
  const same = { config: { features: { fast_mode: true }, "features.hooks": false } };
  assert.equal(strictGatewayFeatureRequest("thread/resume", same), same);
  const other = { config: { features: { guardianv2: { enabled: true } } } };
  assert.equal(strictGatewayFeatureRequest("turn/start", other), other);
});
