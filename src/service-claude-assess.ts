import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalPath } from "./app-background.js";
import { assertSafeAncestors, logDestinationSafe, readRegularFile, sha256 } from "./service-claude-io.js";
import { ClaudeRefusal, legacySpecs, parseLegacyJob, type LegacyKind } from "./service-claude-legacy.js";
import { canonical, planText, type PendingClaudeConsolidation } from "./service-claude-receipt.js";
import { executableFile, livePlistPath, maximumLegacyPlistBytes, type ClaudeHost } from "./service-claude-transaction.js";
import { servicePlanPath, serviceLabel, serviceMarker, validateServicePlan, type ServicePlan } from "./service-plan.js";

const appIdentifier = "com.edihasaj.harness-gateway.app";
const helperSuffix = "/Contents/MacOS/GatewayService";

export interface AssessedJob { label: string; kind: LegacyKind; componentId: string; bytes: Buffer; plistBase64: string; plistSha256: string; mode: number; argv: string[] }
export interface ReadyAssessment {
  status: "ready"; app: string; mainPlistSha256: string;
  originalText: string; originalPlanSha256: string; current: ServicePlan;
  candidate: ServicePlan; candidatePlanSha256: string; jobs: AssessedJob[];
}
export type Assessment = ReadyAssessment | { status: "none" } | { status: "consolidated" };

const refusal = (reason: string, message?: string) => new ClaudeRefusal(reason, message);
async function answered<T>(reason: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) { throw error instanceof ClaudeRefusal ? error : refusal(reason); }
}

/** The gateway plan, read as a bounded private regular file. */
export async function readPlanText(state: string): Promise<string> {
  const file = await readRegularFile(servicePlanPath(state), 65536, true);
  if (!file) throw new Error("Cannot safely read gateway service plan");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { throw new Error("Gateway service plan has invalid text"); }
}

export async function inspectMain(host: ClaudeHost, configPath: string): Promise<{ app: string; appNode: string; sha: string }> {
  const file = await answered("main_service", () => readRegularFile(livePlistPath(host, serviceLabel), 65536, false));
  if (!file || !file.bytes.toString("utf8").includes(serviceMarker)) throw refusal("main_service", "The primary gateway LaunchAgent is missing or not gateway-managed");
  const plist = await answered("main_service", () => host.decodePlist(file.bytes));
  const args = plist.ProgramArguments; const program = plist.Program; const bundle = plist.AssociatedBundleIdentifiers;
  const configs = Array.isArray(args) ? args.flatMap((arg, index) => arg === "--config" ? [index] : []) : [];
  if (plist.Label !== serviceLabel || !Array.isArray(args) || !args.every(arg => typeof arg === "string") || (args[1] !== "daemon" && args[1] !== "serve")
    || configs.length !== 1 || args[configs[0]! + 1] !== configPath || typeof program !== "string" || !program.endsWith(helperSuffix)
    || !(bundle === appIdentifier || Array.isArray(bundle) && bundle.length === 1 && bundle[0] === appIdentifier)) {
    throw refusal("main_service", "The primary gateway LaunchAgent is not associated with the signed app for this configuration");
  }
  const app = program.slice(0, -helperSuffix.length);
  if (!isAbsolute(app) || resolve(app) !== app || basename(app) !== "Harness Gateway.app") throw refusal("main_app", "The signed app path is not the Harness Gateway app");
  if (await answered("main_app", () => host.realpath(app)) !== await answered("main_app", () => canonicalPath(app))) throw refusal("main_app", "The signed app path crosses a link");
  const appNode = join(app, "Contents", "Resources", "backend", "runtime", "bin", "node");
  if (!await executableFile(appNode)) throw refusal("main_app", "The signed app has no regular executable Node runtime");
  if (!await host.verifySignature(app, join(app, "Contents", "MacOS", "GatewayService"))) throw refusal("signature", "The app signature could not be verified");
  return { app, appNode, sha: sha256(file.bytes) };
}

async function pinExists(path: string): Promise<boolean> {
  try {
    await assertSafeAncestors(dirname(path));
    const info = await lstat(path);
    await access(path, constants.R_OK);
    return info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid?.();
  } catch { return false; }
}

/** Read-only: everything staging and activation must agree on. Throws ClaudeRefusal when the work must not proceed. */
export async function assess(host: ClaudeHost, configPath: string, state: string): Promise<Assessment> {
  if (host.platform !== "darwin") throw refusal("unsupported_platform", "Claude consolidation supports macOS");
  const main = await inspectMain(host, configPath);
  const originalText = await answered("plan_unreadable", () => readPlanText(state));
  let current: ServicePlan;
  try { current = validateServicePlan(JSON.parse(originalText)); } catch { throw refusal("plan_invalid"); }
  if (current.config !== configPath) throw refusal("other_config", "The unified gateway service belongs to another configuration");
  for (const read of [host.pendingLogin, host.pendingNative]) {
    let pending: unknown; try { pending = await read(state); } catch { pending = true; }
    if (pending) throw refusal("startup_pending", "Another startup consolidation is pending");
  }
  const jobs: AssessedJob[] = []; const components: ServicePlan["components"] = [];
  for (const spec of legacySpecs) {
    const file = await answered("unsafe_legacy_file", () => readRegularFile(livePlistPath(host, spec.label), maximumLegacyPlistBytes, false));
    if (!file) {
      if ((await answered("launchd_unknown", () => host.launchd.print(spec.label))).loaded) throw refusal("loaded_without_plist", "A legacy Claude job is loaded without an owned plist");
      continue;
    }
    if (await answered("launchd_unknown", () => host.launchd.disabled(spec.label))) throw refusal("disabled", "A legacy Claude job is disabled; it was left alone");
    const plist = await answered("legacy_shape", () => host.decodePlist(file.bytes));
    const parsed = parseLegacyJob(spec, file.bytes, plist, { home: host.home, appNode: main.appNode, state });
    if (!await logDestinationSafe(parsed.component.log)) throw refusal("log_unsafe", "The private log destination for a migrated component is not safe");
    for (const pin of parsed.pins) if (!await pinExists(pin)) throw refusal("pinned_missing", "A pinned Claude runtime or configuration file is missing");
    components.push(parsed.component);
    jobs.push({ label: spec.label, kind: spec.kind, componentId: spec.componentId, bytes: file.bytes, plistBase64: file.bytes.toString("base64"),
      plistSha256: sha256(file.bytes), mode: file.mode, argv: parsed.argv });
  }
  const adopted = current.components.some(component => component.kind === "claude-adapter" || component.kind === "claude-inference" || legacySpecs.some(spec => spec.componentId === component.id));
  if (!jobs.length) return { status: adopted ? "consolidated" : "none" };
  if (adopted) throw refusal("conflict", "Claude components already exist alongside legacy Claude jobs");
  let candidate: ServicePlan;
  try { candidate = validateServicePlan({ ...current, components: [...current.components, ...components] }); } catch { throw refusal("plan_invalid", "The merged service plan is not valid"); }
  return { status: "ready", app: main.app, mainPlistSha256: main.sha, originalText, originalPlanSha256: sha256(originalText), current,
    candidate, candidatePlanSha256: sha256(planText(candidate)), jobs };
}

/** Whether a fresh assessment describes exactly what was frozen at staging. */
export function matchesReceipt(fresh: ReadyAssessment, receipt: PendingClaudeConsolidation): boolean {
  return fresh.app === receipt.app && fresh.mainPlistSha256 === receipt.mainPlistSha256 && fresh.originalPlanSha256 === receipt.originalPlanSha256
    && fresh.candidatePlanSha256 === receipt.candidatePlanSha256 && fresh.jobs.length === receipt.jobs.length
    && fresh.jobs.every((job, index) => { const frozen = receipt.jobs[index]!; return job.label === frozen.label && job.plistSha256 === frozen.plistSha256 && canonical(job.argv) === canonical(frozen.argv); });
}
