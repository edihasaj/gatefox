import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { handleManagement } from "../app-management.js";
import { loadConfig } from "../config.js";
import { modelCatalog } from "../catalog.js";
import { designatedDefault, nativeModelAlias } from "../model-routing.js";

const dependencies = { lookupCli: async () => true };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-order-")); const path = join(root, "gateway.json"); const state = join(root, "state"); await mkdir(state, { recursive: true });
  const codex = (id: string, label: string, extra: object = {}) => ({ id, label, type: "codex-subscription", credentialFile: join(state, `${id}.json`), models: { [`${id}/gpt-6-luna`]: "gpt-6-luna" }, modelMetadata: { [`${id}/gpt-6-luna`]: { displayName: "Luna" } }, ...extra });
  const config = { version: 1, port: 3457, stateDirectory: state, unknownRoot: { keep: true }, providers: [
    codex("codex", "Codex 2", { defaultForBareModels: true, unknownProvider: { nested: [1, 2] } }),
    { id: "api", label: "API", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", credentialFile: join(state, "api-key"), models: { "api/m": "m" } },
    codex("codex-main", "Codex Main"),
  ] };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const inspect = async () => { const r = await handleManagement({ operation: "inspect", configPath: path }, dependencies); assert.equal(r.ok, true); if (!r.ok) throw new Error("inspect"); return r.result; };
  const raw = async () => JSON.parse(await readFile(path, "utf8"));
  const reorder = async (providerIds: unknown, revision?: string) => handleManagement({ operation: "reorder", configPath: path, providerIds, revision: revision ?? (await inspect()).revision } as never, dependencies);
  return { root, path, config, inspect, raw, reorder, backups: async () => readdir(join(dirname(path), "app-backups")).catch(() => []) };
}

test("reorders connections, persists the order, and preserves every provider object exactly", async () => {
  const f = await fixture(); const before = await f.raw();
  const result = await f.reorder(["codex-main", "codex", "api"]);
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.result.changed, true); assert.deepEqual(result.result.providers?.map(item => item.id), ["codex-main", "codex", "api"]);
  const saved = await f.raw(); assert.deepEqual(saved.providers.map((item: { id: string }) => item.id), ["codex-main", "codex", "api"]);
  for (const provider of before.providers) assert.deepEqual(saved.providers.find((item: { id: string }) => item.id === provider.id), provider);
  assert.deepEqual(saved.unknownRoot, { keep: true });
  assert.equal(result.result.revision, (await f.inspect()).revision); assert.equal((await f.backups()).length, 1);
  assert.deepEqual((await f.inspect()).providers?.map(item => item.id), ["codex-main", "codex", "api"]);
});

test("a no-op order leaves the bytes, revision and backups unchanged", async () => {
  const f = await fixture(); const bytes = await readFile(f.path); const revision = (await f.inspect()).revision;
  const result = await f.reorder(["codex", "api", "codex-main"], revision);
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.result.changed, false); assert.equal(result.result.revision, revision);
  assert.deepEqual(await readFile(f.path), bytes); assert.equal((await f.backups()).length, 0);
});

test("refuses malformed, duplicate, missing, unknown, and extra IDs and a missing or stale revision without writing", async () => {
  const f = await fixture(); const bytes = await readFile(f.path); const revision = (await f.inspect()).revision;
  const bad: unknown[] = [undefined, null, "codex", [], ["codex"], ["codex", "api"], ["codex", "api", "codex"], ["codex", "api", "unknown"], ["codex", "api", "codex-main", "extra"],
    ["codex", "api", 3], ["codex", "api", ""], { 0: "codex" }];
  for (const providerIds of bad) { const result = await f.reorder(providerIds, revision); assert.equal(result.ok, false, JSON.stringify(providerIds)); if (!result.ok) assert.equal(result.error.code, "invalid_request"); }
  const missing = await handleManagement({ operation: "reorder", configPath: f.path, providerIds: ["api", "codex", "codex-main"] }, dependencies);
  assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.error.code, "invalid_request");
  const stale = await f.reorder(["api", "codex", "codex-main"], "stale"); assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "configuration_changed");
  assert.deepEqual(await readFile(f.path), bytes);
});

test("a reviewed revision that changed underneath the order is refused", async () => {
  const f = await fixture(); const revision = (await f.inspect()).revision;
  const renamed = await handleManagement({ operation: "rename", configPath: f.path, providerId: "api", revision, label: "Renamed" }, dependencies); assert.equal(renamed.ok, true);
  const result = await f.reorder(["codex-main", "api", "codex"], revision); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "configuration_changed");
  assert.deepEqual((await f.raw()).providers.map((item: { id: string }) => item.id), ["codex", "api", "codex-main"]);
});

test("a cancelled reorder leaves the original bytes", async () => {
  const f = await fixture(); const bytes = await readFile(f.path); const revision = (await f.inspect()).revision; const control = new AbortController(); control.abort();
  const result = await handleManagement({ operation: "reorder", configPath: f.path, providerIds: ["api", "codex", "codex-main"], revision }, { ...dependencies, signal: control.signal });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "cancelled"); assert.deepEqual(await readFile(f.path), bytes);
});

test("client-only configurations cannot be reordered", async () => {
  const f = await fixture(); await writeFile(f.path, JSON.stringify({ version: 1, port: 1, stateDirectory: f.config.stateDirectory, providers: [], clientOnly: true }), { mode: 0o600 });
  const bytes = await readFile(f.path); const result = await f.reorder([]);
  assert.equal(result.ok, false); assert.deepEqual(await readFile(f.path), bytes);
});

test("the saved order drives the model catalog and keeps the designated bare-model account", async () => {
  const f = await fixture(); const result = await f.reorder(["codex-main", "api", "codex"]); assert.equal(result.ok, true);
  const config = await loadConfig(f.path); assert.deepEqual(config.providers.map(item => item.id), ["codex-main", "api", "codex"]);
  assert.deepEqual(modelCatalog(config).models.map(model => model.slug), ["codex-main/gpt-6-luna", "api/m", "codex/gpt-6-luna"]);
  assert.equal(designatedDefault(config, "codex-subscription")?.id, "codex");
  assert.equal(nativeModelAlias(config, "gpt-6-luna"), "codex/gpt-6-luna");
});
