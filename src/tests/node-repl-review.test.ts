import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCatalog } from "../catalog.js";
import { apiKeyReviewModel, nativeReviewModel, noReviewRoute, reviewRoute, reviewerCanRun, withReviewerPolicy } from "../codex-native-rows.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { gatewayToken, type GatewayConfig, type ProviderConfig } from "../config.js";
import { nativeModelAlias, startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";

type Row = Record<string, unknown>;
const codex = (id: string, models: Record<string, string>): ProviderConfig => ({ id, type: "codex-subscription", models, modelMetadata: Object.fromEntries(Object.keys(models).map(alias => [alias, { reasoningEfforts: ["low"] }])) });
const config = (...providers: ProviderConfig[]) => ({ version: 1, port: 0, stateDirectory: ".", providers } as unknown as GatewayConfig);
const natives = (...slugs: string[]): Row[] => slugs.map(slug => ({ slug, supported_in_api: true }));
const route = (native: Row[], ...providers: ProviderConfig[]) => reviewRoute(native, modelCatalog(config(...providers)).models);
const reviewerText = { instructions_template: "", auto_review: { node_repl_policy: "native reviewer text", policy: "native policy" } };

test("under API-key auth the SDK's reviewer is gpt-5.6-luna, not the ChatGPT-auth reviewer codex-auto-review", () => {
  // Source: model-provider approval_review_preferred_model() in the pinned SDK; the gateway SDK binary carries both names.
  assert.equal(apiKeyReviewModel, "gpt-5.6-luna");
  assert.equal(nativeReviewModel, "codex-auto-review");
});

test("the review route agrees with the gateway's own routing of a bare model name", () => {
  const single = [codex("a", { "codex/luna": "gpt-5.6-luna" })];
  const twice = [codex("a", { "codex/luna": "gpt-5.6-luna" }), codex("b", { "codex-b/luna": "gpt-5.6-luna" })];
  const exact = [codex("a", { "gpt-5.6-luna": "gpt-5.6-luna", "codex/other": "gpt-5.6-luna" })];
  const none = [codex("a", { "codex/sol": "gpt-6.1-sol" })];
  const claudeOnly = [{ id: "c", type: "claude-subscription", models: { "claude/opus": "claude-opus-5" } } as ProviderConfig];
  const odd = [codex("a", { "codex/odd": "my-model" })];
  const all = ["gpt-5.6-luna", "gpt-6.1-sol", "codex-auto-review", "my-model", "claude-opus-5"];
  for (const providers of [single, twice, exact, none, claudeOnly, odd, []]) {
    const served = route(natives(...all), ...providers);
    for (const model of all) {
      const alias = nativeModelAlias(config(...providers), model);
      const direct = providers.some(provider => Object.hasOwn(provider.models, model));
      // Claude names are served by the Claude subscription, which this OpenAI-side route does not offer as a reviewer.
      const expected = model.startsWith("claude-") ? false : direct || alias !== undefined;
      assert.equal(served(model), expected, `${model} with ${providers.map(provider => Object.keys(provider.models)).join("|")}`);
    }
  }
});

test("a reviewer must be offered in the executor catalog as well as served", () => {
  const providers = [codex("a", { "codex/luna": "gpt-5.6-luna" })];
  assert.equal(route(natives("gpt-5.6-luna"), ...providers)("gpt-5.6-luna"), true);
  assert.equal(route(natives("gpt-6.1-sol"), ...providers)("gpt-5.6-luna"), false, "not in the catalog: the SDK would fall back to the parent model");
  assert.equal(route([{ slug: "gpt-5.6-luna", supported_in_api: false }], ...providers)("gpt-5.6-luna"), false, "a row hidden from API-key auth is not offered");
  assert.equal(noReviewRoute("gpt-5.6-luna"), false);
});

test("reviewerCanRun follows the override, else the API-key reviewer", () => {
  const only = (model: string) => (name: string) => name === model;
  assert.equal(reviewerCanRun({}, only("gpt-5.6-luna")), true);
  assert.equal(reviewerCanRun({ auto_review_model_override: null }, only("gpt-5.6-luna")), true);
  assert.equal(reviewerCanRun({ auto_review_model_override: "gpt-6-luna" }, only("gpt-5.6-luna")), false);
  assert.equal(reviewerCanRun({ auto_review_model_override: "gpt-6-luna" }, only("gpt-6-luna")), true);
  assert.equal(reviewerCanRun({ auto_review_model_override: 7 }, () => true), false);
  assert.equal(reviewerCanRun({}, noReviewRoute), false);
});

test("a reviewer row without the node_repl review text gets the native reviewer's, and nothing else changes", () => {
  const donor: Row = { slug: "codex-auto-review", visibility: "hide", model_messages: reviewerText };
  const luna: Row = { slug: "gpt-5.6-luna", model_messages: { instructions_template: "luna prompt", auto_review: { policy: "luna policy" } } };
  const sol: Row = { slug: "gpt-6.1-sol", model_messages: { instructions_template: "sol prompt" } };
  const before = structuredClone([donor, luna, sol]);
  const [donor2, luna2, sol2] = withReviewerPolicy([donor, luna, sol]);
  assert.deepEqual(luna2, { ...luna, model_messages: { instructions_template: "luna prompt", auto_review: { policy: "luna policy", node_repl_policy: "native reviewer text" } } });
  assert.equal(donor2, donor); assert.equal(sol2, sol, "only reviewer rows change");
  assert.deepEqual([donor, luna, sol], before, "the native rows are never modified");
  // A row that states its own text, even an empty one, keeps it; so does a row that cannot hold the text.
  const own: Row = { slug: "gpt-5.6-luna", model_messages: { instructions_template: "", auto_review: { node_repl_policy: "" } } };
  assert.equal(withReviewerPolicy([donor, own])[1], own);
  const noMessages: Row = { slug: "gpt-5.6-luna" }; const oddReview: Row = { slug: "gpt-5.6-luna", model_messages: { instructions_template: "", auto_review: "x" } };
  assert.equal(withReviewerPolicy([donor, noMessages])[1], noMessages, "an SDK row needs its instructions_template, which is never invented");
  assert.equal(withReviewerPolicy([donor, oddReview])[1], oddReview);
  // An override names another reviewer row, which is filled the same way.
  const other: Row = { slug: "gpt-6-luna", model_messages: { instructions_template: "" } };
  const caller: Row = { slug: "gpt-6.1-sol", auto_review_model_override: "gpt-6-luna", model_messages: { instructions_template: "" } };
  assert.equal((withReviewerPolicy([donor, other, caller])[1].model_messages as Row).auto_review !== undefined, true);
  // Without a native reviewer, or with one that has no text, there is nothing to copy.
  assert.deepEqual(withReviewerPolicy([luna, sol]), [luna, sol]);
  assert.deepEqual(withReviewerPolicy([{ slug: "codex-auto-review", model_messages: { instructions_template: "", auto_review: { node_repl_policy: "" } } }, luna])[1], luna);
});

test("combined() gives the reviewer row the native review text, and a new reviewer alias starts a new generation", () => {
  const donor: Row = { slug: "codex-auto-review", visibility: "hide", model_messages: reviewerText };
  const luna: Row = { slug: "gpt-5.6-luna", model_messages: { instructions_template: "luna prompt" } };
  const sol: Row = { slug: "gpt-6.1-sol", node_repl_disabled: false, node_repl_auto_review_required: true, model_messages: { instructions_template: "sol prompt" } };
  for (const codeMode of [true, false]) {
    const without = new DesktopCatalog(config(codex("a", { "codex/sol": "gpt-6.1-sol" })), [donor, luna, sol], "unused", codeMode);
    const served = new DesktopCatalog(config(codex("a", { "codex/sol": "gpt-6.1-sol", "codex/luna": "gpt-5.6-luna" })), [donor, luna, sol], "unused", codeMode);
    const row = (catalog: DesktopCatalog, slug: string) => catalog.combined().models.find(entry => entry.slug === slug)!;
    assert.deepEqual((row(without, "gpt-5.6-luna").model_messages as Row).auto_review, { node_repl_policy: "native reviewer text" });
    assert.equal((row(without, "codex-auto-review").model_messages as Row).auto_review, reviewerText.auto_review);
    assert.deepEqual([row(without, "gpt-6.1-sol").node_repl_disabled, row(served, "gpt-6.1-sol").node_repl_disabled], [true, false]);
    assert.equal((luna.model_messages as Row).auto_review, undefined, "the native rows are never modified");
    assert.notEqual(without.current().revision, served.current().revision, "a catalog change that moves the native rows starts a new generation");
  }
});

test("the gateway serves the SDK's API-key reviewer through the one Codex alias, and does not answer the ChatGPT-auth reviewer", async () => {
  const live = config(codex("codex", { "codex/gpt-6.1-sol": "gpt-6.1-sol", "codex/gpt-5.6-luna": "gpt-5.6-luna" }));
  assert.equal(nativeModelAlias(live, apiKeyReviewModel), "codex/gpt-5.6-luna");
  assert.equal(nativeModelAlias(live, nativeReviewModel), undefined);
  const directory = await mkdtemp(join(tmpdir(), "gateway-reviewer-"));
  const seen: string[] = [];
  const provider: Provider = { async *infer(request) { seen.push(String(request.model)); yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; } };
  const server = await startGateway({ ...live, stateDirectory: directory, providers: live.providers.map(entry => ({ ...entry, credentialFile: "unused" })) }, () => provider);
  try {
    const ask = async (model: string) => (await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, input: "review" }),
    })).status;
    assert.equal(await ask(apiKeyReviewModel), 200);
    assert.deepEqual(seen, ["gpt-5.6-luna"], "the request reaches the Codex route for gpt-5.6-luna");
    assert.equal(await ask(nativeReviewModel), 404);
    // The route computed from the published catalog says the same.
    const served = route(natives("gpt-5.6-luna"), ...live.providers);
    assert.deepEqual([served(apiKeyReviewModel), served(nativeReviewModel)], [true, false]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
