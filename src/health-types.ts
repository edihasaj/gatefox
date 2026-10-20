import type { ConfigRejection } from "./config-rejection.js";
/**
 * The vocabulary `gateway health` speaks in. Every reason is a fixed phrase plus
 * counts and versions, so a verdict can be read by a person, by `--json`, and by an
 * Uptime Kuma push without ever carrying a path, a command argument, or the text of
 * a failure. The watchdog exists so a ChatGPT update that breaks something is known
 * in minutes; that only works if the summary can be sent somewhere.
 */
export type FindingLevel = "info" | "warn" | "fail";
export interface Finding { level: FindingLevel; reason: string }
export type Verdict = "ok" | "warn" | "fail";

/** The window every count below covers, and the longest any single probe may take. */
export const healthWindowMs = 15 * 60_000;
export const pushTimeoutMs = 10_000;
export const smokeTimeoutMs = 10 * 60_000;
/**
 * How long a stopped smoke gets to take its own children down after SIGTERM. The check
 * starts its gateway, executor and engine in groups of their own, so killing only the
 * script would orphan them; the group is signalled first, and SIGKILL follows.
 */
export const smokeKillGraceMs = 15_000;
/** The refusal count in one window that turns a warning into a failure. */
export const refusalFailThreshold = 3;
/** A component that has run an older release for this long has stopped being "idle, not yet moved". */
export const staleLagMs = 48 * 60 * 60_000;
/** A service still running an older installed release after an hour needs attention, even for a patch update. */
export const staleServiceLagMs = 60 * 60_000;

/** Where this Mac keeps its own gateway state, and the port its inference serves. */
export interface HealthTargets { stateDirectory: string; port: number; clientOnly: boolean }

/** The pair that identifies which app build this Mac runs. Both are version strings. */
export interface AppVersions { bundle: string | null; engine: string | null }
/** The same pair, plus where it came from. `path` and `enginePath` never reach a report. */
export interface AppInfo extends AppVersions { state: "found" | "absent"; path: string; enginePath: string }

export interface ServiceComponentRow { kind: string; state: string }
/** What the unified service last published, reduced to kinds, states and a host answer. */
export interface ServiceSnapshot { installed: boolean; components: ServiceComponentRow[]; executionHost?: string }

/**
 * The loopback inference answer: whether anything served, and with which release.
 * `unreadable` is the probe itself failing, which is a warning about the check, not about the server.
 */
export interface InferenceProbe { state: "answered" | "unreachable" | "skipped" | "unreadable"; status?: number; release?: string | null; bodyStatus?: string | null;
  /** Why the server holds back a change to `gateway.json`, from the fixed list in `config-rejection.ts`; absent while the file in place serves. */
  configRejected?: ConfigRejection }

/** This run's smoke answer, or the recorded one when nothing needed re-running. */
export interface SmokeOutcome { ran: boolean; result: "pass" | "fail" | "unavailable" | "skipped"; phase?: string; recorded?: "pass" | "fail" | "unavailable" }
export interface PushOutcome { state: "sent" | "skipped" | "insecure" | "failed"; up?: boolean; error?: string }

export interface HealthReport {
  at: string;
  verdict: Verdict;
  findings: Finding[];
  app: { state: AppInfo["state"]; bundle: string | null; engine: string | null; changed: boolean };
  components: { installed: string | null; lagging: string[]; stale: string[] };
  service: { installed: boolean; components: ServiceComponentRow[]; executionHost?: string; hostFailures: number };
  inference: InferenceProbe;
  errors: {
    windowMinutes: number;
    rpcErrors: Record<string, number>;
    /** Every session refusal in the window. Only an ongoing run of `refusalFailThreshold` or more fails (see health-telemetry). */
    refusals: number;
    configRetries: number;
    configRetryRpcErrors: number;
    componentExits: Record<string, number>;
    nativeSharing: string[];
  };
  smoke: SmokeOutcome;
  push?: PushOutcome;
}

/** Runs one local command and returns its stdout; a failure throws. */
export type Exec = (command: string, args: string[]) => Promise<string>;

/** A phase name is a slug: the check names where it stopped, and nothing else may ride along. */
export const phaseName = /^[a-z0-9-]{1,64}$/;
/** A phase, from the check or from the state file; a name that is not a slug reads as `unknown`. */
export function safePhase(value: unknown): string | undefined {
  if (value === undefined || value === null) return;
  return typeof value === "string" && phaseName.test(value) ? value : "unknown";
}

/** A version or status token: one short word, never a sentence or a path. */
export const valueToken = /^[0-9A-Za-z.+-]{1,32}$/;
/** A release header or a body status, reduced to a token; anything wider reads as `unknown`. */
export function safeToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return;
  return typeof value === "string" && valueToken.test(value) ? value : "unknown";
}

/** The worst level seen decides the verdict; info never moves one. */
export function verdictOf(findings: Finding[]): Verdict {
  if (findings.some(finding => finding.level === "fail")) return "fail";
  return findings.some(finding => finding.level === "warn") ? "warn" : "ok";
}

/** The exit code a verdict and an attempted push map to. */
export function exitCodeFor(verdict: Verdict, push?: PushOutcome): number {
  if (push?.state === "insecure") return 2;
  const code = verdict === "fail" ? 2 : verdict === "warn" ? 1 : 0;
  return push?.state === "failed" ? 3 : code;
}
