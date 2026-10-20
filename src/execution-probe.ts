import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GatewaySdkRuntime } from "./gateway-sdk-runtime.js";

/** Fixed reasons are safe for a health/status response. Never return child output or local paths. */
export type ExecutionProbeReason =
  | "ready" | "runtime_unavailable" | "identity_unavailable" | "identity_changed" | "runtime_changed"
  | "child_timeout" | "child_cancelled" | "child_invalid" | "child_failed";

/** The serving host supplies this from its frozen ownership/status snapshot. */
export interface ExecutionProbeHostSnapshot {
  hostPid: number;
  startedAtMs: number;
  runningRelease: string;
  sourceCommit: string;
  catalogFingerprint: string;
}

/** A deliberately small readiness result: it contains proof fields, never child diagnostics or paths. */
export interface ScrubbedExecutionProbeReport {
  ready: boolean;
  reason: ExecutionProbeReason;
  checkedAt: string;
  hostPid?: number;
  startedAtMs?: number;
  runningRelease?: string;
  sourceCommit?: string;
  catalogFingerprint?: string;
  sdkSha256?: string;
  sdkVerified: boolean;
  configVerified: boolean;
  directToolVerified: boolean;
  completedTurn: boolean;
  commandVerified: boolean;
}

export interface ExecutionProbeChildInput {
  executable: string;
  packageDirectory: string;
  sdkSha256: string;
  catalogFingerprint: string;
  /** Parent-created 0700 root with a private marker; never derived from an RPC caller. */
  root: string;
}

export interface ExecutionProbeChildResult {
  sdkVerified: boolean;
  configVerified: boolean;
  directToolVerified: boolean;
  completedTurn: boolean;
  commandVerified: boolean;
}

export type ExecutionProbeChildRunner = (input: ExecutionProbeChildInput, signal: AbortSignal) => Promise<ExecutionProbeChildResult>;

export interface ExecutionProbeManagerOptions {
  runtime: () => Promise<GatewaySdkRuntime | undefined>;
  snapshot: () => ExecutionProbeHostSnapshot | Promise<ExecutionProbeHostSnapshot>;
  signal?: AbortSignal;
  timeoutMs?: number;
  runChild?: ExecutionProbeChildRunner;
}

const timeoutMs = 30_000;
const sha = /^[a-f0-9]{64}$/;
const release = /^[0-9A-Za-z._-]{1,64}$/;
const commit = /^[a-f0-9]{40}$/;
const fingerprint = /^[a-f0-9]{64}$/;
const start = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function validSnapshot(value: unknown): value is ExecutionProbeHostSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return start(row.hostPid) && start(row.startedAtMs) && typeof row.runningRelease === "string" && release.test(row.runningRelease)
    && typeof row.sourceCommit === "string" && commit.test(row.sourceCommit)
    && typeof row.catalogFingerprint === "string" && fingerprint.test(row.catalogFingerprint);
}

function sameSnapshot(left: ExecutionProbeHostSnapshot, right: ExecutionProbeHostSnapshot): boolean {
  return left.hostPid === right.hostPid && left.startedAtMs === right.startedAtMs && left.runningRelease === right.runningRelease
    && left.sourceCommit === right.sourceCommit && left.catalogFingerprint === right.catalogFingerprint;
}

function sameRuntime(left: GatewaySdkRuntime, right: GatewaySdkRuntime): boolean {
  return resolve(left.executable) === resolve(right.executable) && left.binarySha256 === right.binarySha256;
}

function report(reason: ExecutionProbeReason, checkedAt: string, snapshot?: ExecutionProbeHostSnapshot, runtime?: GatewaySdkRuntime, result?: ExecutionProbeChildResult): ScrubbedExecutionProbeReport {
  const complete = result?.sdkVerified === true && result.configVerified === true && result.directToolVerified === true
    && result.completedTurn === true && result.commandVerified === true;
  return {
    ready: reason === "ready" && complete,
    reason,
    checkedAt,
    ...(snapshot ? { hostPid: snapshot.hostPid, startedAtMs: snapshot.startedAtMs, runningRelease: snapshot.runningRelease, sourceCommit: snapshot.sourceCommit, catalogFingerprint: snapshot.catalogFingerprint } : {}),
    ...(runtime ? { sdkSha256: runtime.binarySha256 } : {}),
    sdkVerified: result?.sdkVerified === true,
    configVerified: result?.configVerified === true,
    directToolVerified: result?.directToolVerified === true,
    completedTurn: result?.completedTurn === true,
    commandVerified: result?.commandVerified === true,
  };
}

function childResult(value: unknown): value is ExecutionProbeChildResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ["sdkVerified", "configVerified", "directToolVerified", "completedTurn", "commandVerified"].every(key => typeof row[key] === "boolean");
}

/** Validates a report crossing the host RPC boundary. */
export function executionProbeReportValid(value: unknown): value is ScrubbedExecutionProbeReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const fields = new Set(["ready", "reason", "checkedAt", "hostPid", "startedAtMs", "runningRelease", "sourceCommit", "catalogFingerprint", "sdkSha256",
    "sdkVerified", "configVerified", "directToolVerified", "completedTurn", "commandVerified"]);
  if (Object.keys(row).some(key => !fields.has(key))) return false;
  if (typeof row.ready !== "boolean" || typeof row.reason !== "string" || !["ready", "runtime_unavailable", "identity_unavailable", "identity_changed", "runtime_changed", "child_timeout", "child_cancelled", "child_invalid", "child_failed"].includes(row.reason)
    || typeof row.checkedAt !== "string" || !Number.isFinite(Date.parse(row.checkedAt))) return false;
  for (const key of ["sdkVerified", "configVerified", "directToolVerified", "completedTurn", "commandVerified"]) if (typeof row[key] !== "boolean") return false;
  if (row.hostPid !== undefined && !start(row.hostPid) || row.startedAtMs !== undefined && !start(row.startedAtMs)
    || row.runningRelease !== undefined && (typeof row.runningRelease !== "string" || !release.test(row.runningRelease))
    || row.sourceCommit !== undefined && (typeof row.sourceCommit !== "string" || !commit.test(row.sourceCommit))
    || row.catalogFingerprint !== undefined && (typeof row.catalogFingerprint !== "string" || !fingerprint.test(row.catalogFingerprint))
    || row.sdkSha256 !== undefined && (typeof row.sdkSha256 !== "string" || !sha.test(row.sdkSha256))) return false;
  return row.ready === (row.reason === "ready" && row.sdkVerified && row.configVerified && row.directToolVerified && row.completedTurn && row.commandVerified);
}

function stopOwned(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    } else child.kill("SIGKILL");
  }, 1500);
  timer.unref();
  void once(child, "close").finally(() => clearTimeout(timer));
}

/** Builds the fixed release-owned canary child runner. The optional URL is a compiled-test seam only. */
export function executionProbeChildRunner(childUrl = new URL("./execution-probe-child.js", import.meta.url)): ExecutionProbeChildRunner {
  const module = fileURLToPath(childUrl);
  return async (input, signal) => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR"]) if (typeof process.env[key] === "string") env[key] = process.env[key];
  const child = spawn(process.execPath, [module], { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "ignore"], env });
  let output = ""; let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (overflow) return;
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output) > 16 * 1024) { overflow = true; stopOwned(child); }
  });
  const cancelled = () => stopOwned(child);
  if (signal.aborted) cancelled(); else signal.addEventListener("abort", cancelled, { once: true });
  try {
    child.stdin.end(JSON.stringify(input) + "\n");
    await once(child, "close");
  } finally { signal.removeEventListener("abort", cancelled); }
  if (signal.aborted || overflow) throw Object.assign(new Error("probe child cancelled"), { executionProbeReason: signal.aborted ? "child_cancelled" : "child_invalid" });
  const lines = output.trim().split("\n");
  if (lines.length !== 1 || !lines[0]) throw Object.assign(new Error("probe child result invalid"), { executionProbeReason: "child_invalid" });
  let decoded: unknown;
  try { decoded = JSON.parse(lines[0]); } catch { throw Object.assign(new Error("probe child result invalid"), { executionProbeReason: "child_invalid" }); }
  if (!childResult(decoded)) throw Object.assign(new Error("probe child result invalid"), { executionProbeReason: "child_invalid" });
    return decoded;
  };
}

/** Runs the fixed release-owned canary child. No caller-controlled executable or child arguments are accepted. */
export const runExecutionProbeChild = executionProbeChildRunner();

/** One canary at a time per execution host. It deliberately keeps no success cache: a host is ready only when checked now. */
export class ExecutionProbeManager {
  private readonly controller = new AbortController();
  private current?: Promise<ScrubbedExecutionProbeReport>;
  private closed = false;
  private readonly timeout: number;
  private readonly runChild: ExecutionProbeChildRunner;

  constructor(private readonly options: ExecutionProbeManagerOptions) {
    this.timeout = Math.max(1, Math.min(options.timeoutMs ?? timeoutMs, timeoutMs));
    this.runChild = options.runChild ?? runExecutionProbeChild;
    if (options.signal?.aborted) void this.close();
    else options.signal?.addEventListener("abort", () => void this.close(), { once: true });
  }

  run(): Promise<ScrubbedExecutionProbeReport> {
    this.current ??= this.runNow().finally(() => { this.current = undefined; });
    return this.current;
  }

  async close(): Promise<void> { this.closed = true; this.controller.abort(); await this.current?.catch(() => undefined); }

  private async runNow(): Promise<ScrubbedExecutionProbeReport> {
    const checkedAt = new Date().toISOString();
    if (this.closed || this.controller.signal.aborted) return report("child_cancelled", checkedAt);
    const deadline = new AbortController();
    const abort = () => deadline.abort();
    this.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => deadline.abort(), this.timeout); timer.unref();
    let endLookup: (reason: ExecutionProbeReason) => void = () => {};
    const stopped = new Promise<ExecutionProbeReason>(resolve => { endLookup = resolve; });
    const stopReason = (): ExecutionProbeReason | undefined =>
      this.closed || this.controller.signal.aborted ? "child_cancelled" : deadline.signal.aborted ? "child_timeout" : undefined;
    const stop = () => endLookup(stopReason() ?? "child_timeout");
    this.controller.signal.addEventListener("abort", stop, { once: true });
    deadline.signal.addEventListener("abort", stop, { once: true });
    type AwaitedProbe<T> = { value: T } | { reason: ExecutionProbeReason };
    const wait = async <T>(work: Promise<T>): Promise<AwaitedProbe<T>> => {
      const before = stopReason(); if (before) return { reason: before };
      const result = await Promise.race([
        work.then(value => ({ value }) as AwaitedProbe<T>),
        stopped.then(reason => ({ reason }) as AwaitedProbe<T>),
      ]);
      return stopReason() ? { reason: stopReason()! } : result;
    };
    const lookup = () => Promise.all([
      Promise.resolve().then(() => this.options.runtime()).catch(() => undefined),
      Promise.resolve().then(() => this.options.snapshot()).catch(() => undefined),
    ]);
    try {
      const initial = await wait(lookup());
      if ("reason" in initial) return report(initial.reason, checkedAt);
      const [runtime, snapshot] = initial.value;
      if (!runtime || !sha.test(runtime.binarySha256)) return report("runtime_unavailable", checkedAt);
      if (!validSnapshot(snapshot)) return report("identity_unavailable", checkedAt, undefined, runtime);
      const packageDirectory = dirname(dirname(resolve(runtime.executable)));
      let root: string | undefined;
      let result: ExecutionProbeChildResult;
      try {
        root = await mkdtemp(resolve(tmpdir(), "gateway-execution-probe-"));
        if (stopReason()) return report(stopReason()!, checkedAt, snapshot, runtime);
        await chmod(root, 0o700);
        if (stopReason()) return report(stopReason()!, checkedAt, snapshot, runtime);
        await writeFile(resolve(root, ".execution-probe-root"), "harness-gateway-execution-probe\n", { mode: 0o600 });
        if (stopReason()) return report(stopReason()!, checkedAt, snapshot, runtime);
        try { result = await this.runChild({ executable: runtime.executable, packageDirectory, sdkSha256: runtime.binarySha256, catalogFingerprint: snapshot.catalogFingerprint, root }, deadline.signal); }
        catch (error) {
          const reason = (error as { executionProbeReason?: unknown })?.executionProbeReason;
          return report(reason === "child_invalid" ? "child_invalid" : stopReason() ?? "child_failed", checkedAt, snapshot, runtime);
        }
      } finally { if (root) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {}); }
      const later = await wait(lookup());
      if ("reason" in later) return report(later.reason, checkedAt, snapshot, runtime, result);
      const [laterRuntime, laterSnapshot] = later.value;
      if (!laterRuntime || !sameRuntime(runtime, laterRuntime)) return report("runtime_changed", checkedAt, snapshot, runtime, result);
      if (!validSnapshot(laterSnapshot) || !sameSnapshot(snapshot, laterSnapshot)) return report("identity_changed", checkedAt, snapshot, runtime, result);
      if (stopReason()) return report(stopReason()!, checkedAt, snapshot, runtime, result);
      return report(result.sdkVerified && result.configVerified && result.directToolVerified && result.completedTurn && result.commandVerified ? "ready" : "child_failed", checkedAt, snapshot, runtime, result);
    } finally {
      clearTimeout(timer); this.controller.signal.removeEventListener("abort", abort); this.controller.signal.removeEventListener("abort", stop); deadline.signal.removeEventListener("abort", stop);
    }
  }
}
