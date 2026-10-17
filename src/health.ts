import { parseConfigRejection } from "./config-rejection.js";
import { access, constants, lstat, readFile as readTextFile } from "node:fs/promises";
import { readServicePlan, serviceStatusPath, type ServicePlan } from "./service-plan.js";
import { locateInstall, runVersions, type VersionsResult } from "./versions.js";
import { loadConfig } from "./config.js";
import { configPath } from "./paths.js";
import { resolve } from "node:path";
import { nativeRegistrationPath } from "./native-pause.js";
import { appFindings, componentFindings, errorFindings, inferenceFindings, nativePaused, relayFindings, serviceFindings, smokeFindings, statusFields, type RelayHealth, type ServiceStatus } from "./health-checks.js";
import { desktopFindings } from "./health-desktop.js";
import { appPathFromPlan, detectAppChange, readAppInfo } from "./health-app.js";
import { healthWindowMs, exitCodeFor, verdictOf, type AppInfo, type Exec, type Finding, type HealthReport, type InferenceProbe, type PushOutcome, type SmokeOutcome, type Verdict } from "./health-types.js";
import { emptySignals, readHealthTelemetry, refusalOngoingMs, summarizeHealthEvents, type HealthEvent } from "./health-telemetry.js";
import { pushFindings, pushVerdict, pushUrlPath, readPushUrl, type PushUrlReader } from "./health-push.js";
import { runSmoke, type SmokeAnswer, type SmokeRunner } from "./health-smoke.js";
import { readHealthState, writeHealthState, smokeCovers, type HealthState } from "./health-state.js";

/**
 * `gateway health` — one verdict for this Mac, in one pass, with no network beyond
 * localhost and the optional alert push.
 *
 * The question is the one no terminal shows: did the ChatGPT app move under the gateway,
 * and did anything break when it did? The app answer comes from the bundle the service
 * launches, the release answer from `gateway versions`, and the rest from the local
 * telemetry window and the inference socket. A new build is only news until the
 * compatibility check answers it, so its answer is kept with the pair it was earned
 * against and the ten-minute run happens once per update rather than once per tick.
 */
const probeTimeoutMs = 2000;

export interface HealthOptions {
  stateDirectory: string;
  port: number;
  clientOnly?: boolean;
  /** Send the verdict to the monitor named by `<state>/alert-push-url`. */
  push?: boolean;
  /** Run the compatibility check even though the app has not changed. */
  smoke?: boolean;
  /** Stopping the service stops a compatibility run that is still going; see health-smoke. */
  signal?: AbortSignal;
}

/** Every side effect the checks have, so a test can hand them fixtures instead of a machine. */
export interface HealthDeps {
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  exists?: (path: string) => Promise<boolean>;
  /** Runs one local command and returns its stdout: the app's `--version` and PlistBuddy. */
  exec?: Exec;
  versions?: () => Promise<VersionsResult>;
  /** The loopback inference probe. */
  probe?: (port: number) => Promise<InferenceProbe>;
  readPlan?: (stateDirectory: string) => Promise<ServicePlan | undefined>;
  /** What the unified service last published, or the fixture a test is describing. */
  readStatus?: (stateDirectory: string) => Promise<ServiceStatus>;
  telemetry?: (stateDirectory: string) => Promise<HealthEvent[]>;
  /** The compatibility runner; the real one starts a child and this one can be a table. */
  smoke?: SmokeRunner;
  smokeTargets?: () => Promise<{ gateway: string; packageRoot: string } | undefined>;
  state?: (stateDirectory: string) => Promise<HealthState | undefined>;
  writeState?: (stateDirectory: string, state: HealthState) => Promise<void>;
  pushUrl?: PushUrlReader;
  pushSend?: (url: string, verdict: Verdict, findings: Finding[], signal?: AbortSignal) => Promise<PushOutcome>;
  moduleUrl?: string;
  windowMs?: number;
  /** Whether the relay is registered and connected; a test describes it directly. */
  relay?: (stateDirectory: string) => Promise<RelayHealth>;
  /** Modification time (ms) of a file, for the age of the relay's status. */
  mtime?: (path: string) => Promise<number | undefined>;
  /** When the installed `current` link was switched; the clock a lag becomes stale on. */
  switchedAt?: (moduleUrl?: string) => Promise<number | undefined>;
}

const owned = (path: string) => access(path, constants.F_OK).then(() => true, () => false);

/** The loopback answer: whether inference serves at all, and which release replies. */
export async function probeInference(port: number): Promise<InferenceProbe> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(probeTimeoutMs), redirect: "error" });
    const body = await response.json().catch(() => undefined) as { status?: unknown; configRejected?: unknown } | undefined;
    const configRejected = parseConfigRejection(body?.configRejected);
    return { state: "answered", status: response.status, release: response.headers.get("x-gateway-release"),
      ...(typeof body?.status === "string" ? { bodyStatus: body.status } : {}), ...(configRejected ? { configRejected } : {}) };
  } catch { return { state: "unreachable" }; }
}

/** What the unified service last published, and whether one is installed here at all. */
async function readServiceStatus(stateDirectory: string, plan: ServicePlan | undefined, readFile: (path: string) => Promise<string>): Promise<ServiceStatus> {
  const installed = Boolean(plan);
  let published: unknown;
  try { published = JSON.parse(await readFile(serviceStatusPath(stateDirectory))); } catch { return { installed, components: [], published: false }; }
  const status = statusFields(published);
  // A snapshot left by an older install still counts as one, so an unreadable plan cannot hide a service.
  return { ...status, installed: installed || status.components.length > 0 };
}

/** The relay's registration and last status. A missing or unreadable record reads as not registered. */
async function readRelayHealth(stateDirectory: string, now: number, readFile: (path: string) => Promise<string>, mtime: (path: string) => Promise<number | undefined>): Promise<RelayHealth> {
  let record: { registered?: unknown; home?: unknown };
  try { record = JSON.parse(await readFile(nativeRegistrationPath(stateDirectory))); } catch { return { registered: false }; }
  if (record.registered !== true) return { registered: false };
  if (typeof record.home !== "string") return { registered: true };
  const file = resolve(record.home, "status.json");
  let connected = false;
  try { connected = (JSON.parse(await readFile(file)) as { status?: unknown }).status === "connected"; } catch { /* No status file is not connected. */ }
  const changed = await mtime(file);
  return { registered: true, connected, ...(changed === undefined ? {} : { statusAgeMs: Math.max(0, now - changed) }) };
}

/** A section that could not be read says so once, as a warning, and the run goes on. */
async function readable<T>(name: string, read: () => Promise<T>, fallback: T): Promise<{ value: T; finding?: Finding }> {
  try { return { value: await read() }; }
  catch { return { value: fallback, finding: { level: "warn", reason: `${name} unreadable` } }; }
}

/**
 * When the installed release was switched: the mtime of `<root>/current` itself, which a link
 * replacement rewrites. Process start says how long a daemon has been up, not how long it has
 * been behind, which is why the stale clock starts here.
 */
async function releaseSwitchedAt(moduleUrl?: string): Promise<number | undefined> {
  for (const root of locateInstall(moduleUrl).roots) {
    const switched = await lstat(resolve(root, "current")).then(info => info.mtimeMs, () => undefined);
    if (switched !== undefined) return switched;
  }
  return;
}

/** One pass over this Mac: five sections, one verdict, and the reasons behind it. */
export async function runHealth(options: HealthOptions, deps: HealthDeps = {}): Promise<HealthReport> {
  const now = deps.now?.() ?? Date.now();
  const at = new Date(now).toISOString();
  const readFile = deps.readFile ?? (path => readTextFile(path, "utf8").catch(() => ""));
  const unreadable: Finding[] = [];
  const note = async <T,>(name: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    const part = await readable(name, read, fallback);
    if (part.finding) unreadable.push(part.finding);
    return part.value;
  };
  const absentApp: AppInfo = { state: "absent", path: "", enginePath: "", bundle: null, engine: null };
  const state = await note("state", () => (deps.state ?? (directory => readHealthState(directory, readFile)))(options.stateDirectory), undefined);
  const plan = await note("plan", () => (deps.readPlan ?? (directory => readServicePlan(directory).catch(() => undefined)))(options.stateDirectory), undefined);
  const app = await note("app", () => readAppInfo(appPathFromPlan(plan), { exec: deps.exec, exists: deps.exists ?? owned }), absentApp);
  const change = detectAppChange(state?.app, app, at);
  const versions = await note<VersionsResult>("versions", () => (deps.versions ?? (() => runVersions({ moduleUrl: deps.moduleUrl })))(),
    { installed: null, processes: [], lagging: 0 });
  const status = await note("service", () => (deps.readStatus ?? (directory => readServiceStatus(directory, plan, readFile)))(options.stateDirectory),
    { installed: false, components: [], published: false });
  const relay = await note<RelayHealth>("relay", () => (deps.relay ?? (directory => readRelayHealth(directory, now, readFile, deps.mtime ?? (path => lstat(path).then(info => info.mtimeMs, () => undefined)))))(options.stateDirectory), { registered: false });
  const switched = await note("release switch", () => (deps.switchedAt ?? releaseSwitchedAt)(deps.moduleUrl), undefined);
  // The service's own start is a recovery marker: whatever it was refusing as the old release, it no longer is.
  // Only once it has stayed up that long, so a service that crashes and restarts cannot keep resetting the verdict.
  const serviceStarts = versions.processes.filter(row => row.role === "service").map(row => Date.parse(row.startedAt))
    .filter(started => Number.isFinite(started) && now - started >= refusalOngoingMs);
  const signals = await note("telemetry", async () => summarizeHealthEvents(deps.telemetry
    ? await deps.telemetry(options.stateDirectory)
    : await readHealthTelemetry(options.stateDirectory, { readFile, now: () => now, windowMs: deps.windowMs, ...(deps.now ? { until: now } : {}) }), { now, markers: serviceStarts }), emptySignals());
  const desktop = await note<Finding[]>("desktop", () => desktopFindings(options.stateDirectory, app.path, { readFile, exec: deps.exec }), []);
  // A probe that could not run at all says so about itself; one that ran and got no answer says so about inference.
  const inference: InferenceProbe = options.clientOnly
    ? { state: "skipped" }
    : await (deps.probe ?? probeInference)(options.port).catch(() => ({ state: "unreadable" } as InferenceProbe));
  // The smoke is the section that can run for ten minutes; a crash inside it is the one answer
  // the watchdog already knows how to say, and it never stops the run or the alert.
  const smoke = await decideSmoke(options, app, state, change.changed, deps, now)
    .catch(() => ({ outcome: { ran: false, result: "unavailable" } as SmokeOutcome }));
  const components = componentFindings(versions, now, switched);
  const findings: Finding[] = [
    ...appFindings(app, change.changed), ...components.findings,
    ...serviceFindings(status, signals), ...relayFindings(status, relay, now), ...inferenceFindings(inference, versions.installed),
    ...errorFindings(signals, nativePaused(status)), ...desktop, ...smokeFindings(smoke.outcome.result, smoke.outcome.phase),
    ...unreadable,
  ];
  const report: HealthReport = {
    at, verdict: verdictOf(findings), findings,
    app: { state: app.state, bundle: app.bundle, engine: app.engine, changed: change.changed },
    components: { installed: versions.installed, lagging: components.lagging, stale: components.stale },
    service: { installed: status.installed, components: status.components, ...(status.executionHost ? { executionHost: status.executionHost } : {}), hostFailures: signals.hostFailures },
    inference,
    errors: { windowMinutes: Math.round((deps.windowMs ?? healthWindowMs) / 60000), rpcErrors: signals.rpcErrors, refusals: signals.refusals, configRetries: signals.featureRetries, configRetryRpcErrors: signals.retriedThenRefused, componentExits: signals.exits, nativeSharing: signals.nativeSharing },
    smoke: smoke.outcome,
  };
  await remember(options.stateDirectory, state, change, smoke, deps);
  // A run this Mac was asked to stop says nothing about the Mac, so it says nothing aloud either:
  // stopping the service must never send a warning born of the stop itself.
  if (options.push && !options.signal?.aborted) report.push = await deliver(report, options.stateDirectory, deps, options.signal);
  return report;
}

/** The smoke answer for this run: the recorded one while nothing moved, a fresh one after. */
async function decideSmoke(
  options: HealthOptions, app: Awaited<ReturnType<typeof readAppInfo>>, state: HealthState | undefined,
  changed: boolean, deps: HealthDeps, now: number,
): Promise<{ outcome: SmokeOutcome; record?: HealthState["smoke"] }> {
  const pair = { bundle: app.bundle, engine: app.engine };
  if (app.state === "absent" && !options.smoke) return { outcome: { ran: false, result: "skipped" } };
  if (!options.smoke && smokeCovers(state?.smoke, pair)) {
    const seen = state?.smoke;
    return { outcome: { ran: false, result: seen?.result ?? "skipped", ...(seen?.phase ? { phase: seen.phase } : {}), recorded: seen?.result } };
  }
  const answer: SmokeAnswer = await runSmoke(app, options.stateDirectory, {
    run: deps.smoke, exists: deps.exists ?? owned, targets: deps.smokeTargets, moduleUrl: deps.moduleUrl, now: () => now, signal: options.signal,
  });
  const phase = answer.result === "fail" ? answer.phase : undefined;
  return {
    outcome: { ran: true, result: answer.result, ...(phase ? { phase } : {}) },
    ...(answer.result === "unavailable" ? {} : { record: { ...pair, result: answer.result, ...(phase ? { phase } : {}), at: new Date(now).toISOString() } }),
  };
}

/** What the run learned, written forward: an idle tick that saw nothing new rewrites nothing. */
async function remember(stateDirectory: string, before: HealthState | undefined, change: ReturnType<typeof detectAppChange>, smoke: { outcome: SmokeOutcome; record?: HealthState["smoke"] }, deps: HealthDeps): Promise<void> {
  // An unchanged pair keeps the instant it was first seen, so a quiet tick rewrites nothing.
  const app = before?.app && !change.changed ? before.app : change.record;
  const smokeRecord = smoke.record ?? before?.smoke;
  if (!app && !smokeRecord) return;
  const next: HealthState = { version: 1, ...(app ? { app } : {}), ...(smokeRecord ? { smoke: smokeRecord } : {}) };
  if (before && JSON.stringify(next) === JSON.stringify(before)) return;
  await (deps.writeState ?? writeHealthState)(stateDirectory, next).catch(() => undefined);
}

/** The alert: read the monitor's URL privately, send one heartbeat, and fold in what it says. */
async function deliver(report: HealthReport, stateDirectory: string, deps: HealthDeps, signal?: AbortSignal): Promise<PushOutcome> {
  const file = await (deps.pushUrl ?? readPushUrl)(pushUrlPath(stateDirectory));
  const outcome: PushOutcome = file.error === "insecure" ? { state: "insecure" } : !file.url ? { state: "skipped" }
    : await (deps.pushSend ?? ((url, verdict, findings, abort) => pushVerdict(url, verdict, findings, { signal: abort })))(file.url, report.verdict, report.findings, signal);
  // Every outcome, including a URL this watchdog will not read, says so in its own words.
  report.findings = [...report.findings, ...pushFindings(outcome)];
  report.verdict = verdictOf(report.findings);
  return outcome;
}

export const healthUsage = "Usage: gateway health [--json] [--push] [--smoke]\n";

/** One line per section, in the same order every report reads. */
function sectionLines(report: HealthReport): string[] {
  const total = (counts: Record<string, number>) => Object.values(counts).reduce((left, right) => left + right, 0);
  const app = report.app.state === "absent" ? "absent" : `${report.app.bundle ?? "unknown"} / codex ${report.app.engine ?? "unknown"}${report.app.changed ? " (changed)" : ""}`;
  const behind = report.components.lagging.length + report.components.stale.length;
  const components = report.components.installed === null ? "no installed release" : behind ? `${behind} behind${report.components.stale.length ? `, ${report.components.stale.length} stale` : ""}` : `all on ${report.components.installed}`;
  const service = report.service.installed ? `${report.service.components.map(row => `${row.kind} ${row.state}`).join(", ") || "no components"}${report.service.executionHost ? `, host ${report.service.executionHost}` : ""}` : "not installed";
  const inference = report.inference.state === "answered" ? `${report.inference.release ?? "release unknown"}` : report.inference.state;
  const errors = total(report.errors.rpcErrors) || report.errors.configRetryRpcErrors || total(report.errors.componentExits) || report.service.hostFailures
    ? `refused ${total(report.errors.rpcErrors)}, exits ${total(report.errors.componentExits)}, host ${report.service.hostFailures}, config ${report.errors.configRetries}`
    : `quiet (${report.errors.windowMinutes} min)`;
  const smoke = report.smoke.ran ? report.smoke.result : report.smoke.result === "skipped" ? "not needed" : `${report.smoke.result} (recorded)`;
  return [`  app          ${app}`, `  components   ${components}`, `  service      ${service}`, `  inference    ${inference}`, `  errors       ${errors}`, `  smoke        ${smoke}`];
}

/** The human summary: the verdict, one line per section, then what moved it. */
export function formatHealth(report: HealthReport): string {
  const reasons = report.findings.filter(finding => finding.level !== "info");
  const lines = [`verdict ${report.verdict}${report.components.installed ? ` (${report.components.installed})` : ""}`, ...sectionLines(report)];
  if (reasons.length) lines.push("", ...reasons.map(finding => `  ${finding.level}  ${finding.reason}`));
  if (report.push) lines.push("", `  push         ${report.push.state}${report.push.error ? ` (${report.push.error})` : ""}`);
  return lines.join("\n") + "\n";
}

export interface HealthCommandDeps extends HealthDeps {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  configPath?: () => Promise<string>;
}

/**
 * `gateway health [--json] [--push] [--smoke]`. Exit 0 is `ok`, 1 `warn`, 2 `fail`, and 3
 * says the verdict was computed but the monitor never heard it. A push URL the watchdog
 * will not read (group-, other- or neighbour-owned) is a failure of the alert path, so it
 * exits 2 with a fixed message that names no path and no contents. `--help` prints the
 * usage line and exits 0; a bad flag prints it and exits 2.
 */
export async function healthCommand(args: string[], deps: HealthCommandDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.includes("--help") || args.includes("-h")) { out(healthUsage); return 0; }
  const flags = new Set(["--json", "--push", "--smoke"]);
  if (args.some(arg => !flags.has(arg))) { err(healthUsage); return 2; }
  let config;
  try { config = await loadConfig(await (deps.configPath ?? (async () => configPath()))()); }
  catch { err("health: no readable gateway configuration on this Mac\n"); return 2; }
  const report = await runHealth({ stateDirectory: config.stateDirectory, port: config.port, clientOnly: config.clientOnly, push: args.includes("--push"), smoke: args.includes("--smoke") }, deps);
  out(args.includes("--json") ? JSON.stringify(report, null, 2) + "\n" : formatHealth(report));
  // A monitor URL this watchdog will not read is a broken alert path, so it also says so where
  // a script looking only at the verdict line will see it. The message is fixed: no path, no URL.
  if (report.push?.state === "insecure") err("health: the alert push URL is not private; fix its permissions or remove the file\n");
  return exitCodeFor(report.verdict, report.push);
}
