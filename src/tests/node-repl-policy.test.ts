import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { modelCatalog } from "../catalog.js";
import { executorNativeRow, nodeReplFallback, withNativeRow, type ReviewRoute } from "../codex-native-rows.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { shimFiles } from "./shim-fixture.js";

type Row = Record<string, unknown>;
// Real native rows (ChatGPT 26.1007): every row enables node_repl; gpt-6-astra, gpt-6.1-sol and gpt-6-sol
// require auto review, gpt-6-luna and the 5.x rows do not. Every row with visibility "list" has guardian and
// auto_review_model_override null and requires_sandboxed_review false. In that app's embedded catalog the
// 6.x, gpt-5.6-luna and codex-auto-review rows share confirmation_policies and guardian_v2; the fetched
// models_cache.json that the adapter loads gives gpt-5.6-luna no auto_review text.
const confirmation = { browser_use: "native browser confirmations", computer_use: "native computer confirmations" };
const classifier = { classifier_instructions: "Predict whether the agent's computer and browser activity needs blocking security review" };
const native = (slug: string, node_repl_disabled: unknown, node_repl_auto_review_required: unknown, extra: Row = {}): Row => ({
  slug, tool_mode: "code_mode_only", node_repl_disabled, node_repl_auto_review_required, guardian: null, auto_review_model_override: null, requires_sandboxed_review: false,
  model_messages: { instructions_template: `${slug} prompt`, confirmation_policies: confirmation, guardian_v2: classifier }, ...extra,
});
const strict = native("gpt-6.1-sol", false, true);
const lax = native("gpt-6-luna", false, false);
const luna = native("gpt-5.6-luna", false, false); // the reviewer the SDK picks under API-key auth
const bare: Row = { slug: "gpt-6.1-sol", tool_mode: "code_mode_only" }; // states no node_repl field at all
const repl = (row: { node_repl_disabled?: unknown; node_repl_auto_review_required?: unknown }) => ({ disabled: row.node_repl_disabled, review: row.node_repl_auto_review_required });
const codex = (models: Record<string, string>): ProviderConfig => ({ id: "codex", type: "codex-subscription", label: "Codex 2", models, modelMetadata: Object.fromEntries(Object.keys(models).map(alias => [alias, { reasoningEfforts: ["low"] }])) });
const claude: ProviderConfig = { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus" } };
const sol = codex({ "codex/sol": "gpt-6.1-sol" }); // serves no reviewer
const solLuna = codex({ "codex/sol": "gpt-6.1-sol", "codex/luna": "gpt-5.6-luna" }); // one Codex alias serves the reviewer
const config = (...providers: ProviderConfig[]) => ({ version: 1, port: 0, stateDirectory: ".", providers } as unknown as GatewayConfig);
const published = (...providers: ProviderConfig[]) => modelCatalog(config(...providers)).models;
const desktop = (rows: Row[], codeMode: boolean, ...providers: ProviderConfig[]) => new DesktopCatalog(config(...providers), rows, "unused", codeMode);
const bySlug = (rows: Row[]) => Object.fromEntries(rows.map(row => [row.slug, repl(row)]));
const served: ReviewRoute = () => true;
const modes = [true, false];
const [on, off] = [{ disabled: false, review: false }, { disabled: true, review: true }];

test("every published row starts at the strictest node_repl policy", () => {
  for (const row of published(solLuna, claude)) assert.deepEqual(repl(row), off);
});

test("a Codex 2 row copies both node_repl fields from its native row when the reviewer runs, and stays off when it cannot", () => {
  const [row] = published(sol);
  for (const codeMode of modes) {
    for (const [disabled, review] of [[false, true], [false, false], [true, false], [true, true]]) {
      assert.deepEqual(repl(withNativeRow(row, [native("gpt-6.1-sol", disabled, review)], codeMode, served)), { disabled, review }, `copied ${codeMode} ${disabled} ${review}`);
      assert.deepEqual(repl(withNativeRow(row, [native("gpt-6.1-sol", disabled, review)], codeMode)), { disabled: disabled || review, review }, `no reviewer ${codeMode} ${disabled} ${review}`);
    }
    assert.deepEqual(repl(withNativeRow(row, [strict, lax], codeMode, served)), { disabled: false, review: true }, "the row's own native policy, not another row's");
    assert.deepEqual(repl(withNativeRow({ ...row, upstream_slug: "gpt-6-luna" }, [strict, lax], codeMode)), on);
  }
});

test("the reviewer is the row's auto_review_model_override when it has one, else the API-key reviewer", () => {
  const [row] = published(sol);
  const only = (model: string): ReviewRoute => name => name === model;
  for (const codeMode of modes) {
    const policy = (extra: Row, route: ReviewRoute) => repl(withNativeRow(row, [native("gpt-6.1-sol", false, true, extra)], codeMode, route));
    assert.deepEqual(policy({}, only("gpt-5.6-luna")), { disabled: false, review: true }, "the API-key reviewer runs");
    assert.deepEqual(policy({}, only("codex-auto-review")), off, "the ChatGPT-auth reviewer is not the one the SDK picks here");
    assert.deepEqual(policy({ auto_review_model_override: "gpt-6-luna" }, only("gpt-6-luna")), { disabled: false, review: true }, "an override that runs");
    assert.deepEqual(policy({ auto_review_model_override: "gpt-6-luna" }, only("gpt-5.6-luna")), off, "the override replaces the default, so the default reviewer does not matter");
    assert.deepEqual(policy({ auto_review_model_override: 7 }, served), off, "an override that is not a model name cannot be shown to run");
  }
});

test("a native row that does not state a node_repl field plainly gives the stricter value", () => {
  const [row] = published(sol);
  const weaker = { ...row, node_repl_disabled: false, node_repl_auto_review_required: false }; // a host or old cache cannot lower it either
  for (const codeMode of modes) {
    for (const route of [served, undefined]) {
      for (const source of [bare, native("gpt-6.1-sol", "false", null), native("gpt-6.1-sol", undefined, false)]) {
        assert.equal(repl(withNativeRow(weaker, [source], codeMode, route)).disabled, true, JSON.stringify(repl(source)));
      }
      assert.deepEqual(repl(withNativeRow(weaker, [bare], codeMode, route)), off);
      assert.deepEqual(repl(withNativeRow(weaker, [native("gpt-6.1-sol", undefined, false)], codeMode, route)), { disabled: true, review: false }, "each field is judged on its own");
    }
    assert.deepEqual(repl(withNativeRow(weaker, [native("gpt-6.1-sol", false, undefined)], codeMode, served)), { disabled: false, review: true }, "an unstated flag requires review, which runs here");
    assert.deepEqual(repl(withNativeRow(weaker, [native("gpt-6.1-sol", false, undefined)], codeMode)), off);
  }
});

test("the native review fields guardian, auto_review_model_override and requires_sandboxed_review are copied", () => {
  const [row] = published(sol);
  const guardian = { computer_use: "adaptive", shell: "synchronous" };
  for (const codeMode of modes) {
    const source = native("gpt-6.1-sol", false, false, { guardian, auto_review_model_override: "gpt-5.6-luna", requires_sandboxed_review: true });
    const copied = withNativeRow(row, [source], codeMode, served);
    assert.deepEqual(copied.guardian, guardian); assert.notEqual(copied.guardian, guardian);
    assert.equal(copied.auto_review_model_override, "gpt-5.6-luna"); assert.equal(copied.requires_sandboxed_review, true);
    assert.deepEqual(repl(copied), on, "a guardian policy that reviews computer use overrides the flag; node_repl stays on where the reviewer runs");
    assert.deepEqual(repl(withNativeRow(row, [source], codeMode)), { disabled: true, review: false }, "and off where it cannot");
    // A guardian policy that omits computer use skips its review, as natively (the flag is only the older transport).
    assert.deepEqual(repl(withNativeRow(row, [native("gpt-6.1-sol", false, true, { guardian: { shell: "synchronous" } })], codeMode)), { disabled: false, review: true });
    const nulls = withNativeRow(row, [native("gpt-6.1-sol", false, false)], codeMode);
    assert.deepEqual([nulls.guardian, nulls.auto_review_model_override, nulls.requires_sandboxed_review], [null, null, false]);
    assert.deepEqual(repl(nulls), on, "a null guardian, as on every real row, leaves the flag in charge");
    // Values that are not plainly typed are never copied.
    const odd = withNativeRow(row, [native("gpt-6.1-sol", false, false, { guardian: "all", auto_review_model_override: 7, requires_sandboxed_review: "yes" })], codeMode, served);
    for (const key of ["guardian", "auto_review_model_override", "requires_sandboxed_review"]) assert.equal(Object.hasOwn(odd, key), false, key);
    assert.deepEqual(repl(odd), off, "a guardian that is not copied leaves the flag to require review, and an override that is not a model name cannot be shown to run");
  }
});

test("rows without a native counterpart take the strictest policy among the native rows", () => {
  const policy = (disabled: boolean, review: boolean, requires_sandboxed_review?: true) => ({ node_repl_disabled: disabled, node_repl_auto_review_required: review, ...(requires_sandboxed_review ? { requires_sandboxed_review } : {}) });
  assert.deepEqual(nodeReplFallback([lax]), policy(false, false));
  assert.deepEqual(nodeReplFallback([lax, strict]), policy(true, true), "any native row that requires review requires it, and the row gets no reviewer, so node_repl stays off");
  assert.deepEqual(nodeReplFallback([lax, native("off", true, false)]), policy(true, false), "off when any native row is off");
  assert.deepEqual(nodeReplFallback([lax, native("odd", false, "yes")]), policy(true, true), "an ambiguous field counts as required");
  assert.deepEqual(nodeReplFallback([lax, bare]), policy(true, true), "fields absent from a native row count as the stricter value");
  assert.deepEqual(nodeReplFallback([lax, native("guarded", false, false, { guardian: { computer_use: "synchronous" } })]), policy(true, true), "a guardian that reviews computer use makes review required on a row that has only the flag");
  assert.deepEqual(nodeReplFallback([lax, native("gpt-y", false, true, { guardian: { shell: "synchronous" } })]), policy(true, true), "a native flag set to true is required even where that row's guardian skips computer-use review");
  assert.deepEqual(nodeReplFallback([lax, native("sandboxed", false, false, { requires_sandboxed_review: true })]), policy(false, false, true), "sandboxed review carries over");
  assert.deepEqual(nodeReplFallback([]), policy(true, true), "with no native rows both are the strictest");
  assert.deepEqual(nodeReplFallback([native("a", false, false), native("b", false, false), native("c", false, false)]), policy(false, false), "no native row requires review");
});

test("Claude rows and Codex rows with a missing upstream are never weaker than the native rows, in snapshot, current and combined", () => {
  const next = { "codex/next": "gpt-9" };
  const providers = [codex({ "codex/sol": "gpt-6.1-sol", "codex/luna": "gpt-5.6-luna", ...next }), claude];
  const names = ["codex/sol", "codex/luna", "codex/next", "claude/opus"];
  const expected = (sol: object, reviewer: object, rest: object) => ({ "codex/sol": sol, "codex/luna": reviewer, "codex/next": rest, "claude/opus": rest });
  for (const codeMode of modes) {
    for (const carried of [false, true]) {
      // current() holds the gateway rows; combined() puts the native rows in front of them.
      const run = (list: Row[], ...use: ProviderConfig[]) => {
        const catalog = desktop(list, codeMode, ...use);
        return Object.fromEntries(Object.entries(bySlug(carried ? catalog.combined().models.slice(list.length) : catalog.current().models)).filter(([name]) => names.includes(name)));
      };
      const at = (list: Row[], want: object) => assert.deepEqual(run(list, ...providers), want, `${codeMode} ${carried}`);
      const guarded = native("gpt-y", false, true, { guardian: { shell: "synchronous" } });
      at([lax, strict, luna], expected({ disabled: false, review: true }, on, off));
      at([native("gpt-6.1-sol", false, false), native("gpt-6.2", false, true), luna], expected(on, on, off));
      at([native("gpt-6.1-sol", false, false), native("gpt-6.2", false, false), luna], expected(on, on, on));
      at([native("gpt-6.1-sol", false, false), native("gpt-6.2", true, false), luna], expected(on, on, { disabled: true, review: false }));
      // A fallback row has no guardian, so a flag set on any native row requires review, and the row stays off.
      at([strict, guarded, luna], expected({ disabled: false, review: true }, on, off));
      assert.deepEqual(Object.values(run([], ...providers)), [off, off, off, off], "no native catalog");
      // The reviewer is not served, so review-required Codex 2 rows are off as well.
      const unserved = run([lax, strict, luna], codex({ "codex/sol": "gpt-6.1-sol", ...next }), claude);
      assert.deepEqual(unserved, { "codex/sol": off, "codex/next": off, "claude/opus": off });
    }
  }
});

test("a fallback row keeps node_repl off and receives none of the native confirmation or classifier policy", () => {
  // Claude, Copilot and API rows have no confirmation_policies or guardian_v2, so a strict row's review flag alone would leave them weaker.
  for (const codeMode of modes) {
    const catalog = desktop([strict, lax, luna], codeMode, solLuna, claude);
    const claudeRow = catalog.combined().models.find(row => row.slug === "claude/opus")!;
    assert.deepEqual(claudeRow.model_messages, { instructions_template: "" });
    assert.deepEqual(repl(claudeRow), off);
  }
});

test("combined() gives the native rows the Codex 2 rule: both fields kept where the reviewer runs, node_repl off where it cannot, whether code mode is on or off", () => {
  const reviewer = native("codex-auto-review", false, false, { visibility: "hide", model_messages: { instructions_template: "", auto_review: { node_repl_policy: "reviewer text" } } });
  const guarded = native("gpt-guarded", false, false, { guardian: { computer_use: "synchronous" } });
  const rows = [strict, lax, { ...bare, slug: "gpt-bare" }, guarded, reviewer];
  const before = structuredClone(rows);
  const slugs = rows.map(row => row.slug);
  for (const codeMode of modes) {
    for (const [providers, want] of [
      [[solLuna, claude], [["gpt-6.1-sol", false, true], ["gpt-6-luna", false, false], ["gpt-bare", true, true], ["gpt-guarded", false, false], ["codex-auto-review", false, false]]],
      [[sol, claude], [["gpt-6.1-sol", true, true], ["gpt-6-luna", false, false], ["gpt-bare", true, true], ["gpt-guarded", true, false], ["codex-auto-review", false, false]]],
    ] as const) {
      const combined = desktop([...rows, luna], codeMode, ...providers).combined().models;
      assert.deepEqual(combined.filter(row => slugs.includes(row.slug)).map(row => [row.slug, row.node_repl_disabled, row.node_repl_auto_review_required]), want, `${codeMode} ${providers.length}: a row that states no policy gets node_repl off, as a Codex 2 row for it does`);
      assert.deepEqual(combined.find(row => row.slug === "codex-auto-review"), { ...reviewer, tool_mode: codeMode ? "code_mode_only" : "direct" }, "the reviewer row is carried unchanged apart from the executor tool mode");
      assert.equal(combined[0].tool_mode, codeMode ? "code_mode_only" : "direct", "only tool_mode depends on code mode");
    }
  }
  assert.deepEqual(rows, before, "the native rows are never modified");
  assert.deepEqual(executorNativeRow(strict), { ...strict, node_repl_disabled: true });
  assert.equal(executorNativeRow(strict, served), strict, "a plain policy whose reviewer runs is carried as it is");
  assert.equal(executorNativeRow(lax), lax);
});

test("a Codex 2 row and the native row it serves get one node_repl policy in the executor catalog, whether code mode is on or off", () => {
  const sources = [bare, native("gpt-6.1-sol", "false", null), native("gpt-6.1-sol", false, undefined), native("gpt-6.1-sol", undefined, false), strict, { ...lax, slug: "gpt-6.1-sol" },
    native("gpt-6.1-sol", false, false, { guardian: { computer_use: "synchronous" } }), native("gpt-6.1-sol", false, true, { guardian: { shell: "synchronous" } }),
    native("gpt-6.1-sol", false, false, { guardian: "all" }), native("gpt-6.1-sol", false, true, { auto_review_model_override: "gpt-6-luna" })];
  for (const codeMode of modes) {
    for (const providers of [[sol], [solLuna]]) {
      for (const source of sources) {
        const [carried, , sol2] = desktop([source, luna], codeMode, ...providers).combined().models;
        assert.equal(carried.slug, "gpt-6.1-sol"); assert.equal(sol2.slug, "codex/sol");
        assert.deepEqual(repl(carried), repl(sol2), `${codeMode} ${providers.length} ${JSON.stringify(source)}`);
      }
    }
    const [carried] = desktop([bare], codeMode, solLuna).combined().models;
    assert.deepEqual(repl(carried), off, "a bare upstream gets the stricter value on both rows");
    // Where the reviewer runs, a review-required model keeps node_repl on in both rows, as natively; where it does not, in neither.
    for (const [providers, want] of [[[solLuna], { disabled: false, review: true }], [[sol], off]] as const) {
      const [native, , gateway] = desktop([strict, luna], codeMode, ...providers).combined().models;
      assert.deepEqual([repl(native), repl(gateway)], [want, want], `${codeMode} ${providers.length}`);
    }
  }
});

test("guardian shapes decide review the same way through withNativeRow, executorNativeRow and nodeReplFallback, whether code mode is on or off", () => {
  const unreviewed = { disabled: false, review: true }, blocked = { disabled: true, review: false }, flagged = { disabled: true, review: true };
  // [guardian, node_repl_disabled, node_repl_auto_review_required] -> [Codex 2 row, native row in the executor catalog, fallback row]
  type Case = [unknown, boolean, boolean, object, object, object, string];
  const none: Case[] = [ // no reviewer runs in this executor
    [null, false, false, on, on, on, "a null guardian, as on every real row, leaves the flag in charge"],
    [null, false, true, flagged, flagged, flagged, "a null guardian with the flag set needs review, which cannot run here"],
    [{ computer_use: "disabled" }, false, true, unreviewed, unreviewed, flagged, "a guardian that turns computer-use review off overrides the flag where it travels; a fallback row has only the flag"],
    [{ computer_use: "disabled" }, false, false, on, on, on, "a guardian that turns computer-use review off"],
    [{ computer_use: null }, false, false, on, on, on, "a null computer_use mode is no review, as in the SDK's review_mode"],
    [{ computer_use: null }, false, true, unreviewed, unreviewed, flagged, "a null computer_use mode skips review even with the flag set"],
    [{ shell: "synchronous" }, false, false, on, on, on, "a guardian without a computer_use mode skips computer-use review"],
    [{ computer_use: "adaptive" }, false, false, blocked, blocked, flagged, "a guardian that reviews computer use, with no reviewer to run it; a fallback row's flag then requires it"],
    ["all", false, false, flagged, flagged, flagged, "a guardian that is not an object cannot be shown to skip review, and is not copied, so the flag requires it"],
    [[], false, false, flagged, flagged, flagged, "an array guardian cannot be shown to skip review"],
  ];
  const runs: Case[] = [ // the reviewer runs
    [null, false, false, on, on, on, "a null guardian leaves the flag in charge"],
    [null, false, true, unreviewed, unreviewed, flagged, "the flag is copied and node_repl stays on, as natively; a fallback row gets no reviewer and stays off"],
    [{ computer_use: "disabled" }, false, true, unreviewed, unreviewed, flagged, "a guardian that turns computer-use review off"],
    [{ computer_use: null }, false, false, on, on, on, "a null computer_use mode is no review"],
    [{ computer_use: null }, false, true, unreviewed, unreviewed, flagged, "a null computer_use mode skips review even with the flag set"],
    [{ computer_use: "adaptive" }, false, false, on, on, flagged, "a guardian that reviews computer use is copied with the row, so node_repl stays on"],
    ["all", false, false, unreviewed, unreviewed, flagged, "a guardian that is not an object is not copied, so the flag must require the review the reviewer runs"],
    [[], false, false, unreviewed, unreviewed, flagged, "an array guardian"],
    [null, true, false, blocked, blocked, blocked, "a native row that turns node_repl off"],
  ];
  const [row] = published(sol);
  for (const codeMode of modes) {
    for (const [cases, route, providers, natives] of [[none, undefined, [sol, claude], [] as Row[]], [runs, served, [solLuna, claude], [luna]]] as const) {
      for (const [guardian, disabled, review, gateway, carried, fallback, why] of cases) {
        const source = native("gpt-6.1-sol", disabled, review, { guardian });
        assert.deepEqual(repl(withNativeRow(row, [source], codeMode, route)), gateway, `${codeMode} withNativeRow: ${why}`);
        assert.deepEqual(repl(executorNativeRow(source, route)), carried, `executorNativeRow: ${why}`);
        assert.deepEqual(repl(nodeReplFallback([source])), fallback, `nodeReplFallback: ${why}`);
        const models = desktop([source, ...natives], codeMode, ...providers).combined().models.filter(entry => ["gpt-6.1-sol", "codex/sol", "claude/opus"].includes(String(entry.slug)));
        assert.deepEqual(models.map(entry => [entry.slug, repl(entry)]), [["gpt-6.1-sol", carried], ["codex/sol", gateway], ["claude/opus", fallback]], `${codeMode} combined(): ${why}`);
      }
    }
  }
});

test("a host row that publishes a weaker node_repl policy cannot lower the combined catalog", async () => {
  const f = await shimFiles();
  try {
    f.value.providers = [solLuna, claude];
    const weaker = modelCatalog(f.value); weaker.models = weaker.models.map(row => ({ ...row, node_repl_disabled: false, node_repl_auto_review_required: false })); f.setCatalog(weaker);
    const path = join(f.directory, "combined.json");
    await new DesktopCatalog(f.value, [strict, lax, luna], path, true).refresh(true);
    const rows = bySlug(JSON.parse(await readFile(path, "utf8")).models);
    assert.deepEqual([rows["codex/sol"], rows["codex/luna"], rows["claude/opus"]], [{ disabled: false, review: true }, on, off]);
    const cache = JSON.parse(await readFile(join(f.value.stateDirectory, "desktop-public-models.json"), "utf8"));
    assert.equal(cache.models.every((row: Row) => "node_repl_auto_review_required" in row), true, "the public cache keeps the auto review field the host published");
  } finally { f.close(); }
});
