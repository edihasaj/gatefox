import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { configPath as resolveConfigPath } from "./paths.js";
import { autoLatestProtocol, autoLatestScheduleStatus, prepareScheduledTemp, trimScheduleLog } from "./model-auto-latest/schedule.js";

/** The fields `check` prints. Anything else the engine returns (and any error text) never reaches the output. */
const outcomes = ["updated", "unchanged", "baseline", "partial", "failed", "cancelled", "stale", "disabled", "busy"] as const;
export type AutoLatestCheckOutcome = typeof outcomes[number];
export interface AutoLatestCheckResult {
  outcome: AutoLatestCheckOutcome; changed: boolean; activated: number; providersChecked: number; providersFailed: number; nativeUpdated: boolean; checkedAt: number;
}
export type AutoLatestCheckFailure = "config_unavailable" | "check_failed" | "temp_unavailable";

export interface AutoLatestCliTools {
  reconcile(configPath: string, options: { signal: AbortSignal }): Promise<unknown>;
  prepareTemp(): Promise<string>;
  trimLog(configPath: string): Promise<void>;
  status(configPath: string): Promise<unknown>;
  stdout(text: string): void;
  /** Called with the job's private TMPDIR so the whole process uses it; the default sets the process variable. */
  useTemp(directory: string): void;
  /** Registers an abort on SIGTERM and SIGINT; returns the function that removes it. */
  onStop(abort: () => void): () => void;
}

export const autoLatestHelp = `gateway auto-latest — background upkeep for auto-latest model selections

  gateway auto-latest check [--config PATH]    One reconcile pass; prints one JSON line. Exit 0 done, 75 deferred (busy, cancelled, stale), 1 failed.
  gateway auto-latest status [--config PATH]   Whether the background job for this configuration is installed and loaded.
`;

function defaultTools(): AutoLatestCliTools {
  return {
    reconcile: async (path, options) => (await import("./model-auto-latest/engine.js")).reconcileAutoLatest(path, options),
    prepareTemp: () => prepareScheduledTemp(),
    trimLog: async path => {
      const { loadConfig } = await import("./config.js");
      await trimScheduleLog((await loadConfig(path)).stateDirectory);
    },
    status: path => autoLatestScheduleStatus(path),
    stdout: text => { process.stdout.write(text); },
    useTemp: directory => { process.env.TMPDIR = directory; },
    onStop: abort => {
      process.once("SIGTERM", abort); process.once("SIGINT", abort);
      return () => { process.off("SIGTERM", abort); process.off("SIGINT", abort); };
    },
  };
}

const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Copies only the whitelisted fields, with their types enforced. An unknown outcome is reported as `failed`. */
export function sanitizeCheckResult(value: unknown): AutoLatestCheckResult {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const outcome = outcomes.find(name => name === raw.outcome) ?? "failed";
  return { outcome, changed: raw.changed === true, activated: count(raw.activated), providersChecked: count(raw.providersChecked), providersFailed: count(raw.providersFailed),
    nativeUpdated: raw.nativeUpdated === true, checkedAt: count(raw.checkedAt) };
}
/** Success and a deferral are different to a scheduler: a deferred pass is retried at the next interval, a failure is reported. */
export function checkExitCode(outcome: AutoLatestCheckOutcome): number {
  if (outcome === "busy" || outcome === "cancelled" || outcome === "stale") return 75;
  return outcome === "failed" ? 1 : 0;
}

/** Runs `gateway auto-latest ...` and returns the exit code. Output is one JSON line holding only fixed fields. */
export async function runAutoLatestCli(args: string[], tools: AutoLatestCliTools = defaultTools()): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { config: { type: "string" }; scheduled: { type: "boolean" } }; allowPositionals: true; strict: true }>>;
  try { parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { config: { type: "string" }, scheduled: { type: "boolean" } } }); }
  catch { tools.stdout(autoLatestHelp); return 2; }
  const [action, ...extra] = parsed.positionals;
  if (extra.length || !action || !["check", "status", "probe"].includes(action) || (parsed.values.scheduled && action !== "check")) { tools.stdout(autoLatestHelp); return 2; }
  // `probe` needs no configuration: it only tells the installer that this release has the command.
  if (action === "probe") { tools.stdout(JSON.stringify({ autoLatest: autoLatestProtocol }) + "\n"); return 0; }
  let path: string;
  try { path = resolve(await resolveConfigPath(parsed.values.config)); }
  catch { tools.stdout(JSON.stringify({ outcome: "failed", reason: "config_unavailable" satisfies AutoLatestCheckFailure }) + "\n"); return 1; }
  if (action === "status") { tools.stdout(JSON.stringify(await tools.status(path)) + "\n"); return 0; }
  return check(path, parsed.values.scheduled === true, tools);
}

async function check(path: string, scheduled: boolean, tools: AutoLatestCliTools): Promise<number> {
  const fail = (reason: AutoLatestCheckFailure) => { tools.stdout(JSON.stringify({ outcome: "failed", reason }) + "\n"); return 1; };
  if (scheduled) {
    // Only the scheduled job takes over TMPDIR: a person running the command keeps their own.
    try { tools.useTemp(await tools.prepareTemp()); } catch { return fail("temp_unavailable"); }
    await tools.trimLog(path).catch(() => undefined);
  }
  const controller = new AbortController();
  const release = tools.onStop(() => controller.abort());
  try {
    const result = sanitizeCheckResult(await tools.reconcile(path, { signal: controller.signal }));
    tools.stdout(JSON.stringify(result) + "\n");
    return checkExitCode(result.outcome);
  } catch { return fail("check_failed"); }
  finally { release(); }
}
