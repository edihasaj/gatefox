// Synthetic assets only. The real-asset case reads the installed app read-only and writes under a task-owned /tmp dir.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { buildNativeCatalog, CatalogError, patchNativeCatalogAsset } from "../claude-native-trial/catalog.mjs";

const MERGE = "l=e?.models,u=UR(HR(l?.map(e=>MR(e,i))??[],o)";
const CAPABILITY = "hasCapability:(e,t)=>{let n=m(e);return!!n&&n.capabilities?.[t]!==!1}";

/** A tiny module that keeps both exact anchors and the identity-preserving shape of the app's pipeline. */
const synthetic = () => [
  "const UR=a=>a,HR=a=>a,MR=e=>e,i=0,o=0;",
  `export function pick(e){let ${MERGE},0),d=new Map(u.map(e=>[e.id,e])),m=e=>e?d.get(e):void 0;`,
  `return{raw:l,list:u,${CAPABILITY}}}`,
].join("\n");

let nonce = 0;
async function load(source) {
  const text = `${source}\n//${(nonce += 1)}`;
  return import(`data:text/javascript;base64,${Buffer.from(text, "utf8").toString("base64")}`);
}

const route = (n, extra = {}) => ({
  slug: `claude-hg-route-${n}`,
  display_name: `Route ${n}`,
  supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map(effort => ({ effort })),
  default_reasoning_level: "medium",
  service_tiers: [{ id: "priority", name: "Fast" }],
  context_window: 200000,
  ...extra,
});

test("builds one native entry per eligible route with real efforts and a fast toggle", () => {
  const [entry, ...rest] = buildNativeCatalog({ models: [route(1)] });
  assert.equal(rest.length, 0);
  assert.deepEqual(entry, {
    id: "claude-hg-route-1",
    name: "Route 1",
    thinking: {
      type: "effort",
      always_on: true,
      effort_options: [
        { id: "low", name: "Low", description: "Low reasoning effort" },
        { id: "medium", name: "Medium", description: "Medium reasoning effort" },
        { id: "high", name: "High", description: "High reasoning effort" },
        { id: "xhigh", name: "Extra high", description: "Extra high reasoning effort" },
        { id: "max", name: "Max", description: "Max reasoning effort" },
      ],
    },
    context_window: 200000,
    fast_mode: { type: "toggle", options: [{ id: "off", name: "Standard" }, { id: "fast", name: "Fast" }] },
  });
});

test("only claude-hg-route-N ids are exposed, in input order, with no invented family", () => {
  const entries = buildNativeCatalog({ models: [
    route(7), route(3), route(1, { slug: "claude-opus-4" }), route(2, { slug: "claude-hg-route-" }),
    route(4, { slug: "claude-hg-route-4x" }), route(5, { slug: " claude-hg-route-5" }), route(6, { slug: "gpt-5" }),
  ] });
  assert.deepEqual(entries.map(e => e.id), ["claude-hg-route-7", "claude-hg-route-3"]);
  for (const entry of entries) assert.deepEqual(Object.keys(entry).sort(), ["context_window", "fast_mode", "id", "name", "thinking"]);
});

test("effort options come from the declared levels only, as strings or { effort }, deduplicated and ordered", () => {
  const options = levels => buildNativeCatalog({ models: [route(1, { supported_reasoning_levels: levels })] })[0].thinking?.effort_options.map(o => o.id);
  assert.deepEqual(options(["low", "high"]), ["low", "high"]);
  assert.deepEqual(options([{ effort: "max" }, "low", { effort: "low" }, "max"]), ["low", "max"]);
  assert.deepEqual(options(["ultra", "none", "minimal", "HIGH", "", 7, null, {}, { effort: 3 }, [], "medium"]), ["medium"]);
  assert.equal(options(["ultra", "minimal"]), undefined, "no real effort means no effort control, never a fake one");
  assert.equal(options([]), undefined);
  assert.equal(options(undefined), undefined);
  assert.equal(options("high"), undefined);
  assert.equal(options({ effort: "high" }), undefined);
});

test("fast mode needs the priority tier and nothing else", () => {
  const fast = tiers => buildNativeCatalog({ models: [route(1, { service_tiers: tiers })] })[0].fast_mode;
  assert.equal(fast([{ id: "priority", name: "Whatever" }]).type, "toggle");
  assert.equal(fast([{ id: "flex", name: "Fast" }, { id: "default", name: "Standard" }]), undefined);
  assert.equal(fast([{ id: "Priority" }, { name: "priority" }, "priority", null]), undefined);
  assert.equal(fast([]), undefined);
  assert.equal(fast(undefined), undefined);
  assert.equal(fast("priority"), undefined);
});

test("context window is kept only when it is a sane positive integer", () => {
  const context = value => buildNativeCatalog({ models: [route(1, { context_window: value })] })[0].context_window;
  assert.equal(context(1_000_000), 1_000_000);
  for (const bad of [0, -5, 1.5, "200000", null, undefined, Number.NaN, Infinity, 1e12]) assert.equal(context(bad), undefined, String(bad));
});

test("rejects malformed input and unbounded labels instead of guessing", () => {
  const bad = input => assert.throws(() => buildNativeCatalog(input), err => err instanceof CatalogError && err.name === "CatalogError");
  for (const input of [undefined, null, [], "x", {}, { models: "x" }, { models: {} }]) bad(input);
  bad({ models: [null] });
  bad({ models: ["claude-hg-route-1"] });
  bad({ models: [route(1, { display_name: undefined })] });
  bad({ models: [route(1, { display_name: 7 })] });
  bad({ models: [route(1, { display_name: "   " })] });
  bad({ models: [route(1, { display_name: "x".repeat(81) })] });
  bad({ models: [route(1, { display_name: "line\nbreak" })] });
  bad({ models: [route(1, { display_name: "bell\u0007" })] });
  bad({ models: [route(1), route(1)] });
  bad({ models: [route(1, { slug: `claude-hg-route-${"9".repeat(60)}` })] });
  assert.equal(buildNativeCatalog({ models: [route(1, { display_name: "  padded  " })] })[0].name, "padded");
  assert.equal(buildNativeCatalog({ models: [route(1, { display_name: "x".repeat(80) })] })[0].name.length, 80);
});

test("the model count is bounded at 200, counting ineligible models too", () => {
  const many = count => ({ models: Array.from({ length: count }, (_, n) => route(n)) });
  assert.equal(buildNativeCatalog(many(200)).length, 200);
  assert.throws(() => buildNativeCatalog(many(201)), /at most 200/);
  assert.throws(() => buildNativeCatalog({ models: Array.from({ length: 201 }, () => route(1, { slug: "gpt-5" })) }), /at most 200/);
});

test("patching fails closed unless each anchor appears exactly once", () => {
  const catalog = buildNativeCatalog({ models: [route(1)] });
  const refuses = (source, pattern) => assert.throws(() => patchNativeCatalogAsset(source, catalog), err => err instanceof CatalogError && pattern.test(err.message));
  const good = synthetic();
  assert.equal(typeof patchNativeCatalogAsset(good, catalog), "string");
  refuses(good.replace(MERGE, "l=e?.models"), /model-list anchor.*found 0/);
  refuses(`${good}\n;${MERGE}`, /model-list anchor.*found 2/);
  refuses(good.replace(CAPABILITY, "hasCapability:()=>!0"), /capability anchor.*found 0/);
  refuses(`${good}\n;${CAPABILITY}`, /capability anchor.*found 2/);
  refuses("", /non-empty string/);
  refuses(7, /non-empty string/);
  refuses(`${good}\nconst __hgSomething=1;`, /already contains/);
  assert.throws(() => patchNativeCatalogAsset(good, []), /no eligible/);
  assert.throws(() => patchNativeCatalogAsset(good, { models: [route(1, { slug: "claude-opus-4" })] }), /no eligible/);
  assert.throws(() => patchNativeCatalogAsset(good, undefined), CatalogError);
});

test("patching an already built list re-validates it and rejects anything buildNativeCatalog would not make", () => {
  const good = synthetic();
  const [entry] = buildNativeCatalog({ models: [route(1)] });
  const refuses = candidate => assert.throws(() => patchNativeCatalogAsset(good, [candidate]), CatalogError);
  refuses({ ...entry, id: "claude-opus-4" });
  refuses({ ...entry, extra: "x" });
  refuses({ ...entry, name: " padded " });
  refuses({ ...entry, name: "bad\u0000" });
  refuses({ ...entry, thinking: { ...entry.thinking, always_on: false } });
  refuses({ ...entry, thinking: { ...entry.thinking, effort_options: [{ id: "ultra", name: "Ultra", description: "Ultra reasoning effort" }] } });
  refuses({ ...entry, thinking: { ...entry.thinking, effort_options: [{ id: "low", name: "Low", description: "<img src=x>" }] } });
  refuses({ ...entry, thinking: { ...entry.thinking, effort_options: [] } });
  refuses({ ...entry, context_window: -1 });
  refuses({ ...entry, fast_mode: { type: "toggle", options: [{ id: "off", name: "Standard" }, { id: "turbo", name: "Fast" }] } });
  refuses({ ...entry, fast_mode: { type: "toggle", options: [{ id: "off", name: "Standard" }, { id: "fast", name: "Fast", badge: {} }] } });
  assert.throws(() => patchNativeCatalogAsset(good, [entry, entry]), /duplicate/);
  assert.equal(typeof patchNativeCatalogAsset(good, [entry]), "string");
});

test("patched module merges local routes before native normalization and keeps identity stable", async () => {
  const catalog = buildNativeCatalog({ models: [route(1), route(2, { supported_reasoning_levels: ["low", "high"], service_tiers: [] })] });
  const { pick } = await load(patchNativeCatalogAsset(synthetic(), catalog));

  const nativeA = { id: "claude-sonnet-x", name: "Sonnet", thinking: { type: "effort", effort_options: [{ id: "high", name: "High" }] } };
  const nativeB = { id: "claude-haiku-x", name: "Haiku" };
  const models = Object.freeze([nativeA, nativeB]);
  const before = JSON.stringify(models);

  const first = pick({ models });
  assert.deepEqual(first.raw.map(m => m.id), ["claude-sonnet-x", "claude-haiku-x", "claude-hg-route-1", "claude-hg-route-2"]);
  assert.equal(first.raw[0], nativeA, "native entry objects are passed through, not copied");
  assert.equal(first.raw[1], nativeB);
  assert.equal(first.list[0], nativeA);
  assert.equal(JSON.stringify(models), before, "the native input is not mutated");
  assert.ok(Object.isFrozen(models));
  assert.equal(first.raw.length, 4);

  const again = pick({ models });
  assert.equal(again.raw, first.raw, "same input array gives the same merged array");
  assert.equal(again.raw[2], first.raw[2], "injected entries keep their identity");
  assert.equal(pick({ models: [nativeA, nativeB] }).raw[2], first.raw[2], "even for a new input array, local entries are not rebuilt");
  assert.equal(first.raw[2].thinking.effort_options.length, 5);
  assert.equal(first.raw[3].thinking.effort_options.length, 2);
  assert.equal(first.raw[3].fast_mode, undefined);
});

test("a native entry with the same id wins and is never replaced or duplicated", async () => {
  const catalog = buildNativeCatalog({ models: [route(1), route(2)] });
  const { pick } = await load(patchNativeCatalogAsset(synthetic(), catalog));
  const native = { id: "claude-hg-route-1", name: "Native owner" };
  const merged = pick({ models: [native] }).raw;
  assert.deepEqual(merged.map(m => m.id), ["claude-hg-route-1", "claude-hg-route-2"]);
  assert.equal(merged[0], native);
  assert.equal(native.name, "Native owner");
  assert.equal(native.thinking, undefined);
  const allNative = [native, { id: "claude-hg-route-2", name: "Also native" }];
  assert.equal(pick({ models: allNative }).raw, allNative, "nothing to add means the original array comes back");
});

test("missing or odd model lists keep a stable, original-compatible result", async () => {
  const catalog = buildNativeCatalog({ models: [route(1)] });
  const { pick } = await load(patchNativeCatalogAsset(synthetic(), catalog));
  const a = pick(undefined);
  const b = pick({});
  const c = pick({ models: null });
  assert.deepEqual(a.raw.map(m => m.id), ["claude-hg-route-1"]);
  assert.equal(a.raw, b.raw, "the undefined fallback is one stable array");
  assert.equal(a.raw, c.raw);
  assert.equal(a.raw[0], pick(undefined).raw[0]);
  const odd = { not: "an array" };
  assert.throws(() => pick({ models: odd }), TypeError, "a non-array value reaches the app's own handling unchanged");
  const empty = [];
  assert.deepEqual(pick({ models: empty }).raw.map(m => m.id), ["claude-hg-route-1"]);
  assert.equal(empty.length, 0);
});

test("injected ids only report capabilities they advertise, native behavior is unchanged", async () => {
  const catalog = buildNativeCatalog({ models: [route(1)] });
  const { pick } = await load(patchNativeCatalogAsset(synthetic(), catalog));
  const models = [
    { id: "claude-native-a", name: "A" },
    { id: "claude-native-b", name: "B", capabilities: { vision: false, tools: true } },
  ];
  const view = pick({ models });
  assert.equal(view.hasCapability("claude-native-a", "vision"), true, "native entry without capabilities keeps the original default");
  assert.equal(view.hasCapability("claude-native-b", "vision"), false);
  assert.equal(view.hasCapability("claude-native-b", "tools"), true);
  assert.equal(view.hasCapability("claude-native-b", "other"), true);
  assert.equal(view.hasCapability("claude-unknown", "vision"), false, "unknown ids stay false");
  assert.equal(view.hasCapability(undefined, "vision"), false);
  for (const capability of ["vision", "tools", "computer_use", "anything"]) {
    assert.equal(view.hasCapability("claude-hg-route-1", capability), false, `injected id does not advertise ${capability}`);
  }
});

test("capability guard is scoped to the surface that injected the entry, in any call order", async () => {
  const catalog = buildNativeCatalog({ models: [route(1)] });
  const { pick } = await load(patchNativeCatalogAsset(synthetic(), catalog));
  const id = "claude-hg-route-1";
  const native = { id, name: "Native owner" };
  const nativeSurface = [native];
  const before = pick({ models: nativeSurface });
  assert.equal(before.hasCapability(id, "vision"), true, "a native colliding entry keeps the original default");
  const injected = pick({ models: [] });
  assert.equal(injected.hasCapability(id, "vision"), false, "the injected entry advertises no capabilities");
  assert.equal(before.hasCapability(id, "vision"), true, "another surface injecting the same id does not change it");
  const again = pick({ models: nativeSurface });
  assert.equal(again.raw[0], native, "the native entry is preserved unchanged");
  assert.equal(again.hasCapability(id, "vision"), true);
  assert.equal(pick(undefined).hasCapability(id, "vision"), false);
  assert.equal(pick({ models: [{ id: "claude-other", name: "Other" }] }).hasCapability("claude-other", "vision"), true);
  assert.equal(native.capabilities, undefined);
});

test("labels with quotes, markup, backslashes and line separators survive intact and the source stays inert", async () => {
  const nasty = 'He said "hi" \\ </script><!-- ${x} `tick` \'    end';
  const catalog = buildNativeCatalog({ models: [route(1, { display_name: nasty })] });
  assert.equal(catalog[0].name, nasty.trim());
  const patched = patchNativeCatalogAsset(synthetic(), catalog);
  const helper = patched.slice(0, patched.indexOf(synthetic().slice(0, 20)));
  for (const raw of ["</script>", "<!--", " ", " "]) assert.equal(helper.includes(raw), false, `helper must not contain a raw ${JSON.stringify(raw)}`);
  const { pick } = await load(patched);
  assert.equal(pick({ models: [] }).raw[0].name, nasty.trim());
  assert.deepEqual(pick({ models: [] }).raw[0], catalog[0]);
});

test("the helper carries no credentials, network, filesystem or code evaluation", () => {
  const patched = patchNativeCatalogAsset(synthetic(), buildNativeCatalog({ models: [route(1)] }));
  const helper = patched.slice(0, patched.indexOf("const UR="));
  for (const forbidden of [/\bfetch\b/, /XMLHttpRequest/, /\bimport\s*\(/, /\beval\b/, /new Function/, /\bProxy\b/, /\bprocess\b/, /\brequire\b/, /token/i, /Authorization/i, /localStorage/]) {
    assert.equal(forbidden.test(helper), false, String(forbidden));
  }
  assert.ok(patched.endsWith(synthetic().slice(synthetic().indexOf("const UR="))) === false, "the two anchors were rewritten");
  assert.equal(patched.includes(MERGE), false);
  assert.equal(patched.includes(CAPABILITY), false);
});

const REAL_ASSET = "/Applications/Claude.app/Contents/Resources/ion-dist/assets/v1/shared-182-DmmFG2g-.js";
test("real Claude asset (read-only): both anchors patch in memory and the result still parses", { skip: !existsSync(REAL_ASSET) }, () => {
  const source = readFileSync(REAL_ASSET, "utf8");
  const patched = patchNativeCatalogAsset(source, { models: [route(1), route(2, { service_tiers: [] })] });
  assert.ok(patched.length > source.length);
  assert.equal(patched.includes(MERGE), false);
  assert.equal(patched.includes(CAPABILITY), false);
  assert.ok(patched.endsWith(source.slice(source.indexOf(MERGE) + MERGE.length)) === false);
  const dir = mkdtempSync("/tmp/claude-native-catalog-test.");
  try {
    const file = join(dir, "patched.mjs");
    writeFileSync(file, patched, { mode: 0o600 });
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe", timeout: 30000, cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => patchNativeCatalogAsset(patched, { models: [route(1)] }), CatalogError, "an already patched asset is refused");
});
