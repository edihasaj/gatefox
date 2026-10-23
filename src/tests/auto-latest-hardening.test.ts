import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleManagement } from "../app-management.js";
import { reconcileAutoLatest } from "../model-auto-latest/reconcile.js";
import { readState, statePath } from "../model-auto-latest/state.js";
import { setAutoLatest } from "../model-auto-latest/toggle.js";
import type { DiscoveredModel } from "../catalog.js";

const NOW = Date.UTC(2026, 9, 24) / 1000;
type Row = { id: string; releasedAt?: number };
const deps0 = { lookupCli: async () => true };

async function fixture(saved: Record<string, unknown> = { displayName: "Opus 5.4" }, extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "gateway-auto-latest-h-")); const path = join(root, "gateway.json"); const state = join(root, "state"); const home = join(root, "native");
  await mkdir(state, { recursive: true }); await mkdir(home, { recursive: true });
  const config = { version: 1, port: 3457, stateDirectory: state, providers: [
    { id: "claude", label: "Claude", type: "claude-subscription", authDirectory: join(state, "claude-auth"), models: { "claude/claude-opus-5-4": "claude-opus-5-4" }, modelMetadata: { "claude/claude-opus-5-4": saved } },
  ], ...extra };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  const catalog: { rows: Row[]; fail: boolean } = { rows: [{ id: "claude-opus-5-4" }], fail: false };
  const discoverModels = async (): Promise<DiscoveredModel[]> => {
    if (catalog.fail) throw new Error("provider down");
    return catalog.rows.map(row => ({ model: row.id, metadata: { displayName: row.id, ...(row.releasedAt !== undefined ? { releasedAt: row.releasedAt } : {}) } }));
  };
  const raw = async () => JSON.parse(await readFile(path, "utf8"));
  const revision = async () => createHash("sha256").update(await readFile(path)).digest("hex");
  const deps = { discoverModels, now: () => NOW * 1000, nativeHome: home };
  return { root, home, path, catalog, raw, revision, deps, enable: async () => setAutoLatest(path, true, await revision(), deps), check: () => reconcileAutoLatest(path, deps) };
}

test("a FIFO planted at the state file cannot hang inspect or the state read", async () => {
  const f = await fixture(); execFileSync("mkfifo", [await statePath(f.path)]);
  const timeout = new Promise<"hung">(done => setTimeout(() => done("hung"), 5000).unref());
  assert.deepEqual(await Promise.race([readState(f.path), timeout]), {});
  const inspect = await Promise.race([handleManagement({ operation: "inspect", configPath: f.path }, deps0), timeout]);
  assert.notEqual(inspect, "hung"); assert.equal((inspect as { ok: boolean }).ok, true);
});

test("state files are per configuration and stable", async () => {
  const f = await fixture(); const other = join(f.root, "other.json");
  const a = await statePath(f.path); const b = await statePath(other);
  assert.notEqual(a, b); assert.equal(await statePath(f.path), a);
  assert.match(a, /app-auto-latest-[0-9a-f]{16}\.json$/);
});

test("a fold that cannot hold every known ID blocks the scope for good, even after the catalog shrinks and the ID reappears", async () => {
  const f = await fixture(); f.catalog.fail = true; await f.enable(); f.catalog.fail = false;
  f.catalog.rows = Array.from({ length: 300 }, (_, index) => ({ id: `claude-opus-${index + 1}` }));
  const first = await f.check(); assert.equal(first.outcome, "failed"); assert.equal(first.activated, 0);
  const blocked = (await f.raw()).autoLatestModels.providers.claude; assert.equal(blocked.baselineBlocked, true); assert.deepEqual(blocked.baselineModels, ["claude-opus-5-4"]);
  // The catalog shrinks to a size that would fit; the scope still never completes or activates.
  f.catalog.rows = [{ id: "claude-opus-5-4" }, { id: "claude-opus-250" }];
  const second = await f.check(); assert.equal(second.activated, 0); assert.equal(Object.values((await f.raw()).providers[0].models).includes("claude-opus-250"), false);
  assert.equal((await f.raw()).autoLatestModels.providers.claude.baselineBlocked, true);
});

test("the status previews the families turning the setting on would follow", async () => {
  const f = await fixture();
  const before = await handleManagement({ operation: "inspect", configPath: f.path }, deps0); assert.equal(before.ok, true); if (!before.ok) return;
  assert.equal(before.result.autoLatest?.enabled, false); assert.deepEqual(before.result.autoLatest?.families, [{ providerId: "claude", label: "Claude", families: ["claude-opus"] }]);
  await f.enable(); await setAutoLatest(f.path, false, await f.revision(), f.deps);
  const after = await handleManagement({ operation: "inspect", configPath: f.path }, deps0); assert.equal(after.ok, true); if (!after.ok) return;
  assert.equal(after.result.autoLatest?.enabled, false); assert.deepEqual(after.result.autoLatest?.families.map(item => item.families), [["claude-opus"]]);
});

test("an absent saved release time is filled from the exact-ID fresh catalog row when ranking", async () => {
  const f = await fixture({ displayName: "Opus 5.4" });
  f.catalog.rows = [{ id: "claude-opus-5-4", releasedAt: 1_700_000_000 }]; await f.enable();
  // Same version; the candidate carries a later date in its ID. Without the fill the current model is undated and they tie.
  f.catalog.rows = [{ id: "claude-opus-5-4", releasedAt: 1_700_000_000 }, { id: "claude-opus-5-4-20260601" }];
  const result = await f.check(); assert.equal(result.outcome, "updated"); assert.equal(result.activated, 1);
  const provider = (await f.raw()).providers[0]; assert.equal(Object.values(provider.models).includes("claude-opus-5-4-20260601"), true);
  assert.equal(provider.modelMetadata["claude/claude-opus-5-4"].pickerHidden, true);
});

test("an off that times out waiting for the schedule lock is still applied by the first toggle's re-sync", async () => {
  const f = await fixture(); const calls: boolean[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const sync = async (_path: string, enabled: boolean) => { calls.push(enabled); if (calls.length === 1) await gate; return { scheduled: enabled }; };
  const options = { ...deps0, ...f.deps, syncAutoLatestSchedule: sync, scheduleLockMs: 100 };
  const on = handleManagement({ operation: "auto-latest", configPath: f.path, revision: await f.revision(), enabled: true }, options);
  for (let waited = 0; calls.length < 1 && waited < 100; waited++) await new Promise(resolve => setTimeout(resolve, 25));
  const off = await handleManagement({ operation: "auto-latest", configPath: f.path, revision: await f.revision(), enabled: false }, options);
  assert.equal(off.ok, true); if (!off.ok) return; assert.equal(off.result.autoLatest?.scheduled, false); assert.equal(off.result.autoLatest?.scheduleReason, "schedule_busy");
  release(); const first = await on; assert.deepEqual(calls, [true, false]);
  assert.equal(first.ok, true); if (!first.ok) return; assert.equal(first.result.autoLatest?.enabled, false); assert.equal(first.result.autoLatest?.scheduled, false);
});

test("concurrent toggles install the background job in order and report the last setting", async () => {
  const f = await fixture(); const started: boolean[] = []; const done: boolean[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const sync = async (_path: string, enabled: boolean) => { started.push(enabled); if (started.length === 1) await gate; done.push(enabled); return { scheduled: enabled }; };
  const options = { ...deps0, ...f.deps, syncAutoLatestSchedule: sync };
  const on = handleManagement({ operation: "auto-latest", configPath: f.path, revision: await f.revision(), enabled: true }, options);
  for (let waited = 0; started.length < 1 && waited < 100; waited++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(started.length, 1);
  const off = handleManagement({ operation: "auto-latest", configPath: f.path, revision: await f.revision(), enabled: false }, options);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.deepEqual(started, [true]);
  release(); const [first, second] = await Promise.all([on, off]);
  // The first toggle may re-sync to off before the queued off runs its own idempotent sync, so only the order is fixed.
  assert.equal(done[0], true); assert.equal(done.at(-1), false); assert.equal(done.indexOf(true), done.lastIndexOf(true)); assert.ok(done.indexOf(false) > done.indexOf(true)); assert.equal(first.ok && second.ok, true); if (!second.ok) return;
  assert.equal(second.result.autoLatest?.enabled, false); assert.equal(second.result.autoLatest?.scheduled, false);
});

test("inspect reports the observed job state only while enabled, and never claims polling it did not see", async () => {
  const f = await fixture(); let asked = 0;
  const seen = (reply: { scheduled: boolean; reason?: string } | "throw") => ({ ...deps0, observeAutoLatestSchedule: async () => { asked++; if (reply === "throw") throw new Error("launchctl secret"); return reply; } });
  const off = await handleManagement({ operation: "inspect", configPath: f.path }, seen({ scheduled: true })); assert.equal(off.ok, true); if (!off.ok) return;
  assert.equal(asked, 0); assert.equal(off.result.autoLatest?.scheduled, undefined);
  await f.enable();
  const loaded = await handleManagement({ operation: "inspect", configPath: f.path }, seen({ scheduled: true })); assert.equal(loaded.ok, true); if (!loaded.ok) return;
  assert.equal(asked, 1); assert.equal(loaded.result.autoLatest?.scheduled, true); assert.equal(loaded.result.autoLatest?.scheduleReason, undefined);
  const gone = await handleManagement({ operation: "inspect", configPath: f.path }, seen({ scheduled: false, reason: "not_loaded" })); assert.equal(gone.ok, true); if (!gone.ok) return;
  assert.equal(gone.result.autoLatest?.scheduled, false); assert.equal(gone.result.autoLatest?.scheduleReason, "not_loaded");
  const broken = await handleManagement({ operation: "inspect", configPath: f.path }, seen("throw")); assert.equal(broken.ok, true); if (!broken.ok) return;
  assert.equal(broken.result.autoLatest?.scheduled, undefined); assert.equal(JSON.stringify(broken.result).includes("secret"), false);
});

const nativeCache = (slugs: string[]) => JSON.stringify({ models: slugs.map(slug => ({ slug, visibility: "list" })) });

test("an empty native cache at enable is pending: the first populated catalog only sets the baseline", async () => {
  const f = await fixture(undefined, { nativeModelPicker: ["gpt-6-luna"] }); const cache = join(f.home, "models_cache.json");
  await writeFile(cache, nativeCache([]), { mode: 0o600 }); await f.enable();
  assert.equal((await f.raw()).autoLatestModels.native.baselinePending, true);
  await writeFile(cache, nativeCache(["gpt-6-luna", "gpt-6.1-luna"]), { mode: 0o600 });
  const first = await f.check(); assert.equal(first.nativeUpdated, false); assert.equal(first.activated, 0);
  const raw = await f.raw(); assert.deepEqual(raw.nativeModelPicker, ["gpt-6-luna"]); assert.equal(raw.autoLatestModels.native.baselinePending, undefined); assert.ok(raw.autoLatestModels.native.baselineModels.includes("gpt-6.1-luna"));
  assert.equal((await f.check()).nativeUpdated, false);
});

test("a pending native scope stays pending through an empty catalog and folds on the first populated one", async () => {
  const f = await fixture(undefined, { nativeModelPicker: ["gpt-6-luna"] }); const cache = join(f.home, "models_cache.json");
  await f.enable(); assert.equal((await f.raw()).autoLatestModels.native.baselinePending, true);
  await writeFile(cache, nativeCache([]), { mode: 0o600 }); await f.check();
  assert.equal((await f.raw()).autoLatestModels.native.baselinePending, true);
  await writeFile(cache, nativeCache(["gpt-6-luna", "gpt-6.1-luna"]), { mode: 0o600 });
  assert.equal((await f.check()).nativeUpdated, false); assert.deepEqual((await f.raw()).nativeModelPicker, ["gpt-6-luna"]);
  await writeFile(cache, nativeCache(["gpt-6-luna", "gpt-6.1-luna", "gpt-6.2-luna"]), { mode: 0o600 });
  assert.equal((await f.check()).nativeUpdated, true); assert.deepEqual((await f.raw()).nativeModelPicker, ["gpt-6.2-luna"]);
});
