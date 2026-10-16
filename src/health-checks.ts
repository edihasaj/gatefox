import type { VersionsResult } from "./versions.js";
import { staleLagMs, type AppInfo, type Finding, type InferenceProbe } from "./health-types.js";
import type { TelemetrySignals } from "./health-telemetry.js";

/**
 * The checks behind `gateway health`, each a plain function from what was read to the
 * findings it earns. Nothing here touches a machine: reading lives in health.ts, so
 * every branch can be handed a fixture. A finding holds a fixed phrase plus counts and
 * versions, never a path, an argument, or the text of an error.
 */

/** The two leading numbers of a release name, or nothing for `unknown` and `checkout`. */
function releasePair(release: string): [number, number] | undefined {
  const match = /^(\d+)\.(\d+)\./.exec(release);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** How many minor releases one name sits behind another; a major apart counts as many. */
export function minorDistance(installed: string, release: string): number | undefined {
  const ahead = releasePair(installed); const behind = releasePair(release);
  if (!ahead || !behind) return;
  return (ahead[0] - behind[0]) * 100 + (ahead[1] - behind[1]);
}

/** Every distinct role and release running something older than what is installed. */
export function laggingNames(result: VersionsResult): string[] {
  return [...new Set(result.processes.filter(row => row.release !== result.installed).map(row => `${row.role}@${row.release}`))].sort();
}

/**
 * The lagging pair that is no longer a lag: more than one minor behind the installed
 * release, and started long enough ago that an idle move had every chance to happen.
 */
export function staleNames(result: VersionsResult, now: number, lagMs = staleLagMs): string[] {
  if (!result.installed) return [];
  const names = new Set<string>();
  for (const row of result.processes) {
    if (row.release === result.installed) continue;
    const distance = minorDistance(result.installed, row.release);
    const started = Date.parse(row.startedAt);
    if (distance !== undefined && distance > 1 && !Number.isNaN(started) && now - started > lagMs) names.add(`${row.role}@${row.release}`);
  }
  return [...names].sort();
}

export function componentFindings(result: VersionsResult, now: number): { findings: Finding[]; lagging: string[]; stale: string[] } {
  const stale = staleNames(result, now);
  const lagging = laggingNames(result).filter(name => !stale.includes(name));
  return { lagging, stale, findings: [
    ...lagging.map(name => ({ level: "warn" as const, reason: `lagging ${name}` })),
    ...stale.map(name => ({ level: "fail" as const, reason: `stale ${name}` })),
  ] };
}

/** A new app build is news, not a fault: the smoke run is what decides whether it broke. */
export function appFindings(info: AppInfo, changed: boolean): Finding[] {
  if (info.state === "absent") return [{ level: "info", reason: "app absent" }];
  return changed ? [{ level: "info", reason: "app changed" }] : [];
}

/** What the unified service last published, reduced to kinds, states and counts. */
export interface ServiceStatus {
  installed: boolean;
  components: Array<{ kind: string; state: string }>;
  executionHost?: string;
  stopping?: boolean;
  published: boolean;
}

/** The snapshot file's shape, kept to the fields the watchdog is allowed to read. */
export function statusFields(value: unknown): ServiceStatus {
  if (!value || typeof value !== "object") return { installed: false, components: [], published: false };
  const row = value as Record<string, unknown>;
  const components = Array.isArray(row.components) ? row.components.flatMap(entry => {
    const component = entry as Record<string, unknown>;
    return typeof component.kind === "string" && typeof component.state === "string" ? [{ kind: component.kind, state: component.state }] : [];
  }) : [];
  const host = row.executionHost as Record<string, unknown> | undefined;
  return { installed: true, published: true, components, ...(typeof host?.state === "string" ? { executionHost: host.state } : {}), ...(row.stopping === true ? { stopping: true } : {}) };
}

/** A component the service is still waiting on. A paused native relay is a choice, not a fault. */
export function serviceFindings(status: ServiceStatus, signals: TelemetrySignals): Finding[] {
  if (!status.installed) return [{ level: "info", reason: "service not installed" }];
  const findings: Finding[] = [];
  if (!status.published) findings.push({ level: "warn", reason: "service published nothing" });
  else if (!status.components.length && !status.stopping) findings.push({ level: "warn", reason: "service runs no components" });
  for (const component of status.components) {
    if (component.state === "running" || component.state === "complete") continue;
    findings.push(component.state === "paused"
      ? { level: "info", reason: `${component.kind} paused` }
      : { level: "warn", reason: `${component.kind} ${component.state}` });
  }
  if (status.executionHost === "failed") findings.push({ level: "fail", reason: "execution host failed" });
  if (signals.hostFailures > 0) findings.push({ level: "warn", reason: `execution host restarted ${signals.hostFailures}x` });
  for (const event of signals.nativeSharing) findings.push({ level: "info", reason: event });
  return findings;
}

/** Whether the parked native relay is a choice the service made, read from its snapshot. */
export const nativePaused = (status: ServiceStatus): boolean =>
  status.components.some(component => component.kind === "native" && component.state === "paused");

/** Everything the window's telemetry says about failures; counts only, never text. */
export function errorFindings(signals: TelemetrySignals, paused = false): Finding[] {
  const findings: Finding[] = Object.entries(signals.rpcErrors).sort()
    .map(([method, count]) => ({ level: "fail" as const, reason: `refused ${method} ${count}x` }));
  if (signals.retriedThenRefused > 0) findings.push({ level: "fail", reason: `config retry refused ${signals.retriedThenRefused}x` });
  else if (signals.featureRetries > 0) findings.push({ level: "info", reason: `config retried ${signals.featureRetries}x` });
  for (const [kind, count] of Object.entries(signals.exits).sort()) {
    // A native relay that is parked by choice exits once and stays out; that is not churn.
    findings.push({ level: kind === "native" && paused ? "info" : "warn", reason: `${kind} exited ${count}x` });
  }
  return findings;
}

/** The loopback inference answer: it must serve, and it must serve the installed release. */
export function inferenceFindings(probe: InferenceProbe, installed: string | null): Finding[] {
  if (probe.state === "skipped") return [{ level: "info", reason: "inference remote" }];
  if (probe.state === "unreachable") return [{ level: "fail", reason: "inference not serving" }];
  if (probe.status !== 200) return [{ level: "fail", reason: `inference status ${probe.status ?? "unknown"}` }];
  if (probe.bodyStatus && probe.bodyStatus !== "ok") return [{ level: "fail", reason: `inference ${probe.bodyStatus}` }];
  if (!probe.release) return [{ level: "warn", reason: "inference release unknown" }];
  if (installed && probe.release !== installed) return [{ level: "warn", reason: `lagging inference@${probe.release}` }];
  return [];
}

/** A failing phase is the loudest signal the watchdog has: the app moved and chats broke. */
export function smokeFindings(result: "pass" | "fail" | "unavailable" | "skipped", phase?: string): Finding[] {
  if (result === "fail") return [{ level: "fail", reason: phase ? `smoke failed at ${phase}` : "smoke failed" }];
  if (result === "unavailable") return [{ level: "warn", reason: "smoke unavailable" }];
  return [];
}
