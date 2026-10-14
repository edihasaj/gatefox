// Advisory report (never a gate, never run against installed apps by CI): it always exits 0.
// Pass a COPY of the combined catalog.json from an executor home, never the installed app's live state.
// Usage: node scripts/check-node-repl.mjs combined-catalog.json
import { readFileSync } from "node:fs";
const file = process.argv[2];
if (!file) { console.error("Usage: node scripts/check-node-repl.mjs <copy-of-combined-catalog.json>"); process.exit(0); }
const models = JSON.parse(readFileSync(file, "utf8")).models ?? [];
for (const m of models) console.log(`${m.node_repl_disabled === false ? "enabled " : "disabled"} ${m.slug}`);
console.log(`${models.filter(m => m.node_repl_disabled !== false).length} of ${models.length} row(s) keep node_repl disabled.`);
