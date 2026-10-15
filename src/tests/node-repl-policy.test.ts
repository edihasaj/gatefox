import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { modelCatalog } from "../catalog.js";
import { executorNativeRow, noReviewers, nodeReplFallback, reviewRuns, reviewerFor, withFallback, withNativeRow } from "../codex-native-rows.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { shimFiles } from "./shim-fixture.js";

type Row = Record<string, unknown>;
// Real native rows (ChatGPT 26.1007): every row enables node_repl; gpt-6-astra, gpt-6.1-sol and gpt-6-sol
// require auto review, gpt-6-luna and the 5.x rows do not. The catalog embedded in the ChatGPT.app codex binary states
// guardian and auto_review_model_override as null; ~/.codex/models_cache.json omits them, which the code reads the same. The 6.x rows share confirmation_policies and guardian_v2. The hidden
// codex-auto-review row is the reviewer: supported_in_api true, with the node_repl review text.
const confirmation = { browser_use: "native browser confirmations", computer_use: "native computer confirmations" };
const classifier = { classifier_instructions: "Predict whether the agent's computer and browser activity needs blocking security review" };
const native = (slug: string, node_repl_disabled: unknown, node_repl_auto_review_required: unknown, extra: Row = {}): Row => ({
  slug, tool_mode: "code_mode_only", node_repl_disabled, node_repl_auto_review_required, guardian: null, auto_review_model_override: null,
  model_messages: { instructions_template: `${slug} prompt`, confirmation_policies: confirmation, guardian_v2: classifier }, ...extra,
});
const strict = native("gpt-6.1-sol", false, true);
const lax = native("gpt-6-luna", false, false);
const reviewer = native("codex-auto-review", false, false, { visibility: "hide", supported_in_api: true, model_messages: { instructions_template: "", auto_review: { node_repl_policy: "native reviewer text" } } });
const bare: Row = { slug: "gpt-6.1-sol", tool_mode: "code_mode_only" }; // states no node_repl field at all
const repl = (row: { node_repl_disabled?: unknown; node_repl_auto_review_required?: unknown }) => ({ disabled: row.node_repl_disabled, review: row.node_repl_auto_review_required });
const codex = (models: Record<string, string>): ProviderConfig => ({ id: "codex", type: "codex-subscription", label: "Codex 2", models, modelMetadata: Object.fromEntries(Object.keys(models).map(alias => [alias, { reasoningEfforts: ["low"] }])) });
const claude: ProviderConfig = { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } };
const sol = codex({ "codex/sol": "gpt-6.1-sol" });
const solLuna = codex({ "codex/sol": "gpt-6.1-sol", "codex/luna": "gpt-5.6-luna" });
const config = (...providers: ProviderConfig[]) => ({ version: 1, port: 0, stateDirectory: ".", providers } as unknown as GatewayConfig);
const published = (...providers: ProviderConfig[]) => modelCatalog(config(...providers)).models;
const served = new Set(["codex-auto-review"]); // the host advertised the reviewer
const desktop = (rows: Row[], codeMode: boolean, ...providers: ProviderConfig[]) => new DesktopCatalog(config(...providers), rows, "unused", codeMode);
const bySlug = (rows: Row[]) => Object.fromEntries(rows.map(row => [row.slug, repl(row)]));
const modes = [true, false];
const [on, off] = [{ disabled: false, review: false }, { disabled: true, review: true }];
const unreviewed = { disabled: false, review: true }, blocked = { disabled: true, review: false };

test("every published row starts at the strictest node_repl policy", () => {
  for (const row of published(solLuna, claude)) assert.deepEqual(repl(row), off);
});

test("a Codex 2 row copies both node_repl fields from its native row when the reviewer runs, and stays off when it cannot", () => {
  const [row] = published(sol);
  for (const codeMode of modes) {
    for (const [disabled, review] of [[false, true], [false, false], [true, false], [true, true]]) {
      const source = native("gpt-6.1-sol", disabled, review);
      assert.deepEqual(repl(withNativeRow(row, [source, reviewer], codeMode, served)), { disabled, review }, `copied ${codeMode} ${disabled} ${review}`);
      assert.deepEqual(repl(withNativeRow(row, [source, reviewer], codeMode)), { disabled: disabled || review, review }, `not advertised ${codeMode} ${disabled} ${review}`);
    }
    assert.deepEqual(repl(withNativeRow(row, [strict, lax, reviewer], codeMode, served)), unreviewed, "the row's own native policy, not another row's");
    assert.deepEqual(repl(withNativeRow({ ...row, upstream_slug: "gpt-6-luna" }, [strict, lax, reviewer], codeMode)), on);
  }
});

test("the reviewer is codex-auto-review unless the row overrides it, and it must be advertised and offered to API-key auth", () => {
  const [row] = published(sol);
  const run = (extra: Row, rows: Row[] = [reviewer], set: ReadonlySet<string> = served) => repl(withNativeRow(row, [native("gpt-6.1-sol", false, true, extra), ...rows], true, set));
  assert.deepEqual(run({}), unreviewed, "the default reviewer runs");
  assert.deepEqual(run({ auto_review_model_override: "codex-auto-review" }), unreviewed);
  assert.deepEqual(run({}, [reviewer], noReviewers), off, "the host did not advertise it");
  assert.deepEqual(run({}, []), off, "no reviewer row: the SDK would review with the parent model's messages");
  for (const supported of [false, "true", null, undefined]) assert.deepEqual(run({}, [{ ...reviewer, supported_in_api: supported }]), off, `supported_in_api ${String(supported)}`);
  assert.deepEqual(run({ auto_review_model_override: "gpt-6-luna" }, [reviewer, { ...lax, supported_in_api: true }]), off, "an override the host does not advertise");
  const both = new Set(["codex-auto-review", "gpt-6-luna"]);
  assert.deepEqual(run({ auto_review_model_override: "gpt-6-luna" }, [reviewer, { ...lax, supported_in_api: true }], both), unreviewed, "an override that is advertised and offered");
  assert.deepEqual(run({ auto_review_model_override: "gpt-6-luna" }, [reviewer], both), off, "an override missing from the executor catalog");
  for (const odd of [7, "", true, {}]) assert.deepEqual(run({ auto_review_model_override: odd }), off, `override ${JSON.stringify(odd)}`);
  assert.equal(reviewerFor({}), "codex-auto-review"); assert.equal(reviewerFor({ auto_review_model_override: null }), "codex-auto-review");
  assert.equal(reviewerFor({ auto_review_model_override: "x" }), "x"); assert.equal(reviewerFor({ auto_review_model_override: "" }), undefined);
  assert.equal(reviewRuns({}, [reviewer], served), true); assert.equal(reviewRuns({}, [reviewer], noReviewers), false);
});

test("a native row that does not state a node_repl field plainly gives the stricter value", () => {
  const [row] = published(sol);
  const weaker = { ...row, node_repl_disabled: false, node_repl_auto_review_required: false }; // a host or old cache cannot lower it either
  for (const codeMode of modes) {
    for (const reviewers of [served, noReviewers]) {
      for (const source of [bare, native("gpt-6.1-sol", "false", null), native("gpt-6.1-sol", undefined, false)]) {
        assert.equal(repl(withNativeRow(weaker, [source, reviewer], codeMode, reviewers)).disabled, true, JSON.stringify(repl(source)));
      }
      assert.deepEqual(repl(withNativeRow(weaker, [bare, reviewer], codeMode, reviewers)), off);
      assert.deepEqual(repl(withNativeRow(weaker, [native("gpt-6.1-sol", undefined, false), reviewer], codeMode, reviewers)), blocked, "each field is judged on its own");
    }
    assert.deepEqual(repl(withNativeRow(weaker, [native("gpt-6.1-sol", false, undefined), reviewer], codeMode, served)), unreviewed, "an unstated flag requires review, which runs here");
    assert.deepEqual(repl(withNativeRow(weaker, [native("gpt-6.1-sol", false, undefined), reviewer], codeMode)), off);
  }
});

test("the native review fields guardian, auto_review_model_override and requires_sandboxed_review are copied", () => {
  const [row] = published(sol);
  const guardian = { computer_use: "adaptive", shell: "synchronous" };
  for (const codeMode of modes) {
    const source = native("gpt-6.1-sol", false, false, { guardian, auto_review_model_override: "codex-auto-review", requires_sandboxed_review: true });
    const copied = withNativeRow(row, [source, reviewer], codeMode, served);
    assert.deepEqual(copied.guardian, guardian); assert.notEqual(copied.guardian, guardian);
    assert.equal(copied.auto_review_model_override, "codex-auto-review"); assert.equal(copied.requires_sandboxed_review, true);
    assert.deepEqual(repl(copied), on, "a guardian policy that reviews computer use overrides the flag; node_repl stays on where the reviewer runs");
    assert.deepEqual(repl(withNativeRow(row, [source, reviewer], codeMode)), blocked, "and off where it cannot");
    // A guardian policy that omits computer use skips its review, as natively (the flag is only the older transport).
    assert.deepEqual(repl(withNativeRow(row, [native("gpt-6.1-sol", false, true, { guardian: { shell: "synchronous" } }), reviewer], codeMode)), unreviewed);
    const nulls = withNativeRow(row, [native("gpt-6.1-sol", false, false), reviewer], codeMode);
    assert.deepEqual([nulls.guardian, nulls.auto_review_model_override, nulls.requires_sandboxed_review], [null, null, undefined]);
    assert.deepEqual(repl(nulls), on, "a null guardian, as on every real row, leaves the flag in charge");
    // Values that are not plainly typed are never copied.
    const odd = withNativeRow(row, [native("gpt-6.1-sol", false, false, { guardian: "all", auto_review_model_override: 7, requires_sandboxed_review: "yes" }), reviewer], codeMode, served);
    for (const key of ["guardian", "auto_review_model_override", "requires_sandboxed_review"]) assert.equal(Object.hasOwn(odd, key), false, key);
    assert.deepEqual(repl(odd), off, "a guardian that is not copied leaves the flag to require review, and an override that is not a model name cannot be shown to run");
  }
});

test("combined() gives the native rows the Codex 2 rule: both fields kept where the reviewer runs, node_repl off where it cannot, whether code mode is on or off", () => {
  const guarded = native("gpt-guarded", false, false, { guardian: { computer_use: "synchronous" } });
  const rows = [strict, lax, { ...bare, slug: "gpt-bare" }, guarded, reviewer];
  const before = structuredClone(rows);
  for (const codeMode of modes) {
    const catalog = desktop(rows, codeMode, sol, claude);
    const want = [["gpt-6.1-sol", true, true], ["gpt-6-luna", false, false], ["gpt-bare", true, true], ["gpt-guarded", true, false], ["codex-auto-review", false, false]];
    const combined = catalog.combined().models;
    assert.deepEqual(combined.slice(0, rows.length).map(row => [row.slug, row.node_repl_disabled, row.node_repl_auto_review_required]), want, `${codeMode}: a row that states no policy gets node_repl off, as a Codex 2 row for it does`);
    assert.deepEqual(combined.find(row => row.slug === "codex-auto-review"), { ...reviewer, tool_mode: codeMode ? "code_mode_only" : "direct" }, "the reviewer row is carried unchanged apart from the executor tool mode");
    assert.equal(combined[0].tool_mode, codeMode ? "code_mode_only" : "direct", "only tool_mode depends on code mode");
  }
  assert.deepEqual(rows, before, "the native rows are never modified");
  assert.deepEqual(executorNativeRow(strict, rows), { ...strict, node_repl_disabled: true });
  assert.equal(executorNativeRow(strict, rows, served), strict, "a plain policy whose reviewer runs is carried as it is");
  assert.equal(executorNativeRow(lax, rows), lax);
});

test("guardian shapes decide review the same way through withNativeRow, executorNativeRow and nodeReplFallback, whether code mode is on or off", () => {
  // [guardian, node_repl_disabled, node_repl_auto_review_required] -> [Codex 2 row, native row in the executor catalog, fallback row]
  type Case = [unknown, boolean, boolean, object, object, object, string];
  const none: Case[] = [ // the reviewer does not run in this executor
    [null, false, false, on, on, off, "a null guardian, as on every real row, leaves the flag in charge; a fallback row always requires review"],
    [null, false, true, off, off, off, "a null guardian with the flag set needs review, which cannot run here"],
    [{ computer_use: "disabled" }, false, true, unreviewed, unreviewed, off, "a guardian that turns computer-use review off overrides the flag where it travels"],
    [{ computer_use: null }, false, true, unreviewed, unreviewed, off, "a null computer_use mode skips review even with the flag set"],
    [{ shell: "synchronous" }, false, false, on, on, off, "a guardian without a computer_use mode skips computer-use review"],
    [{ computer_use: "adaptive" }, false, false, blocked, blocked, off, "a guardian that reviews computer use, with no reviewer to run it"],
    ["all", false, false, off, off, off, "a guardian that is not an object cannot be shown to skip review, and is not copied, so the flag requires it"],
    [[], false, false, off, off, off, "an array guardian cannot be shown to skip review"],
  ];
  const runs: Case[] = [ // the reviewer runs
    [null, false, false, on, on, unreviewed, "a null guardian leaves the flag in charge; a fallback row requires review, which runs"],
    [null, false, true, unreviewed, unreviewed, unreviewed, "the flag is copied and node_repl stays on, as natively"],
    [{ computer_use: "disabled" }, false, true, unreviewed, unreviewed, unreviewed, "a guardian that turns computer-use review off"],
    [{ computer_use: null }, false, false, on, on, unreviewed, "a null computer_use mode is no review"],
    [{ computer_use: "adaptive" }, false, false, on, on, unreviewed, "a guardian that reviews computer use is copied with the row, so node_repl stays on"],
    ["all", false, false, unreviewed, unreviewed, unreviewed, "a guardian that is not an object is not copied, so the flag must require the review the reviewer runs"],
    [[], false, false, unreviewed, unreviewed, unreviewed, "an array guardian"],
    [null, true, false, blocked, blocked, off, "a native row that turns node_repl off turns it off for a fallback row too"],
  ];
  const [row] = published(sol);
  for (const codeMode of modes) {
    for (const [cases, reviewers, providers] of [[none, noReviewers, [sol, claude]], [runs, served, [solLuna, claude]]] as const) {
      for (const [guardian, disabled, review, gateway, carried, fallback, why] of cases) {
        const source = native("gpt-6.1-sol", disabled, review, { guardian });
        const rows = [source, reviewer];
        assert.deepEqual(repl(withNativeRow(row, rows, codeMode, reviewers)), gateway, `${codeMode} withNativeRow: ${why}`);
        assert.deepEqual(repl(executorNativeRow(source, rows, reviewers)), carried, `executorNativeRow: ${why}`);
        assert.deepEqual(repl(withFallback({}, nodeReplFallback(rows, reviewers))), fallback, `nodeReplFallback: ${why}`);
      }
    }
  }
});

test("a host row that publishes a weaker node_repl policy cannot lower the combined catalog", async () => {
  const f = await shimFiles();
  try {
    f.value.providers = [solLuna, claude];
    const weaker = Object.assign(modelCatalog(f.value), { auto_review: { models: ["codex-auto-review"] } });
    weaker.models = weaker.models.map(row => ({ ...row, node_repl_disabled: false, node_repl_auto_review_required: false })); f.setCatalog(weaker);
    const path = join(f.directory, "combined.json");
    await new DesktopCatalog(f.value, [strict, lax, reviewer], path, true).refresh(true);
    const rows = bySlug(JSON.parse(await readFile(path, "utf8")).models);
    assert.deepEqual([rows["codex/sol"], rows["codex/luna"], rows["claude/opus"]], [unreviewed, unreviewed, unreviewed], "a row with no native counterpart requires review, which runs");
    const cache = JSON.parse(await readFile(join(f.value.stateDirectory, "desktop-public-models.json"), "utf8"));
    assert.equal(cache.models.every((row: Row) => "node_repl_auto_review_required" in row), true, "the public cache keeps the auto review field the host published");
    assert.equal("auto_review" in cache, false, "the advertisement is never cached: a cache does not prove the route works now");
  } finally { f.close(); }
});
