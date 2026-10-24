import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeDesktopProfile, type ClaudeDesktopGatewaySource } from "../claude-desktop-profile.js";

const source: ClaudeDesktopGatewaySource = {
  port: 3457, stateDirectory: "/private/gateway",
  providers: [
    { id: "claude", type: "claude-subscription", models: { "claude/claude-fable-5-1": "claude-fable-5-1", "claude/claude-sonnet": "claude-sonnet" } },
    { id: "codex-a", type: "codex-subscription", models: { "codex/gpt": "gpt" } },
    { id: "codex-b", type: "responses-api", models: { "codex/gpt-2": "gpt-2" } },
    { id: "qwen", type: "chat-completions-api", models: { "qwen/flash": "qwen-flash" } },
  ],
};
const catalog = {
  models: [
    { slug: "claude/claude-fable-5-1", display_name: "Claude Fable 5.1" },
    { slug: "claude/claude-sonnet", display_name: "Claude Sonnet" },
    { slug: "codex/gpt", display_name: "GPT One", supported_reasoning_levels: ["high"] },
    { slug: "codex/gpt-2", display_name: "GPT Two" },
    { slug: "qwen/flash", display_name: "Qwen Flash", supported_reasoning_levels: [{ effort: "high" }] },
  ],
};
const options = { tokenFile: "/private/desktop/client-token", adapterRoot: "/private/desktop" };

test("builds stable opaque routes for two GPT accounts and Qwen while preserving the primary identity", () => {
  const existing = { preserved: { enabled: true }, inferenceModels: [{ name: "claude-sonnet", maxEffort: "medium" }] };
  const before = structuredClone(source);
  const { profile, adapterConfig } = buildClaudeDesktopProfile(source, catalog, existing, options);
  const models = profile.inferenceModels as Array<Record<string, unknown>>;
  assert.equal(profile.preserved instanceof Object, true);
  assert.deepEqual(models.slice(0, 2).map(row => row.name), ["claude-fable-5-1", "claude-sonnet"]);
  assert.equal(models[1]!.maxEffort, "medium");
  assert.deepEqual(adapterConfig.models.slice(0, 2).map(row => [row.id, row.upstream]), [["claude-fable-5-1", "claude/claude-fable-5-1"], ["claude-sonnet", "claude/claude-sonnet"]]);
  const extras = adapterConfig.models.slice(2, 5);
  assert.equal(extras.length, 3);
  assert.ok(extras.every(model => /^claude-hg-route-\d+$/.test(model.id)));
  assert.equal(extras.filter(model => model.preserveOptionalToolArguments).length, 2);
  assert.equal(extras.some(model => "supports1MContext" in model), false);
  assert.equal(extras.some(model => "anthropicFamilyTier" in model), false);
  assert.equal(adapterConfig.endpoint, "http://127.0.0.1:3457");
  assert.deepEqual(source, before);
});

test("puts the explicit helper token argument in the isolated profile only when requested", () => {
  const existing = {
    apiKeyHelper: "preserved",
    inferenceCredentialHelper: "/old/helper",
    inferenceCredentialHelperArgs: ["token", "--file", "/old/token"],
  };
  const built = buildClaudeDesktopProfile(source, catalog, existing, { ...options, credentialHelper: { command: "/usr/local/bin/gateway", args: ["token", "--file", "/old/token"] } });
  assert.equal(built.profile.inferenceCredentialHelper, "/usr/local/bin/gateway");
  assert.deepEqual(built.profile.inferenceCredentialHelperArgs, ["token", "--file", options.tokenFile]);
  assert.equal(built.profile.apiKeyHelper, "preserved");
  assert.equal(buildClaudeDesktopProfile(source, catalog, existing, options).profile.inferenceCredentialHelper, "/old/helper");
});

test("rejects missing catalog rows, ambiguous ownership, a missing default, and an adapter self-loop", () => {
  assert.throws(() => buildClaudeDesktopProfile(source, { models: catalog.models.slice(1) }, {}, options), /absent from the model catalog/);
  const duplicate = structuredClone(source); duplicate.providers[1]!.models["qwen/flash"] = "dup";
  assert.throws(() => buildClaudeDesktopProfile(duplicate, catalog, {}, options), /owned by more than one/);
  assert.throws(() => buildClaudeDesktopProfile(source, catalog, {}, { ...options, defaultModel: "missing" }), /must explicitly provide/);
  assert.throws(() => buildClaudeDesktopProfile(source, catalog, {}, { ...options, upstream: "http://127.0.0.1:3467" }), /conflicts/);
});

const fast = { id: "priority", name: "Fast", description: "Faster output" };
const allLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const variantSource: ClaudeDesktopGatewaySource = {
  port: 3457, stateDirectory: "/private/gateway",
  providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/claude-fable-5-1": "claude-fable-5-1", "claude/claude-plain": "claude-plain" } },
    { id: "codex-a", type: "codex-subscription", models: { "codex/gpt": "gpt" } },
    { id: "codex-b", type: "responses-api", models: { "codex/gpt-2": "gpt-2" } },
    { id: "qwen", type: "chat-completions-api", models: { "qwen/flash": "qwen-flash" } },
  ],
};
const variantCatalog = {
  models: [
    { slug: "claude/claude-fable-5-1", display_name: "Claude · Opus", supported_reasoning_levels: allLevels.map(effort => ({ effort })), service_tiers: [fast] },
    { slug: "claude/claude-plain", display_name: "Claude · Plain" },
    { slug: "codex/gpt", display_name: "GPT One", supported_reasoning_levels: ["low", "high", "ultra"], service_tiers: [fast, { id: "flex", name: "Flex" }, { id: "default", name: "Dup" }, { id: "Bad Id", name: "Bad" }] },
    { slug: "codex/gpt-2", display_name: "GPT Two", service_tiers: [fast] },
    { slug: "qwen/flash", display_name: "Qwen Flash", supported_reasoning_levels: [{ effort: "medium" }, { effort: "max" }], service_tiers: [fast] },
  ],
};
type Row = { id: string; upstream: string; displayName: string; reasoningEffort?: string; serviceTier?: string };

test("adds opaque effort and speed variants for Claude, GPT and Qwen after the original rows", () => {
  const base = buildClaudeDesktopProfile(variantSource, { models: variantCatalog.models.map(({ supported_reasoning_levels, service_tiers, ...row }) => row) }, {}, options);
  const built = buildClaudeDesktopProfile(variantSource, variantCatalog, {}, options);
  const originals = base.adapterConfig.models.length;
  assert.deepEqual(built.adapterConfig.models.slice(0, originals), base.adapterConfig.models);
  // Original rows keep their names and labels; primary rows now also carry an accurate maxEffort.
  const keyed = (rows: unknown) => (rows as Array<Record<string, unknown>>).slice(0, originals).map(row => [row.name, row.labelOverride]);
  assert.deepEqual(keyed(built.profile.inferenceModels), keyed(base.profile.inferenceModels));
  const variants = built.adapterConfig.models.slice(originals) as Row[];
  const labelsFor = (alias: string) => variants.filter(row => row.upstream === alias).map(row => row.displayName);
  // Primary Claude keeps its native controls for Standard: only Fast x the five supported efforts
  // (ultra, none and minimal ignored), and no explicit Standard variant.
  assert.deepEqual(labelsFor("claude/claude-fable-5-1"), ["Low", "Medium", "High", "Extra High", "Max"].map(effort => `Claude · Opus · ${effort} · Fast`));
  assert.ok(labelsFor("claude/claude-fable-5-1").includes("Claude · Opus · High · Fast"));
  assert.ok(labelsFor("claude/claude-fable-5-1").every(label => !label.endsWith("Standard")));
  // GPT: low and high x Standard, Fast, Flex; the duplicate default and malformed tier ids are dropped.
  assert.equal(labelsFor("codex/gpt").length, 6);
  // Effort-less model with a tier: speed-only variants. Plain Claude has neither.
  assert.deepEqual(labelsFor("codex/gpt-2"), ["GPT Two · Standard", "GPT Two · Fast"]);
  assert.deepEqual(labelsFor("claude/claude-plain"), []);
  // Qwen's transport does not honor tiers, so only efforts remain.
  assert.deepEqual(labelsFor("qwen/flash"), ["Qwen Flash · Medium", "Qwen Flash · Max"]);
  assert.ok(variants.filter(row => row.upstream === "qwen/flash").every(row => row.serviceTier === undefined));
  assert.ok(variants.every(row => row.reasoningEffort === undefined || (variantEfforts as readonly string[]).includes(row.reasoningEffort)));
  assert.ok(variants.every(row => row.serviceTier === undefined || ["default", "priority", "flex"].includes(row.serviceTier)));
  const standard = variants.find(row => row.displayName === "GPT One · High · Standard")!;
  assert.deepEqual([standard.reasoningEffort, standard.serviceTier], ["high", "default"]);
  const quick = variants.find(row => row.displayName === "Claude · Opus · High · Fast")!;
  assert.deepEqual([quick.reasoningEffort, quick.serviceTier], ["high", "priority"]);
  assert.ok(variants.every(row => /^claude-hg-route-\d+$/.test(row.id)));
  const profileVariants = (built.profile.inferenceModels as Array<Record<string, unknown>>).slice(originals);
  assert.deepEqual(profileVariants.map(row => [row.name, row.labelOverride]), variants.map(row => [row.id, row.displayName]));
  assert.ok(profileVariants.every(row => Object.keys(row).sort().join() === "labelOverride,name"));
  assert.equal(new Set(built.adapterConfig.models.map(row => row.id)).size, built.adapterConfig.models.length);
});

test("variant routes keep their provider ownership and tool behavior, with stable identifiers", () => {
  const first = buildClaudeDesktopProfile(variantSource, variantCatalog, {}, options);
  const second = buildClaudeDesktopProfile(structuredClone(variantSource), structuredClone(variantCatalog), {}, options);
  assert.deepEqual(second.adapterConfig, first.adapterConfig);
  const models = first.adapterConfig.models as Array<Row & { preserveOptionalToolArguments?: true }>;
  const owned = new Map([["claude/claude-fable-5-1", false], ["codex/gpt", true], ["codex/gpt-2", true], ["qwen/flash", false]]);
  for (const [alias, keep] of owned) {
    const rows = models.filter(row => row.upstream === alias);
    assert.ok(rows.length > 1, alias);
    assert.ok(rows.every(row => Boolean(row.preserveOptionalToolArguments) === keep), alias);
  }
  // Dropping one model's metadata leaves every other variant ID unchanged.
  const trimmed = structuredClone(variantCatalog); delete trimmed.models[2]!.service_tiers;
  const other = buildClaudeDesktopProfile(variantSource, trimmed, {}, options).adapterConfig.models as Row[];
  const claudeIds = (rows: Row[]) => rows.filter(row => row.upstream === "claude/claude-fable-5-1").map(row => row.id);
  assert.deepEqual(claudeIds(other), claudeIds(models));
});

test("primary Claude native rows keep an accurate maxEffort bounded by an existing cap", () => {
  const rowsOf = (built: ReturnType<typeof buildClaudeDesktopProfile>) => built.profile.inferenceModels as Array<Record<string, unknown>>;
  const fresh = rowsOf(buildClaudeDesktopProfile(variantSource, variantCatalog, {}, options));
  assert.equal(fresh.find(row => row.name === "claude-fable-5-1")!.maxEffort, "max");
  assert.equal("maxEffort" in fresh.find(row => row.name === "claude-plain")!, false);
  const cappedBuild = buildClaudeDesktopProfile(variantSource, variantCatalog, { inferenceModels: [{ name: "claude-fable-5-1", maxEffort: "medium" }] }, options);
  const capped = rowsOf(cappedBuild);
  assert.equal(capped.find(row => row.name === "claude-fable-5-1")!.maxEffort, "medium");
  // The same cap bounds the explicit Fast variants, so Fast cannot reach Max when Standard stops at Medium.
  const cappedFast = (cappedBuild.adapterConfig.models as Row[]).filter(row => row.upstream === "claude/claude-fable-5-1" && row.id !== "claude-fable-5-1");
  assert.deepEqual(cappedFast.map(row => [row.reasoningEffort, row.serviceTier]), [["low", "priority"], ["medium", "priority"]]);
  assert.deepEqual(cappedFast.map(row => row.displayName), ["Claude · Opus · Low · Fast", "Claude · Opus · Medium · Fast"]);
  // A primary model without efforts but with a tier still gets a tier-only Fast variant.
  const tierOnly = buildClaudeDesktopProfile(variantSource, { models: variantCatalog.models.map(row => row.slug === "claude/claude-plain" ? { ...row, service_tiers: [fast] } : row) }, {}, options);
  const plainFast = (tierOnly.adapterConfig.models as Row[]).filter(row => row.upstream === "claude/claude-plain" && row.id !== "claude-plain");
  assert.deepEqual(plainFast.map(row => [row.displayName, row.reasoningEffort, row.serviceTier]), [["Claude · Plain · Fast", undefined, "priority"]]);
  const above = rowsOf(buildClaudeDesktopProfile(variantSource, { models: variantCatalog.models.map(row => row.slug === "claude/claude-fable-5-1" ? { ...row, supported_reasoning_levels: ["low", "high"] } : row) }, { inferenceModels: [{ name: "claude-fable-5-1", maxEffort: "max" }] }, options));
  assert.equal(above.find(row => row.name === "claude-fable-5-1")!.maxEffort, "high");
});

function bulkBuild(tiered: number, plain: number) {
  const codex: Record<string, string> = {};
  const rows: Array<Record<string, unknown>> = [{ slug: "claude/claude-fable-5-1", display_name: "Claude Fable 5.1" }];
  const add = (name: string, extra: Record<string, unknown>) => {
    codex[`codex/${name}`] = name;
    rows.push({ slug: `codex/${name}`, display_name: name, ...extra });
  };
  for (let index = 0; index < tiered; index++) add(`t${String(index).padStart(2, "0")}`, { supported_reasoning_levels: [...variantEfforts], service_tiers: [fast] });
  for (let index = 0; index < plain; index++) add(`p${String(index).padStart(2, "0")}`, {});
  const bulk: ClaudeDesktopGatewaySource = {
    port: 3457, stateDirectory: "/private/gateway",
    providers: [
      { id: "claude", type: "claude-subscription", models: { "claude/claude-fable-5-1": "claude-fable-5-1" } },
      { id: "codex", type: "codex-subscription", models: codex },
    ],
  };
  return buildClaudeDesktopProfile(bulk, { models: rows as never }, {}, options);
}

test("allows exactly 200 rows and refuses more instead of dropping choices", () => {
  // One primary row + 18 tiered models x (1 + 5 efforts x Standard/Fast) + one plain model = 200.
  const built = bulkBuild(18, 1);
  assert.equal(built.adapterConfig.models.length, 200);
  assert.equal((built.profile.inferenceModels as unknown[]).length, 200);
  assert.equal(new Set(built.adapterConfig.models.map(row => row.id)).size, 200);
  assert.deepEqual(bulkBuild(18, 1).adapterConfig, built.adapterConfig);
  assert.throws(() => bulkBuild(18, 2), /at most 200 model rows.*needs 201/);
  assert.throws(() => bulkBuild(40, 0), /remove models or service tiers/);
});

const variantEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
