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
/** A component that has run an older release for this long has stopped being "idle, not yet moved". */
export const staleLagMs = 48 * 60 * 60_000;

/** Where this Mac keeps its own gateway state, and the port its inference serves. */
export interface HealthTargets { stateDirectory: string; port: number; clientOnly: boolean }

/** The pair that identifies which app build this Mac runs. Both are version strings. */
export interface AppVersions { bundle: string | null; engine: string | null }
/** The same pair, plus where it came from. `path` and `enginePath` never reach a report. */
export interface AppInfo extends AppVersions { state: "found" | "absent"; path: string; enginePath: string }

export interface ServiceComponentRow { kind: string; state: string }
/** What the unified service last published, reduced to kinds, states and a host answer. */
export interface ServiceSnapshot { installed: boolean; components: ServiceComponentRow[]; executionHost?: string }

/** The loopback inference answer: whether anything served, and with which release. */
export interface InferenceProbe { state: "answered" | "unreachable" | "skipped"; status?: number; release?: string | null; bodyStatus?: string | null }

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
