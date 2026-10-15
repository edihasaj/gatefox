// Advisory report (never a gate, never run against installed apps by CI): it always exits 0.
// Pass a COPY of the combined catalog.json from an executor home, never the installed app's live state.
// Usage: node scripts/check-node-repl.mjs combined-catalog.json
import { readFileSync } from "node:fs";
const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/check-node-repl.mjs <copy-of-combined-catalog.json>"); process.exit(0); }
const models = JSON.parse(readFileSync(file, "utf8")).models ?? [];
const show = value => value === undefined ? "missing" : String(value);
for (const m of models) console.log(`disabled=${show(m.node_repl_disabled)} auto_review_required=${show(m.node_repl_auto_review_required)} ${m.slug}`);
console.log(`${models.filter(m => m.node_repl_disabled !== false).length} of ${models.length} row(s) keep node_repl disabled.`);
// A native row may enable node_repl without auto review; a gateway row must not unless its native row does.
console.log(`${models.filter(m => m.node_repl_disabled === false && m.node_repl_auto_review_required !== true).length} of ${models.length} row(s) enable node_repl without requiring auto review.`);
