import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelCatalog } from "../catalog.js";
import { executorNativeRow, executorRunsAutoReview, nodeReplFallback, withNativeRow } from "../codex-native-rows.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import { gatewayToken, type GatewayConfig, type ProviderConfig } from "../config.js";
import { nativeModelAlias, startGateway } from "../server.js";
import type { Provider } from "../providers/provider.js";
import { shimFiles } from "./shim-fixture.js";

type Row = Record<string, unknown>;
// Real native rows (ChatGPT 26.1007): every row enables node_repl; gpt-6-astra, gpt-6.1-sol and gpt-6-sol
// require auto review, gpt-6-luna and the 5.x rows do not. Every row with visibility "list" has guardian and
// auto_review_model_override null and requires_sandboxed_review false. All four 6.x rows share confirmation_policies and guardian_v2.
const confirmation = { browser_use: "native browser confirmations", computer_use: "native computer confirmations" };
const classifier = { classifier_instructions: "Predict whether the agent's computer and browser activity needs blocking security review" };
const native = (slug: string, node_repl_disabled: unknown, node_repl_auto_review_required: unknown, extra: Row = {}): Row => ({
  slug, tool_mode: "code_mode_only", node_repl_disabled, node_repl_auto_review_required, guardian: null, auto_review_model_override: null, requires_sandboxed_review: false,
  model_messages: { instructions_template: `${slug} prompt`, confirmation_policies: confirmation, guardian_v2: classifier }, ...extra,
});
const strict = native("gpt-6.1-sol", false, true);
const lax = native("gpt-6-luna", false, false);
const bare: Row = { slug: "gpt-6.1-sol", tool_mode: "code_mode_only" }; // states no node_repl field at all
const repl = (row: { node_repl_disabled?: unknown; node_repl_auto_review_required?: unknown }) => ({ disabled: row.node_repl_disabled, review: row.node_repl_auto_review_required });
const codex = (models: Record<string, string>): ProviderConfig => ({ id: "codex", type: "codex-subscription", label: "Codex 2", models, modelMetadata: Object.fromEntries(Object.keys(models).map(alias => [alias, { reasoningEfforts: ["low"] }])) });
const claude: ProviderConfig = { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } };
const config = (...providers: ProviderConfig[]) => ({ version: 1, port: 0, stateDirectory: ".", providers } as unknown as GatewayConfig);
const published = (...providers: ProviderConfig[]) => modelCatalog(config(...providers)).models;
const desktop = (rows: Row[], codeMode: boolean, ...providers: ProviderConfig[]) => new DesktopCatalog(config(...providers), rows, "unused", codeMode);
const bySlug = (rows: Row[]) => Object.fromEntries(rows.map(row => [row.slug, repl(row)]));
const modes = [true, false];

test("every published row starts at the strictest node_repl policy", () => {
  for (const row of published(codex({ "codex/sol": "gpt-6.1-sol" }), claude)) assert.deepEqual(repl(row), { disabled: true, review: true });
});

test("a Codex 2 row copies the review flag, and node_repl stays off where that review cannot run", () => {
  const [row] = published(codex({ "codex/sol": "gpt-6.1-sol" }));
  assert.equal(executorRunsAutoReview, false, "the reviewer slug is not routed by the gateway; see the 404 test below");
  for (const codeMode of modes) {
    for (const [disabled, review] of [[false, true], [false, false], [true, false], [true, true]]) {
      assert.deepEqual(repl(withNativeRow(row, [native("gpt-6.1-sol", disabled, review)], codeMode)), { disabled: disabled || review, review }, `${codeMode} ${disabled} ${review}`);
    }
    assert.deepEqual(repl(withNativeRow(row, [strict, lax], codeMode)), { disabled: true, review: true }, "the row's own native policy, not another row's");
    assert.deepEqual(repl(withNativeRow({ ...row, upstream_slug: "gpt-6-luna" }, [strict, lax], codeMode)), { disabled: false, review: false });
  }
});

test("a native row that does not state a node_repl field plainly gives the stricter value", () => {
  const [row] = published(codex({ "codex/sol": "gpt-6.1-sol" }));
  const weaker = { ...row, node_repl_disabled: false, node_repl_auto_review_required: false }; // a host or old cache cannot lower it either
  for (const codeMode of modes) {
    for (const source of [bare, native("gpt-6.1-sol", "false", null), native("gpt-6.1-sol", false, undefined), native("gpt-6.1-sol", undefined, false)]) {
      assert.equal(repl(withNativeRow(weaker, [source], codeMode)).disabled, true, JSON.stringify(repl(source)));
    }
    assert.deepEqual(repl(withNativeRow(weaker, [bare], codeMode)), { disabled: true, review: true });
    assert.deepEqual(repl(withNativeRow(weaker, [native("gpt-6.1-sol", undefined, false)], codeMode)), { disabled: true, review: false }, "each field is judged on its own");
  }
});

test("the native review fields guardian, auto_review_model_override and requires_sandboxed_review are copied", () => {
  const [row] = published(codex({ "codex/sol": "gpt-6.1-sol" }));
  const guardian = { computer_use: "adaptive", shell: "synchronous" };
  for (const codeMode of modes) {
    const copied = withNativeRow(row, [native("gpt-6.1-sol", false, false, { guardian, auto_review_model_override: "gpt-5.6-luna", requires_sandboxed_review: true })], codeMode);
    assert.deepEqual(copied.guardian, guardian); assert.notEqual(copied.guardian, guardian);
    assert.equal(copied.auto_review_model_override, "gpt-5.6-luna"); assert.equal(copied.requires_sandboxed_review, true);
    assert.deepEqual(repl(copied), { disabled: true, review: false }, "a guardian policy that reviews computer use overrides the flag, so node_repl stays off");
    // A guardian policy that omits computer use skips its review, as natively (the flag is only the older transport).
    assert.deepEqual(repl(withNativeRow(row, [native("gpt-6.1-sol", false, true, { guardian: { shell: "synchronous" } })], codeMode)), { disabled: false, review: true });
    const nulls = withNativeRow(row, [native("gpt-6.1-sol", false, false)], codeMode);
    assert.deepEqual([nulls.guardian, nulls.auto_review_model_override, nulls.requires_sandboxed_review], [null, null, false]);
    assert.deepEqual(repl(nulls), { disabled: false, review: false }, "a null guardian, as on every real row, leaves the flag in charge");
    // Values that are not plainly typed are never copied.
    const odd = withNativeRow(row, [native("gpt-6.1-sol", false, false, { guardian: "all", auto_review_model_override: 7, requires_sandboxed_review: "yes" })], codeMode);
    for (const key of ["guardian", "auto_review_model_override", "requires_sandboxed_review"]) assert.equal(Object.hasOwn(odd, key), false, key);
  }
});

test("rows without a native counterpart take the strictest policy among the native rows", () => {
  const off = (disabled: boolean, review: boolean, requires_sandboxed_review?: true) => ({ node_repl_disabled: disabled, node_repl_auto_review_required: review, ...(requires_sandboxed_review ? { requires_sandboxed_review } : {}) });
  assert.deepEqual(nodeReplFallback([lax]), off(false, false));
  assert.deepEqual(nodeReplFallback([lax, strict]), off(true, true), "any native row that requires review also keeps node_repl off where review cannot run");
  assert.deepEqual(nodeReplFallback([lax, native("off", true, false)]), off(true, false), "off when any native row is off");
  assert.deepEqual(nodeReplFallback([lax, native("odd", false, "yes")]), off(true, true), "an ambiguous field counts as required");
  assert.deepEqual(nodeReplFallback([lax, bare]), off(true, true), "fields absent from a native row count as the stricter value");
  assert.deepEqual(nodeReplFallback([lax, native("guarded", false, false, { guardian: { computer_use: "synchronous" } })]), off(true, true), "a guardian that reviews computer use makes review required on a row that has only the flag");
  assert.deepEqual(nodeReplFallback([lax, native("gpt-y", false, true, { guardian: { shell: "synchronous" } })]), off(true, true), "a native flag set to true is required even where that row's guardian skips computer-use review");
  assert.deepEqual(nodeReplFallback([lax, native("sandboxed", false, false, { requires_sandboxed_review: true })]), off(false, false, true), "sandboxed review carries over");
  assert.deepEqual(nodeReplFallback([]), off(true, true));
});

test("Claude rows and Codex rows with a missing upstream are never weaker than the native rows, in snapshot, current and combined", () => {
  const providers = [codex({ "codex/sol": "gpt-6.1-sol", "codex/next": "gpt-9" }), claude];
  const expect = (codex_sol: object, rest: object) => ({ "codex/sol": codex_sol, "codex/next": rest, "claude/opus": rest });
  for (const codeMode of modes) {
    for (const carried of [false, true]) {
      // current() holds the gateway rows; combined() puts the native rows in front of them.
      const run = (list: Row[]) => bySlug(carried ? desktop(list, codeMode, ...providers).combined().models.slice(list.length) : desktop(list, codeMode, ...providers).current().models);
      assert.deepEqual(run([lax, strict]), expect({ disabled: true, review: true }, { disabled: true, review: true }), `${codeMode}: the strictest native row decides`);
      assert.deepEqual(run([native("gpt-6.1-sol", false, false), native("gpt-6.2", false, true)]), expect({ disabled: false, review: false }, { disabled: true, review: true }), `${codeMode}: the marked row follows its own native row`);
      assert.deepEqual(run([native("gpt-6.1-sol", false, false), native("gpt-6.2", false, false)]), expect({ disabled: false, review: false }, { disabled: false, review: false }), `${codeMode}: no native row requires review`);
      assert.deepEqual(run([native("gpt-6.1-sol", false, false), native("gpt-6.2", true, false)]), expect({ disabled: false, review: false }, { disabled: true, review: false }), `${codeMode}: one native row off`);
      // A fallback row has no guardian, so review it cannot run would reject every node_repl action; it stays off.
      assert.deepEqual(run([lax, native("gpt-y", false, true, { guardian: { shell: "synchronous" } })]), expect({ disabled: true, review: true }, { disabled: true, review: true }), `${codeMode}: a guarded native row with the flag set`);
      assert.deepEqual(Object.values(run([])), [{ disabled: true, review: true }, { disabled: true, review: true }, { disabled: true, review: true }], "no native catalog");
    }
  }
});

test("a fallback row keeps node_repl off and receives none of the native confirmation or classifier policy", () => {
  // Claude, Copilot and API rows have no confirmation_policies or guardian_v2, so a strict row's review flag alone would leave them weaker.
  for (const codeMode of modes) {
    const catalog = desktop([strict, lax], codeMode, codex({ "codex/sol": "gpt-6.1-sol" }), claude);
    const claudeRow = catalog.combined().models.find(row => row.slug === "claude/opus")!;
    assert.deepEqual(claudeRow.model_messages, { instructions_template: "" });
    assert.equal(claudeRow.node_repl_disabled, true);
    assert.equal(claudeRow.node_repl_auto_review_required, true);
  }
});

test("combined() turns node_repl off on native rows that need review, whether code mode is on or off", () => {
  const providers = [codex({ "codex/sol": "gpt-6.1-sol" }), claude];
  const reviewer = native("codex-auto-review", false, false, { visibility: "hide", model_messages: { instructions_template: "", auto_review: { node_repl_policy: "reviewer text" } } });
  const guarded = native("gpt-guarded", false, false, { guardian: { computer_use: "synchronous" } });
  const rows = [strict, lax, { ...bare, slug: "gpt-bare" }, guarded, reviewer];
  const before = structuredClone(rows);
  for (const codeMode of modes) {
    const combined = desktop(rows, codeMode, ...providers).combined().models;
    assert.deepEqual(combined.slice(0, 5).map(row => [row.slug, row.node_repl_disabled, row.node_repl_auto_review_required]), [
      ["gpt-6.1-sol", true, true], ["gpt-6-luna", false, false], ["gpt-bare", true, true], ["gpt-guarded", true, false], ["codex-auto-review", false, false],
    ], `${codeMode}: a row that states no policy gets node_repl off, as a Codex 2 row for it does`);
    assert.deepEqual(combined[4], { ...reviewer, tool_mode: codeMode ? "code_mode_only" : "direct" }, "the reviewer row is carried unchanged apart from the executor tool mode");
    assert.equal(combined[0].tool_mode, codeMode ? "code_mode_only" : "direct", "only tool_mode depends on code mode");
    assert.equal(combined[5].tool_mode, codeMode ? "code_mode_only" : "direct");
  }
  assert.deepEqual(rows, before, "the native rows are never modified");
  assert.deepEqual(executorNativeRow(strict), { ...strict, node_repl_disabled: true });
  assert.equal(executorNativeRow(lax), lax);
});

test("a Codex 2 row and the native row it serves get one node_repl policy in the executor catalog, whether code mode is on or off", () => {
  const sources = [bare, native("gpt-6.1-sol", "false", null), native("gpt-6.1-sol", false, undefined), native("gpt-6.1-sol", undefined, false), strict, { ...lax, slug: "gpt-6.1-sol" },
    native("gpt-6.1-sol", false, false, { guardian: { computer_use: "synchronous" } }), native("gpt-6.1-sol", false, true, { guardian: { shell: "synchronous" } })];
  for (const codeMode of modes) {
    for (const source of sources) {
      const [carried, sol] = desktop([source], codeMode, codex({ "codex/sol": "gpt-6.1-sol" })).combined().models;
      assert.equal(sol.slug, "codex/sol");
      assert.deepEqual(repl(carried), repl(sol), `${codeMode} ${JSON.stringify(repl(source))}`);
    }
    const [carried] = desktop([bare], codeMode, codex({ "codex/sol": "gpt-6.1-sol" })).combined().models;
    assert.deepEqual(repl(carried), { disabled: true, review: true }, "a bare upstream gets the stricter value on both rows");
  }
});

test("guardian shapes decide review the same way through withNativeRow, executorNativeRow and nodeReplFallback, whether code mode is on or off", () => {
  const on = { disabled: false, review: false }, off = { disabled: true, review: true }, unreviewed = { disabled: false, review: true }, blocked = { disabled: true, review: false };
  // [guardian, node_repl_disabled, node_repl_auto_review_required] -> [Codex 2 row, native row in the executor catalog, fallback row]
  const cases: Array<[unknown, boolean, boolean, object, object, object, string]> = [
    [null, false, false, on, on, on, "a null guardian, as on every real row, leaves the flag in charge"],
    [null, false, true, off, off, off, "a null guardian with the flag set needs review, which cannot run here"],
    [{ computer_use: "disabled" }, false, true, unreviewed, unreviewed, off, "a guardian that turns computer-use review off overrides the flag where it travels; a fallback row has only the flag"],
    [{ computer_use: "disabled" }, false, false, on, on, on, "a guardian that turns computer-use review off"],
    ["all", false, false, blocked, blocked, off, "a guardian that is not an object cannot be shown to skip review"],
    [[], false, false, blocked, blocked, off, "an array guardian cannot be shown to skip review"],
  ];
  for (const codeMode of modes) {
    for (const [guardian, disabled, review, gateway, carried, fallback, why] of cases) {
      const source = native("gpt-6.1-sol", disabled, review, { guardian });
      const [row] = published(codex({ "codex/sol": "gpt-6.1-sol" }));
      assert.deepEqual(repl(withNativeRow(row, [source], codeMode)), gateway, `${codeMode} withNativeRow: ${why}`);
      assert.deepEqual(repl(executorNativeRow(source)), carried, `executorNativeRow: ${why}`);
      assert.deepEqual(repl(nodeReplFallback([source])), fallback, `nodeReplFallback: ${why}`);
      const models = desktop([source], codeMode, codex({ "codex/sol": "gpt-6.1-sol" }), claude).combined().models;
      assert.deepEqual(models.map(entry => [entry.slug, repl(entry)]), [["gpt-6.1-sol", carried], ["codex/sol", gateway], ["claude/opus", fallback]], `${codeMode} combined(): ${why}`);
    }
  }
});

test("a host row that publishes a weaker node_repl policy cannot lower the combined catalog", async () => {
  const f = await shimFiles();
  try {
    f.value.providers = [codex({ "codex/sol": "gpt-6.1-sol" }), claude];
    const weaker = modelCatalog(f.value); weaker.models = weaker.models.map(row => ({ ...row, node_repl_disabled: false, node_repl_auto_review_required: false })); f.setCatalog(weaker);
    const path = join(f.directory, "combined.json");
    await new DesktopCatalog(f.value, [strict, lax], path, true).refresh(true);
    const [, , sol, opus] = JSON.parse(await readFile(path, "utf8")).models;
    assert.deepEqual([sol.slug, repl(sol)], ["codex/sol", { disabled: true, review: true }]);
    assert.deepEqual([opus.slug, repl(opus)], ["claude/opus", { disabled: true, review: true }]);
    const cache = JSON.parse(await readFile(join(f.value.stateDirectory, "desktop-public-models.json"), "utf8"));
    assert.equal(cache.models.every((row: Row) => "node_repl_auto_review_required" in row), true, "the public cache keeps the auto review field the host published");
  } finally { f.close(); }
});

test("the gateway answers the native reviewer slug with 404, which is why review cannot run in its executors", async () => {
  // The SDK reviews node_repl actions with "codex-auto-review" (it is in the native catalog), through the executor's provider.
  const live = config(codex({ "codex/gpt-6.1-sol": "gpt-6.1-sol", "codex/gpt-5.6-luna": "gpt-5.6-luna" }));
  assert.equal(nativeModelAlias(live, "codex-auto-review"), undefined);
  const directory = await mkdtemp(join(tmpdir(), "gateway-reviewer-"));
  const provider: Provider = { async *infer() { yield { type: "done", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }; } };
  const server = await startGateway({ ...live, stateDirectory: directory, providers: live.providers.map(entry => ({ ...entry, credentialFile: "unused" })) }, () => provider);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${await gatewayToken(directory)}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "codex-auto-review", input: "review" }),
    });
    assert.equal(response.status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

const script = join(import.meta.dirname, "..", "..", "scripts", "check-node-repl.mjs");
const check = (file?: string) => spawnSync(process.execPath, file === undefined ? [script] : [script, file], { encoding: "utf8" });

test("check-node-repl prints both node_repl fields for every row and counts rows as the SDK reads them", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-node-repl-"));
  try {
    const file = join(root, "catalog.json");
    const row = (slug: string, disabled: boolean, review: boolean, guardian: unknown) => ({ slug, node_repl_disabled: disabled, node_repl_auto_review_required: review, guardian });
    await writeFile(file, JSON.stringify({ models: [
      { slug: "a", node_repl_disabled: false, node_repl_auto_review_required: true }, { slug: "b", node_repl_disabled: false, node_repl_auto_review_required: false },
      { slug: "c", node_repl_disabled: true }, { slug: "d" },
      // As in the SDK, a guardian policy decides review instead of the flag; a null one leaves the flag in charge.
      row("e", false, false, { computer_use: "synchronous" }), row("f", false, true, { shell: "synchronous" }), row("g", false, true, null),
      row("h", false, false, "all"), row("i", false, true, { computer_use: "disabled" }), row("j", false, true, { computer_use: 5 }),
      { slug: "k", node_repl_disabled: "true", node_repl_auto_review_required: "true" },
    ] }));
    const run = check(file);
    assert.equal(run.status, 0);
    assert.deepEqual(run.stdout.trim().split("\n"), [
      "disabled=false auto_review_required=true a", "disabled=false auto_review_required=false b", "disabled=true auto_review_required=missing c", "disabled=missing auto_review_required=missing d",
      'disabled=false auto_review_required=false guardian={"computer_use":"synchronous"} e', 'disabled=false auto_review_required=true guardian={"shell":"synchronous"} f',
      "disabled=false auto_review_required=true g", 'disabled=false auto_review_required=false guardian="all" h', 'disabled=false auto_review_required=true guardian={"computer_use":"disabled"} i',
      'disabled=false auto_review_required=true guardian={"computer_use":5} j', 'disabled="true" auto_review_required="true" k',
      // A missing node_repl_disabled means enabled (the SDK default), so row d counts as enabled without review.
      "1 of 11 row(s) keep node_repl disabled.", "7 of 11 row(s) enable node_repl without requiring auto review.",
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("check-node-repl is advisory: unreadable or oddly shaped input exits 0 with a one-line message", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-node-repl-"));
  try {
    const write = async (name: string, text: string) => { const file = join(root, name); await writeFile(file, text); return file; };
    for (const file of [join(root, "missing.json"), await write("bad.json", "{ not json"), await write("object.json", '{"models":{}}'), await write("none.json", "{}"), await write("null.json", "null")]) {
      const run = check(file);
      assert.equal(run.status, 0, file); assert.equal(run.stdout, "", file);
      assert.equal(run.stderr.trim(), `cannot read a combined catalog from ${file}`, file);
    }
    const run = check(await write("mixed.json", JSON.stringify({ models: [null, "x", [], { slug: "a", node_repl_disabled: false, node_repl_auto_review_required: true }] })));
    assert.equal(run.status, 0); assert.equal(run.stderr, "");
    assert.deepEqual(run.stdout.trim().split("\n"), ["3 entry(ies) that are not rows were ignored.", "disabled=false auto_review_required=true a", "0 of 1 row(s) keep node_repl disabled.", "0 of 1 row(s) enable node_repl without requiring auto review."]);
    assert.equal(check().status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
