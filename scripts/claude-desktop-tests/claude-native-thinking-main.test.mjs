// Synthetic main-chunk stubs plus a read-only check of the installed app's real chunk (patched in memory, parsed in /tmp).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readAsarFile } from "../claude-native-trial/asar.mjs";
import { buildNativeCatalog, CatalogError, patchNativeThinkingMain } from "../claude-native-trial/catalog.mjs";
import { supportedClaudeTrial } from "../claude-native-trial/prepare.mjs";

const ANCHOR = "function hw(e,t,n){return Q6t(u7t(e,t,n),f7t(t,n))}";

/** CommonJS stand-in with the same function names and call shape as the real chunk's thinking resolution. */
const synthetic = () => [
  '"use strict";',
  "function kC(e){return e.trim()}",
  "function DC(e){return e.toLowerCase()}",
  "function r8t(e,t,n){return t.findIndex(x=>x.id===e)}",
  "function c8t(e,t,n){let r=r8t(e,t,n);return r===-1?void 0:t[r]}",
  'const ORDER=["low","medium","high","xhigh","max"];',
  "function Q6t(e,t){if(!e||!e.effort_options)return e;const r=ORDER.indexOf(t.maxEffort);if(r<0)return e;const k=e.effort_options.filter(x=>{const i=ORDER.indexOf(x.id);return i>=0&&i<=r});return k.length===e.effort_options.length?e:{...e,effort_options:k}}",
  "function u7t(e,t,n){let r=kC(t),i=n.hybridModelSelector?.[e]?.[DC(r)]?.thinking,a=n.modelCatalog?.[e],o=!i&&a?c8t(r,a,n.provider)?.thinking:void 0;return i??o??n.bundledThinking}",
  "function f7t(t,n){return{maxEffort:n.maxEffort}}",
  ANCHOR,
  "module.exports={hw};",
].join("\n");

const load = source => {
  const module = { exports: {} };
  new Function("module", source)(module);
  return module.exports;
};

const route = (n, extra = {}) => ({
  slug: `claude-hg-route-${n}`,
  display_name: `Route ${n}`,
  supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
  default_reasoning_level: "medium",
  service_tiers: [],
  context_window: 200000,
  ...extra,
});

const config = (extra = {}) => ({
  provider: "gateway",
  maxEffort: "max",
  models: [{ id: "claude-hg-route-1" }, { id: "claude-hg-route-2" }, { id: "claude-opus-4-7" }],
  ...extra,
});

const patched = (models = [route(1), route(2, { supported_reasoning_levels: ["low", "high"] })]) => load(patchNativeThinkingMain(synthetic(), { models })).hw;
const ids = thinking => thinking?.effort_options?.map(option => option.id);

test("a configured gateway route gets its declared effort options on every surface", () => {
  const hw = patched();
  for (const surface of ["code", "chat", "cowork"]) {
    const thinking = hw(surface, "claude-hg-route-1", config());
    assert.deepEqual(ids(thinking), ["low", "medium", "high", "xhigh", "max"], surface);
    assert.equal(thinking.type, "effort");
  }
  assert.deepEqual(ids(hw("code", "claude-hg-route-2", config())), ["low", "high"], "only the declared levels");
  assert.deepEqual(ids(hw("code", "  claude-hg-route-1[1m]", config())), ["low", "medium", "high", "xhigh", "max"], "whitespace and the [1m] variant resolve to the same route");
  assert.equal(hw("code", "claude-hg-route-1", config()), hw("code", "claude-hg-route-1", config()), "stable object when no cap changes it");
});

test("the unchanged cap still applies after injection, so options never exceed maxEffort", () => {
  const hw = patched();
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ maxEffort: "high" }))), ["low", "medium", "high"]);
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ maxEffort: "low" }))), ["low"]);
  assert.deepEqual(ids(hw("code", "claude-hg-route-2", config({ maxEffort: "medium" }))), ["low"]);
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ maxEffort: undefined }))), ["low", "medium", "high", "xhigh", "max"]);
});

test("ultracode is restored only after an xhigh-capable generated route survives the native cap", () => {
  const hw = patched([route(1, { supports_ultracode: true })]);
  const expected = ["low", "medium", "high", "xhigh", "max", "ultracode"];
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ maxEffort: "xhigh" }))), expected.slice(0, 4).concat("ultracode"));
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ maxEffort: "max" }))), expected);
  for (const cap of ["low", "high"]) assert.equal(ids(hw("code", "claude-hg-route-1", config({ maxEffort: cap }))).includes("ultracode"), false, cap);
  assert.equal(ids(hw("code", "claude-hg-route-1", config({ maxEffort: "max" }))).filter(id => id === "ultracode").length, 1, "never duplicates the special option");
});

test("ultracode does not modify bundled, hybrid, or signed-catalog thinking rows", () => {
  const hw = patched([route(1, { supports_ultracode: true })]);
  const original = Object.freeze({ type: "effort", effort_options: [{ id: "xhigh", name: "Extra high" }] });
  const none = Object.freeze({ type: "none" });
  const cases = [
    [config({ bundledThinking: original }), original],
    [config({ hybridModelSelector: { code: { "claude-hg-route-1": { thinking: original } } } }), original],
    [config({ modelCatalog: { code: [{ id: "claude-hg-route-1", thinking: original }] } }), original],
    [config({ hybridModelSelector: { code: { "claude-hg-route-1": { thinking: none } } } }), none],
    [config({ modelCatalog: { code: [{ id: "claude-hg-route-1", thinking: none }] } }), none],
  ];
  for (const [cfg, expected] of cases) {
    const result = hw("code", "claude-hg-route-1", cfg);
    assert.equal(result, expected);
    assert.equal(ids(result)?.includes("ultracode") ?? false, false);
  }
});

test("ineligible calls get the original result back untouched", () => {
  const hw = patched();
  const none = Object.freeze({ type: "none" });
  const attempts = {
    "another provider": ["code", "claude-hg-route-1", config({ provider: "anthropic" })],
    "no provider": ["code", "claude-hg-route-1", config({ provider: undefined })],
    "id not configured": ["code", "claude-hg-route-1", config({ models: [{ id: "claude-hg-route-2" }] })],
    "no configured models": ["code", "claude-hg-route-1", config({ models: [] })],
    "models not an array": ["code", "claude-hg-route-1", config({ models: { id: "claude-hg-route-1" } })],
    "unknown surface": ["web", "claude-hg-route-1", config()],
    "undeclared route": ["code", "claude-hg-route-9", config({ models: [{ id: "claude-hg-route-9" }] })],
    "native id": ["code", "claude-opus-4-7", config()],
    "prototype keys": ["code", "constructor", config({ models: [{ id: "constructor" }] })],
    "proto key": ["code", "__proto__", config({ models: [{ id: "__proto__" }] })],
    "partial id": ["code", "claude-hg-route-1x", config({ models: [{ id: "claude-hg-route-1x" }] })],
    "not a string": ["code", 7, config()],
  };
  for (const [name, [surface, id, cfg]] of Object.entries(attempts)) {
    try {
      assert.equal(hw(surface, id, cfg), undefined, name);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.ok(name === "not a string", `${name} must not throw: ${error.message}`); // the stub's own trim() rejects a number
    }
  }
  // The same holds when the original result is an object: it comes back as the same object.
  const cfg = config({ provider: "anthropic", hybridModelSelector: { code: { "claude-hg-route-1": { thinking: none } } } });
  assert.equal(hw("code", "claude-hg-route-1", cfg), none);
});

test("existing effort or mode options are never replaced", () => {
  const hw = patched();
  const withEffort = { type: "effort", effort_options: [{ id: "low", name: "Low" }] };
  const withMode = { type: "mode", mode_options: [{ id: "auto", name: "Thinking" }] };
  const cfg = (thinking) => config({ maxEffort: undefined, hybridModelSelector: { code: { "claude-hg-route-1": { thinking } } } });
  assert.equal(hw("code", "claude-hg-route-1", cfg(withEffort)), withEffort);
  assert.equal(hw("code", "claude-hg-route-1", cfg(withMode)), withMode);
});

test("any bundled thinking result wins, including an explicit none or empty descriptor", () => {
  const hw = patched();
  for (const bundledThinking of [{ type: "none" }, {}, { type: "effort", effort_options: [] }]) {
    assert.equal(hw("code", "claude-hg-route-1", config({ bundledThinking })), bundledThinking);
  }
});

test("an explicit hybrid selector row wins, including an explicit none or an empty row", () => {
  const hw = patched();
  const none = { type: "none" };
  const hybrid = row => config({ hybridModelSelector: { code: { "claude-hg-route-1": row } } });
  assert.equal(hw("code", "claude-hg-route-1", hybrid({ thinking: none })), none);
  assert.equal(hw("code", "claude-hg-route-1", hybrid({})), undefined, "a hybrid row without thinking still blocks injection");
  assert.equal(hw("code", "claude-hg-route-1", hybrid({ name: "Signed" })), undefined);
  assert.deepEqual(ids(hw("chat", "claude-hg-route-1", hybrid({ thinking: none }))), ["low", "medium", "high", "xhigh", "max"], "a hybrid row for another surface does not block this one");
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ hybridModelSelector: { code: { "claude-hg-route-2": { thinking: none } } } }))), ["low", "medium", "high", "xhigh", "max"], "or another model");
});

test("a matched signed-catalog row wins, including an explicit none; an unmatched catalog does not block", () => {
  const hw = patched();
  const none = { type: "none" };
  const withCatalog = rows => config({ modelCatalog: { code: rows } });
  assert.equal(hw("code", "claude-hg-route-1", withCatalog([{ id: "claude-hg-route-1", thinking: none }])), none);
  assert.equal(hw("code", "claude-hg-route-1", withCatalog([{ id: "claude-hg-route-1" }])), undefined, "a matched row with no thinking is still a match");
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", withCatalog([{ id: "claude-opus-4-7", thinking: none }]))), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", withCatalog([]))), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ modelCatalog: { chat: [{ id: "claude-hg-route-1", thinking: none }] } }))), ["low", "medium", "high", "xhigh", "max"], "a catalog for another surface does not block");
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", config({ modelCatalog: "bad" }))), ["low", "medium", "high", "xhigh", "max"], "a malformed catalog is ignored");
});

test("only routes that declare effort levels are embedded, validated through buildNativeCatalog", () => {
  const none = route(3, { supported_reasoning_levels: ["ultra", "minimal"] });
  const hw = patched([route(1), none, route(4, { slug: "claude-opus-4" }), route(5, { slug: "gpt-5" })]);
  const cfg = config({ models: [{ id: "claude-hg-route-1" }, { id: "claude-hg-route-3" }, { id: "claude-opus-4" }, { id: "gpt-5" }] });
  assert.deepEqual(ids(hw("code", "claude-hg-route-1", cfg)), ["low", "medium", "high", "xhigh", "max"]);
  for (const id of ["claude-hg-route-3", "claude-opus-4", "gpt-5"]) assert.equal(hw("code", id, cfg), undefined, id);
  const refuses = (catalog, pattern) => assert.throws(() => patchNativeThinkingMain(synthetic(), catalog), err => err instanceof CatalogError && pattern.test(err.message));
  refuses({ models: [none] }, /no eligible route declares effort/);
  refuses({ models: [route(5, { slug: "gpt-5" })] }, /no eligible claude-hg-route/);
  refuses({ models: [route(1, { display_name: "" })] }, /display_name/);
  refuses(undefined, CatalogError.prototype.constructor === CatalogError ? /input must be/ : /./);
  refuses({ models: [route(1), route(1)] }, /duplicate/);
  assert.equal(typeof patchNativeThinkingMain(synthetic(), buildNativeCatalog({ models: [route(1)] })), "string", "a built catalog is accepted too");
});

test("patching fails closed on a mismatched, repeated or already patched chunk", () => {
  const catalog = { models: [route(1)] };
  const refuses = (source, pattern) => assert.throws(() => patchNativeThinkingMain(source, catalog), err => err instanceof CatalogError && pattern.test(err.message));
  const good = synthetic();
  assert.equal(typeof patchNativeThinkingMain(good, catalog), "string");
  refuses(good.replace(ANCHOR, "function hw(){}"), /thinking anchor.*found 0/);
  refuses(`${good}\n${ANCHOR}`, /thinking anchor.*found 2/);
  for (const needed of ["function kC(e){", "function DC(e){", "function r8t(e,t,n){", "function Q6t(e,t){", "function u7t(e,t,n){"]) {
    refuses(good.replace(needed, "function other(e){"), /found 0/);
    refuses(`${good}\n${needed}}`, /found 2/);
  }
  refuses(good.replace('"use strict";', ""), /use strict/);
  refuses(` ${good}`, /use strict/);
  refuses("", /use strict/);
  refuses(7, /use strict/);
  refuses(`${good}\nconst __hgThinkingX=1;`, /already contains/);
  refuses(patchNativeThinkingMain(good, catalog), /already contains/);
});

test("only the hw anchor changes: the helper is inserted after the directive, nothing else is rewritten", () => {
  const source = synthetic();
  const out = patchNativeThinkingMain(source, { models: [route(1)] });
  assert.ok(out.startsWith('"use strict";/*__hgThinkingRoutes*/'));
  const helperEnd = "return{...o,effort_options:[...o.effort_options,a]}}\n";
  const end = out.indexOf(helperEnd) + helperEnd.length;
  const restored = '"use strict";' + out.slice(end).replace("function hw(e,t,n){let o=u7t(e,t,n),r=__hgThinkingFor(e,t,n,o);return __hgFinalizeThinking(t,r,Q6t(r,f7t(t,n)))}", ANCHOR);
  assert.equal(restored, source, "removing the helper and reversing the anchor restores the original exactly");
  const helper = out.slice(0, end);
  for (const forbidden of [/\bfetch\b/, /XMLHttpRequest/, /\bimport\s*\(/, /\beval\b/, /new Function/, /\bProxy\b/, /\bprocess\b/, /\brequire\b/, /token/i, /Authorization/i, /fast_?mode/i, /capabilit/i, /permission/i, /globalThis/, /\bglobal\b/, /\bwindow\b/]) {
    assert.equal(forbidden.test(helper), false, String(forbidden));
  }
  assert.equal([...helper.matchAll(/(?:const|function)\s+([\w$]+)/g)].every(match => match[1].startsWith("__hg") || match[1] === "d" || match[1] === "r" || match[1] === "a" || match[1] === "i"), true, "only __hg-prefixed module names are declared at the top level");
});

const REAL_ASAR = "/Applications/Claude.app/Contents/Resources/app.asar";
test("real Claude main chunk (read-only): anchors match once, the patched chunk parses, a repatch is refused", { skip: !existsSync(REAL_ASAR) }, t => {
  const archive = readFileSync(REAL_ASAR);
  if (createHash("sha256").update(archive).digest("hex") !== supportedClaudeTrial.asarSha256) {
    t.skip(`requires the pinned Claude Desktop ${supportedClaudeTrial.version} archive`);
    return;
  }
  const source = readAsarFile(archive, supportedClaudeTrial.thinkingMain).toString("utf8");
  const count = (text, needle) => text.split(needle).length - 1;
  assert.equal(count(source, ANCHOR), 1);
  const out = patchNativeThinkingMain(source, { models: [route(1), route(2, { supported_reasoning_levels: ["low", "high"] })] });
  assert.ok(out.startsWith('"use strict";/*__hgThinkingRoutes*/'));
  assert.equal(count(out, ANCHOR), 0);
  assert.equal(count(out, "__hgFinalizeThinking(t,r,Q6t(r,f7t(t,n)))"), 1);
  for (const untouched of ["blocked_by_platform", "K7t(", "fast_mode", "fastMode", "capabilities", "hasCapability"]) {
    assert.equal(count(out, untouched), count(source, untouched), `${untouched} occurrences are unchanged`);
  }
  const dir = mkdtempSync("/tmp/claude-native-thinking-test.");
  try {
    const file = join(dir, "patched.cjs");
    writeFileSync(file, out, { mode: 0o600 });
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe", timeout: 30000, cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.throws(() => patchNativeThinkingMain(out, { models: [route(1)] }), /already contains/);
});
