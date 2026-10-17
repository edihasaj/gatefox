import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCatalog } from "../catalog.js";
import { executorNativeRow, executorRunsCodeMode, withNativeRow } from "../codex-native-rows.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { writePrivateJson, type GatewayConfig, type ProviderConfig } from "../config.js";
import { shimFiles } from "./shim-fixture.js";

const tier = { id: "priority", name: "Fast", description: "2x speed" };
const messages = { instructions_template: "native base prompt", persistent_instructions: "native persistent", approvals: { on_request: "native approvals" }, token_budget: { enabled: false } };
const nativeSol = {
  slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", description: "Native description", priority: 1, model_messages: messages,
  tool_mode: "code_mode_only", shell_type: "shell_command", apply_patch_tool_type: "function", default_reasoning_level: "low", default_verbosity: "low",
  default_reasoning_summary: "none", support_verbosity: true, effective_context_window_percent: 97, truncation_policy: { mode: "bytes", limit: 20000 },
  context_window: 800000, max_context_window: 900000, auto_compact_token_limit: 123456, comp_hash: "native-hash", supports_search_tool: true,
  web_search_tool_type: "text_and_image", service_tiers: [{ id: "flex", name: "Flex", description: "native tier" }], additional_speed_tiers: ["native"],
  multi_agent_version: "v9", multi_agent_reasoning_effort: "max", experimental_supported_tools: ["clock"], include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
  // Every real native row states its node_repl policy; node-repl-policy.test.ts covers rows that state none.
  node_repl_disabled: false, node_repl_auto_review_required: false,
};
const usageFlags = ["include_skills_usage_instructions", "include_plugin_usage_instructions", "include_apps_usage_instructions"] as const;
const codex = (models: Record<string, string>, metadata: ProviderConfig["modelMetadata"] = {}): ProviderConfig => ({ id: "codex", type: "codex-subscription", label: "Codex 2", models, modelMetadata: metadata });
const solMetadata = { displayName: "GPT-6.1-Sol", contextWindow: 500000, maxContextWindow: 872000, reasoningEfforts: ["low", "medium", "high"], serviceTiers: [tier], additionalSpeedTiers: ["fast"], multiAgentVersion: "v2", multiAgentReasoningEffort: "xhigh" };
const catalog = (...providers: ProviderConfig[]) => modelCatalog({ version: 1, port: 0, stateDirectory: ".", providers } as GatewayConfig).models;

test("Codex 2 rows name their upstream model; other routes do not", () => {
  const rows = catalog(codex({ "codex/sol": "gpt-6.1-sol" }), { id: "claude", type: "claude-subscription", models: { "claude/sonnet": "gpt-6.1-sol" } });
  assert.equal(rows.find(row => row.slug === "codex/sol")?.upstream_slug, "gpt-6.1-sol");
  assert.equal(Object.hasOwn(rows.find(row => row.slug === "claude/sonnet")!, "upstream_slug"), false);
});

test("a Codex 2 row copies the native harness fields and keeps the upstream account capabilities", () => {
  const [published] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": { ...solMetadata, autoCompactTokenLimit: 400000 } }));
  const row = withNativeRow(published, [nativeSol]);
  assert.deepEqual(row.model_messages, messages); assert.notEqual(row.model_messages, messages);
  for (const key of ["tool_mode", "shell_type", "apply_patch_tool_type", "default_reasoning_level", "default_verbosity", "default_reasoning_summary", "support_verbosity", "effective_context_window_percent", "truncation_policy", ...usageFlags] as const) assert.deepEqual(row[key], nativeSol[key], key);
  assert.equal(row.context_window, 800000, "the native window is within the upstream's 872K maximum");
  for (const key of ["slug", "display_name", "description", "priority", "supported_reasoning_levels", "service_tiers", "additional_speed_tiers", "default_service_tier", "multi_agent_version", "multi_agent_reasoning_effort", "max_context_window", "auto_compact_token_limit", "experimental_supported_tools", "input_modalities"]) assert.deepEqual(row[key], published[key], key);
  assert.equal(published.supports_search_tool, false, "the gateway publishes search off");
  assert.equal(row.supports_search_tool, true, "a Codex 2 row follows the native row, because the Codex route passes tool_search through");
  assert.equal(withNativeRow(published, [{ ...nativeSol, supports_search_tool: false }]).supports_search_tool, false);
  for (const value of [undefined, "true", null]) assert.equal(withNativeRow(published, [{ ...nativeSol, supports_search_tool: value }]).supports_search_tool, false, `a native value of ${JSON.stringify(value)} is not copied`);
  for (const key of ["comp_hash", "upstream_slug", "web_search_tool_type"]) assert.equal(Object.hasOwn(row, key), false, key);
  (row.model_messages as typeof messages).approvals.on_request = "changed";
  assert.equal(messages.approvals.on_request, "native approvals", "the native row is copied, never shared");
});

test("a Codex 2 row carries the native model specialty, which picks the SDK's Guardian rejection policy", () => {
  const [published] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata }));
  assert.equal(withNativeRow(published, [{ ...nativeSol, model_specialty: "cyber" }]).model_specialty, "cyber");
  assert.equal(withNativeRow(published, [{ ...nativeSol, model_specialty: null }]).model_specialty, null);
  for (const odd of [undefined, 7, { cyber: true }]) assert.equal(Object.hasOwn(withNativeRow(published, [{ ...nativeSol, model_specialty: odd }]), "model_specialty"), false, String(odd));
});

test("native values outside the upstream's limits or offered levels keep the published row", () => {
  const [published] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata }));
  assert.equal(withNativeRow(published, [{ ...nativeSol, context_window: 900000 }]).context_window, 500000);
  const [unbounded] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": { ...solMetadata, maxContextWindow: undefined } }));
  assert.equal(withNativeRow(unbounded, [nativeSol]).context_window, 500000, "no upstream maximum means the native window cannot be checked");
  assert.equal(withNativeRow(published, [{ ...nativeSol, default_reasoning_level: "minimal" }]).default_reasoning_level, "medium");
  const malformed = withNativeRow(published, [{ ...nativeSol, model_messages: "text", tool_mode: 7, truncation_policy: { mode: "tokens", limit: -1 }, effective_context_window_percent: 140 }]);
  for (const key of ["model_messages", "tool_mode", "truncation_policy", "effective_context_window_percent", ...usageFlags]) assert.deepEqual(malformed[key], published[key], key);
  for (const key of usageFlags) assert.equal(malformed[key], true, `${key} stays with the gateway template it describes`);
});

test("an executor without the code-mode host keeps the published tool mode and still takes the native prompt", async () => {
  const [published] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata }));
  const row = withNativeRow(published, [nativeSol], false);
  assert.equal(row.tool_mode, "direct"); assert.deepEqual(row.model_messages, messages); assert.equal(row.default_reasoning_level, "low");
  assert.equal(withNativeRow({ ...published, tool_mode: "code_mode" }, [{ ...nativeSol, tool_mode: "direct" }], false).tool_mode, "direct");
  const root = await mkdtemp(join(tmpdir(), "gateway-code-mode-"));
  try {
    assert.equal(executorRunsCodeMode(root), true, "without a packaged SDK the desktop's own Codex runs gateway chats");
    await mkdir(join(root, "gateway-sdk")); await writeFile(join(root, "gateway-sdk", "gateway-codex"), "", { mode: 0o755 });
    assert.equal(executorRunsCodeMode(root), false, "the packaged SDK has no code-mode host beside it");
    await writeFile(join(root, "gateway-sdk", "codex-code-mode-host"), "", { mode: 0o644 });
    assert.equal(executorRunsCodeMode(root), false, "a host that cannot be executed does not count");
    await chmod(join(root, "gateway-sdk", "codex-code-mode-host"), 0o755);
    assert.equal(executorRunsCodeMode(root), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rows without a marker or a native row for their slug stay as published, without the marker", () => {
  const [missing] = catalog(codex({ "codex/next": "gpt-9" }, { "codex/next": solMetadata }));
  const { upstream_slug: _marker, ...today } = missing;
  assert.deepEqual(withNativeRow(missing, [nativeSol]), today);
  assert.deepEqual(today.model_messages, { instructions_template: "" }); assert.equal(today.tool_mode, "direct");
  const [claude] = catalog({ id: "claude", type: "claude-subscription", models: { "gpt-6.1-sol": "claude-sonnet" } });
  assert.deepEqual(withNativeRow(claude, [nativeSol]), claude);
});

test("the desktop adapter publishes native copies in the combined catalog but caches only the host's public rows", async () => {
  const f = await shimFiles();
  try {
    f.value.providers = [codex({ "codex/sol": "gpt-6.1-sol", "codex/next": "gpt-9", "codex/odd": "gpt-6.1-sol" }, { "codex/sol": solMetadata, "codex/next": solMetadata, "codex/odd": solMetadata })];
    const published = modelCatalog(f.value);
    // A host may only point a row at the client's own native rows; a non-string marker is dropped.
    published.models = published.models.map(row => row.slug === "codex/odd" ? { ...row, upstream_slug: 42 } : row);
    f.setCatalog(published);
    const native = [nativeSol]; const before = structuredClone(nativeSol); const path = join(f.directory, "combined.json");
    // prepareNativeCatalog writes the rows the gateway published, without native copies.
    await writePrivateJson(path, { models: [...native, ...modelCatalog(f.value).models] });
    const live = new DesktopCatalog(f.value, native, path, true); const snapshot = await live.refresh(true);
    const combined = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(combined.models.map((row: { slug: string }) => row.slug), ["gpt-6.1-sol", "codex/sol", "codex/next", "codex/odd"]);
    const [, sol, next, odd] = combined.models;
    assert.deepEqual(sol.model_messages, messages); assert.equal(sol.tool_mode, "code_mode_only"); assert.equal(sol.context_window, 800000);
    assert.equal(sol.default_reasoning_level, "low"); assert.equal(sol.supports_search_tool, true); assert.deepEqual(sol.service_tiers, [tier]);
    for (const key of usageFlags) { assert.equal(sol[key], false, key); assert.equal(next[key], true, key); }
    for (const row of [next, odd]) { assert.deepEqual(row.model_messages, { instructions_template: "" }); assert.equal(row.tool_mode, "direct"); assert.equal(row.context_window, 500000); }
    assert.deepEqual(combined.models[0], nativeSol, "the carried native row keeps tool search on, as the Codex 2 row for it does");
    assert.equal(next.supports_search_tool, false, "a Codex 2 row with no native row stays off");
    assert.equal(JSON.stringify(combined).includes("upstream_slug"), false);
    const cache = await readFile(join(f.value.stateDirectory, "desktop-public-models.json"), "utf8");
    assert.equal(cache.includes("native base prompt"), false); assert.equal(JSON.parse(cache).models[0].upstream_slug, "gpt-6.1-sol");
    f.close(); const restored = new DesktopCatalog(f.value, native, join(f.directory, "restored.json"), true); await restored.initialize();
    assert.equal(restored.current().revision, snapshot.revision);
    assert.deepEqual(restored.current().models[0].model_messages, messages);
    const hostless = new DesktopCatalog(f.value, native, join(f.directory, "hostless.json"), false); await hostless.initialize();
    assert.equal(hostless.current().models[0].tool_mode, "direct"); assert.notEqual(hostless.current().revision, snapshot.revision);
    assert.deepEqual(native, [before]);
  } finally { f.close(); }
});

test("a native row is carried with its own tool search value", () => {
  const carried = executorNativeRow(nativeSol, [nativeSol]);
  assert.equal(carried.supports_search_tool, true);
  assert.equal(carried, nativeSol, "a row whose node_repl policy already matches is returned as it is");
  const off = { ...nativeSol, supports_search_tool: false };
  assert.equal(executorNativeRow(off, [off]), off);
  const stated = { ...nativeSol, node_repl_disabled: undefined, supports_search_tool: true };
  const changed = executorNativeRow(stated, [stated]);
  assert.equal(changed.supports_search_tool, true, "a changed node_repl policy never changes search");
  assert.equal(changed.node_repl_disabled, true);
});

test("the first host read replaces the plain startup catalog even when the host rows match the local config", async () => {
  const f = await shimFiles();
  try {
    f.value.providers = [codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata })]; f.setCatalog(modelCatalog(f.value));
    const path = join(f.directory, "desktop-models.json");
    // A first launch has no offline cache, and prepareNativeCatalog wrote the plain rows.
    await writePrivateJson(path, { models: [nativeSol, ...modelCatalog(f.value).models] });
    // The host publishes the same rows as the local config; the first successful read must still replace that file.
    const live = new DesktopCatalog(f.value, [nativeSol], path, true); await live.refresh(true);
    const sol = JSON.parse(await readFile(path, "utf8")).models[1];
    assert.equal(sol.slug, "codex/sol"); assert.deepEqual(sol.model_messages, messages); assert.equal(sol.include_skills_usage_instructions, false);
    assert.equal(Object.hasOwn(sol, "upstream_slug"), false);
  } finally { f.close(); }
});
