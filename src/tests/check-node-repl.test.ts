import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      "reviewer codex-auto-review: missing",
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
    assert.deepEqual(run.stdout.trim().split("\n"), ["3 entry(ies) that are not rows were ignored.", "disabled=false auto_review_required=true a", "0 of 1 row(s) keep node_repl disabled.", "0 of 1 row(s) enable node_repl without requiring auto review.", "reviewer codex-auto-review: missing"]);
    assert.equal(check().status, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("check-node-repl reports whether the reviewer row is present, offered to API-key auth, and carries its review text", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-node-repl-"));
  try {
    const last = async (reviewer: object) => {
      const file = join(root, "reviewer.json"); await writeFile(file, JSON.stringify({ models: [{ slug: "a", node_repl_disabled: false, node_repl_auto_review_required: false }, { slug: "codex-auto-review", ...reviewer }] }));
      return check(file).stdout.trim().split("\n").at(-1);
    };
    const messages = (node_repl_policy: unknown) => ({ model_messages: { instructions_template: "", auto_review: { node_repl_policy } } });
    assert.equal(await last({ supported_in_api: true, ...messages("reviewer text") }), "reviewer codex-auto-review: supported_in_api=true node_repl_policy=present");
    assert.equal(await last({ supported_in_api: false, ...messages("reviewer text") }), "reviewer codex-auto-review: supported_in_api=false node_repl_policy=present");
    assert.equal(await last({ ...messages("reviewer text") }), "reviewer codex-auto-review: supported_in_api=missing node_repl_policy=present");
    assert.equal(await last({ supported_in_api: true, model_messages: { instructions_template: "" } }), "reviewer codex-auto-review: supported_in_api=true node_repl_policy=missing");
    assert.equal(await last({ supported_in_api: true, ...messages("") }), "reviewer codex-auto-review: supported_in_api=true node_repl_policy=missing");
    assert.equal(await last({ supported_in_api: "true", model_messages: "x" }), 'reviewer codex-auto-review: supported_in_api="true" node_repl_policy=missing');
  } finally { await rm(root, { recursive: true, force: true }); }
});
