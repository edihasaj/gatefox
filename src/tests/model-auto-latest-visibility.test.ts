import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiscoveredModels, modelCatalog } from "../catalog.js";
import { gatewayInfoPayload, maximumGatewayInfoModels } from "../gateway-info.js";
import { gatewayModelList } from "../app-server-model-list.js";
import { gatewayToken, type GatewayConfig, type ModelMetadata, type ProviderConfig } from "../config.js";
import { nativeClaudeModels } from "../providers/claude-models.js";
import { nativeCopilotModels } from "../providers/copilot-models.js";
import { adoptGatewayHandler, createGatewayHandler } from "../server.js";
import { maximumReleasedAt, minimumReleasedAt, normalizeReleasedAt, pickerHiddenAliases, releasedAtMetadata } from "../model-auto-latest/metadata.js";

type ObjectValue = Record<string, unknown>;
const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
// `pickerHidden` is the backend's metadata field; cast so this file compiles on either side of that type change.
const hiddenMetadata = { displayName: "Old", pickerHidden: true } as unknown as ModelMetadata;
const visibleMetadata = { displayName: "New" } as ModelMetadata;

function config(directory = "/tmp/hg-unused"): GatewayConfig {
  return { version: 1, port: 0, stateDirectory: directory, providers: [
    { id: "claude", type: "claude-subscription", label: "Claude", models: { "claude/new": "claude-new", "claude/old": "claude-old" }, modelMetadata: { "claude/new": visibleMetadata, "claude/old": hiddenMetadata } },
    { id: "other", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", apiKeyEnv: "UNUSED_KEY", models: { "other/model": "model" } },
  ] };
}

// --- Release timestamps ----------------------------------------------------------------------------------------------

test("releasedAt normalizes ISO dates, offsets, epoch seconds and milliseconds to UTC seconds", () => {
  const expected = Date.UTC(2026, 5, 15) / 1000;
  assert.equal(normalizeReleasedAt("2026-06-15"), expected);
  assert.equal(normalizeReleasedAt("2026-06-15T00:00:00Z"), expected);
  assert.equal(normalizeReleasedAt("2026-06-15T02:00:00+02:00"), expected);
  assert.equal(normalizeReleasedAt("2026-06-14T19:00:00-05:00"), expected);
  assert.equal(normalizeReleasedAt("2026-06-15T00:00:00"), expected, "a time without an offset is UTC");
  assert.equal(normalizeReleasedAt("2026-06-15T00:00:00.123Z"), expected);
  assert.equal(normalizeReleasedAt(expected), expected);
  assert.equal(normalizeReleasedAt(expected * 1000), expected);
  assert.equal(normalizeReleasedAt(String(expected)), expected);
});

test("releasedAt refuses impossible dates, text, and values outside 2010 through 2100", () => {
  for (const value of ["2026-02-31", "2026-13-01", "2026-06-15T25:00:00Z", "2026-06-15T00:61:00Z", "June 15", "", "  ", "2026-06-15T00:00:00+24:00",
    "1999-12-31", "2009-12-31T23:59:59Z", "2100-01-01", "2100-01-01T00:00:00Z", 0, -5, 1, 1e18, Number.NaN, Infinity, 4102444800, true, null, undefined, {}, [], "9".repeat(60)]) {
    assert.equal(normalizeReleasedAt(value), undefined, String(value));
  }
  assert.equal(normalizeReleasedAt("2010-01-01"), minimumReleasedAt);
  assert.equal(normalizeReleasedAt(maximumReleasedAt - 1), maximumReleasedAt - 1);
});

test("releasedAt reads explicit release fields only: never created, creation or first-seen times", () => {
  const released = Date.UTC(2026, 0, 2) / 1000; const created = Date.UTC(2025, 0, 2) / 1000;
  assert.deepEqual(releasedAtMetadata({ released_at: "2026-01-02", created }), { releasedAt: released });
  assert.deepEqual(releasedAtMetadata({ release_date: "2026-01-02" }), { releasedAt: released });
  assert.deepEqual(releasedAtMetadata({ releasedAt: released * 1000 }), { releasedAt: released });
  assert.deepEqual(releasedAtMetadata({ released_at: "not a date", release_date: "2026-01-02" }), { releasedAt: released }, "an unusable explicit field falls through to the next explicit one");
  assert.deepEqual(releasedAtMetadata({ created }), {}, "OpenAI's created is creation time, not release");
  assert.deepEqual(releasedAtMetadata({ created_at: created, createdAt: created }), {});
  assert.deepEqual(releasedAtMetadata({ first_seen: created, firstSeen: created, firstSeenAt: created, discovered_at: created }), {});
  for (const row of [null, undefined, "2026-01-02", [], 7]) assert.deepEqual(releasedAtMetadata(row), {});
});

test("discovery carries releasedAt from Claude and Copilot rows only when they declare one", () => {
  const released = Date.UTC(2026, 3, 1) / 1000;
  const claude = nativeClaudeModels([{ value: "claude-new", displayName: "New", release_date: "2026-04-01" }, { value: "claude-old", displayName: "Old" }]);
  assert.equal((claude[0].metadata as ObjectValue).releasedAt, released);
  assert.equal(Object.hasOwn(claude[1].metadata, "releasedAt"), false);
  const copilot = nativeCopilotModels([{ id: "m1", name: "One", released_at: "2026-04-01T00:00:00Z" }, { id: "m2", name: "Two" }]);
  assert.equal((copilot[0].metadata as ObjectValue).releasedAt, released);
  assert.equal(Object.hasOwn(copilot[1].metadata, "releasedAt"), false);
});

test("a refresh keeps a model's picker visibility and never marks a rediscovered model hidden", () => {
  const provider: ProviderConfig = { id: "claude", type: "claude-subscription", models: { saved: "claude-old", fresh: "claude-new" }, modelMetadata: { saved: hiddenMetadata } };
  loadDiscoveredModels(provider, [{ model: "claude-old", metadata: { displayName: "Old" } }, { model: "claude-new", metadata: { displayName: "New" } }]);
  const hidden = pickerHiddenAliases({ providers: [provider] });
  assert.equal(hidden.has("saved"), true, "the existing hidden mark survives a merge");
  assert.equal(hidden.has("fresh"), false, "a new model is never hidden by discovery");
  assert.equal(hidden.has("claude/claude-new"), false);
});

// --- Catalog, lists and disclosure -----------------------------------------------------------------------------------

test("modelCatalog marks a row hide exactly when its metadata hides it from the picker, and keeps every row", () => {
  const rows = modelCatalog(config()).models;
  assert.deepEqual(rows.map(row => [row.slug, row.visibility]), [["claude/new", "list"], ["claude/old", "hide"], ["other/model", "list"]]);
});

test("the app model list omits hidden gateway rows, returns them hidden under includeHidden, and pages after filtering", async () => {
  const extras = modelCatalog(config()).models;
  const native = [{ id: "gpt-a", model: "gpt-a", hidden: false, isDefault: false }, { id: "gpt-b", model: "gpt-b", hidden: false, isDefault: false }];
  const backend = async () => ({ data: native, nextCursor: null });
  const none = new Set<string>();
  const normal = await gatewayModelList({}, backend, none, extras, undefined);
  assert.deepEqual((normal.data as ObjectValue[]).map(row => [row.model, row.hidden]), [["gpt-a", false], ["gpt-b", false], ["claude/new", false], ["other/model", false]]);
  const all = await gatewayModelList({ includeHidden: true }, backend, none, extras, undefined);
  assert.deepEqual((all.data as ObjectValue[]).map(row => [row.model, row.hidden]), [["gpt-a", false], ["gpt-b", false], ["claude/new", false], ["claude/old", true], ["other/model", false]]);
  const first = await gatewayModelList({ limit: 3 }, backend, none, extras, undefined);
  assert.deepEqual((first.data as ObjectValue[]).map(row => row.model), ["gpt-a", "gpt-b", "claude/new"]);
  assert.equal(first.nextCursor, "gateway-models:3");
  const second = await gatewayModelList({ limit: 3, cursor: first.nextCursor }, backend, none, extras, undefined);
  assert.deepEqual((second.data as ObjectValue[]).map(row => row.model), ["other/model"]);
  assert.equal(second.nextCursor, null);
  const last = await gatewayModelList({}, backend, none, extras, undefined, ["gpt-a"], "last");
  assert.deepEqual((last.data as ObjectValue[]).map(row => row.model), ["claude/new", "other/model", "gpt-a"]);
  const hiddenPlacement = await gatewayModelList({ includeHidden: true }, backend, none, extras, undefined, ["gpt-a"], "hidden");
  assert.deepEqual((hiddenPlacement.data as ObjectValue[]).map(row => [row.model, row.hidden]), [["gpt-a", true], ["gpt-b", true], ["claude/new", false], ["claude/old", true], ["other/model", false]]);
});

test("a hidden gateway row is not the default in a normal list", async () => {
  const extras = modelCatalog(config()).models;
  const backend = async () => ({ data: [], nextCursor: null });
  const normal = await gatewayModelList({}, backend, new Set<string>(), extras, "claude/old");
  assert.ok((normal.data as ObjectValue[]).every(row => row.isDefault === false));
  const all = await gatewayModelList({ includeHidden: true }, backend, new Set<string>(), extras, "claude/old");
  assert.deepEqual((all.data as ObjectValue[]).filter(row => row.isDefault).map(row => row.model), ["claude/old"]);
});

test("gateway-info omits picker-hidden models and counts only listed ones against its bound", () => {
  const info = gatewayInfoPayload(config(), "host");
  assert.deepEqual(info?.providers.map(provider => provider.models.map(model => model.id)), [["claude/new"], ["other/model"]]);
  const many: GatewayConfig = { ...config(), providers: [{ id: "claude", type: "claude-subscription", models: {}, modelMetadata: {} }] };
  for (let index = 0; index < maximumGatewayInfoModels + 20; index++) {
    many.providers[0].models[`claude/m${index}`] = `m${index}`;
    if (index >= 10) many.providers[0].modelMetadata![`claude/m${index}`] = hiddenMetadata;
  }
  assert.equal(gatewayInfoPayload(many, "host")?.providers[0].models.length, 10);
});

test("/v1/models and gateway-info hide old models, the full catalog keeps them, and an explicit request still routes", { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "gateway-hidden-visibility-"));
  const models: string[] = [];
  const handler = await createGatewayHandler(config(directory), () => ({ async *infer(request: { model: string }) { models.push(request.model); yield { type: "text", text: "ok" }; yield { type: "done", usage }; } }));
  // Close through the gateway's drain so usage writes finish before the fixture directory is removed.
  const server = adoptGatewayHandler(createServer(), handler); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" };
  try {
    const listed = await (await fetch(`${base}/v1/models`, { headers })).json() as { data: Array<{ id: string }> };
    assert.deepEqual(listed.data.map(model => model.id), ["claude/new", "other/model"]);
    const info = await (await fetch(`${base}/v1/gateway-info`, { headers })).json() as { providers: Array<{ models: Array<{ id: string }> }> };
    assert.deepEqual(info.providers.flatMap(provider => provider.models.map(model => model.id)), ["claude/new", "other/model"]);
    const catalog = await (await fetch(`${base}/v1/model-catalog`, { headers })).json() as { models: Array<{ slug: string; visibility: string }> };
    assert.deepEqual(catalog.models.map(model => [model.slug, model.visibility]), [["claude/new", "list"], ["claude/old", "hide"], ["other/model", "list"]]);
    const response = await fetch(`${base}/v1/responses`, { method: "POST", headers, body: JSON.stringify({ model: "claude/old", input: "hi", stream: true }) });
    await response.text();
    assert.equal(response.status, 200, "an explicit request for a hidden model is routed");
    assert.deepEqual(models, ["claude-old"]);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
