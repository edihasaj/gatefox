import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../config.js";
import { routeFingerprint } from "../model-refresh.js";
import { modelCatalog } from "../catalog.js";
import { poolConfig } from "./provider-pool-fixture.js";

const ports = [18001, 18002];
const refuses = (patch: (providers: any[]) => void, reason: RegExp) => assert.throws(() => poolConfig("/tmp/provider-pool-config", ports, patch), reason);

test("a pool needs two or more distinct, existing, self-hosted chat providers that are not pools themselves", () => {
  assert.deepEqual(poolConfig("/tmp/provider-pool-config", ports).providers[0].pool, ["qwen-1", "qwen-2"]);
  refuses(p => { p[0].pool = ["qwen-1"]; }, /2 to 8 different/);
  refuses(p => { p[0].pool = "qwen-1"; }, /2 to 8 different/);
  refuses(p => { p[0].pool = ["qwen-1", "qwen-1"]; }, /2 to 8 different/);
  refuses(p => { p[0].pool = ["qwen-1", 2]; }, /2 to 8 different/);
  refuses(p => { p[0].pool = ["qwen-1", "missing"]; }, /another configured provider/);
  refuses(p => { p[0].pool = ["qwen-1", "qwen"]; }, /another configured provider/);
  refuses(p => { p[1].pool = ["qwen-2", "qwen"]; }, /must not be a pool/);
  refuses(p => { p[0].selfHosted = false; }, /only valid on a self-hosted/);
  refuses(p => { p[2].selfHosted = undefined; }, /must be a self-hosted/);
  refuses(p => { p[2].baseUrl = p[1].baseUrl + "/"; }, /different base URLs/);
});

test("a pool can never reach a subscription or a paid API", () => {
  refuses(p => { p[2] = { id: "qwen-2", type: "claude-subscription", models: { "qwen-2/x": "qwen3.8-flash-next" } }; }, /self-hosted/);
  refuses(p => { p[2] = { ...p[2], baseUrl: "https://openrouter.ai/api/v1" }; }, /self-hosted|loopback or tailnet/);
});

test("every member must serve what the pool advertises", () => {
  refuses(p => { p[2].models = { "qwen-2/other": "other" }; p[2].modelMetadata = {}; }, /does not serve/);
  refuses(p => { p[2].modelMetadata["qwen-2/qwen3.8-flash-next"].reasoningEfforts = ["low"]; }, /reasoning effort/);
  refuses(p => { p[2].modelMetadata["qwen-2/qwen3.8-flash-next"].inputModalities = ["text"]; }, /input modality/);
  refuses(p => { p[2].modelMetadata["qwen-2/qwen3.8-flash-next"].contextWindowCap = 131072; }, /smaller context window/);
  refuses(p => { delete p[2].modelMetadata["qwen-2/qwen3.8-flash-next"].contextWindow; }, /smaller context window/);
  refuses(p => { p[2].chatTemplateReasoningEffort = false; }, /same way/);
});

test("one machine belongs to one pool", () => {
  refuses(p => { p.push({ ...structuredClone(p[0]), id: "again", models: { "again/q": "qwen3.8-flash-next" }, modelMetadata: {} }); }, /already belongs/);
});

test("a pool leaves the saved route, its fingerprint and unpooled configurations unchanged", () => {
  const pooled = poolConfig("/tmp/provider-pool-config", ports).providers[0]; const { pool: _pool, ...plain } = pooled;
  assert.equal(routeFingerprint(pooled), routeFingerprint(plain as typeof pooled));
  const without = poolConfig("/tmp/provider-pool-config", ports, p => { delete p[0].pool; });
  assert.equal(Object.hasOwn(without.providers[0], "pool"), false);
  assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(without))).providers.map(p => p.id), ["qwen", "qwen-1", "qwen-2"]);
});

test("the pool and each machine are separate picker rows", () => {
  const rows = modelCatalog(poolConfig("/tmp/provider-pool-config", ports)).models;
  assert.deepEqual(rows.map(row => [row.slug, row.display_name, row.visibility]), [
    ["qwen/qwen3.8-flash-next", "Qwen 3.8 Flash Next", "list"],
    ["qwen-1/qwen3.8-flash-next", "Qwen 1 · Qwen 3.8 Flash Next", "list"],
    ["qwen-2/qwen3.8-flash-next", "Qwen 2 · Qwen 3.8 Flash Next", "list"],
  ]);
});
