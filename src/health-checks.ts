import type { VersionsResult } from "./versions.js";
import { refusalFailThreshold, safePhase, safeToken, staleLagMs, staleServiceLagMs, type AppInfo, type Finding, type InferenceProbe } from "./health-types.js";
import type { TelemetrySignals } from "./health-telemetry.js";
import type { ServicePlan } from "./service-plan.js";
import { isClaudeComponent } from "./service-claude-activity.js";

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

/**
 * How many minor releases one name sits behind another. A different major counts as more than
 * one minor behind whatever its numbers say: minor numbers do not compare across a boundary.
 */
export function minorDistance(installed: string, release: string): number | undefined {
  const ahead = releasePair(installed); const behind = releasePair(release);
  if (!ahead || !behind) return;
  const distance = (ahead[0] - behind[0]) * 100 + (ahead[1] - behind[1]);
  return ahead[0] > behind[0] ? Math.max(distance, 2) : distance;
}

/** Every distinct role and release running something older than what is installed. */
export function laggingNames(result: VersionsResult): string[] {
  return [...new Set(result.processes.filter(row => row.release !== result.installed).map(row => `${row.role}@${row.release}`))].sort();
}

/**
 * A service still behind any installed release after an hour needs attention. Other
 * processes retain the wider allowance for loaded chats and reused native components:
 * more than one minor behind for longer than `lagMs`.
 *
 * The clock starts when `current` was switched (`since`, the link's own mtime), not when the
 * process started: a daemon that has run for a week was still given the release the moment
 * the Mac moved. Without that answer the process start is the only clock there is.
 */
export function staleNames(result: VersionsResult, now: number, lagMs = staleLagMs, since?: number): string[] {
  if (!result.installed) return [];
  const names = new Set<string>();
  for (const row of result.processes) {
    if (row.release === result.installed) continue;
    const distance = minorDistance(result.installed, row.release);
    const sinceRow = since ?? Date.parse(row.startedAt);
    const stale = row.role === "service"
      ? olderRelease(row.release, result.installed) && now - sinceRow > staleServiceLagMs
      : distance !== undefined && distance > 1 && now - sinceRow > lagMs;
    if (stale && Number.isFinite(sinceRow)) names.add(`${row.role}@${row.release}`);
  }
  return [...names].sort();
}

/** Compare canonical releases only; unknown receipts and a newer service during rollback never earn an older-release alarm. */
function olderRelease(release: string, installed: string): boolean {
  const version = /^(\d+)\.(\d+)\.(\d+)$/;
  const before = version.exec(release)?.slice(1).map(Number);
  const after = version.exec(installed)?.slice(1).map(Number);
  if (!before || !after || ![...before, ...after].every(Number.isSafeInteger)) return false;
  for (let index = 0; index < 3; index++) if (before[index] !== after[index]) return before[index] < after[index];
  return false;
}

export function componentFindings(result: VersionsResult, now: number, since?: number): { findings: Finding[]; lagging: string[]; stale: string[] } {
  const stale = staleNames(result, now, staleLagMs, since);
  const lagging = laggingNames(result).filter(name => !stale.includes(name));
  return { lagging, stale, findings: [
    ...lagging.map(name => ({ level: "warn" as const, reason: `lagging ${name}` })),
    ...stale.map(name => ({ level: "fail" as const, reason: `stale ${name}` })),
  ] };
}

/**
 * Why a service behind the installed release has not moved, and what moves it. A service whose controller already runs the
 * installed release moved live: only its bootstrap stays until a natural start, and its execution host moves once its chats
 * drain (no running turn), so that is information, not a fault. A service whose controller did not move with a configured
 * Claude Desktop component refuses every automatic restart (`claude_busy`) and needs the forced restart. Fixed phrases only.
 */
export function upgradeFindings(plan: ServicePlan | undefined, lagging: string[], stale: string[], controllerRelease?: string, installed?: string | null): Finding[] {
  if (![...lagging, ...stale].some(name => name.startsWith("service@"))) return [];
  if (installed && controllerRelease === installed) return [{ level: "info", reason: "service moved live; its execution host follows once chats drain: see gateway activity" }];
  if (plan?.components.some(component => isClaudeComponent(component))) {
    return [{ level: "warn", reason: "service upgrade blocked by Claude Desktop components: run gateway service restart --force when Claude is idle" }];
  }
  return [{ level: "info", reason: "service upgrade waits for no running turn: see gateway activity" }];
}

/** A new app build is news, not a fault: the smoke run is what decides whether it broke. */
export function appFindings(info: AppInfo, changed: boolean): Finding[] {
  if (info.state === "absent") return [{ level: "info", reason: "app absent" }];
  return changed ? [{ level: "info", reason: "app changed" }] : [];
}

/** What the unified service last published, reduced to kinds, states and counts. */
export interface ServiceStatus {
  installed: boolean;
  components: Array<{ kind: string; state: string; pausedReason?: string; pausedAt?: string; startedAt?: string; lastConnectedAt?: string }>;
  executionHost?: string;
  pid?: number;
  updatedAt?: string;
  runningRelease?: string;
  /** The release whose controller the service runs; differs from `runningRelease` after a live controller update. */
  controllerRelease?: string;
  stopping?: boolean;
  published: boolean;
}

/** The snapshot file's shape, kept to the fields the watchdog is allowed to read. */
export function statusFields(value: unknown): ServiceStatus {
  if (!value || typeof value !== "object") return { installed: false, components: [], published: false };
  const row = value as Record<string, unknown>;
  const components = Array.isArray(row.components) ? row.components.flatMap(entry => {
    const component = entry as Record<string, unknown>;
    return typeof component.kind === "string" && typeof component.state === "string"
      ? [{ kind: component.kind, state: component.state,
        ...(typeof component.pausedReason === "string" && /^[a-z_]{1,32}$/.test(component.pausedReason) ? { pausedReason: component.pausedReason } : {}),
        ...(typeof component.pausedAt === "string" && Number.isFinite(Date.parse(component.pausedAt)) ? { pausedAt: component.pausedAt } : {}),
        ...(typeof component.startedAt === "string" && Number.isFinite(Date.parse(component.startedAt)) ? { startedAt: component.startedAt } : {}),
        ...(typeof component.lastConnectedAt === "string" && Number.isFinite(Date.parse(component.lastConnectedAt)) ? { lastConnectedAt: component.lastConnectedAt } : {}) }] : [];
  }) : [];
  const host = row.executionHost as Record<string, unknown> | undefined;
  return { installed: true, published: true, components, ...(typeof host?.state === "string" ? { executionHost: host.state } : {}),
    ...(Number.isSafeInteger(row.pid) && Number(row.pid) > 0 ? { pid: Number(row.pid) } : {}),
    ...(typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt)) ? { updatedAt: row.updatedAt } : {}),
    ...(typeof row.runningRelease === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/.test(row.runningRelease) ? { runningRelease: row.runningRelease } : {}),
    ...(typeof row.controllerRelease === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.[0-9]$/.test(row.controllerRelease) ? { controllerRelease: row.controllerRelease } : {}),
    ...(row.stopping === true ? { stopping: true } : {}) };
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

/** What the watchdog may know about the relay's registration and connection: counts and ages, never a path. */
export interface RelayHealth { registered: boolean; connected?: boolean }
/** A registered relay that is not running this long leaves the phone without this Mac; it is worth a warning. */
export const relayDownWarnMs = 5 * 60_000;

/**
 * A registered relay owns the machine's remote control: every engine stands down for it, so one that is paused or not connected
 * leaves the phone without this Mac until it is back. The warning names the cause class when it is known and the way out.
 */
export function relayFindings(status: ServiceStatus, relay: RelayHealth, now: number): Finding[] {
  if (!relay.registered) return [];
  const way = "gateway native uninstall gives remote control back to ChatGPT";
  const component = status.components.find(entry => entry.kind === "native");
  if (component?.state === "paused" && component.pausedAt) {
    const minutes = Math.floor((now - Date.parse(component.pausedAt)) / 60_000);
    if (minutes * 60_000 < relayDownWarnMs) return [];
    const cause = component.pausedReason === "failing" ? "the relay keeps failing" : component.pausedReason === "not_registered" ? "the service has not started it since the registration" : "cause unknown";
    return [{ level: "warn", reason: `native relay registered but paused for ${minutes} min (${cause}); the phone cannot reach this Mac; ${way}` }];
  }
  if (component?.state === "running" && relay.connected === false) {
    // Measured from the last time the relay was connected, or from its start if it never was in this run. The age of its status
    // file would not do: the relay rewrites that on every change, and a refused connection (HTTP 409) changes it all the time.
    const since = Math.max(Date.parse(component.lastConnectedAt ?? "") || 0, Date.parse(component.startedAt ?? "") || 0);
    if (since > 0 && now - since >= relayDownWarnMs)
      return [{ level: "warn", reason: `native relay registered but not connected for ${Math.floor((now - since) / 60_000)} min; the phone cannot reach this Mac; ${way}` }];
  }
  return [];
}

/** Whether the parked native relay is a choice the service made, read from its snapshot. */
export const nativePaused = (status: ServiceStatus): boolean =>
  status.components.some(component => component.kind === "native" && component.state === "paused");

/** The UTC hour and minute of an instant, the way the report names when a refusal stopped. */
const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/**
 * Everything the window's telemetry says about failures; counts only, never text.
 *
 * A session refusal is judged by whether it is still happening, then by how many there were. It
 * is ongoing while one happened in the last five minutes after the latest recovery marker (a
 * self-upgrade, a recovered host that stayed up, the service's own start once it has run for five
 * minutes); it fails only when three or more are each that recent. A refusal that has stopped is a
 * warning that says when ("none since 07:25 UTC"), so a Mac that healed itself does not page for the rest of the window.
 */
export function errorFindings(signals: TelemetrySignals, paused = false): Finding[] {
  const fail = signals.recentRefusals >= refusalFailThreshold;
  const findings: Finding[] = Object.entries(signals.rpcErrors).sort().map(([method, count]) => {
    if (signals.ongoingMethods.includes(method)) return { level: fail ? "fail" as const : "warn" as const, reason: `refused ${method} ${count}x` };
    const last = signals.lastRefusalAt[method];
    return { level: "warn" as const, reason: `refused ${method} ${count}x${last === undefined ? "" : `, none since ${clock(last)} UTC`}` };
  });
  if (signals.skewRefusals > 0) findings.push({ level: "fail", reason: `chats refused ${signals.skewRefusals}x: the service still runs an older release than the installed one; finish running turns or run gateway service restart --interrupt` });
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
  // A probe that could not run says so about the check; only a probe that asked and got nothing says it about inference.
  if (probe.state === "unreadable") return [{ level: "warn", reason: "inference unreadable" }];
  if (probe.state === "unreachable") return [{ level: "fail", reason: "inference not serving" }];
  if (probe.status !== 200) return [{ level: "fail", reason: `inference status ${probe.status ?? "unknown"}` }];
  // The header and the body field come from a process, so neither reaches a report unchecked:
  // anything that is not a short version token is named `unknown` instead of carried through.
  const release = safeToken(probe.release);
  if (probe.bodyStatus !== undefined && safeToken(probe.bodyStatus) !== "ok") {
    return [{ level: "fail", reason: `inference ${safeToken(probe.bodyStatus) ?? "unknown"}` }];
  }
  // The server answers while it holds back a change to gateway.json, so this is a warning about the file, not about serving.
  // It reads the server's own answer rather than telemetry, so it stays for as long as the file stays refused.
  const refused: Finding[] = probe.configRejected ? [{ level: "warn", reason: `gateway.json change not applied (${probe.configRejected}); fix it or restart the service` }] : [];
  if (!probe.release || release === "unknown") return [...refused, { level: "warn", reason: "inference release unknown" }];
  if (installed && release !== installed) return [...refused, { level: "warn", reason: `lagging inference@${release}` }];
  return refused;
}

/** A failing phase is the loudest signal the watchdog has: the app moved and chats broke. */
export function smokeFindings(result: "pass" | "fail" | "unavailable" | "skipped", phase?: string): Finding[] {
  if (result === "fail") {
    const named = safePhase(phase);
    return [{ level: "fail", reason: named ? `smoke failed at ${named}` : "smoke failed" }];
  }
  if (result === "unavailable") return [{ level: "warn", reason: "smoke unavailable" }];
  return [];
}
