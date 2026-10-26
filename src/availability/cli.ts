import { resolve } from "node:path";
import { loadConfig, readClientToken } from "../config.js";
import { configPath } from "../paths.js";

export const availabilityUsage = `gateway availability [--json] [--wait MS]
  What this Mac's gateway can serve now: local model health, load, subscription quota, paid balance.
  Facts only; agents still choose their models. Exits 0 whenever it prints a report, including "unknown".
`;
export interface AvailabilityCommandDeps {
  stdout?: (text: string) => void; stderr?: (text: string) => void;
  configPath?: () => Promise<string>; fetch?: typeof fetch;
}
type Row = Record<string, unknown> & { id: string; status: string; reasons?: string[]; load?: { running: number; queued: number; limit: number } };

const percent = (value: unknown) => typeof value === "number" ? `${value}% left` : "";
function line(row: Row): string {
  const quota = row.quota as { remainingPercent?: number; fresh?: boolean; account?: string } | undefined;
  const health = row.health as { status?: string; latencyMs?: number; fresh?: boolean } | undefined;
  const balance = row.balance as { remainingUsd?: number; fresh?: boolean } | undefined;
  const parts = [`${row.id.padEnd(18)} ${row.status.padEnd(11)}`];
  if (row.load) parts.push(`load ${row.load.running}/${row.load.limit}${row.load.queued ? ` +${row.load.queued} queued` : ""}`);
  if (health) parts.push(`health ${health.status}${health.latencyMs !== undefined ? ` ${health.latencyMs}ms` : ""}${health.fresh ? "" : " (stale)"}`);
  if (quota && quota.remainingPercent !== undefined) parts.push(`quota ${percent(quota.remainingPercent)}${quota.fresh ? "" : " (stale)"}`);
  if (balance) parts.push(`balance $${balance.remainingUsd}${balance.fresh ? "" : " (stale)"}`);
  if (row.reasons?.length) parts.push(`[${row.reasons.join(", ")}]`);
  return parts.join("  ");
}

export async function availabilityCommand(args: string[], deps: AvailabilityCommandDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.includes("--help") || args.includes("-h")) { out(availabilityUsage); return 0; }
  let json = false; let wait = 2500;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--json") json = true;
    else if (args[index] === "--wait" && /^[0-9]{1,4}$/.test(args[index + 1] ?? "") && Number(args[index + 1]) <= 5000) wait = Number(args[++index]);
    else { err(availabilityUsage); return 2; }
  }
  const unknown = (reason: string) => {
    out(json ? JSON.stringify({ object: "availability", status: "unknown", reason, providers: [] }, null, 2) + "\n" : `availability unknown: ${reason}\n`);
    return 0;
  };
  let config;
  try { config = await loadConfig(await (deps.configPath ?? (async () => configPath()))()); } catch { return unknown("no readable gateway configuration"); }
  let token: string;
  try { token = await readClientToken(resolve(config.stateDirectory, "client-token")); } catch { return unknown("no gateway client token"); }
  let body: { providers?: Row[] };
  try {
    const response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${config.port}/v1/availability?wait=${wait}`, {
      headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(wait + 1500),
    });
    if (response.status === 404) return unknown("this gateway release does not report availability");
    if (!response.ok) return unknown(`gateway answered HTTP ${response.status}`);
    body = await response.json() as { providers?: Row[] };
    if (!Array.isArray(body.providers)) return unknown("invalid gateway answer");
  } catch { return unknown("gateway unreachable"); }
  out(json ? JSON.stringify(body, null, 2) + "\n" : body.providers!.map(line).join("\n") + "\n");
  return 0;
}
