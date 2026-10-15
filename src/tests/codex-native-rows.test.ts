import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCatalog } from "../catalog.js";
import { executorRunsCodeMode, nodeReplFallback, withNativeRow } from "../codex-native-rows.js";
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
  for (const key of ["slug", "display_name", "description", "priority", "supported_reasoning_levels", "service_tiers", "additional_speed_tiers", "default_service_tier", "multi_agent_version", "multi_agent_reasoning_effort", "max_context_window", "auto_compact_token_limit", "supports_search_tool", "experimental_supported_tools", "input_modalities"]) assert.deepEqual(row[key], published[key], key);
  assert.equal(row.supports_search_tool, false);
  for (const key of ["comp_hash", "upstream_slug", "web_search_tool_type"]) assert.equal(Object.hasOwn(row, key), false, key);
  (row.model_messages as typeof messages).approvals.on_request = "changed";
  assert.equal(messages.approvals.on_request, "native approvals", "the native row is copied, never shared");
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
    assert.equal(sol.default_reasoning_level, "low"); assert.equal(sol.supports_search_tool, false); assert.deepEqual(sol.service_tiers, [tier]);
    for (const key of usageFlags) { assert.equal(sol[key], false, key); assert.equal(next[key], true, key); }
    for (const row of [next, odd]) { assert.deepEqual(row.model_messages, { instructions_template: "" }); assert.equal(row.tool_mode, "direct"); assert.equal(row.context_window, 500000); }
    assert.deepEqual(combined.models[0], nativeSol);
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

// Real native rows (ChatGPT 26.1007): every row enables node_repl; gpt-6-astra, gpt-6.1-sol and gpt-6-sol require auto review, gpt-6-luna and the 5.x rows do not.
const policy = (slug: string, node_repl_disabled: unknown, node_repl_auto_review_required: unknown) => ({ ...nativeSol, slug, node_repl_disabled, node_repl_auto_review_required });
const strictNative = policy("gpt-6.1-sol", false, true);
const laxNative = policy("gpt-6-luna", false, false);
const repl = (row: Record<string, unknown>) => ({ disabled: row.node_repl_disabled, review: row.node_repl_auto_review_required });
const config = (...providers: ProviderConfig[]) => ({ version: 1, port: 0, stateDirectory: ".", providers } as unknown as GatewayConfig);
const claude: ProviderConfig = { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } };
const rows = (native: Array<Record<string, unknown>>, codeMode: boolean, ...providers: ProviderConfig[]) => new DesktopCatalog(config(...providers), native, "unused", codeMode).current().models;

test("the published default is the strictest node_repl policy", () => {
  const [published] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata }));
  assert.deepEqual(repl(published), { disabled: true, review: true });
  assert.deepEqual(repl(catalog(claude)[0]), { disabled: true, review: true });
});

test("a Codex 2 row copies both node_repl fields from its native row, with or without code mode", () => {
  const [published] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata }));
  for (const codeMode of [true, false]) {
    for (const [disabled, review] of [[false, true], [false, false], [true, false], [true, true]]) {
      assert.deepEqual(repl(withNativeRow(published, [policy("gpt-6.1-sol", disabled, review)], codeMode)), { disabled, review }, `${codeMode} ${disabled} ${review}`);
    }
    assert.deepEqual(repl(withNativeRow(published, [strictNative, laxNative], codeMode)), { disabled: false, review: true }, "the row's own native policy, not another row's");
    assert.deepEqual(repl(withNativeRow({ ...published, upstream_slug: "gpt-6-luna" }, [strictNative, laxNative], codeMode)), { disabled: false, review: false });
  }
});

test("a native row that does not state a node_repl field plainly gives the stricter value", () => {
  const [published] = catalog(codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata }));
  // A host (or an older cache) that published a weaker value cannot lower the policy either.
  const weaker = { ...published, node_repl_disabled: false, node_repl_auto_review_required: false };
  for (const codeMode of [true, false]) {
    assert.deepEqual(repl(withNativeRow(weaker, [nativeSol], codeMode)), { disabled: true, review: true }, "fields absent from the native row");
    assert.deepEqual(repl(withNativeRow(weaker, [policy("gpt-6.1-sol", "false", null)], codeMode)), { disabled: true, review: true }, "fields that are not booleans");
    assert.deepEqual(repl(withNativeRow(weaker, [policy("gpt-6.1-sol", false, undefined)], codeMode)), { disabled: false, review: true }, "each field is judged on its own");
  }
});

test("rows without a native counterpart take the strictest policy among the native rows", () => {
  assert.deepEqual(nodeReplFallback([laxNative]), { node_repl_disabled: false, node_repl_auto_review_required: false });
  assert.deepEqual(nodeReplFallback([laxNative, strictNative]), { node_repl_disabled: false, node_repl_auto_review_required: true }, "auto review is required when any native row requires it");
  assert.deepEqual(nodeReplFallback([strictNative, policy("off", true, false)]), { node_repl_disabled: true, node_repl_auto_review_required: true }, "off when any native row is off");
  assert.deepEqual(nodeReplFallback([laxNative, policy("odd", false, "yes")]), { node_repl_disabled: false, node_repl_auto_review_required: true }, "an ambiguous field counts as required");
  assert.deepEqual(nodeReplFallback([laxNative, nativeSol]), { node_repl_disabled: true, node_repl_auto_review_required: true }, "fields absent from a native row count as the stricter value");
  assert.deepEqual(nodeReplFallback([]), { node_repl_disabled: true, node_repl_auto_review_required: true });
});

test("Claude rows and Codex rows with a missing upstream take the fallback in both code modes", () => {
  const providers = [codex({ "codex/sol": "gpt-6.1-sol", "codex/next": "gpt-9" }), claude];
  for (const codeMode of [true, false]) {
    const bySlug = (native: Array<Record<string, unknown>>) => Object.fromEntries(rows(native, codeMode, ...providers).map(row => [row.slug, repl(row)]));
    assert.deepEqual(bySlug([laxNative, strictNative]), {
      "codex/sol": { disabled: false, review: true }, "codex/next": { disabled: false, review: true }, "claude/opus": { disabled: false, review: true },
    }, `strictest native policy ${codeMode}`);
    // The Codex row follows its own native row; the others follow the strictest one.
    assert.deepEqual(bySlug([policy("gpt-6.1-sol", false, false), policy("gpt-6.2", false, true)]), {
      "codex/sol": { disabled: false, review: false }, "codex/next": { disabled: false, review: true }, "claude/opus": { disabled: false, review: true },
    }, `own row for the marked Codex row ${codeMode}`);
    assert.deepEqual(bySlug([policy("gpt-6.1-sol", false, true), policy("gpt-6.2", true, false)]), {
      "codex/sol": { disabled: false, review: true }, "codex/next": { disabled: true, review: true }, "claude/opus": { disabled: true, review: true },
    }, `one native row off keeps the fallback rows off ${codeMode}`);
    assert.deepEqual(Object.values(bySlug([])), [{ disabled: true, review: true }, { disabled: true, review: true }, { disabled: true, review: true }], "no native catalog");
  }
});

test("combined() carries both node_repl fields on native and gateway rows, whether code mode is on or off", () => {
  const providers = [codex({ "codex/sol": "gpt-6.1-sol", "codex/next": "gpt-9" }, { "codex/sol": solMetadata, "codex/next": solMetadata }), claude];
  const native = [strictNative, laxNative];
  const before = structuredClone(native);
  for (const codeMode of [true, false]) {
    const combined = new DesktopCatalog(config(...providers), native, "unused", codeMode).combined().models;
    assert.deepEqual(combined.map(row => [row.slug, repl(row).disabled, repl(row).review]), [
      ["gpt-6.1-sol", false, true], ["gpt-6-luna", false, false], ["codex/sol", false, true], ["codex/next", false, true], ["claude/opus", false, true],
    ], String(codeMode));
    assert.equal(combined[2].tool_mode, codeMode ? "code_mode_only" : "direct", "only tool_mode depends on code mode");
  }
  assert.deepEqual(native, before, "the native rows are never modified");
});

test("check-node-repl prints both node_repl fields for every row and counts rows without auto review", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-node-repl-"));
  try {
    const file = join(root, "catalog.json");
    await writeFile(file, JSON.stringify({ models: [
      { slug: "a", node_repl_disabled: false, node_repl_auto_review_required: true }, { slug: "b", node_repl_disabled: false, node_repl_auto_review_required: false },
      { slug: "c", node_repl_disabled: true }, { slug: "d" },
    ] }));
    const output = execFileSync(process.execPath, [join(import.meta.dirname, "..", "..", "scripts", "check-node-repl.mjs"), file], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(output, [
      "disabled=false auto_review_required=true a", "disabled=false auto_review_required=false b", "disabled=true auto_review_required=missing c", "disabled=missing auto_review_required=missing d",
      "2 of 4 row(s) keep node_repl disabled.", "1 of 4 row(s) enable node_repl without requiring auto review.",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a host row that publishes a weaker node_repl policy cannot lower the combined catalog", async () => {
  const f = await shimFiles();
  try {
    f.value.providers = [codex({ "codex/sol": "gpt-6.1-sol" }, { "codex/sol": solMetadata }), claude];
    const weaker = modelCatalog(f.value); weaker.models = weaker.models.map(row => ({ ...row, node_repl_disabled: false, node_repl_auto_review_required: false })); f.setCatalog(weaker);
    const path = join(f.directory, "combined.json");
    await new DesktopCatalog(f.value, [strictNative, laxNative], path, true).refresh(true);
    const [, , sol, opus] = JSON.parse(await readFile(path, "utf8")).models;
    assert.deepEqual([sol.slug, repl(sol)], ["codex/sol", { disabled: false, review: true }]);
    assert.deepEqual([opus.slug, repl(opus)], ["claude/opus", { disabled: false, review: true }]);
    const cache = JSON.parse(await readFile(join(f.value.stateDirectory, "desktop-public-models.json"), "utf8"));
    assert.equal(cache.models.every((row: Record<string, unknown>) => "node_repl_auto_review_required" in row), true, "the public cache keeps the auto review field the host published");
  } finally { f.close(); }
});
