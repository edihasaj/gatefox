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
for (const m of rows) console.log(`disabled=${show(m.node_repl_disabled)} auto_review_required=${show(m.node_repl_auto_review_required)} ${show(m.slug)}`);
console.log(`${rows.filter(m => m.node_repl_disabled !== false).length} of ${rows.length} row(s) keep node_repl disabled.`);
// A native row may enable node_repl without auto review; a gateway row must not unless its native row does.
console.log(`${rows.filter(m => m.node_repl_disabled === false && m.node_repl_auto_review_required !== true).length} of ${rows.length} row(s) enable node_repl without requiring auto review.`);
