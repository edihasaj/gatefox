import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { configPath } from "./paths.js";
import { readActivity } from "./activity.js";

export async function activityCommand(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    config: { type: "string" }, "native-home": { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { process.stdout.write("gateway activity [--json] [--config PATH] [--native-home PATH]\nRead-only, bounded activity on this Mac. Recorded outcomes do not prove current liveness.\n"); return 0; }
  const path = resolve(values.config ?? await configPath()), config = await loadConfig(path);
  const report = await readActivity(path, config.stateDirectory, { nativeHome: values["native-home"] ? resolve(values["native-home"]) : undefined });
  if (values.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    process.stdout.write(`${report.hostname} · ${report.coverage} snapshot · ${report.checkedAt}\n`);
    process.stdout.write("Local execution only. Status describes a turn, not completion of the whole task.\n");
    for (const row of report.rows) process.stdout.write(`${row.state.padEnd(11)} ${row.threadId}  ${row.requestedModel ? row.requestedModel + " → " : ""}${row.model ? row.model + "  " : ""}${row.waitingFor ? "waiting for " + row.waitingFor + "; " : ""}${row.turn ? `${row.source === "recorded" ? "recorded " : ""}${row.turn.status}${row.turn.errorClass ? ":" + row.turn.errorClass : ""}` : "no verified turn"}  ${row.turn?.completedAt ? "ended " + row.turn.completedAt : "observed " + row.observedAt}\n`);
    if (report.hasMore) process.stdout.write("More activity exists than this bounded snapshot can display.\n");
    if (report.coverage !== "available") process.stdout.write("Some live state is unavailable; unknown is not finished or failed.\n");
  }
  return report.coverage === "unavailable" ? 1 : 0;
}
