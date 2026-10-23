import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleManagement } from "../app-management.js";
import { reconcileAutoLatest } from "../model-auto-latest/reconcile.js";
import { setAutoLatest } from "../model-auto-latest/toggle.js";
import type { DiscoveredModel } from "../catalog.js";
import type { ProviderConfig } from "../config.js";

const NOW = Date.UTC(2026, 9, 24) / 1000;
type Row = { id: string; releasedAt?: number };

async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-auto-latest-")); const path = join(root, "gateway.json"); const state = join(root, "state"); const home = join(root, "native"); await mkdir(state, { recursive: true }); await mkdir(home, { recursive: true });
  const config = { version: 1, port: 3457, stateDirectory: state, unknownRoot: { keep: true }, providers: [
    { id: "claude", label: "Claude", type: "claude-subscription", defaultForBareModels: true, authDirectory: join(state, "claude-auth"), models: { "claude/claude-opus-5-4": "claude-opus-5-4", "claude/old-alias": "claude-opus-5-4" },
      modelMetadata: { "claude/claude-opus-5-4": { displayName: "Opus 5.4", releasedAt: 1_780_000_000 } } },
    { id: "api", label: "API", type: "responses-api", baseUrl: "http://127.0.0.1:1/v1", credentialFile: join(state, "api-key"), models: { "api/m": "m" } },
  ], ...extra };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const catalog: { rows: Row[]; fail: boolean; calls: number; gate?: Promise<void> } = { rows: [{ id: "claude-opus-5-4" }], fail: false, calls: 0 };
  const discoverModels = async (provider: ProviderConfig): Promise<DiscoveredModel[]> => {
    catalog.calls++;
    if (catalog.gate) await catalog.gate;
    if (catalog.fail) throw new Error("secret-token-xyz");
    if (provider.id !== "claude") return [];
    return catalog.rows.map(row => ({ model: row.id, metadata: { displayName: row.id, ...(row.releasedAt !== undefined ? { releasedAt: row.releasedAt } : {}) } }));
  };
  const raw = async () => JSON.parse(await readFile(path, "utf8"));
  const revision = async () => createHash("sha256").update(await readFile(path)).digest("hex");
  const deps = { discoverModels, now: () => NOW * 1000, nativeHome: home };
  const enable = async () => setAutoLatest(path, true, await revision(), deps);
  const check = (options: object = {}) => reconcileAutoLatest(path, { ...deps, ...options });
  const claude = async () => (await raw()).providers[0];
  return { root, path, home, catalog, raw, revision, deps, enable, check, claude };
}

test("enabling seeds recognizable families and baseline without changing any selection", async () => {
  const f = await fixture(); const before = await f.raw();
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-3" }, { id: "claude-haiku-5-5" }];
  const result = await f.enable(); assert.equal(result.changed, true);
  const after = await f.raw(); const { autoLatestModels, ...rest } = after; assert.deepEqual(rest, before);
  assert.equal(autoLatestModels.enabled, true);
  assert.deepEqual(autoLatestModels.providers.claude.families, ["claude-opus"]);
  assert.deepEqual([...autoLatestModels.providers.claude.baselineModels].sort(), ["claude-opus-5-3", "claude-opus-5-4"]);
  assert.equal(autoLatestModels.providers.claude.baselinePending, undefined);
  assert.equal(autoLatestModels.providers.api, undefined);
});

test("a failed fresh discovery seeds a pending baseline whose first successful check never upgrades", async () => {
  const f = await fixture(); f.catalog.fail = true; await f.enable();
  assert.equal((await f.raw()).autoLatestModels.providers.claude.baselinePending, true);
  f.catalog.fail = false; f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }];
  const first = await f.check(); assert.equal(first.outcome, "baseline"); assert.equal(first.activated, 0);
  const scope = (await f.raw()).autoLatestModels.providers.claude; assert.equal(scope.baselinePending, undefined); assert.ok(scope.baselineModels.includes("claude-opus-5-5"));
  const second = await f.check(); assert.equal(second.outcome, "unchanged"); assert.equal(Object.values((await f.claude()).models).includes("claude-opus-5-5"), false);
});

test("an unchanged catalog is a no-op and leaves the configuration bytes alone", async () => {
  const f = await fixture(); await f.enable(); const bytes = await readFile(f.path);
  const result = await f.check(); assert.equal(result.outcome, "unchanged"); assert.equal(result.changed, false); assert.equal(result.providersChecked, 2);
  assert.deepEqual(await readFile(f.path), bytes);
});

test("a newer version in a watched family becomes routable and hides only the old picker rows", async () => {
  const f = await fixture(); await f.enable();
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5", releasedAt: 1_790_000_000 }, { id: "claude-haiku-5-5" }];
  const result = await f.check(); assert.equal(result.outcome, "updated"); assert.equal(result.activated, 1); assert.equal(result.changed, true);
  const provider = await f.claude();
  // Old aliases and upstream routes are exactly as saved; only metadata.pickerHidden is added.
  assert.equal(provider.models["claude/claude-opus-5-4"], "claude-opus-5-4"); assert.equal(provider.models["claude/old-alias"], "claude-opus-5-4");
  assert.equal(provider.modelMetadata["claude/claude-opus-5-4"].pickerHidden, true); assert.equal(provider.modelMetadata["claude/claude-opus-5-4"].displayName, "Opus 5.4");
  assert.equal(provider.modelMetadata["claude/old-alias"].pickerHidden, true);
  assert.equal(provider.models["claude/claude-opus-5-5"], "claude-opus-5-5");
  assert.equal(provider.modelMetadata["claude/claude-opus-5-5"].pickerHidden, undefined); assert.equal(provider.modelMetadata["claude/claude-opus-5-5"].releasedAt, 1_790_000_000);
  // Unrelated new family stays off; defaults, auth and unknown fields are preserved.
  assert.equal(Object.values(provider.models).includes("claude-haiku-5-5"), false);
  assert.equal(provider.defaultForBareModels, true); assert.ok(provider.authDirectory); assert.deepEqual((await f.raw()).unknownRoot, { keep: true });
  assert.ok((await f.raw()).autoLatestModels.providers.claude.baselineModels.includes("claude-opus-5-5"));
  const inspect = await handleManagement({ operation: "inspect", configPath: f.path }, { lookupCli: async () => true });
  assert.equal(inspect.ok, true); if (!inspect.ok) return;
  const models = inspect.result.providers!.find(item => item.id === "claude")!.models;
  assert.equal(models.find(item => item.id === "claude-opus-5-4")!.enabled, false); assert.equal(models.find(item => item.id === "claude-opus-5-5")!.enabled, true);
  // A later check does not activate again.
  assert.equal((await f.check()).outcome, "unchanged");
});

test("a retired alias is never rebound: a reserved ledger alias forces a new alias", async () => {
  const f = await fixture(); await f.enable();
  await writeFile(join(f.root, "app-aliases.json"), JSON.stringify({ version: 1, aliases: { "claude/claude-opus-5-5": { route: "other-route", model: "claude-opus-4-0" } } }), { mode: 0o600 });
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }];
  assert.equal((await f.check()).outcome, "updated"); const provider = await f.claude();
  assert.equal(provider.models["claude/claude-opus-5-5"], undefined);
  assert.equal(provider.models["claude/claude-opus-5-5-2"], "claude-opus-5-5");
  const ledger = JSON.parse(await readFile(join(f.root, "app-aliases.json"), "utf8"));
  assert.equal(ledger.aliases["claude/claude-opus-5-5"].model, "claude-opus-4-0"); assert.equal(ledger.aliases["claude/claude-opus-5-5-2"].model, "claude-opus-5-5");
});

test("ties, past or missing data, downgrades, future dates and baseline IDs never activate", async () => {
  const f = await fixture(); await f.enable(); const bytes = await readFile(f.path);
  const cases: Row[][] = [
    [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-3" }],
    [{ id: "claude-opus-5-4" }, { id: "claude-opus-6", releasedAt: NOW + 86400 * 30 }],
    [{ id: "claude-opus-5-4" }, { id: "claude-opus-6-20990101" }],
    [{ id: "claude-opus-5-4" }, { id: "claude-opus-7" }, { id: "claude-opus-7-20260101" }, { id: "claude-opus-7-20260102" }],
    [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5-preview" }, { id: "claude-haiku-9" }],
    [],
  ];
  for (const rows of cases) {
    f.catalog.rows = rows; const result = await f.check();
    // Case 4 has a non-tied winner among identical 7 rows? the undated 7 ties with the dated ones, so nothing wins.
    assert.equal(result.activated, 0, JSON.stringify(rows)); assert.deepEqual(await readFile(f.path), bytes);
  }
});

test("provider failures keep the current selection and never leak provider text", async () => {
  const f = await fixture(); await f.enable(); const bytes = await readFile(f.path); f.catalog.fail = true;
  const result = await f.check(); assert.equal(result.outcome, "failed"); assert.equal(result.providersFailed, 2);
  assert.equal(JSON.stringify(result).includes("secret"), false); assert.deepEqual(await readFile(f.path), bytes);
  const stateFile = (await readdir(f.root)).find(name => /^app-auto-latest-[0-9a-f]{16}\.json$/.test(name)); assert.ok(stateFile); const state = await readFile(join(f.root, stateFile!), "utf8"); assert.equal(state.includes("secret"), false); assert.match(state, /"failed"/);
});

test("an oversized catalog is refused whole and cannot complete a pending baseline", async () => {
  const f = await fixture(); f.catalog.fail = true; await f.enable(); f.catalog.fail = false;
  f.catalog.rows = Array.from({ length: 4097 }, (_, index) => ({ id: `claude-opus-${index + 1}` }));
  const big = await f.check(); assert.equal(big.outcome, "partial"); assert.equal(big.providersFailed, 1); assert.equal((await f.raw()).autoLatestModels.providers.claude.baselinePending, true);
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-6" }];
  assert.equal((await f.check()).outcome, "baseline");
  assert.equal((await f.check()).activated, 0); assert.equal(Object.values((await f.claude()).models).includes("claude-opus-5-6"), false);
});

test("a seed whose watched-family baseline exceeds 256 entries is refused before arming", async () => {
  const f = await fixture(); f.catalog.rows = Array.from({ length: 300 }, (_, index) => ({ id: `claude-opus-${index + 1}` }));
  const before = await readFile(f.path);
  await assert.rejects(f.enable(), error => (error as { code?: string }).code === "invalid_request");
  assert.deepEqual(await readFile(f.path), before);
});

test("turning the setting off stops updates without rolling back selections", async () => {
  const f = await fixture(); await f.enable(); f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }]; await f.check();
  const off = await setAutoLatest(f.path, false, await f.revision(), f.deps); assert.equal(off.changed, true);
  const provider = await f.claude(); assert.equal(provider.models["claude/claude-opus-5-5"], "claude-opus-5-5"); assert.equal(provider.modelMetadata["claude/claude-opus-5-4"].pickerHidden, true);
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }, { id: "claude-opus-6" }]; const calls = f.catalog.calls;
  assert.equal((await f.check()).outcome, "disabled"); assert.equal(f.catalog.calls, calls);
  assert.equal((await setAutoLatest(f.path, false, await f.revision(), f.deps)).changed, false);
});

test("a manual selection reseeds the provider so automatic upkeep never undoes an explicit disable", async () => {
  const f = await fixture(); f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-sonnet-5-4" }]; await f.enable();
  const discovered = await handleManagement({ operation: "discover", configPath: f.path, providerId: "claude" }, { ...f.deps, lookupCli: async () => true }); assert.equal(discovered.ok, true);
  const chosen = await handleManagement({ operation: "models", configPath: f.path, providerId: "claude", revision: await f.revision(), selectedModels: ["claude-sonnet-5-4"] }, { ...f.deps, lookupCli: async () => true });
  assert.equal(chosen.ok, true);
  const scope = (await f.raw()).autoLatestModels.providers.claude; assert.deepEqual(scope.families, ["claude-sonnet"]);
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-sonnet-5-4" }, { id: "claude-opus-6" }];
  assert.equal((await f.check()).activated, 0); assert.equal(Object.values((await f.claude()).models).includes("claude-opus-6"), false);
});

test("explicitly re-enabling an auto-hidden model unhides it, while unchecking keeps hidden routes", async () => {
  const f = await fixture(); await f.enable(); f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }]; await f.check();
  const deps = { ...f.deps, lookupCli: async () => true };
  const keep = await handleManagement({ operation: "models", configPath: f.path, providerId: "claude", revision: await f.revision(), selectedModels: ["claude-opus-5-5"] }, deps); assert.equal(keep.ok, true);
  assert.equal((await f.claude()).models["claude/claude-opus-5-4"], "claude-opus-5-4"); assert.equal((await f.claude()).modelMetadata["claude/claude-opus-5-4"].pickerHidden, true);
  const back = await handleManagement({ operation: "models", configPath: f.path, providerId: "claude", revision: await f.revision(), selectedModels: ["claude-opus-5-4"] }, deps); assert.equal(back.ok, true);
  assert.equal((await f.claude()).modelMetadata["claude/claude-opus-5-4"].pickerHidden, undefined);
});

test("a configuration edit during discovery aborts without overwriting", async () => {
  const f = await fixture(); await f.enable(); let release!: () => void; f.catalog.gate = new Promise(done => { release = done; });
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }];
  const running = f.check(); await new Promise(done => setTimeout(done, 50));
  const edited = await f.raw(); edited.providers[0].label = "Renamed"; await writeFile(f.path, JSON.stringify(edited), { mode: 0o600 });
  release(); const result = await running; assert.equal(result.outcome, "stale");
  const provider = await f.claude(); assert.equal(provider.label, "Renamed"); assert.equal(provider.models["claude/claude-opus-5-5"], undefined);
});

test("toggling off during discovery or cancelling writes nothing", async () => {
  const f = await fixture(); await f.enable(); let release!: () => void; f.catalog.gate = new Promise(done => { release = done; });
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }];
  const running = f.check(); await new Promise(done => setTimeout(done, 50));
  await setAutoLatest(f.path, false, await f.revision(), f.deps); release();
  assert.equal((await running).activated, 0); assert.equal((await f.claude()).models["claude/claude-opus-5-5"], undefined);
  const g = await fixture(); await g.enable(); const controller = new AbortController(); controller.abort(); const bytes = await readFile(g.path);
  g.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-5-5" }];
  assert.equal((await g.check({ signal: controller.signal })).outcome, "cancelled"); assert.deepEqual(await readFile(g.path), bytes);
});

test("two checks never overlap: the second reports busy while the first holds the job lock", async () => {
  const f = await fixture(); await f.enable(); let release!: () => void; f.catalog.gate = new Promise(done => { release = done; });
  const first = f.check(); await new Promise(done => setTimeout(done, 50));
  const second = await f.check({ lockTimeoutMs: 100 }); assert.equal(second.outcome, "busy");
  release(); assert.equal((await first).outcome, "unchanged");
});

test("the native scope updates only the gateway allowlist and never touches the native cache", async () => {
  const f = await fixture({ nativeModelPicker: ["gpt-6.1-luna", "custom-model"] });
  const cachePath = join(f.home, "models_cache.json"); const cache = (slugs: string[]) => JSON.stringify({ models: [...slugs.map(slug => ({ slug, visibility: "list" })), { slug: "gpt-9-luna", visibility: "hide" }] });
  await writeFile(cachePath, cache(["gpt-6.1-luna", "gpt-6-luna"]), { mode: 0o600 });
  await f.enable(); const scope = (await f.raw()).autoLatestModels.native; assert.deepEqual(scope.families, ["gpt-luna"]); assert.deepEqual([...scope.baselineModels].sort(), ["gpt-6-luna", "gpt-6.1-luna"]);
  await writeFile(cachePath, cache(["gpt-6.1-luna", "gpt-6-luna", "gpt-6.2-luna"]), { mode: 0o600 }); const cacheBytes = await readFile(cachePath);
  const result = await f.check(); assert.equal(result.nativeUpdated, true);
  assert.deepEqual((await f.raw()).nativeModelPicker, ["gpt-6.2-luna", "custom-model"]); assert.deepEqual(await readFile(cachePath), cacheBytes);
  assert.equal((await f.check()).nativeUpdated, false);
});

test("management operations carry the autoLatest view and report schedule failure accurately", async () => {
  const f = await fixture(); const deps = { ...f.deps, lookupCli: async () => true };
  const inspect = await handleManagement({ operation: "inspect", configPath: f.path }, deps); assert.equal(inspect.ok, true); if (!inspect.ok) return;
  assert.equal(inspect.result.autoLatest?.enabled, false); assert.equal(inspect.result.autoLatest?.intervalMinutes, 5);
  assert.equal((await handleManagement({ operation: "auto-latest", configPath: f.path, revision: inspect.result.revision }, deps)).ok, false);
  const on = await handleManagement({ operation: "auto-latest", configPath: f.path, revision: inspect.result.revision, enabled: true }, { ...deps, syncAutoLatestSchedule: async () => ({ scheduled: true }) });
  assert.equal(on.ok, true); if (!on.ok) return;
  assert.equal(on.result.autoLatest?.enabled, true); assert.equal(on.result.autoLatest?.scheduled, true); assert.deepEqual(on.result.autoLatest?.families, [{ providerId: "claude", label: "Claude", families: ["claude-opus"] }]);
  const stale = await handleManagement({ operation: "auto-latest", configPath: f.path, revision: inspect.result.revision, enabled: false }, deps);
  assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "configuration_changed");
  const off = await handleManagement({ operation: "auto-latest", configPath: f.path, revision: on.result.revision, enabled: false }, { ...deps, syncAutoLatestSchedule: async () => { throw new Error("launchctl secret"); } });
  assert.equal(off.ok, true); if (!off.ok) return; assert.equal(off.result.autoLatest?.scheduled, false); assert.equal(off.result.autoLatest?.scheduleReason, "schedule_failed");
  assert.equal(JSON.stringify(off.result).includes("secret"), false);
  const check = await handleManagement({ operation: "auto-latest-check", configPath: f.path }, deps); assert.equal(check.ok, false);
  const ok = await handleManagement({ operation: "auto-latest-check", configPath: f.path, revision: off.result.revision }, deps); assert.equal(ok.ok, true);
});
