import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig, type GatewayConfig } from "../config.js";
import { bridgeRouteName, buildClaudeDesktopProfile, stableRouteNumber } from "../claude-desktop-profile.js";
import { modelCatalog } from "../catalog.js";
import { claudeDirectModelDetail, claudeDirectModelList, claudeDirectPrimary, claudeDirectRequest, claudeDirectSurface, optionalToolsRuntime, restoreOptionalToolCall } from "../claude-direct.js";

const opaque = (alias: string) => `claude-hg-route-${stableRouteNumber(alias)}`;
const efforts = ["low", "medium", "high"];
function config(extra: Array<Record<string, unknown>> = [], claude: Record<string, unknown> = {}): GatewayConfig {
  return validateConfig({ version: 1, port: 3457, stateDirectory: "/tmp/claude-direct-test", providers: [
    { id: "codex", type: "codex-subscription", label: "Codex", credentialFile: "/tmp/claude-direct-test/unused", models: { "codex/gpt": "gpt-x", "codex/old": "gpt-old" },
      modelMetadata: { "codex/gpt": { displayName: "GPT X", contextWindow: 272000, reasoningEfforts: [...efforts, "ultra"], serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }] }, "codex/old": { displayName: "GPT Old", pickerHidden: true } } },
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/claude-fable-5-1": "claude-fable-5-1" }, modelMetadata: { "claude/claude-fable-5-1": { displayName: "Fable 5.1", contextWindow: 1000000, reasoningEfforts: ["low", "high", "max"] } }, ...claude },
    { id: "qwen", type: "chat-completions-api", label: "Local", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_UNUSED_KEY", models: { "qwen/flash": "qwen-flash" } },
    ...extra,
  ] });
}

test("every alias outside the primary Claude account answers to its opaque and bridge IDs", () => {
  const surface = claudeDirectSurface(config());
  assert.equal(surface.degraded, undefined);
  // Catalog order, one row per model: the hidden row is derived but not listed.
  assert.deepEqual(surface.rows.map(row => [row.id, row.alias, row.native, row.listed]), [
    [opaque("codex/gpt"), "codex/gpt", false, true], [opaque("codex/old"), "codex/old", false, false],
    ["claude-fable-5-1", "claude/claude-fable-5-1", true, true], [opaque("qwen/flash"), "qwen/flash", false, true]]);
  const gpt = surface.rows[0]!;
  assert.deepEqual(gpt.efforts, efforts); assert.equal(gpt.bridgeId, bridgeRouteName("codex/gpt")); assert.equal(gpt.contextWindow, 272000);
  // No window is advertised for a row whose window is only the catalog placeholder.
  assert.equal(surface.rows[3]!.contextWindow, undefined); assert.equal(surface.rows[3]!.bridgeId, undefined);
  assert.equal(surface.routes.get(opaque("codex/gpt"))!.upstream, "codex/gpt");
  assert.equal(surface.routes.get(bridgeRouteName("codex/gpt"))!.upstream, "codex/gpt");
  assert.equal(surface.routes.get(opaque("codex/old"))!.upstream, "codex/old");
  // A native Claude ID stays with the gateway's own bare-name routing.
  assert.equal(surface.routes.has("claude-fable-5-1"), false);
  assert.ok([...surface.routes.keys()].every(id => /^claude-(hg-route-\d+|opus-5\[hg-route-\d+\])$/.test(id) && !/gpt|qwen/i.test(id)));
  // The surface is derived once per loaded configuration.
  const loaded = config(); assert.equal(claudeDirectSurface(loaded), claudeDirectSurface(loaded));
});

test("the gateway accepts every ID the adapter accepted for the same configuration", () => {
  const loaded = config();
  const source = { port: 3457, stateDirectory: "/private/state", providers: loaded.providers.map(provider => ({ id: provider.id, type: provider.type, models: provider.models })) };
  const surface = claudeDirectSurface(loaded);
  for (const nativeModelMetadata of [false, true]) {
    const built = buildClaudeDesktopProfile(source, modelCatalog(loaded) as never, {}, { tokenFile: "/private/token", adapterRoot: "/private/adapter", nativeModelMetadata });
    for (const model of built.adapterConfig.models) {
      if (model.id === "claude-fable-5-1") continue;
      const route = surface.routes.get(model.id);
      assert.ok(route, model.id);
      assert.deepEqual([route.upstream, route.reasoningEffort, route.serviceTier, route.supportedEfforts, route.preserveOptionalToolArguments],
        [model.upstream, model.reasoningEffort, model.serviceTier, model.supportedEfforts, model.preserveOptionalToolArguments]);
    }
    // Every picker row names an ID this gateway serves.
    for (const row of built.profile.inferenceModels as Array<{ name: string }>) assert.ok(row.name === "claude-fable-5-1" || surface.routes.has(row.name), row.name);
  }
});

test("only a designated or sole Claude account keeps native IDs", () => {
  const second = { id: "claude-2", type: "claude-subscription", label: "Claude 2", models: { "claude-2/claude-fable-5-1": "claude-fable-5-1" } };
  const ambiguous = config([second]);
  assert.equal(claudeDirectPrimary(ambiguous), undefined);
  const rows = claudeDirectSurface(ambiguous).rows;
  assert.ok(rows.every(row => !row.native));
  assert.deepEqual(rows.filter(row => row.alias.includes("fable")).map(row => row.id), [opaque("claude/claude-fable-5-1"), opaque("claude-2/claude-fable-5-1")]);
  const designated = config([second], { defaultForBareModels: true });
  assert.equal(claudeDirectPrimary(designated)?.id, "claude");
  assert.deepEqual(claudeDirectSurface(designated).rows.filter(row => row.alias.includes("fable")).map(row => row.id), ["claude-fable-5-1", opaque("claude-2/claude-fable-5-1")]);
});

test("the model list is Anthropic-shaped and one model resolves by any of its IDs", () => {
  const surface = claudeDirectSurface(config());
  const list = claudeDirectModelList(surface) as { type: string; has_more: boolean; first_id: string; data: Array<Record<string, any>> };
  assert.equal(list.type, "list"); assert.equal(list.has_more, false); assert.equal(list.first_id, opaque("codex/gpt"));
  assert.deepEqual(list.data.map(row => row.display_name), ["Codex · GPT X", "Claude · Fable 5.1", "Local · qwen-flash"]);
  assert.deepEqual(list.data[0], { id: opaque("codex/gpt"), type: "model", display_name: "Codex · GPT X", created_at: "2026-01-01T00:00:00Z", context_window: 272000,
    gatefox: { alias: "codex/gpt", native: false, efforts, bridge_id: bridgeRouteName("codex/gpt") } });
  assert.deepEqual(list.data[1]!.gatefox, { alias: "claude/claude-fable-5-1", native: true, efforts: ["low", "high", "max"] });
  assert.equal((claudeDirectModelDetail(surface, bridgeRouteName("codex/gpt")) as any).display_name, "Codex · GPT X");
  assert.equal((claudeDirectModelDetail(surface, opaque("codex/old")) as any).id, opaque("codex/old"));
  assert.equal((claudeDirectModelDetail(surface, "claude-fable-5-1") as any).gatefox.native, true);
  assert.equal(claudeDirectModelDetail(surface, "codex/gpt"), undefined);
});

test("a sent effort is clamped to the route and never added", () => {
  const surface = claudeDirectSurface(config());
  const base = { max_tokens: 16, messages: [{ role: "user", content: "hi" }] };
  const clamp = (effort: string | undefined, id = bridgeRouteName("codex/gpt")) => claudeDirectRequest(surface, { ...base, model: id, ...(effort ? { output_config: { effort, format: "kept" } } : {}) })!;
  assert.deepEqual(clamp("max").wire.output_config, { effort: "high", format: "kept" });
  assert.deepEqual(clamp("xhigh", opaque("codex/gpt")).wire.output_config, { effort: "high", format: "kept" });
  assert.deepEqual(clamp("medium").wire.output_config, { effort: "medium", format: "kept" });
  const untouched = clamp(undefined);
  assert.equal(untouched.wire.output_config, undefined); assert.equal(untouched.wire.model, "codex/gpt"); assert.equal(untouched.exposedModel, bridgeRouteName("codex/gpt"));
  // A tool continuation keeps earlier efforts in its system messages.
  const continued = claudeDirectRequest(surface, { ...base, model: opaque("codex/gpt"), messages: [{ role: "system", content: "s", output_config: { effort: "max" } }, { role: "user", content: "hi" }] })!;
  assert.deepEqual((continued.wire.messages as any[])[0].output_config, { effort: "high" });
  // A route with no reasoning levels is left as sent, and an unknown or native ID is not a direct route.
  assert.deepEqual(claudeDirectRequest(surface, { ...base, model: opaque("qwen/flash"), output_config: { effort: "max" } })!.wire.output_config, { effort: "max" });
  assert.equal(claudeDirectRequest(surface, { ...base, model: "claude-fable-5-1" }), undefined);
  assert.equal(claudeDirectRequest(surface, { ...base, model: "codex/gpt" }), undefined);
});

test("a hidden variant alias selects its effort and speed, and an auxiliary review keeps its own controls", () => {
  const surface = claudeDirectSurface(config());
  const variant = [...surface.routes.values()].find(route => route.upstream === "codex/gpt" && route.reasoningEffort === "low" && route.serviceTier === "priority")!;
  assert.ok(variant);
  const wire = { model: variant.id, max_tokens: 16, thinking: { type: "disabled" }, output_config: { effort: "high" },
    messages: [{ role: "system", content: "s", output_config: { effort: "max" } }, { role: "system", content: "no effort" }, { role: "user", content: "hi" }] };
  const selected = claudeDirectRequest(surface, wire)!;
  assert.deepEqual(selected.wire.output_config, { effort: "low" }); assert.equal(selected.wire.service_tier, "priority");
  assert.deepEqual(selected.wire.thinking, { type: "adaptive" });
  assert.deepEqual((selected.wire.messages as any[]).map(message => message.output_config), [{ effort: "low" }, undefined, undefined]);
  // The caller's request object is never changed.
  assert.deepEqual(wire.output_config, { effort: "high" }); assert.equal(wire.model, variant.id);
  // The app names a bridge row by its base ID in its own checks, so the review is recognized under that ID.
  const seen: unknown[] = [];
  const review = claudeDirectRequest(surface, { model: bridgeRouteName("codex/gpt"), max_tokens: 16, output_config: { effort: "max" }, messages: [] }, payload => { seen.push((payload as any).model); return true; })!;
  assert.deepEqual(seen, ["claude-opus-5"]);
  assert.deepEqual(review.wire.output_config, { effort: "max" }); assert.equal(review.wire.model, "codex/gpt");
  const auxiliaryVariant = claudeDirectRequest(surface, wire, () => true)!;
  assert.deepEqual(auxiliaryVariant.wire.output_config, { effort: "high" }); assert.equal(auxiliaryVariant.wire.service_tier, undefined);
});

test("a catalog too large for the hidden aliases keeps its picker rows", () => {
  const models: Record<string, string> = {}; const modelMetadata: Record<string, unknown> = {};
  for (let index = 0; index < 120; index++) { models[`big/m${index}`] = `m${index}`; modelMetadata[`big/m${index}`] = { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }] }; }
  const surface = claudeDirectSurface(config([{ id: "big", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "TEST_UNUSED_KEY", models, modelMetadata }]));
  assert.equal(surface.degraded, "variants");
  assert.equal(surface.rows.length, 124);
  assert.equal(surface.routes.get(bridgeRouteName("big/m7"))!.upstream, "big/m7");
  assert.ok([...surface.routes.values()].every(route => route.reasoningEffort === undefined && route.serviceTier === undefined));
});

test("a returned tool call loses only the nulls its converted schema introduced", async () => {
  const runtime = await optionalToolsRuntime();
  const prepared = runtime.prepareOptionalToolArguments({ tools: [{ name: "read", input_schema: { type: "object", required: ["path"], properties: { path: { type: "string" }, limit: { type: "integer" }, note: { type: ["string", "null"] } } } }] });
  assert.equal(prepared.plans.size, 1);
  const call = (name: string, value: unknown) => ({ type: "function" as const, id: "call_1", function: { name, arguments: typeof value === "string" ? value : JSON.stringify(value) } });
  assert.equal(restoreOptionalToolCall(call("read", { path: "a", limit: null, note: null }), prepared.plans, runtime).function.arguments, JSON.stringify({ path: "a", note: null }));
  const kept = call("read", { path: "a", limit: 2 });
  assert.equal(restoreOptionalToolCall(kept, prepared.plans, runtime), kept);
  const other = call("write", { limit: null }); assert.equal(restoreOptionalToolCall(other, prepared.plans, runtime), other);
  const unreadable = call("read", "{"); assert.equal(restoreOptionalToolCall(unreadable, prepared.plans, runtime), unreadable);
  // The Messages tool name is the one the plan knows, even when the provider call carries a transport name.
  const renamed = { ...call("transport_name", { path: "a", limit: null }), responseTool: { type: "function" as const, name: "read" } };
  assert.equal(restoreOptionalToolCall(renamed, prepared.plans, runtime).function.arguments, JSON.stringify({ path: "a" }));
});
