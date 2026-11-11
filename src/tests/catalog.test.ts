import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeEffort } from "../providers/claude.js";
import { claudeCliModel, nativeClaudeModels, readClaudeModels } from "../providers/claude-models.js";
import { discoverModels, loadDiscoveredModels, modelCatalog, modelLabel } from "../catalog.js";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { validateConfig } from "../config.js";
import { readServiceTierMetadata } from "../model-service-tiers.js";

const native = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Duplicate" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
];

test("Claude catalog resolves aliases, removes duplicate defaults, and retains native reasoning capabilities", () => {
  const models = nativeClaudeModels(native);
  assert.deepEqual(models.map(m => m.model), ["claude-opus-5-5", "claude-haiku-4-5-20251001"]);
  assert.equal(models[0].metadata.contextWindow, 1000000);
  // Ultra is Codex's top effort plus its own v2 delegation; Claude runs it at max.
  assert.deepEqual(models[0].metadata.reasoningEfforts, ["low", "medium", "high", "max", "ultra"]);
  assert.equal(models[0].metadata.multiAgentVersion, "v2"); assert.equal(models[0].metadata.multiAgentReasoningEffort, "max");
  assert.deepEqual(models[1].metadata.reasoningEfforts, []);
  assert.equal(models[1].metadata.multiAgentVersion, undefined);
  assert.equal(models[1].metadata.contextWindow, 200000, "older Claude rows report Claude's real window instead of a 32K fallback");
  assert.throws(() => nativeClaudeModels([{ value: "opus", displayName: "Opus", supportedEffortLevels: ["unsupported"] }]), /reasoning/);
});

test("Claude models that reach 1M on the subscription advertise 1M, including Fable 5.2 through the CLI's [1m] variant", () => {
  const models = nativeClaudeModels([
    { value: "claude-fable-5-2", displayName: "Fable 5.2" }, { value: "claude-mythos-5-1", displayName: "Mythos 5.1" },
    { value: "claude-sonnet-4-6", displayName: "Sonnet 4.6" }, { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  ]);
  assert.deepEqual(models.map(m => [m.model, m.metadata.contextWindow]),
    [["claude-fable-5-2", 1000000], ["claude-mythos-5-1", 1000000], ["claude-sonnet-4-6", 200000], ["claude-haiku-4-5-20251001", 200000]]);
  assert.equal(claudeCliModel("claude-fable-5-2"), "claude-fable-5-2[1m]", "the CLI runs Fable 5.2's plain ID at 200K");
  assert.equal(claudeCliModel("claude-mythos-5-1"), "claude-mythos-5-1");
  assert.equal(claudeCliModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001", "Haiku's [1m] variant silently runs another model");
});

test("refresh retains existing account aliases and metadata while replacing the offered model set", () => {
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { saved: "claude-opus-5-5", retired: "old" }, modelMetadata: { saved: { contextWindow: 200000 } } };
  loadDiscoveredModels(provider, nativeClaudeModels(native));
  assert.deepEqual(provider.models, { saved: "claude-opus-5-5", "claude/claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001" });
  assert.equal(provider.modelMetadata?.saved.contextWindow, 1000000);
  assert.equal(provider.modelMetadata?.saved.displayName, "Opus 5.5");
});

test("account groups stay in configuration order despite conflicting upstream priorities", () => {
  const catalog = modelCatalog({ version: 1, port: 0, stateDirectory: ".", providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { older: "a", newer: "b" }, modelMetadata: { older: { priority: 90000 }, newer: { priority: 2 } } },
    { id: "codex", type: "codex-subscription", label: "Codex 2", models: { secondary: "b" }, modelMetadata: { secondary: { priority: -90000 } } },
  ] });
  assert.deepEqual(catalog.models.map(m => m.slug), ["newer", "older", "secondary"]);
  assert.deepEqual(catalog.models.map(m => m.display_name), ["Claude · b", "Claude · a", "Codex 2 · b"]);
});

test("every row publishes the tokenizer family of its upstream model, not of its alias text", () => {
  const catalog = modelCatalog({ version: 1, port: 0, stateDirectory: ".", providers: [
    { id: "team", type: "claude-subscription", label: "Team", models: { "team/large": "claude-opus-5-5", "team/small": "claude-sonnet-5-5" } },
    { id: "codex", type: "codex-subscription", label: "Codex 2", models: { "codex/fast": "gpt-6.1-sol" } },
    { id: "local", type: "openai-compatible", label: "Local", baseUrl: "http://127.0.0.1:1/v1", models: { "qwen/worker": "qwen3.8-flash-next" } },
  ] } as never);
  assert.deepEqual(Object.fromEntries(catalog.models.map(m => [m.slug, m.tokenizer_family])),
    { "team/large": "anthropic", "team/small": "anthropic", "codex/fast": "openai", "qwen/worker": "qwen3" });
});

function worker(mode: string) {
  return spawn(process.execPath, ["--input-type=module", "-e", `
    import {createInterface} from 'node:readline';
    ${mode === "hang" ? "process.on('SIGTERM',()=>{});" : ""}
    for await(const line of createInterface({input:process.stdin})){
      const m=JSON.parse(line);
      if(m.type!=='control_request'||m.request.subtype!=='initialize')process.exit(8);
      if(${JSON.stringify(mode)}==='eof'){process.stderr.write('private diagnostic');process.exit(2);}
      if(${JSON.stringify(mode)}==='hang')continue;
      if(${JSON.stringify(mode)}==='oversize'){process.stdout.write('x'.repeat(1024*1024+1));continue;}
      if(${JSON.stringify(mode)}==='invalid'){console.log('private-diagnostic-invalid-json');continue;}
      console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:m.request_id,response:{models:${JSON.stringify(native)}}}}));
    }
  `], { stdio: ["pipe", "pipe", "pipe"] });
}

test("API discovery keeps one vendor name in labels and stable configured aliases", async () => {
  const original = globalThis.fetch, old = process.env.OPENROUTER_LABEL_FIXTURE_KEY;
  globalThis.fetch = async () => Response.json({ data: [{ id: "deepseek/deepseek-v4-flash", name: "DeepSeek: DeepSeek V4 Flash" }] });
  process.env.OPENROUTER_LABEL_FIXTURE_KEY = "fixture-only";
  try {
    const provider: ProviderConfig = { id: "openrouter", label: "OpenRouter", type: "chat-completions-api", baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_LABEL_FIXTURE_KEY", models: { "or-deepseek": "deepseek/deepseek-v4-flash" },
      modelMetadata: { "or-deepseek": { displayName: "or-deepseek" } } };
    loadDiscoveredModels(provider, await discoverModels(provider));
    assert.deepEqual(provider.models, { "or-deepseek": "deepseek/deepseek-v4-flash" });
    assert.equal(provider.modelMetadata?.["or-deepseek"]?.displayName, "DeepSeek V4 Flash");
  } finally {
    globalThis.fetch = original;
    if (old === undefined) delete process.env.OPENROUTER_LABEL_FIXTURE_KEY; else process.env.OPENROUTER_LABEL_FIXTURE_KEY = old;
  }
});

test("model labels drop a vendor prefix only when the name repeats that vendor", () => {
  assert.equal(modelLabel("DeepSeek: DeepSeek V4.1 Flash 1017"), "DeepSeek V4.1 Flash 1017");
  assert.equal(modelLabel("Z.ai: GLM 5.3"), "Z.ai: GLM 5.3");
  assert.equal(modelLabel("DeepSeek V4 Flash"), "DeepSeek V4 Flash");
  assert.equal(modelLabel("DeepSeek : DeepSeek V4 Flash"), "DeepSeek V4 Flash");
  assert.equal(modelLabel("Qwen: Qwen3-Coder"), "Qwen3-Coder");
  // Only one leading `vendor: ` segment is a candidate; later colons are part of the name.
  assert.equal(modelLabel("Meta: Llama 4: Instruct"), "Meta: Llama 4: Instruct");
  assert.equal(modelLabel("OpenAI: gpt-5.6"), "OpenAI: gpt-5.6");
});

test("catalog display names remove the repeated vendor already shown by the provider label", () => {
  const catalog = modelCatalog({ version: 1, port: 0, stateDirectory: ".", providers: [
    { id: "openrouter", type: "chat-completions-api", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "KEY",
      models: { "or-deepseek": "deepseek/deepseek-v4.1-flash-1017" },
      modelMetadata: { "or-deepseek": { displayName: "DeepSeek: DeepSeek V4.1 Flash 1017" } } },
  ] });
  assert.deepEqual(catalog.models.map(m => m.display_name), ["OpenRouter · DeepSeek V4.1 Flash 1017"]);
});

test("native discovery sends only metadata initialization and cleans up its worker", async () => {
  const child = worker("ok");
  const models = await readClaudeModels(child);
  assert.equal(models.length, 2);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("discovery rejects premature exit without exposing diagnostics and kills stalled workers", async () => {
  await assert.rejects(readClaudeModels(worker("eof")), /ended without a catalog/);
  const child = worker("hang");
  await assert.rejects(readClaudeModels(child, 150), /timed out/);
  assert.equal(child.signalCode, "SIGKILL");
});


test("discovery bounds unterminated output and keeps malformed metadata out of errors", async () => {
  const oversized = worker("oversize");
  await assert.rejects(readClaudeModels(oversized), /exceeds 1 MiB/);
  assert.ok(oversized.exitCode !== null || oversized.signalCode !== null);
  await assert.rejects(readClaudeModels(worker("invalid")), error => {
    assert.equal((error as Error).message, "Claude model discovery returned invalid JSON");
    return true;
  });
});


test("a Claude model without effort controls accepts none without passing an unsupported CLI flag", () => {
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { haiku: "haiku", sonnet: "sonnet" }, modelMetadata: { haiku: { reasoningEfforts: [] }, sonnet: { reasoningEfforts: ["low", "high"] } } };
  assert.equal(claudeEffort(provider, { model: "haiku", input: "hello", reasoning: { effort: "none" } }), undefined);
  assert.throws(() => claudeEffort(provider, { model: "haiku", input: "hello", reasoning: { effort: "high" } }), /does not support/);
  assert.equal(claudeEffort(provider, { model: "sonnet", input: "hello", reasoning: { effort: "high" } }), "high");
  assert.throws(() => claudeEffort(provider, { model: "sonnet", input: "hello", reasoning: { effort: "none" } }), /does not support/);
});


test("discovery preserves multiple public aliases of a retained upstream model", () => {
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { old: "claude-opus-5-5", current: "claude-opus-5-5" } };
  loadDiscoveredModels(provider, nativeClaudeModels(native));
  assert.equal(provider.models.old, "claude-opus-5-5");
  assert.equal(provider.models.current, "claude-opus-5-5");
});

const priority = { id: "priority", name: "Fast", description: "Priority routing" };
test("only declared model service tiers reach the public native catalog", () => {
  const catalog = modelCatalog({ version: 1, port: 0, stateDirectory: ".", providers: [
    { id: "codex", type: "codex-subscription", models: { fast: "sol", standard: "other" }, modelMetadata: { fast: { additionalSpeedTiers: ["fast"], serviceTiers: [priority], defaultServiceTier: "priority" } } },
    { id: "copilot", type: "copilot-subscription", models: { copilot: "sol" } },
  ] });
  assert.deepEqual(catalog.models[0].service_tiers, [priority]);
  assert.deepEqual(catalog.models[0].additional_speed_tiers, ["fast"]);
  assert.equal(catalog.models[0].default_service_tier, "priority");
  for (const model of catalog.models.slice(1)) {
    assert.deepEqual(model.service_tiers, []); assert.deepEqual(model.additional_speed_tiers, []); assert.equal(model.default_service_tier, null);
  }
});

test("configuration validates service tier IDs, structure, duplicates and advertised defaults", () => {
  const provider: ProviderConfig = { id: "codex", type: "codex-subscription", credentialFile: "unused", models: { sol: "sol" }, modelMetadata: { sol: { serviceTiers: [priority], defaultServiceTier: "priority" } } };
  assert.equal(validateConfig({ version: 1, port: 0, stateDirectory: ".", providers: [provider] }).providers[0].modelMetadata?.sol.defaultServiceTier, "priority");
  for (const metadata of [
    { serviceTiers: "priority" }, { serviceTiers: [priority, priority] }, { serviceTiers: [{ ...priority, name: 1 }] },
    { serviceTiers: [{ ...priority, id: "default" }] }, { serviceTiers: [{ ...priority, id: "fast" }] },
    { serviceTiers: [priority], defaultServiceTier: "flex" }, { additionalSpeedTiers: ["fast", "fast"] },
  ]) assert.throws(() => validateConfig({ version: 1, port: 0, providers: [{ ...provider, modelMetadata: { sol: metadata } }] }), /[Ss]ervice tier|speed tiers/);
  assert.deepEqual(readServiceTierMetadata({ serviceTiers: [{ ...priority, auth: "not-public" }] }), { serviceTiers: [priority] });
});

test("Responses discovery carries only validated public tier metadata", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "sol", service_tiers: [{ ...priority, credential: "excluded" }], additional_speed_tiers: ["fast"], default_service_tier: "priority" }] });
  const provider: ProviderConfig = { id: "api", type: "responses-api", baseUrl: "https://example.test", apiKeyEnv: "GATEWAY_CATALOG_TEST_KEY", models: { sol: "sol" } };
  process.env.GATEWAY_CATALOG_TEST_KEY = "catalog-fixture";
  try {
    const models = await discoverModels(provider);
    assert.deepEqual(models[0].metadata, { serviceTiers: [priority], additionalSpeedTiers: ["fast"], defaultServiceTier: "priority" });
    globalThis.fetch = async () => Response.json({ data: [{ id: "sol", service_tiers: [priority], default_service_tier: "unadvertised" }] });
    await assert.rejects(discoverModels(provider), /Default service tier/);
  } finally { globalThis.fetch = original; delete process.env.GATEWAY_CATALOG_TEST_KEY; }
});

test("discovered Ultra delegation metadata reaches the Codex catalog row", () => {
  const config = { version: 1 as const, port: 3457, stateDirectory: "/unused", providers: [{ id: "codex", type: "codex-subscription" as const, credentialFile: "unused",
    models: { "codex/sol": "sol" }, modelMetadata: { "codex/sol": { reasoningEfforts: ["high", "max", "ultra"], multiAgentVersion: "v2", multiAgentReasoningEffort: "xhigh" } } }] };
  const row = modelCatalog(config).models[0];
  assert.equal(row.multi_agent_version, "v2"); assert.equal(row.multi_agent_reasoning_effort, "xhigh");
  assert.deepEqual((row.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort), ["high", "max", "ultra"]);
});

const parityConfig = (metadata: ProviderConfig["modelMetadata"] = {}): GatewayConfig => ({ version: 1, port: 0, stateDirectory: ".", providers: [
  { id: "codex", type: "codex-subscription", credentialFile: "unused", label: "Codex 2", models: { "codex/sol": "sol" }, modelMetadata: { "codex/sol": { contextWindow: 500000, ...metadata["codex/sol"] } } },
  { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" }, modelMetadata: { "claude/opus": { contextWindow: 1000000, ...metadata["claude/opus"] } } },
  { id: "copilot", type: "copilot-subscription", models: { "copilot/sol": "sol" } },
  { id: "api", type: "chat-completions-api", baseUrl: "https://example.test", apiKeyEnv: "UNUSED", models: { "api/model": "model" } },
] });

test("Codex 2 rows default to native truncation and window share while other rows keep today's values", () => {
  const [codex, ...others] = modelCatalog(parityConfig()).models;
  assert.deepEqual(codex.truncation_policy, { mode: "tokens", limit: 10000 }); assert.equal(codex.effective_context_window_percent, 95);
  assert.equal((codex.context_window as number) * (codex.effective_context_window_percent as number) / 100, 475000, "475K usable of 500K, as native Codex computes it");
  assert.deepEqual(others.map(row => row.slug), ["claude/opus", "copilot/sol", "api/model"]);
  for (const row of others) { assert.deepEqual(row.truncation_policy, { mode: "tokens", limit: 12000 }); assert.equal(row.effective_context_window_percent, 90); }
  for (const row of [codex, ...others]) {
    assert.equal(Object.hasOwn(row, "auto_compact_token_limit"), false, "an absent compaction limit stays absent");
    assert.equal(row.max_context_window, row.context_window, "without its own maximum a row's window is its maximum, not Codex's global 872K cap");
  }
  // Field order is part of the catalog revision; rows serialize in this stable order.
  for (const row of [codex, ...others]) assert.deepEqual([row.node_repl_disabled, row.node_repl_auto_review_required], [true, true], "every published row starts at the strictest node_repl policy");
  assert.deepEqual(Object.keys(others[0]).slice(-10), ["truncation_policy", "experimental_supported_tools", "input_modalities", "context_window",
    "effective_context_window_percent", "max_context_window", "supports_search_tool", "supports_experimental_context", "node_repl_disabled", "node_repl_auto_review_required"]);
});

test("model metadata overrides the catalog parity defaults for any row", () => {
  const metadata = { truncationPolicy: { mode: "bytes" as const, limit: 20000 }, effectiveContextWindowPercent: 80, autoCompactTokenLimit: 300000, maxContextWindow: 872000 };
  const [codex, claude] = modelCatalog(parityConfig({ "codex/sol": metadata, "claude/opus": { truncationPolicy: { mode: "tokens", limit: 10000 }, effectiveContextWindowPercent: 95 } })).models;
  assert.deepEqual(codex.truncation_policy, { mode: "bytes", limit: 20000 }); assert.equal(codex.effective_context_window_percent, 80);
  assert.equal(codex.auto_compact_token_limit, 300000); assert.equal(codex.max_context_window, 872000);
  assert.deepEqual(claude.truncation_policy, { mode: "tokens", limit: 10000 }); assert.equal(claude.effective_context_window_percent, 95);
  assert.equal(claude.max_context_window, claude.context_window);
  const reverted = modelCatalog(parityConfig({ "codex/sol": { truncationPolicy: { mode: "tokens", limit: 12000 }, effectiveContextWindowPercent: 90 } })).models[0];
  assert.deepEqual(reverted.truncation_policy, { mode: "tokens", limit: 12000 }); assert.equal(reverted.effective_context_window_percent, 90);
});

test("Codex 2 discovery copies valid window and truncation fields, never comp_hash, into the catalog row", async () => {
  const directory = await mkdtemp(join(tmpdir(), "catalog-parity-"));
  const credentialFile = join(directory, "registration.json");
  await writeFile(credentialFile, JSON.stringify({ access_token: "fixture-only", scopes: ["resource.invoke", "chatgpt.tokens.use.direct"], expires_at: Date.now() + 3600000 }), { mode: 0o600 });
  const original = globalThis.fetch; let requested = "";
  globalThis.fetch = async input => {
    requested = String(input);
    return Response.json({ data: [
      { id: "sol", context_window: 500000, truncation_policy: { mode: "tokens", limit: 10000, extra: "dropped" }, effective_context_window_percent: 95,
        auto_compact_token_limit: 400000, max_context_window: 872000, comp_hash: "upstream-hash" },
      { id: "invalid", context_window: 500000, truncation_policy: { mode: "chars", limit: 10000 }, effective_context_window_percent: 95.5,
        auto_compact_token_limit: 512, max_context_window: 400000, comp_hash: null },
      { id: "bounds", context_window: 272000, truncation_policy: { mode: "bytes", limit: 999 }, effective_context_window_percent: 49, auto_compact_token_limit: "400000", max_context_window: 272000 },
      { id: "nested", truncation_policy: "tokens", effective_context_window_percent: 101, max_context_window: 2048 },
    ] });
  };
  try {
    const provider: ProviderConfig = { id: "codex", type: "codex-subscription", credentialFile, label: "Codex 2", models: { "codex/sol": "sol" } };
    const models = await discoverModels(provider);
    assert.equal(requested, "https://api.openai.com/v1/models");
    assert.deepEqual(models[0].metadata, { contextWindow: 500000, truncationPolicy: { mode: "tokens", limit: 10000 }, effectiveContextWindowPercent: 95, autoCompactTokenLimit: 400000, maxContextWindow: 872000 });
    assert.deepEqual(models[1].metadata, { contextWindow: 500000 }, "invalid mode, fractional percent, tiny limit and a maximum below the window are ignored");
    assert.deepEqual(models[2].metadata, { contextWindow: 272000, maxContextWindow: 272000 });
    assert.deepEqual(models[3].metadata, { maxContextWindow: 2048 });
    assert.equal(JSON.stringify(models).includes("upstream-hash") || JSON.stringify(models).includes("comp_hash") || JSON.stringify(models).includes("compHash"), false);
    loadDiscoveredModels(provider, models);
    const row = modelCatalog(validateConfig({ version: 1, port: 0, stateDirectory: directory, providers: [provider] })).models[0];
    assert.deepEqual(row.truncation_policy, { mode: "tokens", limit: 10000 }); assert.equal(row.effective_context_window_percent, 95);
    assert.equal(row.auto_compact_token_limit, 400000); assert.equal(row.max_context_window, 872000); assert.equal(Object.hasOwn(row, "comp_hash"), false);
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});
