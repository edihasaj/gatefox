import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface RollbackJob { path: string; label: string; text: string; loaded: boolean }
export interface RollbackLaunchctl { bootout(label: string): Promise<void>; isLoaded(label: string): Promise<boolean>; bootstrap(path: string): Promise<void> }
export interface RollbackPlan {
  jobs: RollbackJob[]; serviceLabel: string; targetPath: string; planPath: string; trash: string;
  replacementAttempted: boolean; launchctl: RollbackLaunchctl;
}
/** Fixed classes of rollback step; failures name the step and job label, never a path or value. */
export type RollbackStep = "stop_replacement" | "retire_plan" | "restore_plist" | "retire_replacement_plist" | "restart_job";
export interface RollbackFailure { step: RollbackStep; label?: string }

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Undo a failed consolidation. Every step runs even when an earlier one fails, so one fault cannot leave no job loaded. */
export async function rollbackConsolidation(plan: RollbackPlan): Promise<RollbackFailure[]> {
  const failures: RollbackFailure[] = [];
  const attempt = async (failure: RollbackFailure, step: () => Promise<unknown>) => { try { await step(); } catch { failures.push(failure); } };
  const { launchctl, jobs } = plan;
  if (plan.replacementAttempted) await attempt({ step: "stop_replacement" }, async () => { if (await launchctl.isLoaded(plan.serviceLabel)) await launchctl.bootout(plan.serviceLabel); });
  const stamp = Date.now();
  const retire = (path: string, name: string) => mkdir(plan.trash, { recursive: true }).then(() => rename(path, resolve(plan.trash, name))).catch(error => { if (!missing(error)) throw error; });
  await attempt({ step: "retire_plan" }, () => retire(plan.planPath, `gateway-service-plan.${stamp}.json`));
  for (const job of jobs) await attempt({ step: "restore_plist", label: job.label }, () => writeFile(job.path, job.text, { mode: 0o600 }));
  if (!jobs.some(job => job.label === plan.serviceLabel)) await attempt({ step: "retire_replacement_plist" }, () => retire(plan.targetPath, `gateway-service-failed.${stamp}.plist`));
  for (const job of jobs) if (job.loaded) await attempt({ step: "restart_job", label: job.label }, async () => { if (!await launchctl.isLoaded(job.label)) await launchctl.bootstrap(job.path); });
  return failures;
}

export function rollbackFailureSummary(failures: RollbackFailure[]): string {
  return failures.map(failure => failure.label ? `${failure.step}:${failure.label}` : failure.step).join(", ");
}
