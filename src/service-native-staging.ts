import { constants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { gatewaySdkRuntime, type GatewaySdkRuntime } from "./gateway-sdk-runtime.js";
import { readPendingLoginConsolidation } from "./mac-login-consolidate.js";
import { sharedServiceRegistration } from "./mac-shared-native.js";
import { verifyNativeSdk } from "./native-execution-host-sdk.js";
import { withPrivateFileLock } from "./private-file-lock.js";
import { inspectLegacyWriters } from "./service-legacy-writers.js";
import { inspectNativeWriters } from "./service-native-writers.js";
import { serviceNativeExecutionPaths, servicePlanPath, validateServicePlan, type ServicePlan } from "./service-plan.js";
import { telemetry } from "./telemetry.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const maximumIntentBytes = 8192;
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const safePath = (value: unknown): value is string => typeof value === "string" && !/[\0\r\n]/.test(value);

export const pendingNativeSharingPath = (stateDirectory: string): string => resolve(stateDirectory, "native-sharing-pending.json");

/** An immutable, deliberately small request to change the service plan on its next primary launch. */
export interface PendingNativeSharing {
  version: 1;
  action: "enable-native";
  configPath: string;
  nativeHome: string;
  planSha256: string;
  candidatePlanSha256: string;
  enableGateway?: true;
}

function validPending(value: unknown): value is PendingNativeSharing {
  const pending = value as Partial<PendingNativeSharing> | null;
  return !!pending && pending.version === 1 && pending.action === "enable-native" &&
    safePath(pending.configPath) && resolve(pending.configPath) === pending.configPath &&
    safePath(pending.nativeHome) && resolve(pending.nativeHome) === pending.nativeHome &&
    typeof pending.planSha256 === "string" && /^[a-f0-9]{64}$/.test(pending.planSha256) &&
    typeof pending.candidatePlanSha256 === "string" && /^[a-f0-9]{64}$/.test(pending.candidatePlanSha256) &&
    (pending.enableGateway === undefined || pending.enableGateway === true) &&
    Object.keys(pending).every(key => ["version", "action", "configPath", "nativeHome", "planSha256", "candidatePlanSha256", "enableGateway"].includes(key));
}

/**
 * Reads only a regular private receipt. A missing receipt means there is no staged work; every
 * other invalid shape is an error so a daemon never treats an attacker-controlled file as intent.
 */
export async function readPendingNativeSharing(stateDirectory: string): Promise<PendingNativeSharing | undefined> {
  let file;
  try { file = await open(pendingNativeSharingPath(stateDirectory), constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot safely read pending native sharing");
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > maximumIntentBytes) {
      throw new Error("Pending native sharing must be a private regular file");
    }
    const data = await boundedRead(file, maximumIntentBytes, "Pending native sharing");
    const visible = await lstat(pendingNativeSharingPath(stateDirectory));
    if (visible.dev !== info.dev || visible.ino !== info.ino) throw new Error("Pending native sharing changed while it was read");
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString("utf8")); } catch { throw new Error("Invalid pending native sharing"); }
    if (!validPending(parsed)) throw new Error("Invalid pending native sharing");
    return parsed;
  } finally { await file.close(); }
}

async function writePendingNativeSharing(state: string, pending: PendingNativeSharing): Promise<void> {
  const text = JSON.stringify(pending, null, 2) + "\n";
  if (Buffer.byteLength(text) > maximumIntentBytes) throw new Error("Pending native sharing is too large");
  await atomicPrivateText(pendingNativeSharingPath(state), text);
}

async function boundedRead(file: Awaited<ReturnType<typeof open>>, maximum: number, label: string): Promise<Buffer> {
  const data = Buffer.alloc(maximum + 1);
  const { bytesRead } = await file.read(data, 0, data.length, 0);
  if (bytesRead > maximum) throw new Error(`${label} is too large`);
  return data.subarray(0, bytesRead);
}

/**
 * The `rename` is the commit point. Its temporary file already has the intended mode, so this
 * deliberately performs no fallible work afterwards: callers can distinguish an uncommitted
 * failure from a plan another daemon might already have observed.
 */
async function atomicPrivateText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(text);
    await file.sync();
    await file.close();
  } catch (error) {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

async function removePending(state: string): Promise<void> {
  await unlink(pendingNativeSharingPath(state)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
}

function candidate(plan: ServicePlan, pending: PendingNativeSharing): ServicePlan {
  return validateServicePlan({
    ...plan,
    sharedNativeExecutor: true,
    ...(pending.enableGateway ? { sharedExecutors: true } : {}),
  });
}

const planText = (plan: ServicePlan): string => JSON.stringify(plan, null, 2) + "\n";

class PlanOwnershipRefusal extends Error {}

export interface NativeSharingStageDependencies {
  platform: string;
  registration(configPath: string): Promise<boolean>;
  nativeSdk(codex: string): Promise<void>;
  runtime(): Promise<GatewaySdkRuntime | undefined>;
  pendingLogin(stateDirectory: string): Promise<unknown>;
  notice(event: "native_sharing_staged" | "native_sharing_activated" | "native_sharing_deferred", fields: Record<string, string>): void;
}

function stageDependencies(overrides: Partial<NativeSharingStageDependencies>): NativeSharingStageDependencies {
  return {
    platform: process.platform,
    registration: sharedServiceRegistration,
    nativeSdk: async codex => { await verifyNativeSdk(codex); },
    runtime: gatewaySdkRuntime,
    pendingLogin: readPendingLoginConsolidation,
    notice: telemetry,
    ...overrides,
  };
}

async function underPlanThenLoginLock<T>(state: string, action: () => Promise<T>): Promise<T> {
  return withPrivateFileLock(servicePlanPath(state), () => withPrivateFileLock(resolve(state, "service-login"), action));
}

async function assertStageable(configPath: string, stateDirectory: string, plan: ServicePlan, deps: NativeSharingStageDependencies, enableGateway: boolean): Promise<{ nativeHome: string }> {
  if (plan.config !== configPath) throw new Error("The unified gateway service belongs to another configuration");
  if (!await deps.registration(configPath)) throw new Error("The unified LaunchAgent belongs to another configuration or is unavailable");
  const paths = serviceNativeExecutionPaths(plan);
  await deps.nativeSdk(paths.codex);
  if ((enableGateway || plan.sharedExecutors === true) && !(await deps.runtime())?.selectedModelCompaction) {
    throw new Error("Native and gateway sharing requires this release's verified selected-model compaction SDK");
  }
  if (await deps.pendingLogin(stateDirectory)) throw new Error("Gateway startup consolidation is pending; native sharing was not staged");
  return { nativeHome: paths.nativeHome };
}

/** Stages an adoption request only. It deliberately does not touch the live plan or a running service. */
export async function stageNativeSharing(configPath: string, withGateway = false, overrides: Partial<NativeSharingStageDependencies> = {}): Promise<Record<string, unknown>> {
  const deps = stageDependencies(overrides);
  if (deps.platform !== "darwin") throw new Error("Shared native service migration currently supports macOS");
  const config = await loadConfig(configPath); const path = resolve(configPath);
  return underPlanThenLoginLock(config.stateDirectory, async () => {
    // An existing file has to pass the same receipt checks before a re-stage may replace it.
    await readPendingNativeSharing(config.stateDirectory);
    const text = await readPlanText(config.stateDirectory); const plan = validateServicePlan(JSON.parse(text));
    const { nativeHome } = await assertStageable(path, config.stateDirectory, plan, deps, withGateway);
    const pending: PendingNativeSharing = { version: 1, action: "enable-native", configPath: path, nativeHome, planSha256: sha256(text),
      candidatePlanSha256: "", ...(withGateway ? { enableGateway: true } : {}) };
    pending.candidatePlanSha256 = sha256(planText(candidate(plan, pending)));
    await writePendingNativeSharing(config.stateDirectory, pending);
    safeNotice(deps, "native_sharing_staged", { mode: withGateway ? "native_gateway" : "native" });
    return { staged: true, activates: "next service restart", sharedNativeExecutor: true,
      sharedExecutors: withGateway ? true : plan.sharedExecutors === true };
  });
}

async function readPlanText(state: string): Promise<string> {
  const path = servicePlanPath(state); let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0)); }
  catch { throw new Error("Cannot safely read gateway service plan"); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 65536) {
      throw new Error("Gateway service plan must be a private file owned by this user");
    }
    const text = decodeUtf8(await boundedRead(file, 65536, "Gateway service plan"), "Gateway service plan");
    const visible = await lstat(path);
    if (visible.dev !== info.dev || visible.ino !== info.ino) throw new Error("Gateway service plan changed while it was read");
    return text;
  } finally { await file.close(); }
}

function decodeUtf8(value: Uint8Array, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error(`${label} has invalid text`); }
}

async function primaryServiceProcess(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const domain = `gui/${process.getuid!()}`;
    const { stdout } = await exec("/bin/launchctl", ["print", `${domain}/com.edihasaj.subscription-gateway`], { timeout: 5000 });
    return Number(stdout.match(/^\s*pid = (\d+)$/m)?.[1]) === process.pid;
  } catch { return false; }
}

export interface NativeSharingActivationDependencies extends NativeSharingStageDependencies {
  primary(): Promise<boolean>;
  census(configPath: string, stateDirectory: string, codex: string): Promise<Array<{ pid: number; kind: string }>>;
  backup(stateDirectory: string, oldPlan: string): Promise<void>;
  /** Isolated for regression coverage of a crash/error at the plan commit boundary. */
  commit(path: string, text: string): Promise<void>;
}

function activationDependencies(overrides: Partial<NativeSharingActivationDependencies>): NativeSharingActivationDependencies {
  return {
    ...stageDependencies(overrides),
    primary: primaryServiceProcess,
    census: async (config, state, codex) => {
      const writers = [...await inspectLegacyWriters(config, state), ...await inspectNativeWriters(config, codex)];
      return [...new Map(writers.map(writer => [writer.pid, writer])).values()];
    },
    backup: async (state, oldPlan) => {
      const root = resolve(state, "service-backups"); await mkdir(root, { recursive: true, mode: 0o700 });
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.uid !== process.getuid?.() || (rootInfo.mode & 0o077)) throw new Error("Gateway service backups must be private");
      const backup = resolve(root, `native-sharing-staged-${Date.now()}`); await mkdir(backup, { mode: 0o700 });
      const backupInfo = await lstat(backup);
      if (!backupInfo.isDirectory() || backupInfo.uid !== process.getuid?.() || (backupInfo.mode & 0o077)) throw new Error("Gateway service backup must be private");
      await writeFile(resolve(backup, "service-plan.json"), oldPlan, { flag: "wx", mode: 0o600 });
    },
    commit: atomicPrivateText,
    ...overrides,
  };
}

type Deferral = "not_primary" | "registration" | "login_pending" | "stale_plan" | "plan_invalid" | "sdk_unavailable" | "gateway_runtime" | "writer_census" | "writers_present" | "backup_failed";

/**
 * Applies the previously staged change only while the primary launchd daemon is starting. All
 * failures before the atomic plan replacement keep the intent and return the original plan.
 */
export async function activatePendingNativeSharing(configPath: string, plan: ServicePlan, overrides: Partial<NativeSharingActivationDependencies> = {}): Promise<ServicePlan> {
  const deps = activationDependencies(overrides); const path = resolve(configPath);
  let committed: ServicePlan | undefined;
  let pending: PendingNativeSharing | undefined;
  try { pending = await readPendingNativeSharing((await loadConfig(path)).stateDirectory); }
  catch { safeNotice(deps, "native_sharing_deferred", { reason: "plan_invalid" }); return plan; }
  if (!pending) return plan;
  if (!await deps.primary()) { safeNotice(deps, "native_sharing_deferred", { reason: "not_primary" }); return plan; }
  const config = await loadConfig(path);
  try {
    return await underPlanThenLoginLock(config.stateDirectory, async () => {
      const latest = await readPendingNativeSharing(config.stateDirectory);
      if (!latest) return plan;
      if (!await deps.primary()) return defer(deps, "not_primary", plan);
      if (latest.configPath !== path) return defer(deps, "stale_plan", plan);
      const text = await readPlanText(config.stateDirectory); let current: ServicePlan;
      try { current = validateServicePlan(JSON.parse(text)); } catch { return defer(deps, "plan_invalid", plan); }
      if (current.config !== path) throw new PlanOwnershipRefusal("Unified service plan belongs to another configuration");
      // The old daemon may have committed the plan just before it died. Never rewrite or recheck
      // ownership in that case: completing receipt removal is the only safe idempotent action.
      if (sha256(text) === latest.candidatePlanSha256) {
        committed = current;
        await removePending(config.stateDirectory).catch(() => {});
        safeNotice(deps, "native_sharing_activated", { mode: latest.enableGateway ? "native_gateway" : "native" });
        return current;
      }
      if (sha256(text) !== latest.planSha256) return defer(deps, "stale_plan", current);
      if (!await deps.registration(path)) return defer(deps, "registration", current);
      if (await deps.pendingLogin(config.stateDirectory)) return defer(deps, "login_pending", current);
      let paths;
      try { paths = serviceNativeExecutionPaths(current); } catch { return defer(deps, "plan_invalid", current); }
      if (paths.nativeHome !== latest.nativeHome) return defer(deps, "stale_plan", current);
      try { await deps.nativeSdk(paths.codex); } catch { return defer(deps, "sdk_unavailable", current); }
      const next = candidate(current, latest);
      if (next.sharedExecutors && !(await deps.runtime())?.selectedModelCompaction) return defer(deps, "gateway_runtime", current);
      let writers: Array<{ pid: number; kind: string }>;
      try { writers = await deps.census(path, config.stateDirectory, paths.codex); } catch { return defer(deps, "writer_census", current); }
      if (writers.length) return defer(deps, "writers_present", current);
      try { await deps.backup(config.stateDirectory, text); } catch { return defer(deps, "backup_failed", current); }
      try { await deps.commit(servicePlanPath(config.stateDirectory), planText(next)); }
      catch {
        // An injected/platform writer can report after it renamed. Re-read only under both
        // locks and adopt exclusively the staged candidate; any other text stays pending.
        const committedText = await readPlanText(config.stateDirectory).catch(() => undefined);
        if (!committedText || sha256(committedText) !== latest.candidatePlanSha256) return defer(deps, "plan_invalid", current);
      }
      committed = next;
      // The committed plan may already be observed by launchd. A cleanup failure is deliberately
      // tolerated; the exact-candidate branch above completes it after the next start.
      await removePending(config.stateDirectory).catch(() => {});
      safeNotice(deps, "native_sharing_activated", { mode: latest.enableGateway ? "native_gateway" : "native" });
      return next;
    });
  } catch (error) {
    if (error instanceof PlanOwnershipRefusal) throw error;
    safeNotice(deps, "native_sharing_deferred", { reason: "plan_invalid" });
    return committed ?? plan;
  }
}

function defer(deps: NativeSharingActivationDependencies, reason: Deferral, plan: ServicePlan): ServicePlan {
  safeNotice(deps, "native_sharing_deferred", { reason });
  return plan;
}

function safeNotice(deps: NativeSharingStageDependencies, event: "native_sharing_staged" | "native_sharing_activated" | "native_sharing_deferred", fields: Record<string, string>): void {
  try { deps.notice(event, fields); } catch { /* Observability never changes the active plan. */ }
}
