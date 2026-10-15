import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { modelCatalog } from "../catalog.js";
import { autoReviewModels, isAutoReviewModel, readAutoReviewAdvertisement } from "../auto-review.js";
import { noReviewers, nodeReplFallback, sharedReviewMessages, withFallback } from "../codex-native-rows.js";
import { DesktopCatalog } from "../desktop-catalog.js";
import type { GatewayConfig, ProviderConfig } from "../config.js";
import { shimFiles } from "./shim-fixture.js";

type Row = Record<string, unknown>;
// The native catalog as ChatGPT 26.1007 ships it (models_cache.json 0.162.0): the 6.x rows share the confirmation and
// classifier texts, the 5.x rows have none; codex-auto-review is hidden, offered to API-key auth and carries the review text.
const confirmation = { browser_use: "native browser confirmations", computer_use: "native computer confirmations" };
const classifier = { classifier_instructions: "Predict whether the agent's computer and browser activity needs blocking security review" };
const six = (slug: string, review: boolean): Row => ({ slug, supported_in_api: true, tool_mode: "code_mode_only", node_repl_disabled: false, node_repl_auto_review_required: review, guardian: null, auto_review_model_override: null,
  model_messages: { instructions_template: `${slug} prompt`, confirmation_policies: structuredClone(confirmation), guardian_v2: structuredClone(classifier), auto_review: { rejection_instructions: "no" } } });
const five = (slug: string): Row => ({ slug, supported_in_api: true, tool_mode: "direct", node_repl_disabled: false, node_repl_auto_review_required: false, guardian: null, auto_review_model_override: null, model_messages: { instructions_template: `${slug} prompt` } });
const reviewer: Row = { ...five("codex-auto-review"), visibility: "hide", model_messages: { instructions_template: "", auto_review: { policy: "native policy", policy_template: "native template", node_repl_policy: "native reviewer text" } } };
const natives = (): Row[] => [six("gpt-6.1-sol", true), six("gpt-6-astra", true), six("gpt-6-sol", true), six("gpt-6-luna", false), five("gpt-5.6-sol"), five("gpt-5.6-luna"), reviewer];
const codex = (models: Record<string, string>): ProviderConfig => ({ id: "codex", type: "codex-subscription", label: "Codex 2", models, modelMetadata: Object.fromEntries(Object.keys(models).map(alias => [alias, { reasoningEfforts: ["low"] }])) });
const codexAll = codex({ "codex/sol": "gpt-6.1-sol", "codex/astra": "gpt-6-astra", "codex/gsol": "gpt-6-sol", "codex/luna": "gpt-6-luna", "codex/five": "gpt-5.6-sol", "codex/five-luna": "gpt-5.6-luna", "codex/next": "gpt-9" });
const claude: ProviderConfig = { id: "claude", type: "claude-subscription", models: { "claude/opus": "opus", "claude/sonnet": "sonnet" } };
const repl = (row: Row) => ({ disabled: row.node_repl_disabled, review: row.node_repl_auto_review_required });
const [on, off, unreviewed] = [{ disabled: false, review: false }, { disabled: true, review: true }, { disabled: false, review: true }];
const advertise = ["codex-auto-review"];

async function live(rows: Row[], providers: ProviderConfig[], advertised: unknown, codeMode = true) {
  const f = await shimFiles(); f.value.providers = providers;
  f.setCatalog(Object.assign(modelCatalog(f.value), advertised === undefined ? {} : { auto_review: advertised }));
  const path = join(f.directory, "combined.json");
  const catalog = new DesktopCatalog(f.value, rows, path, codeMode);
  return { f, path, catalog, read: () => catalog.refresh(true), policies: () => Object.fromEntries(catalog.combined().models.map(row => [row.slug, repl(row)])) };
}

test("the advertisement parser keeps only allowlisted reviewer slugs and treats any other shape as none", () => {
  assert.deepEqual(autoReviewModels, ["codex-auto-review"]);
  assert.equal(isAutoReviewModel("codex-auto-review"), true);
  for (const other of ["gpt-5.6-luna", "codex-auto-review-2", "Codex-Auto-Review", "", 7, null]) assert.equal(isAutoReviewModel(other), false, String(other));
  assert.deepEqual([...readAutoReviewAdvertisement({ models: advertise })], advertise);
  assert.deepEqual([...readAutoReviewAdvertisement({ models: ["gpt-5.6-luna", "codex-auto-review"] })], advertise, "other slugs are dropped, never routed");
  assert.deepEqual([...readAutoReviewAdvertisement({ models: ["gpt-5.6-luna"] })], []);
  const nine = Array.from({ length: 9 }, () => "codex-auto-review");
  for (const bad of [undefined, null, "codex-auto-review", [], ["codex-auto-review"], {}, { models: "codex-auto-review" }, { models: nine }, { models: [7, "codex-auto-review"] }, { models: [{ slug: "codex-auto-review" }] }]) {
    assert.deepEqual([...readAutoReviewAdvertisement(bad)], [], JSON.stringify(bad));
  }
});

test("with the reviewer advertised every row has node_repl on; review is required exactly where it is natively, and by every row without a native counterpart", async () => {
  for (const codeMode of [true, false]) {
    const run = await live(natives(), [codexAll, claude], { models: advertise }, codeMode);
    try {
      await run.read();
      const rows = run.policies();
      for (const slug of ["codex/sol", "codex/astra", "codex/gsol", "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol"]) assert.deepEqual(rows[slug], unreviewed, slug);
      for (const slug of ["codex/luna", "codex/five", "codex/five-luna", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna", "codex-auto-review"]) assert.deepEqual(rows[slug], on, slug);
      for (const slug of ["codex/next", "claude/opus", "claude/sonnet"]) assert.deepEqual(rows[slug], unreviewed, `${slug} has no native counterpart, so it requires review`);
    } finally { run.f.close(); }
  }
});

test("without a live advertisement the review-required rows and every fallback row keep node_repl off, and the other rows stay on", async () => {
  for (const advertised of [undefined, { models: [] }, { models: ["gpt-5.6-luna"] }, { models: "codex-auto-review" }, null]) {
    const run = await live(natives(), [codexAll, claude], advertised);
    try {
      await run.read();
      const rows = run.policies();
      for (const slug of ["codex/sol", "codex/astra", "codex/gsol", "gpt-6.1-sol", "codex/next", "claude/opus", "claude/sonnet"]) assert.deepEqual(rows[slug], off, `${JSON.stringify(advertised)} ${slug}`);
      for (const slug of ["codex/luna", "codex/five", "gpt-6-luna", "gpt-5.6-sol", "codex-auto-review"]) assert.deepEqual(rows[slug], on, `${JSON.stringify(advertised)} ${slug}`);
    } finally { run.f.close(); }
  }
});

test("the reviewer row must be in the native catalog and offered to API-key auth, or review-required rows stay off", async () => {
  for (const rows of [natives().filter(row => row.slug !== "codex-auto-review"), natives().map(row => row.slug === "codex-auto-review" ? { ...row, supported_in_api: false } : row),
    natives().map(row => row.slug === "codex-auto-review" ? { ...row, supported_in_api: "true" } : row), natives().map(row => row.slug === "codex-auto-review" ? (({ supported_in_api: _gone, ...rest }) => rest)(row) : row)]) {
    const run = await live(rows, [codexAll, claude], { models: advertise });
    try {
      await run.read(); const policies = run.policies();
      assert.deepEqual([policies["codex/sol"], policies["claude/opus"], policies["codex/luna"]], [off, off, on]);
    } finally { run.f.close(); }
  }
});

test("an override naming a reviewer the host does not advertise keeps node_repl off for that row only", async () => {
  const rows = natives().map(row => row.slug === "gpt-6-astra" ? { ...row, auto_review_model_override: "gpt-6-luna" } : row.slug === "gpt-6-sol" ? { ...row, auto_review_model_override: "codex-auto-review" } : row.slug === "gpt-6.1-sol" ? { ...row, auto_review_model_override: 7 } : row);
  const run = await live(rows, [codexAll, claude], { models: advertise });
  try {
    await run.read(); const policies = run.policies();
    assert.deepEqual([policies["codex/astra"], policies["codex/gsol"], policies["codex/sol"]], [off, unreviewed, off]);
    assert.deepEqual(policies["gpt-6-astra"], off); assert.deepEqual(policies["gpt-6-sol"], unreviewed);
  } finally { run.f.close(); }
});

test("fallback rows get the native confirmation and classifier texts as clones, none when no row has them, and nothing when the rows disagree", () => {
  const six1 = six("gpt-6.1-sol", true), five1 = five("gpt-5.6-sol");
  const sol = (): Row => structuredClone(six1);
  const fallbackOf = (rows: Row[], reviewers: ReadonlySet<string> = new Set(advertise)) => withFallback({ slug: "claude/opus", model_messages: { instructions_template: "" } }, nodeReplFallback(rows, reviewers));
  const withText = fallbackOf([six1, five1, reviewer]);
  assert.deepEqual(withText.model_messages, { instructions_template: "", confirmation_policies: confirmation, guardian_v2: classifier });
  assert.notEqual((withText.model_messages as Row).confirmation_policies, (six1.model_messages as Row).confirmation_policies, "cloned, not shared");
  assert.deepEqual(repl(withText), unreviewed);
  // Equal values with another key order are the same value.
  const reordered = sol(); (reordered.model_messages as Row).confirmation_policies = { computer_use: confirmation.computer_use, browser_use: confirmation.browser_use };
  assert.deepEqual(repl(fallbackOf([six1, reordered, reviewer])), unreviewed);
  // None present: the fields are left out and node_repl is still on.
  const plain = fallbackOf([five1, reviewer]);
  assert.deepEqual(plain.model_messages, { instructions_template: "" }); assert.deepEqual(repl(plain), unreviewed);
  // Disagreement on either text: nothing is shared and node_repl is off.
  for (const key of ["confirmation_policies", "guardian_v2"]) {
    const other = sol(); (other.model_messages as Row)[key] = { different: true };
    const conflict = fallbackOf([six1, other, reviewer]);
    assert.deepEqual(conflict.model_messages, { instructions_template: "" }, key); assert.deepEqual(repl(conflict), off, key);
  }
  assert.equal(sharedReviewMessages([six1, { ...sol(), model_messages: { instructions_template: "", confirmation_policies: null } }]).conflict, false, "null is no value");
  // A native row that turns node_repl off, states no policy, or an empty catalog; no reviewer; and a sandboxed-review requirement.
  assert.deepEqual(repl(fallbackOf([six1, { ...five1, node_repl_disabled: true }, reviewer])), off);
  assert.deepEqual(repl(fallbackOf([six1, { slug: "bare" }, reviewer])), off);
  assert.deepEqual(repl(fallbackOf([])), off);
  assert.deepEqual(repl(fallbackOf([six1, reviewer], noReviewers)), off);
  assert.deepEqual(repl(fallbackOf([six1, { ...reviewer, supported_in_api: false }])), off);
  assert.equal(fallbackOf([six1, { ...five1, requires_sandboxed_review: true }, reviewer]).requires_sandboxed_review, true);
  assert.equal(Object.hasOwn(fallbackOf([six1, reviewer]), "guardian"), false, "a fallback row never gets a guardian");
});

test("a conflict between native rows turns the fallback rows off in the combined catalog and shares nothing", async () => {
  const rows = natives().map(row => row.slug === "gpt-6-sol" ? { ...row, model_messages: { ...(row.model_messages as Row), guardian_v2: { classifier_instructions: "different" } } } : row);
  const run = await live(rows, [codexAll, claude], { models: advertise });
  try {
    await run.read();
    const combined = run.catalog.combined().models; const claudeRow = combined.find(row => row.slug === "claude/opus")!;
    assert.deepEqual(repl(claudeRow), off); assert.deepEqual(claudeRow.model_messages, { instructions_template: "" });
    assert.deepEqual(repl(combined.find(row => row.slug === "codex/sol")!), unreviewed, "rows with a native counterpart are unaffected");
  } finally { run.f.close(); }
});

test("a guardian on any native row turns node_repl off for every fallback row, whether code mode is on or off", async () => {
  // A fallback row cannot mirror a guardian (computer-use mode, scoring, other scopes), so it takes the stricter choice.
  for (const guardian of [{ computer_use: "adaptive" }, { computer_use: "disabled" }, { computer_use: null }, { shell: "synchronous" }, "all", []]) {
    for (const codeMode of [true, false]) {
      const rows = natives().map(row => row.slug === "gpt-6-luna" ? { ...row, guardian } : row);
      const run = await live(rows, [codexAll, claude], { models: advertise }, codeMode);
      try {
        // An older host that omits upstream_slug on a Codex row: that row has no native counterpart either.
        run.f.setCatalog(Object.assign(modelCatalog(run.f.value), { auto_review: { models: advertise } }, { models: modelCatalog(run.f.value).models.map(row => row.slug === "codex/five" ? (({ upstream_slug: _gone, ...rest }) => rest)(row) : row) }));
        await run.read(); const policies = run.policies(); const why = `${JSON.stringify(guardian)} ${codeMode}`;
        for (const slug of ["claude/opus", "claude/sonnet", "codex/next", "codex/five"]) assert.deepEqual(policies[slug], off, `${slug} ${why}`);
        assert.deepEqual(policies["codex/sol"], unreviewed, `rows with a native counterpart keep their own policy ${why}`);
        assert.deepEqual(policies["codex/five-luna"], on, why);
      } finally { run.f.close(); }
      assert.deepEqual(repl(withFallback({}, nodeReplFallback(rows, new Set(advertise)))), off, `nodeReplFallback ${JSON.stringify(guardian)}`);
    }
  }
  // A null guardian, as on every real row, is no guardian.
  assert.deepEqual(repl(withFallback({}, nodeReplFallback(natives(), new Set(advertise)))), unreviewed);
});

test("Claude rows get the native 6.x texts; the reviewer and luna rows equal the native rows, and no native row is modified", async () => {
  const rows = natives(); const before = structuredClone(rows);
  for (const codeMode of [true, false]) {
    const run = await live(rows, [codexAll, claude], { models: advertise }, codeMode);
    try {
      await run.read();
      const combined = run.catalog.combined().models; const row = (slug: string) => combined.find(entry => entry.slug === slug)!;
      assert.deepEqual((row("claude/opus").model_messages as Row), { instructions_template: "", confirmation_policies: confirmation, guardian_v2: classifier });
      for (const slug of ["codex-auto-review", "gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-sol"]) {
        const { tool_mode: _executor, ...carried } = row(slug); const { tool_mode: _native, ...source } = rows.find(entry => entry.slug === slug)!;
        assert.deepEqual(carried, source, `${slug}: carried unchanged, no review text injected`);
      }
      assert.deepEqual(row("codex-auto-review").model_messages, reviewer.model_messages);
      assert.deepEqual(row("gpt-5.6-luna").model_messages, five("gpt-5.6-luna").model_messages, "luna is not given the reviewer's text");
    } finally { run.f.close(); }
  }
  assert.deepEqual(rows, before);
});

test("lifecycle: a restored cache keeps node_repl off, a live read turns it on, a failed read keeps the last value, and a source change resets it", async () => {
  const run = await live(natives(), [codexAll, claude], { models: advertise });
  try {
    const first = await run.read();
    assert.deepEqual(run.policies()["codex/sol"], unreviewed);
    const written = async () => Object.fromEntries(JSON.parse(await readFile(run.path, "utf8")).models.map((row: Row) => [row.slug, repl(row)]));
    assert.deepEqual((await written())["claude/opus"], unreviewed);
    // A new process restores the public rows from the cache; that does not prove the reviewer is reachable now.
    const restarted = new DesktopCatalog(run.f.value, natives(), run.path, true);
    await restarted.initialize();
    assert.deepEqual((await written())["codex/sol"], off); assert.deepEqual((await written())["claude/opus"], off); assert.deepEqual((await written())["codex/luna"], on);
    assert.notEqual(restarted.current().revision, first.revision, "the reviewers are part of the generation");
    const second = await restarted.refresh(true);
    assert.equal(second.revision, first.revision); assert.deepEqual((await written())["codex/sol"], unreviewed, "the live read rewrites the combined file");
    // The host stops advertising: the next successful read turns the rows off again.
    run.f.setCatalog(modelCatalog(run.f.value));
    assert.deepEqual(repl((await restarted.refresh(true)).models.find(row => row.slug === "codex/sol")!), off);
    run.f.setCatalog(Object.assign(modelCatalog(run.f.value), { auto_review: { models: advertise } }));
    await restarted.refresh(true);
    assert.deepEqual(repl(restarted.current().models.find(row => row.slug === "codex/sol")!), unreviewed);
    // A failed read keeps the last snapshot (the SDK still declines an action whose review fails).
    const kept = restarted.current(); run.f.close();
    await assert.rejects(restarted.refresh(true));
    assert.equal(restarted.current(), kept);
    assert.equal(await restarted.refresh(false), kept, "a non-strict refresh also keeps it");
    // A different token is a different source: the reviewers are forgotten before the new host is asked.
    await writeFile(join(run.f.value.stateDirectory, "client-token"), "other-gateway-token-" + "y".repeat(32), { mode: 0o600 });
    await assert.rejects(restarted.refresh(true));
    assert.deepEqual(repl(restarted.current().models.find(row => row.slug === "codex/sol")!), off);
    assert.notEqual(restarted.current().revision, kept.revision);
  } finally { run.f.close(); }
});

test("the revision changes when only the reviewers change", async () => {
  const lax = codex({ "codex/luna": "gpt-6-luna" });
  const advertised = await live(natives(), [lax], { models: advertise }); const plain = await live(natives(), [lax], undefined);
  try {
    const [a, b] = [await advertised.read(), await plain.read()];
    // The published gateway rows serialize identically, so only the native rows carried for sub-agents can tell the generations apart.
    assert.equal(JSON.stringify(a.models), JSON.stringify(b.models), "the published rows are identical");
    const executorRows = (run: typeof advertised, snapshot: typeof a) => run.catalog.combined(snapshot).models.slice(0, natives().length).map(repl);
    assert.notDeepEqual(executorRows(advertised, a), executorRows(plain, b), "the executor's native rows differ");
    assert.notEqual(a.revision, b.revision, "so the generation must differ");
  } finally { advertised.f.close(); plain.f.close(); }
});
