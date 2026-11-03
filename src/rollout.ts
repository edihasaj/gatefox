import { readHealthTelemetry, unansweredSkewRefusals, type HealthEvent } from "./health-telemetry.js";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { loadConfig, type GatewayConfig } from "./config.js";
import { executionHostHome } from "./execution-host-storage.js";
import { ExecutionHostClient } from "./execution-host-client.js";
import { executionProbeReportValid, type ScrubbedExecutionProbeReport } from "./execution-probe.js";
import { statusFields } from "./health-checks.js";
import { configPath } from "./paths.js";
import { readServicePlan, serviceExecutionPaths, serviceStatusPath, type ServicePlan } from "./service-plan.js";
import { SocketAppServerConnection } from "./socket-app-server-connection.js";
import { readPendingNativeSharing } from "./service-native-staging.js";
import { readPendingClaudeConsolidation } from "./service-claude-staging.js";
import { locateInstall, parsePs, runVersions, type VersionsResult } from "./versions.js";

export type RolloutState = "ready" | "pending" | "blocked" | "failed";
export type RolloutReason =
  | "ready" | "installed_unknown" | "process_version_pending" | "service_plan_pending"
  | "service_status_pending" | "service_identity_pending" | "service_release_pending"
  | "component_pending" | "inference_pending" | "inference_failed" | "host_pending"
  | "host_status_pending" | "host_identity_pending" | "probe_pending" | "probe_stale"
  | "probe_failed" | "active_work" | "release_skew" | "rollout_changed" | "native_sharing_pending" | "native_owner_pending" | "claude_consolidation_pending";

interface HostIdentity {
  hostPid: number;
  startedAtMs: number;
  runningRelease: string;
  sourceCommit: string;
  catalogFingerprint: string;
  sdkSha256: string;
}

interface HostStatus {
  identity: HostIdentity;
  capabilities: string[];
  compatible: boolean;
  quiescing: boolean;
  cachedProbe?: ScrubbedExecutionProbeReport;
  activeWork: boolean;
  nativeHomeOwned?: boolean;
}

interface ServiceComponentStatus {
  id: string;
  kind: ServicePlan["components"][number]["kind"];
  state: string;
  pid?: number;
  startedAt?: string;
}

export interface RolloutReport {
  state: RolloutState;
  reason: RolloutReason;
  checkedAt: string;
  installed: string | null;
  versions: { total: number; current: number; pending: number; unknown: number };
  service?: { pid: number; runningRelease: string };
  inference?: { status: number; release: string };
  host?: { pid: number; startedAtMs: number; runningRelease: string; capabilities: string[] };
  probe?: Pick<ScrubbedExecutionProbeReport, "ready" | "reason" | "checkedAt" | "sdkVerified" | "configVerified" | "directToolVerified" | "completedTurn" | "commandVerified">;
}

export interface RolloutDeps {
  now?: () => number;
  configPath?: (explicit?: string) => Promise<string>;
  config?: (path: string) => Promise<GatewayConfig>;
  versions?: () => Promise<VersionsResult>;
  plan?: (state: string) => Promise<ServicePlan | undefined>;
  status?: (state: string) => Promise<unknown>;
  inference?: (port: number) => Promise<{ status: number; release?: string }>;
  host?: (input: { configPath: string; plan: ServicePlan; verify: boolean }) => Promise<{ status?: HostStatus; probe?: ScrubbedExecutionProbeReport; unavailable?: boolean }>;
  releaseSource?: (installed: string) => Promise<string | undefined>;
  componentLiveness?: (component: ServicePlan["components"][number], pid: number, startedAt: string) => Promise<boolean>;
  nativeSharingPending?: (state: string) => Promise<boolean>;
  claudeConsolidationPending?: (state: string) => Promise<boolean>;
  /** This Mac's recent telemetry, read for release skew refusals. */
  telemetry?: (state: string) => Promise<HealthEvent[]>;
}

const release = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/;
const sha256 = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{7,64}$/;
const probeTtlMs = 5 * 60_000;
const componentStartSlopMs = 1500;
const exec = promisify(execFile);
const result = (state: RolloutState, reason: RolloutReason, base: Omit<RolloutReport, "state" | "reason">): RolloutReport => ({ state, reason, ...base });
const reportProbe = (probe: ScrubbedExecutionProbeReport): RolloutReport["probe"] => ({
  ready: probe.ready, reason: probe.reason, checkedAt: probe.checkedAt, sdkVerified: probe.sdkVerified,
  configVerified: probe.configVerified, directToolVerified: probe.directToolVerified,
  completedTurn: probe.completedTurn, commandVerified: probe.commandVerified,
});

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function identity(value: unknown): HostIdentity | undefined {
  const row = object(value);
  if (!row || !Number.isSafeInteger(row.hostPid) || Number(row.hostPid) < 1 || !Number.isSafeInteger(row.startedAtMs) || Number(row.startedAtMs) < 0
    || typeof row.runningRelease !== "string" || !release.test(row.runningRelease)
    || typeof row.sourceCommit !== "string" || !commit.test(row.sourceCommit)
    || typeof row.catalogFingerprint !== "string" || !sha256.test(row.catalogFingerprint)
    || typeof row.sdkSha256 !== "string" || !sha256.test(row.sdkSha256)) return;
  return row as unknown as HostIdentity;
}

/** The RPC contains only fixed identity fields and booleans; malformed or old hosts earn no readiness. */
export function hostStatus(value: unknown): HostStatus | undefined {
  const row = object(value); if (!row) return;
  const attestation = object(row.attestation) ?? row;
  const host = identity(attestation); if (!host) return;
  const capabilities = Array.isArray(row.capabilities) ? row.capabilities.filter((value): value is string => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value)) : [];
  if (attestation.compatible !== true || !Number.isSafeInteger(attestation.activeGenerations) || Number(attestation.activeGenerations) < 0
    || !Number.isSafeInteger(attestation.compatibleGenerations) || !Number.isSafeInteger(attestation.incompatibleGenerations)
    || Number(attestation.compatibleGenerations) < 0 || Number(attestation.incompatibleGenerations) < 0
    || Number(attestation.compatibleGenerations) + Number(attestation.incompatibleGenerations) !== Number(attestation.activeGenerations)) return;
  const cached = row.lastProbe ?? row.probe;
  return {
    identity: host, capabilities: [...new Set(capabilities)].sort(), compatible: true, quiescing: row.quiescing === true,
    ...(executionProbeReportValid(cached) ? { cachedProbe: cached } : {}),
    activeWork: row.activeWork === true || row.probeState === "active_work",
    nativeHomeOwned: row.nativeHomeOwned === true,
  };
}

function sameIdentity(host: HostIdentity, probe: ScrubbedExecutionProbeReport): boolean {
  return probe.hostPid === host.hostPid && probe.startedAtMs === host.startedAtMs && probe.runningRelease === host.runningRelease
    && probe.sourceCommit === host.sourceCommit && probe.catalogFingerprint === host.catalogFingerprint && probe.sdkSha256 === host.sdkSha256;
}

function freshProbe(host: HostIdentity, probe: ScrubbedExecutionProbeReport, now: number): boolean {
  const checkedAt = Date.parse(probe.checkedAt);
  return Number.isFinite(checkedAt) && checkedAt <= now + 60_000 && now - checkedAt <= probeTtlMs && sameIdentity(host, probe);
}

/** A release proof is a point-in-time result only when the installed target and all observed gateway PIDs stayed put. */
function sameCohort(before: VersionsResult, after: VersionsResult): boolean {
  if (before.installed !== after.installed || before.processes.length !== after.processes.length) return false;
  const rows = (value: VersionsResult) => value.processes.map(process => `${process.role}\u0000${process.pid}\u0000${process.startedAt}\u0000${process.release}`).sort();
  return JSON.stringify(rows(before)) === JSON.stringify(rows(after));
}

async function readStatus(state: string): Promise<unknown> {
  return JSON.parse(await readFile(serviceStatusPath(state), "utf8"));
}

async function readInference(port: number): Promise<{ status: number; release?: string }> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000), redirect: "error" });
    return { status: response.status, ...(response.headers.get("x-gateway-release") ? { release: response.headers.get("x-gateway-release")! } : {}) };
  } catch { return { status: 0 }; }
}

/** Reads the immutable installed release receipt; a mutable `current` link never supplies source proof. */
async function readReleaseSource(installed: string): Promise<string | undefined> {
  for (const root of locateInstall().roots) {
    try {
      const file = resolve(root, "releases", installed, "package", "release.json");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o022) || info.size > 16 * 1024) continue;
      const value = object(JSON.parse(await readFile(file, "utf8")));
      if (value?.version === installed && typeof value.source === "string" && /^[a-f0-9]{40}$/.test(value.source)) return value.source;
    } catch { /* Another install root may still be readable. */ }
  }
  return;
}

/**
 * Connect only to a host that `discover(required=false)` already authenticated. Discovery does
 * not kick, lease, restart or acquire a generation; the extra RPC is read-only unless verify.
 */
async function readHost(input: { configPath: string; plan: ServicePlan; verify: boolean }): Promise<{ status?: HostStatus; probe?: ScrubbedExecutionProbeReport; unavailable?: boolean }> {
  let paths: { codex: string; nativeHome: string };
  try { paths = serviceExecutionPaths(input.plan); } catch { return { unavailable: true }; }
  let client: ExecutionHostClient | undefined;
  try {
    client = await ExecutionHostClient.discover(input.configPath, paths.nativeHome, paths.codex, "gateway", false);
    if (!client) return { unavailable: true };
    const socket = new SocketAppServerConnection(resolve(executionHostHome(input.configPath, paths.nativeHome), "host.sock"), async () => {});
    try {
      await socket.ready;
      const raw = await socket.request("execution/status", {});
      let status = hostStatus(raw);
      if (!status) return {};
      const probed = input.verify ? await socket.request("execution/probe", {}) : undefined;
      // The canary itself observes an identity twice; read status once more after it
      // returns so a concurrently acquired catalog cannot make a pre-probe snapshot
      // look current.
      if (input.verify) status = hostStatus(await socket.request("execution/status", {}));
      return status ? { status, ...(executionProbeReportValid(probed) ? { probe: probed } : {}) } : {};
    } finally { socket.stop(); }
  } catch { return { unavailable: true }; }
  finally { client?.close(); }
}

function componentStatuses(value: unknown): ServiceComponentStatus[] {
  const rows = object(value)?.components;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(value => {
    const row = object(value);
    if (!row || typeof row.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.id)
      || typeof row.kind !== "string" || !["inference", "desktop", "native", "tunnel", "claude-adapter", "claude-inference"].includes(row.kind)
      || typeof row.state !== "string") return [];
    return [{
      id: row.id, kind: row.kind as ServiceComponentStatus["kind"], state: row.state,
      ...(Number.isSafeInteger(row.pid) && Number(row.pid) > 0 ? { pid: Number(row.pid) } : {}),
      ...(typeof row.startedAt === "string" && Number.isFinite(Date.parse(row.startedAt)) ? { startedAt: row.startedAt } : {}),
    }];
  });
}

const startsTogether = (left: string, right: string): boolean => {
  const a = Date.parse(left); const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= componentStartSlopMs;
};

/** An external tunnel or desktop process is not a gateway release process, but its plan PID and OS start must still match. */
export async function componentLiveness(component: ServicePlan["components"][number], pid: number, startedAt: string): Promise<boolean> {
  try {
    const { stdout } = await exec("ps", ["-p", String(pid), "-o", "pid=,uid=,lstart=,comm="], { timeout: 3000 });
    const row = parsePs(stdout).find(row => row.pid === pid && row.uid === (process.getuid?.() ?? 0));
    if (!row || !startsTogether(row.startedAt, startedAt)) return false;
    const expected = await realpath(component.command).catch(() => undefined);
    if (!expected) return false;
    // `comm=` contains the executable, never its arguments. An absolute command
    // must resolve to the exact plan executable. BSD ps may return only a basename;
    // in that case an immutable text mapping supplies the exact path.
    const command = row.command.trim();
    if (command.startsWith("/") && await realpath(command).catch(() => undefined) === expected) return true;
    if (command !== basename(expected)) return false;
    const files = await exec("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"], { timeout: 3000 }).then(value => value.stdout, () => "");
    for (const line of files.split("\n").slice(0, 1024)) {
      if (!line.startsWith("n") || line.length > 4097) continue;
      if (await realpath(line.slice(1)).catch(() => undefined) === expected) return true;
    }
    return false;
  } catch { return false; }
}

async function requiredComponentPending(plan: ServicePlan, rawStatus: unknown, versions: VersionsResult,
  externalLiveness: (component: ServicePlan["components"][number], pid: number, startedAt: string) => Promise<boolean>): Promise<boolean> {
  const status = componentStatuses(rawStatus);
  for (const component of plan.components) {
    const row = status.find(entry => entry.id === component.id && entry.kind === component.kind);
    if (!row) return true;
    // Only a completed desktop registration intentionally lacks a child. Every
    // running plan child binds its own PID and start instant, so an unrelated
    // current same-role process cannot cover a crashed plan component.
    if (row.state === "complete") { if (component.kind !== "desktop") return true; continue; }
    if (row.state !== "running" || !row.pid || !row.startedAt) return true;
    const pid = row.pid; const startedAt = row.startedAt;
    // Claude keeps its separately pinned runtime. Do not relabel it as the main
    // installed release: verify the exact supervised executable and OS start.
    if (component.kind === "claude-adapter" || component.kind === "claude-inference") {
      if (!await externalLiveness(component, pid, startedAt)) return true;
      continue;
    }
    if (component.kind === "tunnel" || component.kind === "desktop") {
      const role = component.kind === "tunnel" ? "tunnel" : "desktop-adapter";
      if (versions.processes.some(process => process.role === role && process.pid === pid
        && process.release === versions.installed && startsTogether(process.startedAt, startedAt))) continue;
      if (!await externalLiveness(component, pid, startedAt)) return true;
      continue;
    }
    const role = component.kind === "inference" ? "inference" : "native-relay";
    if (!versions.processes.some(process => process.role === role && process.pid === pid
      && process.release === versions.installed && startsTogether(process.startedAt, startedAt))) return true;
  }
  return false;
}

export async function runRollout(verify: boolean, explicitConfig?: string, deps: RolloutDeps = {}): Promise<RolloutReport> {
  const now = deps.now?.() ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  const configFile = await (deps.configPath ?? configPath)(explicitConfig);
  const config = await (deps.config ?? loadConfig)(configFile);
  const versions = await (deps.versions ?? (() => runVersions()))();
  const counts = { total: versions.processes.length, current: versions.processes.filter(row => row.release === versions.installed).length,
    pending: versions.processes.filter(row => row.release !== versions.installed && row.release !== "unknown").length,
    unknown: versions.processes.filter(row => row.release === "unknown").length };
  const base = { checkedAt, installed: versions.installed, versions: counts };
  if (!versions.installed || !release.test(versions.installed)) return result("pending", "installed_unknown", base);
  if (counts.pending || counts.unknown) {
    // A lagging service that is also refusing chats of the installed release is not catching up by itself fast enough: chats
    // do not open. That is blocked, not a pending move to wait out (docs/rollout.md).
    const rows = await (deps.telemetry ?? (state => readHealthTelemetry(state)))(config.stateDirectory).catch(() => [] as HealthEvent[]);
    if (unansweredSkewRefusals(rows) > 0) return result("blocked", "release_skew", base);
    return result("pending", "process_version_pending", base);
  }
  const sharingPending = async (): Promise<boolean> => {
    try { return await (deps.nativeSharingPending ?? (async state => !!await readPendingNativeSharing(state)))(config.stateDirectory); }
    catch { return true; } // An unreadable adoption receipt cannot earn readiness.
  };
  if (await sharingPending()) return result("pending", "native_sharing_pending", base);
  const claudePending = async (): Promise<boolean> => {
    try { return await (deps.claudeConsolidationPending ?? (async state => !!await readPendingClaudeConsolidation(state)))(config.stateDirectory); }
    catch { return true; }
  };
  if (await claudePending()) return result("pending", "claude_consolidation_pending", base);

  const plan = await (deps.plan ?? readServicePlan)(config.stateDirectory);
  if (!plan) return result("pending", "service_plan_pending", base);
  let rawStatus: unknown;
  try { rawStatus = await (deps.status ?? readStatus)(config.stateDirectory); } catch { return result("pending", "service_status_pending", base); }
  const service = statusFields(rawStatus);
  const serviceRow = service.pid ? versions.processes.find(process => process.role === "service" && process.pid === service.pid) : undefined;
  const statusAt = Date.parse(service.updatedAt ?? "");
  if (service.stopping || !service.pid || !service.updatedAt || !service.runningRelease || !serviceRow || !Number.isFinite(statusAt)
    || statusAt < Date.parse(serviceRow.startedAt) || statusAt > now + 60_000 || now - statusAt > 30_000) {
    return result("pending", "service_identity_pending", base);
  }
  const serviceReport = { pid: service.pid, runningRelease: service.runningRelease };
  if (service.runningRelease !== versions.installed || serviceRow.release !== versions.installed) {
    return result("pending", "service_release_pending", { ...base, service: serviceReport });
  }
  if (await requiredComponentPending(plan, rawStatus, versions, deps.componentLiveness ?? componentLiveness)) {
    return result("pending", "component_pending", { ...base, service: serviceReport });
  }

  const inferred = await (deps.inference ?? readInference)(config.port);
  if (inferred.status !== 200) return result("failed", "inference_failed", { ...base, service: serviceReport, inference: { status: inferred.status, release: inferred.release ?? "unknown" } });
  if (!inferred.release || inferred.release !== versions.installed) return result("pending", "inference_pending", { ...base, service: serviceReport, inference: { status: inferred.status, release: inferred.release ?? "unknown" } });
  const inference = { status: inferred.status, release: inferred.release };

  const hostRead = await (deps.host ?? readHost)({ configPath: configFile, plan, verify });
  if (!hostRead.status) return result("pending", "host_pending", { ...base, service: serviceReport, inference });
  const host = hostRead.status.identity;
  const hostReport = { pid: host.hostPid, startedAtMs: host.startedAtMs, runningRelease: host.runningRelease, capabilities: hostRead.status.capabilities };
  const installedSource = await (deps.releaseSource ?? readReleaseSource)(versions.installed);
  const sameServiceStart = Math.floor(Date.parse(serviceRow.startedAt) / 1000) * 1000 === host.startedAtMs;
  if (!installedSource || hostRead.status.quiescing || host.hostPid !== service.pid || !sameServiceStart || host.runningRelease !== versions.installed
    || host.sourceCommit !== installedSource || !hostRead.status.compatible || !hostRead.status.capabilities.includes("gateway")) {
    return result("pending", "host_status_pending", { ...base, service: serviceReport, inference, host: hostReport });
  }
  if (plan.sharedNativeExecutor && (!hostRead.status.capabilities.includes("native") || !hostRead.status.nativeHomeOwned)) {
    return result("pending", "native_owner_pending", { ...base, service: serviceReport, inference, host: hostReport });
  }
  const probe = hostRead.probe ?? hostRead.status.cachedProbe;
  if (!probe) {
    const state: RolloutState = hostRead.status.activeWork ? "blocked" : "pending";
    return result(state, hostRead.status.activeWork ? "active_work" : "probe_pending", { ...base, service: serviceReport, inference, host: hostReport });
  }
  if (!freshProbe(host, probe, now)) return result("pending", "probe_stale", { ...base, service: serviceReport, inference, host: hostReport, probe: reportProbe(probe) });
  if (!probe.ready || !probe.sdkVerified || !probe.configVerified || !probe.directToolVerified || !probe.completedTurn || !probe.commandVerified) {
    return result("failed", "probe_failed", { ...base, service: serviceReport, inference, host: hostReport, probe: reportProbe(probe) });
  }
  // A canary can take long enough for an installer or idle adoption to move the
  // cohort. Its successful proof is deliberately not transferred to that later
  // release; only a second read of the same immutable process set earns ready.
  if (verify && !sameCohort(versions, await (deps.versions ?? (() => runVersions()))())) {
    return result("pending", "rollout_changed", { ...base, service: serviceReport, inference, host: hostReport, probe: reportProbe(probe) });
  }
  if (await sharingPending()) return result("pending", "native_sharing_pending", { ...base, service: serviceReport, inference, host: hostReport, probe: reportProbe(probe) });
  if (await claudePending()) return result("pending", "claude_consolidation_pending", { ...base, service: serviceReport, inference, host: hostReport, probe: reportProbe(probe) });
  return result("ready", "ready", { ...base, service: serviceReport, inference, host: hostReport, probe: reportProbe(probe) });
}

export const rolloutUsage = "Usage: gateway rollout [--json] [--verify] [--config PATH]\n";

export function formatRollout(report: RolloutReport): string {
  const line = `rollout ${report.state}: ${report.reason}`;
  return `${line}\ninstalled ${report.installed ?? "unknown"}; processes ${report.versions.current}/${report.versions.total} current\n`;
}

export async function rolloutCommand(args: string[], deps: RolloutDeps & { stdout?: (text: string) => void; stderr?: (text: string) => void } = {}): Promise<number> {
  const out = deps.stdout ?? (text => process.stdout.write(text)); const err = deps.stderr ?? (text => process.stderr.write(text));
  if (args.includes("--help") || args.includes("-h")) { out(rolloutUsage); return 0; }
  let json = false; let verify = false; let config: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--json") { json = true; continue; }
    if (value === "--verify") { verify = true; continue; }
    if (value === "--config" && typeof args[index + 1] === "string") { config = args[++index]; continue; }
    err(rolloutUsage); return 2;
  }
  try {
    const report = await runRollout(verify, config, deps);
    out(json ? JSON.stringify(report, null, 2) + "\n" : formatRollout(report));
    return report.state === "ready" ? 0 : report.state === "failed" ? 2 : 1;
  } catch {
    err("rollout: readiness could not be read\n"); return 2;
  }
}
