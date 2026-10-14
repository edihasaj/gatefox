import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface RollbackJob { path: string; label: string; text: string; loaded: boolean }
export interface RollbackLaunchctl { bootout(label: string): Promise<void>; isLoaded(label: string): Promise<boolean>; bootstrap(path: string): Promise<void> }
export interface RollbackPlan {
  jobs: RollbackJob[]; serviceLabel: string; targetPath: string; planPath: string; trash: string;
  replacementAttempted: boolean; launchctl: RollbackLaunchctl;
}
/** Fixed classes of rollback step; failures name the step and job label, never a path or value. */
export type RollbackStep = "replacement_still_loaded" | "retire_plan" | "restore_plist" | "retire_replacement_plist" | "restart_job";
export interface RollbackFailure { step: RollbackStep; label?: string }

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Undo a failed consolidation. Every step runs even when an earlier one fails, so one fault cannot leave no job loaded, unless the replacement is still loaded; then it stays the only service. */
export async function rollbackConsolidation(plan: RollbackPlan): Promise<RollbackFailure[]> {
  const failures: RollbackFailure[] = [];
  const attempt = async (failure: RollbackFailure, step: () => Promise<unknown>) => { try { await step(); } catch { failures.push(failure); } };
  const { launchctl, jobs } = plan;
  // A replacement that cannot be proven unloaded stays the one loaded service: retiring its plan or restarting the old jobs would run two writers.
  let replacementLoaded = false;
  if (plan.replacementAttempted) {
    try { if (await launchctl.isLoaded(plan.serviceLabel)) await launchctl.bootout(plan.serviceLabel); } catch { /* the check below decides */ }
    try { replacementLoaded = await launchctl.isLoaded(plan.serviceLabel); } catch { replacementLoaded = true; }
    if (replacementLoaded) failures.push({ step: "replacement_still_loaded" });
  }
  const stamp = Date.now();
  const retire = (path: string, name: string) => mkdir(plan.trash, { recursive: true }).then(() => rename(path, resolve(plan.trash, name))).catch(error => { if (!missing(error)) throw error; });
  if (!replacementLoaded) await attempt({ step: "retire_plan" }, () => retire(plan.planPath, `gateway-service-plan.${stamp}.json`));
  // A loaded replacement keeps its plan, so its own plist must keep the text launchd booted it from;
  // writing the old job text there would desync the running supervisor from service-plan.json.
  for (const job of jobs) if (!replacementLoaded || job.label !== plan.serviceLabel)
    await attempt({ step: "restore_plist", label: job.label }, () => writeFile(job.path, job.text, { mode: 0o600 }));
  if (!replacementLoaded && !jobs.some(job => job.label === plan.serviceLabel)) await attempt({ step: "retire_replacement_plist" }, () => retire(plan.targetPath, `gateway-service-failed.${stamp}.plist`));
  if (!replacementLoaded) for (const job of jobs) if (job.loaded) await attempt({ step: "restart_job", label: job.label }, async () => { if (!await launchctl.isLoaded(job.label)) await launchctl.bootstrap(job.path); });
  return failures;
}

export function rollbackFailureSummary(failures: RollbackFailure[]): string {
  return failures.map(failure => failure.label ? `${failure.step}:${failure.label}` : failure.step).join(", ");
}

/** Describe a failed consolidation whose rollback did not finish. Only fixed failure classes and the backup location are added, never a request value or secret. */
export function consolidationFailureMessage(error: unknown, failures: RollbackFailure[], backup: string): string {
  let message = error instanceof Error && error.message ? error.message : "Consolidation failed";
  // Nothing was restored when the replacement is still loaded, so any promise that the previous jobs will be restored has to go.
  if (failures.some(failure => failure.step === "replacement_still_loaded")) {
    message = `${message.replace(/\s*;?\s*previous jobs will be restored/gi, "").replace(/[\s;]+$/, "")}; `
      + "the new service is still running and the previous jobs were not restarted";
  }
  return `${message}; rollback incomplete (${rollbackFailureSummary(failures)}); original plists are saved in ${backup}`;
}
