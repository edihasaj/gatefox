import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { assess, inspectMain, matchesReceipt, readPlanText, type ReadyAssessment } from "./service-claude-assess.js";
import { UnsafeFile, atomicWrite, ensurePrivateDirectory, randomId, sha256 } from "./service-claude-io.js";
import { ClaudeRefusal, ClaudeRetirementError } from "./service-claude-legacy.js";
import { canonical, planText, readPendingClaudeConsolidation, writePendingClaudeConsolidation, type PendingClaudeConsolidation, type ReceiptJob } from "./service-claude-receipt.js";
import { archiveExactLegacyPlist, archiveReceipt, claudeHost, liveIdentity, oldProcessGone, restoreLegacy, retireJob, type ClaudeDependencies, type ClaudeHost } from "./service-claude-transaction.js";
import { serviceLabel, servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";

export { readPendingClaudeConsolidation, pendingClaudeConsolidationPath, type PendingClaudeConsolidation } from "./service-claude-receipt.js";
export type { ClaudeDependencies } from "./service-claude-transaction.js";

const claudeGui = /\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/;

async function underPlanThenLoginLock<T>(state: string, action: () => Promise<T>): Promise<T> {
  return withPrivateFileLock(servicePlanPath(state), () => withPrivateFileLock(resolve(state, "service-login"), action));
}

const adopted = (receipt: PendingClaudeConsolidation) => receipt.candidatePlan.components.filter(component => receipt.jobs.some(job => job.componentId === component.id)).map(({ id, kind }) => ({ id, kind }));
const summary = (receipt: PendingClaudeConsolidation): Record<string, unknown> => ({
  service: serviceLabel, staged: true, activates: "next primary service start", activeChatsPreserved: true, backup: receipt.backup,
  retires: receipt.jobs.map(job => job.label), components: adopted(receipt),
});

/** Read-only: what a staged consolidation would adopt, or why it cannot. Touches no file, job or process. */
export async function previewClaudeConsolidation(configPath: string, overrides: ClaudeDependencies = {}): Promise<Record<string, unknown>> {
  const host = claudeHost(overrides); const path = resolve(configPath); const state = (await loadConfig(path)).stateDirectory;
  let staged = false;
  try { staged = !!await readPendingClaudeConsolidation(state); } catch { return { service: serviceLabel, staged: false, ready: false, reason: "receipt_invalid" }; }
  try {
    const result = await assess(host, path, state);
    if (result.status !== "ready") return { service: serviceLabel, staged, ready: false, reason: result.status === "none" ? "no_legacy_jobs" : "already_consolidated" };
    return { service: serviceLabel, staged, ready: true, activates: "next primary service start", retires: result.jobs.map(job => job.label),
      components: result.candidate.components.filter(component => result.jobs.some(job => job.componentId === component.id)).map(({ id, kind }) => ({ id, kind })) };
  } catch (error) {
    if (error instanceof ClaudeRefusal) return { service: serviceLabel, staged, ready: false, reason: error.reason };
    throw error;
  }
}

async function createReceipt(state: string, config: string, ready: ReadyAssessment): Promise<PendingClaudeConsolidation> {
  const root = resolve(state, "service-backups"); await ensurePrivateDirectory(root);
  const backup = resolve(root, `claude-${randomId()}`); await ensurePrivateDirectory(backup, true);
  await atomicWrite(resolve(backup, "service-plan.json"), ready.originalText, 0o600, true);
  for (const job of ready.jobs) await atomicWrite(resolve(backup, `${job.label}.plist`), job.bytes, 0o600, true);
  const jobs: ReceiptJob[] = ready.jobs.map(job => ({ label: job.label, kind: job.kind, componentId: job.componentId, plistBase64: job.plistBase64, plistSha256: job.plistSha256, mode: job.mode, argv: job.argv }));
  return { version: 1, phase: "staged", config, app: ready.app, mainPlistSha256: ready.mainPlistSha256, originalPlanSha256: ready.originalPlanSha256,
    candidatePlanSha256: ready.candidatePlanSha256, candidatePlan: ready.candidate, backup, jobs };
}

/** Stages the request only. The live plan, jobs, processes and plists are not changed. */
export async function stageClaudeConsolidation(configPath: string, overrides: ClaudeDependencies = {}): Promise<Record<string, unknown>> {
  const host = claudeHost(overrides); const path = resolve(configPath);
  if (host.platform !== "darwin") throw new Error("Claude consolidation supports macOS");
  const state = (await loadConfig(path)).stateDirectory;
  return underPlanThenLoginLock(state, async () => {
    const existing = await readPendingClaudeConsolidation(state);
    if (existing && existing.phase !== "staged") throw new Error("Claude consolidation needs recovery at the next primary start; it was not restaged");
    let result;
    try { result = await assess(host, path, state); }
    catch (error) { throw error instanceof ClaudeRefusal ? new Error(`Claude consolidation was not staged (${error.reason}): ${error.message}`) : error; }
    if (result.status === "none") return { service: serviceLabel, staged: false, reason: "no_legacy_jobs" };
    if (result.status === "consolidated") return { service: serviceLabel, staged: false, alreadyConsolidated: true };
    if (existing && matchesReceipt(result, existing)) return summary(existing);
    const receipt = await createReceipt(state, path, result);
    await writePendingClaudeConsolidation(state, receipt);
    host.notice("claude_consolidation_staged", { jobs: receipt.jobs.length });
    return summary(receipt);
  });
}

function defer(host: ClaudeHost, reason: string, plan: ServicePlan): ServicePlan {
  host.notice("claude_consolidation_deferred", { reason });
  return plan;
}

async function verifyOriginalPlan(state: string, receipt: PendingClaudeConsolidation): Promise<void> {
  const digest = sha256(await readPlanText(state));
  if (digest !== receipt.originalPlanSha256) throw new ClaudeRetirementError("The service plan is not the original; legacy jobs are not restored");
}

/** Restores the exact old jobs when (and only when) the candidate plan provably never took effect. Otherwise it throws. */
async function rollback(host: ClaudeHost, state: string, receipt: PendingClaudeConsolidation): Promise<void> {
  try { await verifyOriginalPlan(state, receipt); await restoreLegacy(host, receipt); }
  catch (error) {
    host.notice("claude_consolidation_failed", { phase: receipt.phase });
    throw error instanceof ClaudeRetirementError ? error : new ClaudeRetirementError("Legacy Claude jobs could not be restored safely; the recoverable journal was kept");
  }
  await archiveReceipt(state, receipt, "rolled-back").catch(() => {});
  host.notice("claude_consolidation_rolled_back", { jobs: receipt.jobs.length });
}

/** After a committed plan: no legacy job or process may remain, then the receipt is archived. Anything else fails closed. */
async function finishCommitted(host: ClaudeHost, state: string, receipt: PendingClaudeConsolidation): Promise<ServicePlan> {
  try {
    // Retired legacy plists are no reason to skip the ownership checks: the candidate runs under the main signed app.
    const main = await inspectMain(host, receipt.config);
    if (main.app !== receipt.app) throw new ClaudeRetirementError("The signed app changed since Claude consolidation was staged");
    if (main.sha !== receipt.mainPlistSha256) host.notice("claude_consolidation_deferred", { reason: "main_plist_changed" });
    for (const job of receipt.jobs) {
      if ((await host.launchd.print(job.label)).loaded) throw new ClaudeRetirementError("A legacy Claude job is loaded while the app-owned plan is active");
      // A tunnel's app-owned replacement can run the same argument line, so only its recorded identity can be compared.
      if (!await oldProcessGone(host, job, job.kind !== "tunnel")) throw new ClaudeRetirementError("A legacy Claude process may still be running while the app-owned plan is active");
      await archiveExactLegacyPlist(host, receipt, job);
    }
  } catch (error) {
    host.notice("claude_consolidation_failed", { phase: "committed" });
    throw error instanceof ClaudeRetirementError ? error : new ClaudeRetirementError("Legacy Claude retirement could not be verified; the app-owned plan was not started");
  }
  await archiveReceipt(state, receipt, "activated").catch(() => {});
  host.notice("claude_consolidation_activated", { jobs: receipt.jobs.length });
  return receipt.candidatePlan;
}

async function activate(host: ClaudeHost, path: string, state: string, plan: ServicePlan, receipt: PendingClaudeConsolidation): Promise<ServicePlan> {
  let fresh;
  try { fresh = await assess(host, path, state); } catch (error) { return defer(host, error instanceof ClaudeRefusal ? error.reason : "revalidation_failed", plan); }
  if (fresh.status !== "ready" || !matchesReceipt(fresh, receipt)) return defer(host, "changed", plan);
  let rows; try { rows = await host.processes.census(); } catch { return defer(host, "process_census", plan); }
  if (rows.some(row => claudeGui.test(row.args))) return defer(host, "claude_gui_open", plan);
  const jobs: ReceiptJob[] = [];
  for (const job of receipt.jobs) {
    const frozen: ReceiptJob = { ...job }; delete frozen.pid; delete frozen.startedAtMs; delete frozen.loaded;
    // The disk plist is not the loaded definition: bind the live pid, its start and its exact command line to the frozen argv.
    let live;
    try { live = await liveIdentity(host, frozen); } catch (error) { return defer(host, error instanceof ClaudeRefusal ? error.reason : "launchd_unknown", plan); }
    if (live.loaded && job.kind !== "tunnel") { try { if (await host.processes.established(live.pid!)) return defer(host, "busy", plan); } catch { return defer(host, "connection_census", plan); } }
    jobs.push({ ...frozen, loaded: live.loaded, ...(live.loaded ? { pid: live.pid, startedAtMs: live.startedAtMs } : {}) });
  }
  const retiring: PendingClaudeConsolidation = { ...receipt, phase: "retiring", jobs };
  try { await writePendingClaudeConsolidation(state, retiring); } catch { return defer(host, "journal_failed", plan); }
  // Legacy jobs may change from here on: every failure either restores them exactly or throws.
  try {
    for (const job of retiring.jobs) await retireJob(host, retiring, job);
    await verifyOriginalPlan(state, retiring);
  } catch { await rollback(host, state, retiring); return plan; }
  try { await host.commit(servicePlanPath(state), planText(receipt.candidatePlan)); }
  catch {
    const after = await readPlanText(state).then(sha256).catch(() => undefined);
    if (after === receipt.originalPlanSha256) { await rollback(host, state, retiring); return plan; }
    if (after !== receipt.candidatePlanSha256) {
      host.notice("claude_consolidation_failed", { phase: "commit" });
      throw new ClaudeRetirementError("The service plan commit outcome is unknown; legacy Claude jobs stay retired and the journal was kept");
    }
  }
  await writePendingClaudeConsolidation(state, { ...retiring, phase: "committed" }).catch(() => {});
  await archiveReceipt(state, retiring, "activated").catch(() => {});
  host.notice("claude_consolidation_activated", { jobs: retiring.jobs.length });
  return receipt.candidatePlan;
}

async function activateLocked(host: ClaudeHost, path: string, state: string, plan: ServicePlan): Promise<ServicePlan> {
  let receipt;
  try { receipt = await readPendingClaudeConsolidation(state); } catch { return invalidReceipt(host); }
  if (!receipt) return plan;
  if (receipt.config !== path) return defer(host, "stale_plan", plan);
  if (!await host.primary()) return defer(host, "not_primary", plan);
  let text: string;
  try { text = await readPlanText(state); }
  catch { if (receipt.phase === "staged") return defer(host, "plan_unreadable", plan); throw new ClaudeRetirementError("The service plan cannot be read while Claude retirement is in progress"); }
  const digest = sha256(text);
  if (digest === receipt.candidatePlanSha256) return finishCommitted(host, state, receipt);
  if (digest !== receipt.originalPlanSha256) {
    if (receipt.phase === "staged") return defer(host, "stale_plan", plan);
    host.notice("claude_consolidation_failed", { phase: receipt.phase });
    throw new ClaudeRetirementError("The service plan changed during Claude retirement; legacy jobs are not restored");
  }
  let current: ServicePlan;
  try { current = validateServicePlan(JSON.parse(text)); } catch { return defer(host, "plan_invalid", plan); }
  if (receipt.phase === "committed") { host.notice("claude_consolidation_failed", { phase: "committed" }); throw new ClaudeRetirementError("The committed Claude plan is no longer active; legacy jobs are not restored"); }
  // An interrupted retirement never reached the plan commit, so the candidate cannot have run: restore and require restaging.
  if (receipt.phase === "retiring") { await rollback(host, state, receipt); return current; }
  if (canonical(current) !== canonical(plan)) return defer(host, "stale_plan", plan);
  return activate(host, path, state, plan, receipt);
}

/**
 * Applies the staged consolidation only in the primary launchd daemon at start. Conflicts defer before any change and return
 * `plan` unchanged. After legacy jobs have been touched the result is a verified restore or a thrown ClaudeRetirementError.
 */
export async function activatePendingClaudeConsolidation(configPath: string, plan: ServicePlan, overrides: ClaudeDependencies = {}): Promise<ServicePlan> {
  const host = claudeHost(overrides); const path = resolve(configPath);
  const state = (await loadConfig(path)).stateDirectory;
  let pending; let readable = true;
  try { pending = await readPendingClaudeConsolidation(state); } catch { readable = false; }
  if (readable && !pending) return plan;
  if (pending && pending.config !== path) return defer(host, "stale_plan", plan);
  if (!await host.primary()) return defer(host, "not_primary", plan);
  let entered = false;
  try { return await underPlanThenLoginLock(state, () => { entered = true; return activateLocked(host, path, state, plan); }); }
  catch (error) {
    if (entered || error instanceof ClaudeRetirementError || error instanceof UnsafeFile) throw error;
    return defer(host, "lock_busy", plan);
  }
}
/**
 * An unreadable or malformed receipt cannot prove that no legacy job was retired, so the primary service stops instead of
 * starting a plan that might duplicate or lose a writer. Availability is deliberately traded for this guarantee; the fixed
 * message tells the operator to inspect the receipt and its private backup before removing it.
 */
function invalidReceipt(host: ClaudeHost): never {
  host.notice("claude_consolidation_failed", { phase: "receipt" });
  throw new ClaudeRetirementError("The pending Claude consolidation journal is unreadable; the service did not start. Inspect service-claude-pending.json and its private backup, then restore or remove it.");
}

