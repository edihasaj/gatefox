import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { gatewayModelList } from "../app-server-model-list.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { validateConfig, type GatewayConfig } from "../config.js";
import { configureTelemetry } from "../telemetry.js";

type ObjectValue = Record<string, unknown>;
type Backend = (method: string, params: ObjectValue) => Promise<ObjectValue>;
const row = (model: string, extra: ObjectValue = {}): ObjectValue => ({ id: model, model, displayName: model, hidden: false, isDefault: false, ...extra });
const gateway = (slug: string): ObjectValue => ({ slug, display_name: slug, description: "gateway row", supported_reasoning_levels: [{ effort: "low", description: "low" }] });
const slugs = (result: ObjectValue) => (result.data as ObjectValue[]).map(model => model.model);

// A native engine that pages `rows` 100 at a time with numeric cursors, and records every request it receives.
function engine(rows: ObjectValue[]) {
  const requests: ObjectValue[] = [];
  const backend: Backend = async (method, params) => {
    requests.push(structuredClone(params));
    assert.equal(method, "model/list");
    const start = params.cursor ? Number(params.cursor) : 0;
    const data = rows.slice(start, start + 100);
    return { data, nextCursor: start + 100 < rows.length ? String(start + 100) : null };
  };
  return { backend, requests };
}
const catalog = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra"].map(model => row(model));
const none = new Set<string>();

// --- Configuration ---------------------------------------------------------------------------------------------------

const base = async () => ({ version: 1, port: 0, stateDirectory: await mkdtemp(join(tmpdir(), "gateway-picker-config-")),
  providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] });

test("nativeModelPicker is optional: absent stays undefined and a valid list is kept as written", async () => {
  assert.equal(Object.hasOwn(validateConfig(await base()), "nativeModelPicker"), false);
  const ids = ["gpt-6.1-sol", "gpt-5.6-terra", "vendor/model_1:beta", "A"];
  assert.deepEqual(validateConfig({ ...await base(), nativeModelPicker: ids }).nativeModelPicker, ids);
  const longest = "a".repeat(128);
  assert.deepEqual(validateConfig({ ...await base(), nativeModelPicker: [longest] }).nativeModelPicker, [longest]);
  const most = Array.from({ length: 256 }, (_, index) => `model-${index}`);
  assert.equal(validateConfig({ ...await base(), nativeModelPicker: most }).nativeModelPicker?.length, 256);
});

test("nativeModelPicker rejects anything that is not a non-empty list of unique canonical ASCII model IDs", async () => {
  const invalid: unknown[] = [
    "gpt-6.1-sol", null, 7, {}, [], [1], [null], [{}], [["gpt"]], [""], [" gpt"], ["gpt "], ["gpt\n"], ["gp t"], ["gpt\u0000"],
    ["gpt\u0007"], ["gpt\u007f"], ["gpt​"], ["gpté"], ["モデル"], ["gpt‮"], ["-gpt"], [".gpt"], ["gpt*"], ["gpt?"], ["gpt,x"],
    ["gpt;x"], ["gpt@x"], ["gpt#x"], ["gpt\\x"], ["gpt\"x"], ["a".repeat(129)], ["gpt-6", "gpt-6"],
    Array.from({ length: 257 }, (_, index) => `model-${index}`),
  ];
  const config = await base();
  for (const nativeModelPicker of invalid) {
    assert.throws(() => validateConfig({ ...config, nativeModelPicker }), /nativeModelPicker/, JSON.stringify(nativeModelPicker)?.slice(0, 60));
  }
});

test("a nativeModelPicker error never repeats the rejected entry", async () => {
  const secret = "sk-secret-value é";
  const config = await base();
  assert.throws(() => validateConfig({ ...config, nativeModelPicker: [secret] }), (error: Error) => !error.message.includes("secret"));
});

// --- model/list ------------------------------------------------------------------------------------------------------

test("no picker, or an absent one, returns the engine's rows and the gateway rows exactly as before", async () => {
  const { backend } = engine(catalog);
  const absent = await gatewayModelList({}, backend, none, [gateway("alias-a")], undefined);
  assert.deepEqual(slugs(absent), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra", "alias-a"]);
});

test("a picker keeps only the four chosen native rows by exact ID and every gateway row", async () => {
  const { backend } = engine([...catalog, row("gpt-6.1-sol-mini"), row("GPT-6.1-SOL"), row("other")]);
  const result = await gatewayModelList({}, backend, none, [gateway("alias-a"), gateway("alias-b")], undefined,
    ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra"]);
  assert.deepEqual(slugs(result), ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra", "alias-a", "alias-b"]);
  assert.equal(result.nextCursor, null);
  // A prefix, a family and a different case never stand in for a chosen ID.
  const exact = await gatewayModelList({}, backend, none, [], undefined, ["gpt-6.1-sol-mini", "gpt-6"]);
  assert.deepEqual(slugs(exact), ["gpt-6.1-sol-mini"]);
});

test("a gateway alias is never narrowed, and an alias the engine also lists is not duplicated", async () => {
  const { backend } = engine([...catalog, row("alias-a")]);
  const result = await gatewayModelList({}, backend, new Set(["alias-a"]), [gateway("alias-a")], undefined, ["alias-a", "gpt-6-astra"]);
  assert.deepEqual(slugs(result), ["gpt-6-astra", "alias-a"]);
  const empty = await gatewayModelList({}, engine(catalog).backend, none, [gateway("alias-a")], undefined, ["unknown-model"]);
  assert.deepEqual(slugs(empty), ["alias-a"]);
});

test("the picker pages across engine pages and the gateway cursor offsets the combined rows", async () => {
  const many = Array.from({ length: 250 }, (_, index) => row(`native-${index}`));
  const { backend, requests } = engine(many);
  const chosen = many.filter((_, index) => index % 2 === 0).map(model => String(model.model));
  const extras = [gateway("alias-a"), gateway("alias-b")];
  const pages: unknown[] = []; let cursor: unknown = null; let guard = 0;
  do {
    const page = await gatewayModelList({ limit: 40, cursor }, backend, none, extras, undefined, chosen);
    assert.ok(slugs(page).length <= 40); pages.push(...slugs(page)); cursor = page.nextCursor;
  } while (cursor && ++guard < 20);
  assert.deepEqual(pages, [...chosen, "alias-a", "alias-b"]);
  assert.deepEqual(requests.slice(0, 3).map(request => request.cursor), [null, "100", "200"], "the engine is read in full from its start");
  assert.equal((await gatewayModelList({ limit: 40, cursor: "gateway-models:120" }, backend, none, extras, undefined, chosen)).nextCursor, null);
  await assert.rejects(gatewayModelList({ cursor: "gateway-models:9999" }, backend, none, extras, undefined, chosen), /Invalid gateway model cursor/);
  await assert.rejects(gatewayModelList({ cursor: "100" }, backend, none, extras, undefined, chosen), /Invalid gateway model cursor/);
});

test("includeHidden keeps every native row: chosen rows as written, the others as hidden copies, and the vendor's hidden rows hidden", async () => {
  const vendorHidden = row("gpt-vendor-hidden", { hidden: true });
  const rows = [row("gpt-6-astra", { isDefault: true }), vendorHidden, row("gpt-old"), row("gpt-5.6-terra")];
  const { backend, requests } = engine(rows);
  const before = structuredClone(rows);
  const result = await gatewayModelList({ includeHidden: true }, backend, none, [gateway("alias-a")], undefined, ["gpt-6-astra", "gpt-vendor-hidden"]);
  const data = result.data as ObjectValue[];
  assert.deepEqual(data.map(model => [model.model, model.hidden]), [["gpt-6-astra", false], ["gpt-vendor-hidden", true], ["gpt-old", true], ["gpt-5.6-terra", true], ["alias-a", false]]);
  assert.deepEqual(data[0], rows[0], "a chosen row is returned as the engine wrote it");
  assert.deepEqual(data[1], vendorHidden, "a vendor-hidden row is never unhidden");
  assert.equal(data[2]!.displayName, "gpt-old", "a hidden copy keeps the rest of the engine's row");
  assert.notEqual(data[2], rows[2], "the engine's row is copied, not rewritten");
  assert.deepEqual(rows, before, "the engine's rows are not mutated");
  assert.ok(requests.every(request => request.includeHidden === true && request.limit === 100), "the engine is asked for what the caller asked for");
  // includeHidden that is not exactly true narrows like a normal request.
  for (const includeHidden of [false, undefined, "true", 1]) {
    assert.deepEqual(slugs(await gatewayModelList({ includeHidden } as ObjectValue, engine(rows).backend, none, [], undefined, ["gpt-6-astra"])), ["gpt-6-astra"]);
  }
});

test("without a picker, includeHidden marks nothing", async () => {
  const rows = [row("gpt-6-astra"), row("gpt-old")];
  const result = await gatewayModelList({ includeHidden: true }, engine(rows).backend, none, [], undefined);
  assert.deepEqual(result.data, rows);
});

test("the saved gateway default still marks one default row among the picked rows", async () => {
  const result = await gatewayModelList({}, engine(catalog).backend, none, [gateway("alias-a")], "alias-a", ["gpt-6-astra"]);
  assert.deepEqual((result.data as ObjectValue[]).map(model => [model.model, model.isDefault]), [["gpt-6-astra", false], ["alias-a", true]]);
});

// --- Bounds ----------------------------------------------------------------------------------------------------------

const rowsOf = (count: number, prefix = "bulk") => Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`));
const limitError = /exceeds the gateway model limit/;

test("a catalog of exactly 4096 rows is read; one row more is refused, however the picker narrows it", async () => {
  assert.equal(slugs(await gatewayModelList({}, engine(rowsOf(4096)).backend, none, [], undefined, ["bulk-0"])).length, 1);
  const whole = await gatewayModelList({ limit: 1000, cursor: "gateway-models:4000" }, engine(rowsOf(4096)).backend, none, [], undefined);
  assert.equal(slugs(whole).length, 96, "all 4096 rows were read and paged");
  await assert.rejects(gatewayModelList({}, engine(rowsOf(4097)).backend, none, [], undefined), limitError);
  await assert.rejects(gatewayModelList({}, engine(rowsOf(4097)).backend, none, [], undefined, ["bulk-0"]), limitError);
});

test("an oversized final page is refused after the read, even with no next cursor and no row kept", async () => {
  // 40 pages of 100 rows (4000), then one final page of 200 that carries a null next cursor.
  const pages = [...Array.from({ length: 40 }, (_, index) => ({ data: rowsOf(100, `p${index}`), nextCursor: `c${index + 1}` })), { data: rowsOf(200, "last"), nextCursor: null }];
  for (const picker of [undefined, ["unknown-model"], ["p0-0"]]) {
    let reads = 0;
    const backend: Backend = async () => pages[reads++]!;
    await assert.rejects(gatewayModelList({}, backend, none, [], undefined, picker), limitError);
    assert.equal(reads, 41, "the whole final page was read, then the bound applied");
  }
  const kept = new Set<string>(); const backend: Backend = async () => ({ data: rowsOf(4097), nextCursor: null });
  await assert.rejects(gatewayModelList({}, backend, kept, [], undefined, ["bulk-1"]), limitError);
});

test("a catalog the picker excludes whole stops like one it keeps whole", async () => {
  let reads = 0;
  const backend: Backend = async () => { reads++; return { data: rowsOf(100, `r${reads}`), nextCursor: `c${reads}` }; };
  await assert.rejects(gatewayModelList({}, backend, none, [], undefined, ["unknown-model"]), limitError);
  assert.equal(reads, 41, "4096 rows are crossed on the 41st page");
});

test("an engine that answers empty pages with fresh cursors is stopped by the page bound", async () => {
  let reads = 0;
  const backend: Backend = async () => { reads++; return { data: [], nextCursor: `fresh-${reads}` }; };
  await assert.rejects(gatewayModelList({}, backend, none, [], undefined, ["gpt-6-astra"]), limitError);
  assert.equal(reads, 4096);
});

test("an engine that repeats a cursor is stopped at once, kept rows or none", async () => {
  for (const data of [[], [row("gpt-6-astra")]]) {
    let reads = 0;
    const backend: Backend = async () => { reads++; return { data, nextCursor: reads === 1 ? "a" : "b" }; };
    await assert.rejects(gatewayModelList({}, backend, none, [], undefined, ["gpt-6-astra"]), /repeated a model list cursor/);
    assert.ok(reads <= 4, "stopped within a few reads");
  }
  let sameReads = 0;
  await assert.rejects(gatewayModelList({}, async () => { sameReads++; return { data: [], nextCursor: "same" }; }, none, [], undefined, ["x"]), /repeated a model list cursor/);
  assert.equal(sameReads, 2);
  // An empty-string or null cursor ends the read normally.
  for (const nextCursor of [null, "", undefined]) assert.deepEqual((await gatewayModelList({}, async () => ({ data: [row("gpt-6-astra")], nextCursor }), none, [], undefined, ["gpt-6-astra"])).data, [row("gpt-6-astra")]);
  await assert.rejects(gatewayModelList({}, async () => ({ nextCursor: null }), none, [], undefined, ["gpt-6-astra"]), /invalid model list/);
});

// --- Router ----------------------------------------------------------------------------------------------------------

async function routed(nativeModelPicker?: string[]) {
  const root = await mkdtemp(join(tmpdir(), "gateway-native-picker-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" }, modelMetadata: { "codex/model": { reasoningEfforts: ["low", "high"] } } },
  ], ...(nativeModelPicker ? { nativeModelPicker } : {}) };
  const calls: Array<{ method: string; params: ObjectValue }> = [];
  const backend = async (method: string, params: ObjectValue): Promise<ObjectValue> => {
    calls.push({ method, params: structuredClone(params) });
    if (method === "model/list") return { data: catalog.map(model => ({ ...model })), nextCursor: null };
    if (method === "thread/read") return { thread: { id: params.threadId, modelProvider: "openai", model: "gpt-5.6-terra", path: "/no/rollout.jsonl" } };
    if (method === "thread/resume") return { thread: { id: params.threadId }, model: "gpt-5.6-terra", modelProvider: "openai", serviceTier: null };
    if (method === "thread/start") return { thread: { id: "new" }, model: params.model, modelProvider: params.modelProvider ?? "openai", serviceTier: null };
    return {};
  };
  const levels = ["low", "high"].map(effort => ({ effort }));
  const source = new DesktopCatalog(config, catalog.map(model => ({ slug: model.model, supported_reasoning_levels: levels })), join(root, "desktop.json"));
  const router = new AppServerRouter(config, backend, undefined, source, native); await router.initialize();
  return { router, calls, last: (method: string) => calls.filter(call => call.method === method).at(-1)!.params };
}

test("the router lists the picked native rows and still forwards a saved or new chat on an unselected native model", async () => {
  const f = await routed(["gpt-6-astra", "gpt-6.1-sol"]);
  const listed = await f.router.request("model/list", {});
  const names = slugs(listed);
  assert.deepEqual(names.filter(name => String(name).startsWith("gpt-")), ["gpt-6-astra", "gpt-6.1-sol"]);
  assert.ok(names.some(name => !String(name).startsWith("gpt-")), "gateway rows are still listed");
  // The unselected native model is still in the catalog: no rejection, and the request reaches the engine untouched.
  for (const model of ["gpt-5.6-terra", "gpt-6-luna"]) {
    const started = await f.router.request("thread/start", { model, cwd: "/work" });
    assert.equal(started.model, model);
    assert.equal(f.last("thread/start").model, model);
    assert.notEqual(f.last("thread/start").modelProvider, "subscription_gateway", "still a native chat");
  }
  const resumed = { threadId: "saved", model: "gpt-5.6-terra", modelProvider: "openai", path: "/no/rollout.jsonl", config: {} };
  await f.router.request("thread/resume", structuredClone(resumed));
  assert.deepEqual(f.last("thread/resume"), resumed, "a saved chat on an unselected native model is forwarded as the caller sent it");
});

test("the router with includeHidden returns the full native set, marking the unselected rows hidden, and sends the engine the caller's request", async () => {
  const f = await routed(["gpt-6-astra"]);
  const listed = await f.router.request("model/list", { includeHidden: true });
  const natives = (listed.data as ObjectValue[]).filter(model => String(model.model).startsWith("gpt-"));
  assert.deepEqual(natives.map(model => [model.model, model.hidden]), [["gpt-6-astra", false], ["gpt-6.1-sol", true], ["gpt-6-luna", true], ["gpt-5.6-terra", true]]);
  assert.equal(f.last("model/list").includeHidden, true);
  const plain = await routed();
  assert.equal(slugs(await plain.router.request("model/list", {})).filter(name => String(name).startsWith("gpt-")).length, 4, "no picker leaves the list whole");
});
