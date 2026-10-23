import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { handleManagement } from "../app-management.js";
import { loadConfig } from "../config.js";

const dependencies = { lookupCli: async () => true };

async function fixture(extra: Record<string, unknown> = {}, clientOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "gateway-native-picker-")); const path = join(root, "gateway.json"); const state = join(root, "state"); await mkdir(state, { recursive: true });
  const codex = (id: string, label: string, more: object = {}) => ({ id, label, type: "codex-subscription", credentialFile: join(state, `${id}.json`), models: { [`${id}/gpt-6-luna`]: "gpt-6-luna" }, modelMetadata: { [`${id}/gpt-6-luna`]: { displayName: "Luna" } }, ...more });
  const config = clientOnly
    ? { version: 1, port: 3457, stateDirectory: state, clientOnly: true, providers: [], ...extra }
    : { version: 1, port: 3457, stateDirectory: state, unknownRoot: { keep: true }, nativeModelPicker: ["gpt-6-astra", "gpt-6-luna"], providers: [
        codex("codex", "Codex 2", { defaultForBareModels: true, unknownProvider: { nested: [1, 2] } }),
        { id: "api", label: "API", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", credentialFile: join(state, "api-key"), models: { "api/m": "m" } },
        codex("codex-main", "Codex Main"),
      ], ...extra };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const inspect = async () => { const r = await handleManagement({ operation: "inspect", configPath: path }, dependencies); assert.equal(r.ok, true); if (!r.ok) throw new Error("inspect"); return r.result; };
  const raw = async () => JSON.parse(await readFile(path, "utf8"));
  const set = async (nativeModelPickerPlacement: unknown, revision?: string | null) => handleManagement({ operation: "native-picker", configPath: path, nativeModelPickerPlacement,
    ...(revision === null ? {} : { revision: revision ?? (await inspect()).revision }) } as never, dependencies);
  return { root, path, config, inspect, raw, set, backups: async () => readdir(join(dirname(path), "app-backups")).catch(() => []) };
}

test("inspect reports first when the configuration has no placement and the saved value otherwise; an invalid saved value refuses the whole configuration", async () => {
  const f = await fixture(); assert.equal((await f.inspect()).nativeModelPickerPlacement, "first");
  const g = await fixture({ nativeModelPickerPlacement: "hidden" }); assert.equal((await g.inspect()).nativeModelPickerPlacement, "hidden");
  const h = await fixture({ nativeModelPickerPlacement: "bogus" }); const bytes = await readFile(h.path);
  const refused = await handleManagement({ operation: "inspect", configPath: h.path }, dependencies); assert.equal(refused.ok, false); if (!refused.ok) assert.equal(refused.error.code, "invalid_configuration");
  const save = await handleManagement({ operation: "native-picker", configPath: h.path, nativeModelPickerPlacement: "last", revision: "x" } as never, dependencies); assert.equal(save.ok, false);
  assert.deepEqual(await readFile(h.path), bytes);
});

for (const mode of ["last", "hidden"] as const) {
  test(`saving ${mode} persists it, keeps every other field and provider exactly, and makes a backup`, async () => {
    const f = await fixture(); const before = await f.raw();
    const result = await f.set(mode); assert.equal(result.ok, true); if (!result.ok) return;
    assert.equal(result.result.changed, true); assert.equal(result.result.nativeModelPickerPlacement, mode);
    const saved = await f.raw(); assert.equal(saved.nativeModelPickerPlacement, mode);
    const { nativeModelPickerPlacement: _ignored, ...rest } = saved; assert.deepEqual(rest, before);
    assert.deepEqual(saved.providers.map((item: { id: string }) => item.id), ["codex", "api", "codex-main"]);
    assert.deepEqual(saved.nativeModelPicker, ["gpt-6-astra", "gpt-6-luna"]);
    assert.equal(result.result.revision, (await f.inspect()).revision); assert.equal((await f.backups()).length, 1);
    assert.equal((await f.inspect()).nativeModelPickerPlacement, mode);
    assert.equal((await loadConfig(f.path)).providers.length, 3);
  });
}

test("saving the effective first while the field is absent leaves the bytes, revision and backups unchanged", async () => {
  const f = await fixture(); const bytes = await readFile(f.path); const revision = (await f.inspect()).revision;
  const result = await f.set("first"); assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.result.changed, false); assert.equal(result.result.revision, revision); assert.equal(result.result.nativeModelPickerPlacement, "first");
  assert.deepEqual(await readFile(f.path), bytes); assert.equal((await f.backups()).length, 0);
});

test("saving the placement already stored is a no-op", async () => {
  const f = await fixture({ nativeModelPickerPlacement: "last" }); const bytes = await readFile(f.path);
  const result = await f.set("last"); assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.result.changed, false); assert.deepEqual(await readFile(f.path), bytes); assert.equal((await f.backups()).length, 0);
});

test("choosing first after last writes the explicit value", async () => {
  const f = await fixture({ nativeModelPickerPlacement: "last" });
  const result = await f.set("first"); assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.result.changed, true); assert.equal((await f.raw()).nativeModelPickerPlacement, "first"); assert.equal(result.result.nativeModelPickerPlacement, "first");
});

test("unknown modes are refused without touching the file", async () => {
  const f = await fixture(); const bytes = await readFile(f.path); const revision = (await f.inspect()).revision;
  for (const mode of ["", "LAST", "top", "bottom", " last", null, 1, true, ["last"], { value: "last" }, undefined]) {
    const result = await f.set(mode, revision); assert.equal(result.ok, false, JSON.stringify(mode)); if (!result.ok) assert.equal(result.error.code, "invalid_request");
  }
  assert.deepEqual(await readFile(f.path), bytes); assert.equal((await f.backups()).length, 0);
});

test("a missing, empty, non-string or stale revision is refused", async () => {
  const f = await fixture(); const bytes = await readFile(f.path);
  const missing = await f.set("last", null); assert.equal(missing.ok, false); if (!missing.ok) assert.equal(missing.error.code, "invalid_request");
  const empty = await f.set("last", ""); assert.equal(empty.ok, false); if (!empty.ok) assert.equal(empty.error.code, "invalid_request");
  const wrongType = await handleManagement({ operation: "native-picker", configPath: f.path, nativeModelPickerPlacement: "last", revision: 7 } as never, dependencies);
  assert.equal(wrongType.ok, false); if (!wrongType.ok) assert.equal(wrongType.error.code, "invalid_request");
  const stale = await f.set("last", "stale"); assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "configuration_changed");
  assert.deepEqual(await readFile(f.path), bytes);
});

test("a revision made stale by another writer is refused", async () => {
  const f = await fixture(); const revision = (await f.inspect()).revision;
  await writeFile(f.path, JSON.stringify({ ...(await f.raw()), unknownRoot: { keep: false } }), { mode: 0o600 });
  const bytes = await readFile(f.path); const result = await f.set("last", revision);
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "configuration_changed"); assert.deepEqual(await readFile(f.path), bytes);
});

test("a missing configuration is not found", async () => {
  const f = await fixture(); const result = await handleManagement({ operation: "native-picker", configPath: join(f.root, "other.json"), nativeModelPickerPlacement: "last", revision: "x" } as never, dependencies);
  assert.equal(result.ok, false);
});

test("a cancelled save leaves the original bytes", async () => {
  const f = await fixture(); const bytes = await readFile(f.path); const revision = (await f.inspect()).revision; const control = new AbortController(); control.abort();
  const result = await handleManagement({ operation: "native-picker", configPath: f.path, nativeModelPickerPlacement: "last", revision }, { ...dependencies, signal: control.signal });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "cancelled"); assert.deepEqual(await readFile(f.path), bytes);
});

test("client-only configurations can set their local placement and keep their other fields", async () => {
  const f = await fixture({ unknownRoot: { keep: true } }, true); const before = await f.raw();
  assert.equal((await f.inspect()).nativeModelPickerPlacement, "first");
  const result = await f.set("last"); assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.result.changed, true); assert.equal(result.result.nativeModelPickerPlacement, "last"); assert.deepEqual(result.result.providers, []);
  const saved = await f.raw(); assert.equal(saved.clientOnly, true); assert.deepEqual(saved.providers, []);
  const { nativeModelPickerPlacement: _ignored, ...rest } = saved; assert.deepEqual(rest, before);
});

test("client-only provider reordering stays refused after a native placement save", async () => {
  const f = await fixture({}, true); assert.equal((await f.set("hidden")).ok, true);
  const reorder = await handleManagement({ operation: "reorder", configPath: f.path, providerIds: [], revision: (await f.inspect()).revision } as never, dependencies);
  assert.equal(reorder.ok, false);
});

test("the placement save does not require or change provider order, aliases or defaults", async () => {
  const f = await fixture(); const before = await f.raw(); assert.equal((await f.set("hidden")).ok, true); const saved = await f.raw();
  assert.deepEqual(saved.providers, before.providers); assert.equal(saved.providers[0].defaultForBareModels, true);
});
