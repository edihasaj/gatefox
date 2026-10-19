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
  const extras = adapterConfig.models.slice(2);
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
