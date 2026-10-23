import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerRouter } from "../app-server-router.js";
import { gatewayModelList } from "../app-server-model-list.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { validateConfig, type GatewayConfig, type NativeModelPickerPlacement } from "../config.js";
import { configureTelemetry } from "../telemetry.js";

type ObjectValue = Record<string, unknown>;
type Backend = (method: string, params: ObjectValue) => Promise<ObjectValue>;
const row = (model: string, extra: ObjectValue = {}): ObjectValue => ({ id: model, model, displayName: model, hidden: false, isDefault: false, ...extra });
const gateway = (slug: string): ObjectValue => ({ slug, display_name: slug, description: "gateway row", supported_reasoning_levels: [{ effort: "low", description: "low" }] });
const slugs = (result: ObjectValue) => (result.data as ObjectValue[]).map(model => model.model);
const none = new Set<string>();
const catalog = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-5.6-terra"].map(model => row(model));
const picker = ["gpt-6-astra", "gpt-6.1-sol"];

function engine(rows: ObjectValue[]) {
  const requests: ObjectValue[] = [];
  const backend: Backend = async (method, params) => {
    requests.push(structuredClone(params));
    assert.equal(method, "model/list");
    const start = params.cursor ? Number(params.cursor) : 0;
    return { data: rows.slice(start, start + 100), nextCursor: start + 100 < rows.length ? String(start + 100) : null };
  };
  return { backend, requests };
}
const list = (placement: NativeModelPickerPlacement | undefined, params: ObjectValue = {}, rows = catalog, chosen: string[] | "all" = picker,
  extras: ObjectValue[] = [gateway("alias-a"), gateway("alias-b")], preferred?: unknown) =>
  gatewayModelList(params, engine(rows).backend, none, extras, preferred, chosen === "all" ? undefined : chosen, placement);

// --- Configuration ---------------------------------------------------------------------------------------------------

const base = async () => ({ version: 1, port: 0, stateDirectory: await mkdtemp(join(tmpdir(), "gateway-placement-config-")),
  providers: [{ id: "fake", type: "claude-subscription", models: { alias: "actual" } }] });

test("nativeModelPickerPlacement is optional and omitted from the validated config when absent", async () => {
  assert.equal(Object.hasOwn(validateConfig(await base()), "nativeModelPickerPlacement"), false);
  for (const value of ["first", "last", "hidden"] as const) {
    assert.equal(validateConfig({ ...await base(), nativeModelPickerPlacement: value }).nativeModelPickerPlacement, value);
  }
  const both = validateConfig({ ...await base(), nativeModelPicker: picker, nativeModelPickerPlacement: "last" });
  assert.deepEqual(both.nativeModelPicker, picker); assert.equal(both.nativeModelPickerPlacement, "last");
});

test("nativeModelPickerPlacement rejects every other value or type with a fixed error that never repeats the input", async () => {
  const config = await base();
  const invalid: unknown[] = [null, "", "First", "LAST", " last", "last ", "middle", "none", "off", 1, 0, true, false, [], ["last"], {}, { value: "last" }, "secret-sk-value"];
  for (const nativeModelPickerPlacement of invalid) {
    assert.throws(() => validateConfig({ ...config, nativeModelPickerPlacement }), (error: Error) =>
      error.message === "nativeModelPickerPlacement must be first, last or hidden", JSON.stringify(nativeModelPickerPlacement));
  }
});

// --- model/list ------------------------------------------------------------------------------------------------------

test("first, and an absent placement, keep the native rows before the gateway rows exactly as before", async () => {
  const expected = ["gpt-6-astra", "gpt-6.1-sol", "alias-a", "alias-b"];
  assert.deepEqual(slugs(await list(undefined)), expected);
  assert.deepEqual(slugs(await list("first")), expected);
  assert.deepEqual(await list("first"), await list(undefined));
});

test("last puts the gateway rows, in their order, before the selected native rows", async () => {
  assert.deepEqual(slugs(await list("last")), ["alias-a", "alias-b", "gpt-6-astra", "gpt-6.1-sol"]);
  assert.deepEqual(slugs(await list("last", {}, catalog, "all")), ["alias-a", "alias-b", ...catalog.map(model => model.model)]);
  assert.deepEqual(slugs(await list("last", {}, catalog, picker, [])), picker);
});

test("hidden returns only gateway rows from a normal list, however the allowlist is set", async () => {
  assert.deepEqual(slugs(await list("hidden")), ["alias-a", "alias-b"]);
  assert.deepEqual(slugs(await list("hidden", {}, catalog, "all")), ["alias-a", "alias-b"]);
  assert.deepEqual(slugs(await list("hidden", { includeHidden: false })), ["alias-a", "alias-b"]);
  assert.deepEqual(slugs(await list("hidden", {}, catalog, picker, [])), []);
});

test("hidden with includeHidden keeps every native row as a hidden copy, never unhides a vendor-hidden row, and does not mutate the engine's rows", async () => {
  const vendorHidden = row("gpt-vendor-hidden", { hidden: true });
  const rows = [row("gpt-6-astra", { isDefault: true }), vendorHidden, row("gpt-old")];
  const before = structuredClone(rows);
  for (const chosen of ["all" as const, ["gpt-6-astra"]]) {
    const result = await list("hidden", { includeHidden: true }, rows, chosen, [gateway("alias-a")]);
    const data = result.data as ObjectValue[];
    assert.deepEqual(data.map(model => [model.model, model.hidden]), [["gpt-6-astra", true], ["gpt-vendor-hidden", true], ["gpt-old", true], ["alias-a", false]]);
    assert.equal(data[0]!.isDefault, true, "the rest of the engine's row is kept");
    assert.equal(data[2]!.displayName, "gpt-old");
    for (const index of [0, 1, 2]) assert.notEqual(data[index], rows[index], "a copy, not the engine's object");
  }
  assert.deepEqual(rows, before);
});

test("last with includeHidden keeps chosen rows as written, the others as hidden copies, and vendor-hidden rows hidden", async () => {
  const vendorHidden = row("gpt-vendor-hidden", { hidden: true });
  const rows = [row("gpt-6-astra"), vendorHidden, row("gpt-old")];
  const result = await list("last", { includeHidden: true }, rows, ["gpt-6-astra", "gpt-vendor-hidden"], [gateway("alias-a")]);
  const data = result.data as ObjectValue[];
  assert.deepEqual(data.map(model => [model.model, model.hidden]), [["alias-a", false], ["gpt-6-astra", false], ["gpt-vendor-hidden", true], ["gpt-old", true]]);
  assert.deepEqual(data[1], rows[0]); assert.deepEqual(data[2], vendorHidden);
});

test("placement is applied before pagination: a page can cross the gateway and native boundary and the cursors cover every row once", async () => {
  const many = Array.from({ length: 250 }, (_, index) => row(`native-${index}`));
  const chosen = many.filter((_, index) => index % 5 === 0).map(model => String(model.model));
  const extras = [gateway("alias-a"), gateway("alias-b"), gateway("alias-c")];
  for (const placement of ["first", "last"] as const) {
    const { backend, requests } = engine(many);
    const seen: unknown[] = []; const sizes: number[] = []; let cursor: unknown = null; let guard = 0;
    do {
      const page = await gatewayModelList({ limit: 7, cursor }, backend, none, extras, undefined, chosen, placement);
      sizes.push(slugs(page).length); seen.push(...slugs(page)); cursor = page.nextCursor;
    } while (cursor && ++guard < 40);
    assert.deepEqual(seen, placement === "last" ? ["alias-a", "alias-b", "alias-c", ...chosen] : [...chosen, "alias-a", "alias-b", "alias-c"]);
    assert.ok(sizes.every(size => size <= 7));
    assert.equal(requests[0]!.cursor, null);
  }
  const cross = await gatewayModelList({ limit: 4, cursor: "gateway-models:1" }, engine(many).backend, none, extras, undefined, chosen, "last");
  assert.deepEqual(slugs(cross), ["alias-b", "alias-c", chosen[0], chosen[1]], "a page spans the boundary");
  assert.equal(cross.nextCursor, "gateway-models:5");
  const hidden = await gatewayModelList({ limit: 2 }, engine(many).backend, none, extras, undefined, chosen, "hidden");
  assert.deepEqual(slugs(hidden), ["alias-a", "alias-b"]); assert.equal(hidden.nextCursor, "gateway-models:2");
  await assert.rejects(gatewayModelList({ cursor: "gateway-models:4" }, engine(many).backend, none, extras, undefined, chosen, "hidden"), /Invalid gateway model cursor/);
});

test("the default marker follows the saved model wherever it sits", async () => {
  const marks = (result: ObjectValue) => (result.data as ObjectValue[]).filter(model => model.isDefault === true).map(model => model.model);
  assert.deepEqual(marks(await list("last", {}, catalog, picker, undefined, "alias-b")), ["alias-b"]);
  assert.deepEqual(marks(await list("last", {}, catalog, picker, undefined, "gpt-6.1-sol")), ["gpt-6.1-sol"]);
  assert.deepEqual(marks(await list("hidden", {}, catalog, picker, undefined, "alias-a")), ["alias-a"]);
  assert.deepEqual(marks(await list("hidden", {}, catalog, picker, undefined, "gpt-6.1-sol")), [], "a hidden row cannot become the visible default");
  const native = [row("gpt-6-astra", { isDefault: true })];
  assert.deepEqual(marks(await list("last", {}, native, "all", [gateway("alias-a")])), ["gpt-6-astra"], "the native default stays when nothing is saved");
});

test("a gateway alias the engine also lists is never duplicated under any placement", async () => {
  for (const placement of ["first", "last", "hidden"] as const) {
    const result = await gatewayModelList({}, engine([...catalog, row("alias-a")]).backend, new Set(["alias-a"]), [gateway("alias-a")], undefined, undefined, placement);
    assert.equal(slugs(result).filter(model => model === "alias-a").length, 1);
  }
});

// --- Bounds: the engine is scanned the same way whatever the placement ---------------------------------------------------

const rowsOf = (count: number, prefix = "bulk") => Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`));
const limitError = /exceeds the gateway model limit/;

test("hidden still bounds rows and pages and still stops a repeated cursor", async () => {
  for (const params of [{}, { includeHidden: true }]) {
    const page = await gatewayModelList(params, engine(rowsOf(4096)).backend, none, [gateway("a")], undefined, ["bulk-0"], "hidden");
    // Normal list: one gateway row. includeHidden: all 4097 rows were read, and the first default page of 100 comes back.
    assert.equal(slugs(page).length, params.includeHidden ? 100 : 1);
    assert.equal(page.nextCursor, params.includeHidden ? "gateway-models:100" : null);
    await assert.rejects(gatewayModelList(params, engine(rowsOf(4097)).backend, none, [], undefined, ["bulk-0"], "hidden"), limitError);
  }
  let reads = 0;
  await assert.rejects(gatewayModelList({}, async () => { reads++; return { data: [], nextCursor: `fresh-${reads}` }; }, none, [], undefined, undefined, "hidden"), limitError);
  assert.equal(reads, 4096);
  let repeated = 0;
  await assert.rejects(gatewayModelList({}, async () => { repeated++; return { data: [row("x")], nextCursor: "same" }; }, none, [], undefined, undefined, "hidden"), /repeated a model list cursor/);
  assert.equal(repeated, 2);
  const pages = [...Array.from({ length: 40 }, (_, index) => ({ data: rowsOf(100, `p${index}`), nextCursor: `c${index + 1}` })), { data: rowsOf(200, "last"), nextCursor: null }];
  let finalReads = 0;
  await assert.rejects(gatewayModelList({}, async () => pages[finalReads++]!, none, [], undefined, undefined, "hidden"), limitError);
  assert.equal(finalReads, 41);
  await assert.rejects(gatewayModelList({}, async () => ({ nextCursor: null }), none, [], undefined, undefined, "hidden"), /invalid model list/);
});

// --- Router ----------------------------------------------------------------------------------------------------------

async function routed(placement?: NativeModelPickerPlacement) {
  const root = await mkdtemp(join(tmpdir(), "gateway-native-placement-"));
  const state = join(root, "state"); const native = join(root, "native"); await mkdir(native, { recursive: true, mode: 0o700 });
  configureTelemetry(state, "test");
  const config: GatewayConfig = { version: 1, port: 1, stateDirectory: state, providers: [
    { id: "codex", type: "codex-subscription", label: "Codex 2", credentialFile: "unused", models: { "codex/model": "model" }, modelMetadata: { "codex/model": { reasoningEfforts: ["low", "high"] } } },
  ], nativeModelPicker: picker, ...(placement ? { nativeModelPickerPlacement: placement } : {}) };
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

test("the router applies the configured placement to model/list", async () => {
  const names = async (placement?: NativeModelPickerPlacement, params: ObjectValue = {}) => slugs(await (await routed(placement)).router.request("model/list", params));
  const first = await names("first"); const gatewayRows = first.filter(name => !String(name).startsWith("gpt-"));
  assert.ok(gatewayRows.length > 0);
  assert.deepEqual(first, [...picker, ...gatewayRows]);
  assert.deepEqual(await names(), first, "absent behaves as first");
  assert.deepEqual(await names("last"), [...gatewayRows, ...picker]);
  assert.deepEqual(await names("hidden"), gatewayRows);
});

test("with native rows hidden, the router still starts and resumes native chats and lists them under includeHidden", async () => {
  const f = await routed("hidden");
  const listed = await f.router.request("model/list", { includeHidden: true });
  const natives = (listed.data as ObjectValue[]).filter(model => String(model.model).startsWith("gpt-"));
  assert.deepEqual(natives.map(model => [model.model, model.hidden]), catalog.map(model => [model.model, true]));
  assert.equal(f.last("model/list").includeHidden, true);
  for (const model of ["gpt-6-astra", "gpt-5.6-terra", "gpt-6-luna"]) {
    const started = await f.router.request("thread/start", { model, cwd: "/work" });
    assert.equal(started.model, model);
    assert.equal(f.last("thread/start").model, model);
    assert.notEqual(f.last("thread/start").modelProvider, "subscription_gateway", "still a native chat");
  }
  const resumed = { threadId: "saved", model: "gpt-5.6-terra", modelProvider: "openai", path: "/no/rollout.jsonl", config: {} };
  await f.router.request("thread/resume", structuredClone(resumed));
  assert.deepEqual(f.last("thread/resume"), resumed, "a saved native chat resumes exactly as the caller sent it");
});
