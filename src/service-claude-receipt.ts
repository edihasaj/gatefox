import { basename, dirname, isAbsolute, resolve } from "node:path";
import { UnsafeFile, atomicWrite, readRegularFile, sha256 } from "./service-claude-io.js";
import { legacySpecs, type LegacyKind } from "./service-claude-legacy.js";
import { validateServicePlan, type ServicePlan } from "./service-plan.js";

const maximumReceiptBytes = 512 * 1024;
const maximumPlistBytes = 16 * 1024;
export const pendingClaudeConsolidationPath = (state: string): string => resolve(state, "service-claude-pending.json");
export const planText = (plan: ServicePlan): string => JSON.stringify(plan, null, 2) + "\n";
export function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : 1).map(([key, entry]) => [key, sort(entry)])) : item;
  return JSON.stringify(sort(value));
}

export interface ReceiptJob {
  label: string; kind: LegacyKind; componentId: string;
  /** The exact legacy plist bytes, so a rollback never depends on a file that could have been touched. */
  plistBase64: string; plistSha256: string; mode: number;
  /** The legacy process argument line, used to prove that exact old process is gone. */
  argv: string[];
  /** The old process identity captured before it was stopped; absent while the job was not running. */
  pid?: number; startedAtMs?: number;
  /** Whether launchd had the job loaded when retirement began; a rollback starts only jobs that were running. */
  loaded?: boolean;
}
/** Frozen intent: original plan digest, exact legacy bytes and the candidate plan. `phase` records how far activation got. */
export interface PendingClaudeConsolidation {
  version: 1; phase: "staged" | "retiring" | "committed";
  config: string; app: string; mainPlistSha256: string;
  originalPlanSha256: string; candidatePlanSha256: string; candidatePlan: ServicePlan;
  backup: string; jobs: ReceiptJob[];
}

const invalid = () => new Error("Invalid pending Claude consolidation");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const onlyKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

function validJob(value: unknown, phase: PendingClaudeConsolidation["phase"]): ReceiptJob {
  const job = value as Partial<ReceiptJob> | null;
  const spec = legacySpecs.find(item => item.label === job?.label);
  if (!job || typeof job !== "object" || !spec || job.kind !== spec.kind || job.componentId !== spec.componentId
    || !onlyKeys(job, ["label", "kind", "componentId", "plistBase64", "plistSha256", "mode", "argv", "pid", "startedAtMs", "loaded"])) throw invalid();
  if (job.loaded !== undefined && typeof job.loaded !== "boolean") throw invalid();
  if (typeof job.plistBase64 !== "string" || !hex(job.plistSha256) || !Number.isInteger(job.mode) || job.mode! < 0 || job.mode! > 0o777 || (job.mode! & 0o022)) throw invalid();
  const bytes = Buffer.from(job.plistBase64, "base64");
  if (bytes.toString("base64") !== job.plistBase64 || bytes.length === 0 || bytes.length > maximumPlistBytes || sha256(bytes) !== job.plistSha256) throw invalid();
  if (!Array.isArray(job.argv) || job.argv.length < 2 || job.argv.some(arg => typeof arg !== "string" || /[\0\r\n]/.test(arg))) throw invalid();
  if (job.pid !== undefined && (!Number.isSafeInteger(job.pid) || job.pid < 1)) throw invalid();
  if (job.startedAtMs !== undefined && (!Number.isSafeInteger(job.startedAtMs) || job.startedAtMs < 0)) throw invalid();
  // Runtime identity exists only once retirement began: staged jobs carry none, later jobs state exactly what was running.
  if (phase === "staged") { if (job.loaded !== undefined || job.pid !== undefined || job.startedAtMs !== undefined) throw invalid(); }
  else if (job.loaded === true) { if (job.pid === undefined || job.startedAtMs === undefined) throw invalid(); }
  else if (job.loaded !== false || job.pid !== undefined || job.startedAtMs !== undefined) throw invalid();
  return job as ReceiptJob;
}

export function validateReceipt(value: unknown, state: string): PendingClaudeConsolidation {
  const receipt = value as Partial<PendingClaudeConsolidation> | null;
  if (!receipt || typeof receipt !== "object" || receipt.version !== 1 || !["staged", "retiring", "committed"].includes(receipt.phase as string)
    || !onlyKeys(receipt, ["version", "phase", "config", "app", "mainPlistSha256", "originalPlanSha256", "candidatePlanSha256", "candidatePlan", "backup", "jobs"])) throw invalid();
  for (const path of [receipt.config, receipt.app]) if (typeof path !== "string" || /[\0\r\n]/.test(path) || !isAbsolute(path) || resolve(path) !== path) throw invalid();
  if (!hex(receipt.mainPlistSha256) || !hex(receipt.originalPlanSha256) || !hex(receipt.candidatePlanSha256)) throw invalid();
  if (typeof receipt.backup !== "string" || dirname(receipt.backup) !== resolve(state, "service-backups") || !/^claude-[a-f0-9]{16}$/.test(basename(receipt.backup))) throw invalid();
  if (!Array.isArray(receipt.jobs) || !receipt.jobs.length || receipt.jobs.length > legacySpecs.length) throw invalid();
  const jobs = receipt.jobs.map(job => validJob(job, receipt.phase!));
  if (new Set(jobs.map(job => job.label)).size !== jobs.length) throw invalid();
  let plan: ServicePlan;
  try { plan = validateServicePlan(receipt.candidatePlan); } catch { throw invalid(); }
  if (plan.config !== receipt.config || sha256(planText(plan)) !== receipt.candidatePlanSha256) throw invalid();
  if (jobs.some(job => !plan.components.some(component => component.id === job.componentId))) throw invalid();
  return { ...receipt, candidatePlan: plan, jobs } as PendingClaudeConsolidation;
}

/** A missing receipt is "no staged work"; any other problem throws so a daemon never treats a hostile file as intent. */
export async function readPendingClaudeConsolidation(stateDirectory: string): Promise<PendingClaudeConsolidation | undefined> {
  const file = await readRegularFile(pendingClaudeConsolidationPath(stateDirectory), maximumReceiptBytes, true);
  if (!file) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(file.bytes.toString("utf8")); } catch { throw invalid(); }
  return validateReceipt(parsed, resolve(stateDirectory));
}

export async function writePendingClaudeConsolidation(state: string, receipt: PendingClaudeConsolidation): Promise<void> {
  const text = JSON.stringify(receipt, null, 2) + "\n";
  if (Buffer.byteLength(text) > maximumReceiptBytes) throw new UnsafeFile("Pending Claude consolidation is too large");
  await atomicWrite(pendingClaudeConsolidationPath(state), text);
}
