import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredModel } from "../catalog.js";
import type { ProviderConfig } from "../config.js";
import { reconcileAutoLatest, setAutoLatest } from "../model-auto-latest/engine.js";

// Integration tests for the auto-latest engine against private configuration fixtures. Model metadata is mocked; no
// network, no inference, no real native engine or login is used. Pure family/date rules are covered in
// model-auto-latest-families.test.ts, so this file only exercises the engine's decisions and its write safety.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Record<string, any>;
const NOW = Date.UTC(2026, 9, 24, 12);
const seconds = (year: number, month: number, day: number): number => Date.UTC(year, month - 1, day) / 1000;
const codexIds = ["gpt-6.1-sol", "gpt-5.6-terra"];
const claudeIds = ["claude-opus-5-5"];
const nativeDefault = ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-terra", "gpt-6-luna"];

const rows = (ids: string[], dates: Record<string, number> = {}): DiscoveredModel[] => ids.map(model => ({
  model, metadata: { displayName: model, contextWindow: 32768, reasoningEfforts: ["low", "high"], ...(dates[model] ? { releasedAt: dates[model] } : {}) },
}) as unknown as DiscoveredModel);

function route(id: string, type: string, ids: string[], state: string): Raw {
  return { id, label: id, type, ...(type === "codex-subscription" ? { credentialFile: join(state, `${id}.json`), defaultForBareModels: true } : { unknownProvider: { keep: [1] } }),
    models: Object.fromEntries(ids.map(model => [`${id}/${model}`, model])),
    modelMetadata: Object.fromEntries(ids.map(model => [`${id}/${model}`, { displayName: model, contextWindow: 32768, reasoningEfforts: ["low", "high"] }])) };
}

type Catalog = Record<string, DiscoveredModel[]>;
function source(initial: Catalog) {
  const state = { catalog: initial as Record<string, unknown>, gate: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined, calls: [] as string[] };
  const discover = async (provider: ProviderConfig): Promise<DiscoveredModel[]> => {
    state.calls.push(provider.id); state.entered?.();
    await state.gate;
    const found = state.catalog[provider.id];
    if (found === undefined) throw new Error("catalog unavailable");
    return found as DiscoveredModel[];
  };
  const hold = () => {
    let release!: () => void; let enter!: () => void;
    state.gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; }); state.entered = enter;
    return { entered, release: () => { state.gate = undefined; release(); } };
  };
  return { discover, state, hold, set: (catalog: Record<string, unknown>) => { state.catalog = catalog; } };
}
type Source = ReturnType<typeof source>;

async function fixture(nativeIds = nativeDefault) {
  const root = await mkdtemp(join(tmpdir(), "gateway-auto-latest-"));
  const state = join(root, "state"), native = join(root, "native"), path = join(root, "gateway.json");
  await mkdir(state, { mode: 0o700 }); await mkdir(native, { mode: 0o700 });
  const original: Raw = { version: 1, port: 0, stateDirectory: state, nativeModelPicker: nativeIds, nativeModelPickerPlacement: "last", unknownRoot: { preserve: true },
    providers: [route("codex", "codex-subscription", codexIds, state), route("claude", "claude-subscription", claudeIds, state)] };
  await writeFile(path, JSON.stringify(original) + "\n", { mode: 0o600 });
  const writeNative = (ids: Array<string | { slug: string; visibility: string }>) => writeFile(join(native, "models_cache.json"),
    JSON.stringify({ models: ids.map(item => typeof item === "string" ? { slug: item, visibility: "list" } : item), fetched_at: new Date(NOW).toISOString() }), { mode: 0o600 });
  await writeNative(nativeIds);
  await writeFile(join(native, "auth.json"), "native-auth-sentinel\n", { mode: 0o600 });
  await writeFile(join(native, "config.toml"), 'model = "gpt-6-astra"\n', { mode: 0o600 });
  const nativeFiles = async () => Promise.all(["auth.json", "config.toml"].map(name => readFile(join(native, name), "utf8")));
  const sentinels = await nativeFiles();
  return { root, state, native, path, original, writeNative, sentinels, nativeFiles,
    bytes: () => readFile(path), raw: async (): Promise<Raw> => JSON.parse(await readFile(path, "utf8")),
    revision: async () => createHash("sha256").update(await readFile(path)).digest("hex") };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const deps = (s: Source, f: Fixture, extra: object = {}) => ({ discoverModels: s.discover, nativeHome: f.native, now: () => NOW, ...extra });
const enable = async (f: Fixture, s: Source, extra: object = {}) => setAutoLatest(f.path, true, await f.revision(), deps(s, f, extra));
const check = (f: Fixture, s: Source, extra: object = {}) => reconcileAutoLatest(f.path, deps(s, f, extra));
const routes = (raw: Raw, id: string): Record<string, string> => raw.providers.find((item: Raw) => item.id === id).models;
const provider = (raw: Raw, id: string): Raw => raw.providers.find((item: Raw) => item.id === id);
const base = (): Catalog => ({ codex: rows(codexIds), claude: rows(claudeIds) });
const settle = () => new Promise(resolve => setTimeout(resolve, 50));

test("enabling captures the selected families and baseline without changing any selection, picker or setting", async () => {
  const f = await fixture();
  const s = source({ codex: rows([...codexIds, "gpt-6.2-sol", "gpt-7-luna"]), claude: rows([...claudeIds, "claude-opus-5-6"]) });
  await enable(f, s);
  const after = await f.raw();
  assert.deepEqual(after.providers, f.original.providers, "every route, metadata object and unknown field is preserved");
  assert.deepEqual(after.nativeModelPicker, nativeDefault); assert.equal(after.nativeModelPickerPlacement, "last"); assert.deepEqual(after.unknownRoot, { preserve: true });
  const settings = after.autoLatestModels;
  assert.equal(settings.enabled, true);
  assert.deepEqual([...settings.providers.codex.families].sort(), ["gpt-sol", "gpt-terra"]);
  assert.deepEqual(settings.providers.claude.families, ["claude-opus"]);
  assert.deepEqual([...settings.native.families].sort(), ["gpt-astra", "gpt-luna", "gpt-sol", "gpt-terra"]);
  for (const id of [...codexIds, "gpt-6.2-sol"]) assert.ok(settings.providers.codex.baselineModels.includes(id), `${id} is in the baseline`);
  assert.ok(settings.providers.claude.baselineModels.includes("claude-opus-5-6"));
  assert.equal(settings.providers.codex.baselineModels.includes("gpt-7-luna"), false, "an unwatched family is never a candidate");
  assert.deepEqual(await f.nativeFiles(), f.sentinels);
});

test("a higher model that was already known when the switch was enabled stays off", async () => {
  const f = await fixture();
  const s = source({ codex: rows([...codexIds, "gpt-6.2-sol"]), claude: rows(claudeIds) });
  await enable(f, s);
  const enabled = await f.bytes();
  const result = await check(f, s);
  assert.equal(result.outcome, "unchanged"); assert.equal(result.changed, false); assert.equal(result.activated, 0);
  assert.deepEqual(await f.bytes(), enabled);
  assert.equal(Object.values(routes(await f.raw(), "codex")).includes("gpt-6.2-sol"), false);
});

test("a new model in a watched family gets a new alias; the old route stays but is hidden from the picker", async () => {
  const f = await fixture(); const s = source(base());
  await enable(f, s);
  s.set({ codex: rows([...codexIds, "gpt-6.2-sol"]), claude: rows(claudeIds) });
  const result = await check(f, s);
  assert.equal(result.outcome, "updated"); assert.equal(result.changed, true); assert.ok(result.activated >= 1); assert.equal(result.providersFailed, 0);
  const after = await f.raw(); const codex = provider(after, "codex");
  assert.equal(codex.models["codex/gpt-6.2-sol"], "gpt-6.2-sol", "a new version-specific alias");
  assert.equal(codex.models["codex/gpt-6.1-sol"], "gpt-6.1-sol", "the old alias is never rebound or removed");
  assert.equal(codex.modelMetadata["codex/gpt-6.1-sol"].pickerHidden, true);
  assert.notEqual(codex.modelMetadata["codex/gpt-6.2-sol"]?.pickerHidden, true);
  assert.equal(codex.models["codex/gpt-5.6-terra"], "gpt-5.6-terra"); assert.notEqual(codex.modelMetadata["codex/gpt-5.6-terra"].pickerHidden, true);
  // Nothing about the account, defaults, other providers or unknown settings moves.
  assert.equal(codex.defaultForBareModels, true); assert.equal(codex.credentialFile, f.original.providers[0].credentialFile);
  assert.deepEqual(provider(after, "claude"), f.original.providers[1]);
  assert.deepEqual(after.unknownRoot, { preserve: true }); assert.deepEqual(after.nativeModelPicker, nativeDefault);
  assert.deepEqual(await f.nativeFiles(), f.sentinels);
  // A second check is a no-op.
  const settled = await f.bytes(); const again = await check(f, s);
  assert.equal(again.outcome, "unchanged"); assert.deepEqual(await f.bytes(), settled);
});

test("unrelated families, unknown IDs and models only in the cached catalog stay off", async () => {
  const f = await fixture(); const s = source(base());
  await mkdir(join(f.root, "app-catalog"), { mode: 0o700 });
  await writeFile(join(f.root, "app-catalog", "codex.json"), JSON.stringify({ version: 1, models: [{ id: "gpt-reserve-99", label: "Reserve" }, { id: "gpt-8-luna", label: "Luna" }] }), { mode: 0o600 });
  await enable(f, s);
  s.set({ codex: rows([...codexIds, "gpt-6.2-sol", "gpt-8-luna", "gpt-5.3-codex", "gpt-reserve-99"]), claude: rows([...claudeIds, "claude-sonnet-5-6", "claude-unrelated-99"]) });
  await check(f, s);
  const after = await f.raw();
  assert.deepEqual(Object.values(routes(after, "codex")).sort(), [...codexIds, "gpt-6.2-sol"].sort());
  assert.deepEqual(routes(after, "claude"), routes(f.original as Raw, "claude"));
});

test("a model dated in the future, by ID or by release time, is not activated yet", async () => {
  const f = await fixture(); const s = source(base());
  await enable(f, s);
  s.set({ codex: rows([...codexIds, "gpt-6.2-sol"], { "gpt-6.2-sol": seconds(2027, 6, 1) }), claude: rows([...claudeIds, "claude-opus-5-6-20270101"]) });
  const before = await f.bytes(); const result = await check(f, s);
  assert.equal(result.outcome, "unchanged"); assert.equal(result.changed, false); assert.deepEqual(await f.bytes(), before);
});

test("release metadata never downgrades a version or breaks an ambiguous tie", async () => {
  const f = await fixture(); const s = source(base());
  await enable(f, s);
  s.set({ codex: rows([...codexIds, "gpt-5.4-sol"], { "gpt-5.4-sol": seconds(2026, 10, 20) }),
    claude: rows([...claudeIds, "claude-opus-5-4-20261020", "claude-opus-5.5"]) });
  const before = await f.bytes(); const result = await check(f, s);
  assert.equal(result.changed, false); assert.deepEqual(await f.bytes(), before, "older versions and an equal version with unknown dates are never promoted");
});

test("a missing, empty, malformed or failing catalog keeps the current selection", async () => {
  for (const bad of [{ codex: [], claude: [] }, {}, { codex: "nope", claude: { rows: [] } }]) {
    const f = await fixture(); const s = source(base());
    await enable(f, s);
    const before = await f.bytes();
    s.set(bad);
    const result = await check(f, s);
    assert.notEqual(result.outcome, "updated", JSON.stringify(bad)); assert.equal(result.changed, false);
    assert.deepEqual(await f.bytes(), before, JSON.stringify(bad));
  }
});

test("one provider failing does not stop another from updating, and the failed one keeps its routes", async () => {
  const f = await fixture(); const s = source(base());
  await enable(f, s);
  s.set({ claude: rows([...claudeIds, "claude-opus-5-6"]) });
  const result = await check(f, s);
  assert.ok(result.providersFailed >= 1); assert.equal(result.changed, true);
  const after = await f.raw();
  assert.deepEqual(provider(after, "codex"), f.original.providers[0]);
  assert.equal(routes(after, "claude")["claude/claude-opus-5-6"], "claude-opus-5-6");
  assert.equal(routes(after, "claude")["claude/claude-opus-5-5"], "claude-opus-5-5");
});

test("when the first discovery fails, the first successful one only establishes the baseline", async () => {
  const f = await fixture(); const s = source({});
  await enable(f, s);
  const pending = await f.raw();
  assert.equal(pending.autoLatestModels.enabled, true); assert.equal(pending.autoLatestModels.providers.codex.baselinePending, true);
  assert.deepEqual(pending.providers, f.original.providers);
  s.set({ codex: rows([...codexIds, "gpt-6.2-sol"]), claude: rows(claudeIds) });
  const first = await check(f, s);
  assert.equal(first.outcome, "baseline"); assert.equal(first.activated, 0);
  const folded = await f.raw();
  assert.deepEqual(folded.providers, f.original.providers, "a model already in the catalog is not activated by the first success");
  assert.notEqual(folded.autoLatestModels.providers.codex.baselinePending, true);
  assert.ok(folded.autoLatestModels.providers.codex.baselineModels.includes("gpt-6.2-sol"));
  s.set({ codex: rows([...codexIds, "gpt-6.2-sol", "gpt-6.3-sol"]), claude: rows(claudeIds) });
  assert.equal((await check(f, s)).outcome, "updated");
  assert.equal(routes(await f.raw(), "codex")["codex/gpt-6.3-sol"], "gpt-6.3-sol");
});

test("a disable or a manual edit during discovery makes the result stale and nothing is committed", { timeout: 30000 }, async () => {
  for (const mutate of ["disable", "edit"] as const) {
    const f = await fixture(); const s = source(base());
    await enable(f, s);
    s.set({ codex: rows([...codexIds, "gpt-6.2-sol"]), claude: rows(claudeIds) });
    const held = s.hold(); const pending = check(f, s);
    await held.entered;
    if (mutate === "disable") await setAutoLatest(f.path, false, await f.revision(), deps(s, f));
    else { const raw = await f.raw(); raw.providers[1].label = "Edited"; await writeFile(f.path, JSON.stringify(raw) + "\n", { mode: 0o600 }); }
    const edited = await f.bytes();
    held.release();
    const result = await pending;
    assert.equal(result.outcome, "stale", mutate); assert.equal(result.changed, false);
    assert.deepEqual(await f.bytes(), edited, `${mutate}: the stale result wrote nothing`);
    const after = await f.raw();
    assert.equal(Object.values(routes(after, "codex")).includes("gpt-6.2-sol"), false);
    if (mutate === "disable") assert.equal(after.autoLatestModels.enabled, false); else assert.equal(provider(after, "claude").label, "Edited");
  }
});

test("a reviewed revision that no longer matches is refused before any discovery or write", async () => {
  const f = await fixture(); const s = source(base());
  await enable(f, s);
  const reviewed = await f.revision();
  const raw = await f.raw(); raw.providers[1].label = "Edited"; await writeFile(f.path, JSON.stringify(raw) + "\n", { mode: 0o600 });
  s.set({ codex: rows([...codexIds, "gpt-6.2-sol"]), claude: rows(claudeIds) });
  const edited = await f.bytes();
  const calls = s.state.calls.length;
  await assert.rejects(check(f, s, { expectedRevision: reviewed }), (error: { code?: string }) => error.code === "configuration_changed");
  assert.equal(s.state.calls.length, calls, "the preflight refusal discovers nothing");
  assert.deepEqual(await f.bytes(), edited);
});

test("cancellation writes nothing, even when discovery finishes afterwards", { timeout: 30000 }, async () => {
  const f = await fixture(); const s = source(base());
  await enable(f, s);
  s.set({ codex: rows([...codexIds, "gpt-6.2-sol"]), claude: rows(claudeIds) });
  const before = await f.bytes();
  const control = new AbortController(); const held = s.hold();
  const pending = check(f, s, { signal: control.signal });
  await held.entered; control.abort();
  const result = await pending;
  assert.equal(result.outcome, "cancelled"); assert.equal(result.changed, false);
  held.release(); await settle();
  assert.deepEqual(await f.bytes(), before, "no late write after the cancelled check");
  const early = new AbortController(); early.abort();
  assert.equal((await check(f, s, { signal: early.signal })).outcome, "cancelled");
  await setAutoLatest(f.path, false, await f.revision(), deps(s, f, { signal: early.signal })).catch(() => undefined);
  await settle(); assert.deepEqual(await f.bytes(), before);
});

test("a baseline over 256 models stays pending, never activates anything and never drops a configured model", async () => {
  const f = await fixture();
  const crowd = Array.from({ length: 300 }, (_, index) => `gpt-5.${index}-sol`);
  const s = source({ codex: rows([...codexIds, ...crowd]), claude: rows(claudeIds) });
  const before = await f.bytes();
  const enabled = await enable(f, s).then(() => true, () => false);
  if (!enabled) { assert.deepEqual(await f.bytes(), before, "a refused enable wrote nothing"); return; }
  s.set({ codex: rows([...codexIds, ...crowd, "gpt-6.2-sol"]), claude: rows(claudeIds) });
  const result = await check(f, s);
  assert.notEqual(result.outcome, "updated"); assert.equal(result.activated, 0);
  const after = await f.raw(); const scope = after.autoLatestModels.providers.codex;
  assert.equal(scope.baselinePending, true); assert.ok(scope.baselineModels.length <= 256);
  for (const id of codexIds) assert.ok(scope.baselineModels.includes(id), "the configured model is never dropped from the baseline");
  assert.deepEqual(provider(after, "codex"), f.original.providers[0], "the selection is untouched");
});

// Every crowd ID is newer than the configured gpt-6.1-sol, so only the baseline keeps it from activating.
const crowd = Array.from({ length: 300 }, (_, index) => `gpt-7.${index}-sol`);
const fullCatalog = (): Catalog => ({ codex: rows([...codexIds, ...crowd]), claude: rows(claudeIds) });
async function assertNeverActivated(f: Fixture, step: string): Promise<void> {
  const after = await f.raw();
  assert.deepEqual(Object.values(routes(after, "codex")).sort(), [...codexIds].sort(), `${step}: no pre-known model was activated`);
  assert.deepEqual(provider(after, "codex"), f.original.providers[0], `${step}: the selection is untouched`);
}

test("overflow, then shrink, then reappear: a rejected enable never activates a pre-known disabled model", { timeout: 60000 }, async () => {
  const f = await fixture(); const s = source(fullCatalog());
  const before = await f.bytes();
  await assert.rejects(enable(f, s), (error: { code?: string }) => error.code === "invalid_request", "a baseline over 256 models is refused");
  assert.deepEqual(await f.bytes(), before, "a refused enable wrote nothing");
  for (const catalog of [{ codex: rows([...codexIds, ...crowd.slice(0, 100)]), claude: rows(claudeIds) }, fullCatalog(), { codex: rows(codexIds), claude: rows(claudeIds) }, fullCatalog()]) {
    s.set(catalog);
    assert.equal((await check(f, s)).outcome, "disabled");
    assert.deepEqual(await f.bytes(), before);
  }
  await assertNeverActivated(f, "after the cycle");
});

test("overflow, then shrink, then reappear: a safely blocked scope never activates a pre-known disabled model", { timeout: 60000 }, async () => {
  const f = await fixture();
  // The enable-time catalog cannot be read, so the scope is armed small and pending.
  const s = source({});
  await enable(f, s);
  const pending = (await f.raw()).autoLatestModels.providers.codex;
  assert.equal(pending.baselinePending, true); assert.ok(pending.baselineModels.length <= 256);
  await assertNeverActivated(f, "after enable");
  // The first readable catalog is over the bound: the fold cannot hold every known ID, so the scope is blocked for good.
  s.set(fullCatalog());
  const first = await check(f, s);
  assert.equal(first.activated, 0); assert.notEqual(first.outcome, "updated");
  const blocked = (await f.raw()).autoLatestModels.providers.codex;
  assert.equal(blocked.baselineBlocked, true); assert.notEqual(blocked.baselinePending, true); assert.ok(blocked.baselineModels.length <= 256);
  await assertNeverActivated(f, "overflowing catalog");
  // The catalog shrinks to a part that fits: a blocked scope stays blocked and activates nothing.
  s.set({ codex: rows([...codexIds, ...crowd.slice(0, 100)]), claude: rows(claudeIds) });
  assert.equal((await check(f, s)).activated, 0); await assertNeverActivated(f, "shrunk catalog");
  assert.equal((await f.raw()).autoLatestModels.providers.codex.baselineBlocked, true);
  // The whole catalog reappears, including models known at enable time that never fitted the baseline.
  s.set(fullCatalog());
  assert.equal((await check(f, s)).activated, 0); await assertNeverActivated(f, "catalog reappears");
  s.set({ codex: rows(codexIds), claude: rows(claudeIds) }); await check(f, s);
  s.set(fullCatalog()); await check(f, s); await assertNeverActivated(f, "repeated cycle");
  assert.ok(Buffer.byteLength(JSON.stringify((await f.raw()).autoLatestModels)) < 64 * 1024, "the stored scope stays bounded");
});

test("the native picker allowlist follows the public cache; the cache, login and config are never written", async () => {
  const f = await fixture(); const s = source(base());
  await enable(f, s);
  await f.writeNative([...nativeDefault, "gpt-6.2-sol", "gpt-5.3-codex", { slug: "gpt-6.3-sol", visibility: "hide" }]);
  const cache = await readFile(join(f.native, "models_cache.json"));
  const result = await check(f, s);
  assert.equal(result.nativeUpdated, true); assert.equal(result.changed, true);
  const after = await f.raw();
  assert.deepEqual([...after.nativeModelPicker].sort(), ["gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6.2-sol"].sort());
  assert.equal(after.nativeModelPickerPlacement, "last");
  assert.deepEqual(after.providers, f.original.providers, "gateway routes are unchanged by a native update");
  assert.deepEqual(await readFile(join(f.native, "models_cache.json")), cache);
  assert.deepEqual(await f.nativeFiles(), f.sentinels);
});

test("a disabled setting never discovers or writes", async () => {
  const f = await fixture(); const s = source(base());
  const before = await f.bytes();
  const result = await check(f, s);
  assert.equal(result.outcome, "disabled"); assert.equal(s.state.calls.length, 0); assert.deepEqual(await f.bytes(), before);
});
