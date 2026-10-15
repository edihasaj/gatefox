// Advisory report (never a gate, never run against installed apps by CI): it exits 0, also when the input cannot be read.
// Pass a COPY of the combined catalog.json from an executor home, never the installed app's live state.
// Usage: node scripts/check-node-repl.mjs combined-catalog.json
import { readFileSync } from "node:fs";
const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/check-node-repl.mjs <copy-of-combined-catalog.json>"); process.exit(0); }
let models;
try { models = JSON.parse(readFileSync(file, "utf8")).models; } catch { models = undefined; }
if (!Array.isArray(models)) { console.error(`cannot read a combined catalog from ${file}`); process.exit(0); }
const rows = models.filter(m => m !== null && typeof m === "object" && !Array.isArray(m));
if (rows.length !== models.length) console.log(`${models.length - rows.length} entry(ies) that are not rows were ignored.`);
const show = value => value === undefined ? "missing" : String(value);
// Flags print as JSON, so a string "true", which the SDK does not read as a boolean, stays visible.
const flag = value => value === undefined ? "missing" : JSON.stringify(value);
const set = value => value !== undefined && value !== null;
// The counts follow the SDK's ModelInfo: a missing node_repl_disabled means enabled, and a guardian
// policy, when set, decides review instead of the flag (ModelInfo::computer_use_review_required). A
// guardian that is not an object, or a computer_use mode that is not a string, cannot be shown to
// review, so its row counts as without review.
const disabled = m => m.node_repl_disabled === true;
const reviewed = m => {
  if (!set(m.guardian)) return m.node_repl_auto_review_required === true;
  if (typeof m.guardian !== "object" || Array.isArray(m.guardian)) return false;
  return typeof m.guardian.computer_use === "string" && m.guardian.computer_use !== "disabled";
};
for (const m of rows) console.log(`disabled=${flag(m.node_repl_disabled)} auto_review_required=${flag(m.node_repl_auto_review_required)}${set(m.guardian) ? ` guardian=${JSON.stringify(m.guardian)}` : ""} ${show(m.slug)}`);
console.log(`${rows.filter(disabled).length} of ${rows.length} row(s) keep node_repl disabled.`);
// A native row may enable node_repl without auto review; a gateway row must not unless its native row does.
console.log(`${rows.filter(m => !disabled(m) && !reviewed(m)).length} of ${rows.length} row(s) enable node_repl without requiring auto review.`);
