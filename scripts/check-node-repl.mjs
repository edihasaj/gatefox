// Manual live check (never run against installed apps by CI): pass a model/list JSON file.
// Usage: node scripts/check-node-repl.mjs combined-catalog.json
import { readFileSync } from "node:fs";
const models = JSON.parse(readFileSync(process.argv[2], "utf8")).models ?? [];
const bad = models.filter(m => m.node_repl_disabled !== false);
for (const m of models) console.log(`${m.node_repl_disabled === false ? "enabled " : "disabled"} ${m.slug}`);
if (bad.length) { console.error(`${bad.length} row(s) keep node_repl disabled; expected only on executors without codex-code-mode-host.`); process.exitCode = 1; }
