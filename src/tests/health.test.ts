import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { shortFolder } from "./short-folder.js";
import { formatHealth, runHealth, type HealthDeps, type HealthOptions } from "../health.js";
import { exitCodeFor, type Finding, type HealthReport, type InferenceProbe, type PushOutcome, type Verdict } from "../health-types.js";
import type { HealthState } from "../health-state.js";
import type { ServiceStatus } from "../health-checks.js";
import type { HealthEvent } from "../health-telemetry.js";
import type { VersionsResult } from "../versions.js";
import { pushUrlPath, type PushUrlReader } from "../health-push.js";

const at = Date.parse("2026-10-16T09:00:00.000Z");
const iso = (msAgo = 0) => new Date(at - msAgo).toISOString();
/** A monitor URL that shows up verbatim in every output if the watchdog ever leaks it. */
const secretUrl = "https://kuma.invalid.example/api/push/Zm9vYmFyLXNlY3JldA";

const versions = (installed: string | null, rows: Array<[string, string]> = [["service", installed ?? "none"]]): VersionsResult =>
  ({ installed, lagging: 0, processes: rows.map(([role, release], index) => ({ role: role as VersionsResult["processes"][number]["role"], pid: 100 + index, startedAt: iso(60 * 60_000), release })) });
const runningStatus: ServiceStatus = { installed: true, published: true, components: [{ kind: "inference", state: "running" }] };
const healthyProbe: InferenceProbe = { state: "answered", status: 200, release: "0.4.4", bodyStatus: "ok" };

/** The quiet-Mac fixture: every injected reader, nothing touching this machine. */
function base(extra: Partial<HealthDeps> = {}): HealthDeps {
  return {
    now: () => at,
    exists: async () => false,
    state: async () => undefined,
    writeState: async () => {},
    readPlan: async () => undefined,
    readStatus: async () => runningStatus,
    versions: async () => versions("0.4.4"),
    telemetry: async () => [],
    probe: async () => healthyProbe,
    ...extra,
  };
}

/** One report and the exit code its command would return. */
async function check(options: Partial<HealthOptions> = {}, deps: Partial<HealthDeps> = {}) {
  const report = await runHealth({ stateDirectory: "/state", port: 3457, ...options }, base(deps));
  return { report, code: exitCodeFor(report.verdict, report.push) };
}

test("a quiet Mac says ok, and the summary reads section by section", async () => {
  const { report, code } = await check();
  assert.equal(report.verdict, "ok");
  assert.equal(code, 0);
  assert.equal(report.at, iso());
  assert.deepEqual(report.app, { state: "absent", bundle: null, engine: null, changed: false });
  assert.deepEqual(report.findings.filter(f => f.level !== "info"), []);
  const text = formatHealth(report);
  assert.match(text, /^verdict ok \(0\.4\.4\)/);
  assert.ok(text.includes("app          absent"));
  assert.ok(text.includes("smoke        not needed"));
  assert.ok(text.includes("quiet (15 min)"));
});

test("a run the service stopped pushes nothing", async () => {
  const controller = new AbortController();
  let sent = 0;
  const { report } = await check({ push: true, signal: controller.signal }, {
    pushUrl: async () => ({ url: secretUrl }),
    pushSend: async () => { sent++; return Promise.resolve({ state: "sent", up: true } as PushOutcome); },
  });
  assert.equal(sent, 1);
  controller.abort();
  const stopped = await check({ push: true, signal: controller.signal }, {
    pushUrl: async () => ({ url: secretUrl }),
    pushSend: async () => { sent++; return Promise.resolve({ state: "sent", up: true } as PushOutcome); },
  });
  assert.equal(sent, 1, "an aborted run still alerted");
  assert.equal(stopped.report.push, undefined);
  assert.equal(exitCodeFor(stopped.report.verdict, stopped.report.push), 0);
});

test("the run's signal reaches the push, so a stop cancels the request", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  await check({ push: true, signal: controller.signal }, {
    pushUrl: async () => ({ url: secretUrl }),
    pushSend: async (_url, _verdict, _findings, signal) => { seen = signal; return { state: "sent", up: true } as PushOutcome; },
  });
  assert.equal(seen, controller.signal);
});

test("a section that cannot be read warns, and the run and its push still finish", async () => {
  const boom = async () => { throw new Error("ps: Operation not permitted"); };
  const seen: Array<{ verdict: Verdict }> = [];
  const { report, code } = await check({ push: true, smoke: true }, {
    versions: boom,
    state: boom,
    readStatus: boom,
    telemetry: boom,
    probe: boom,
    smokeTargets: async () => { throw new Error("install scope unreadable"); },
    pushUrl: async () => ({ url: secretUrl }),
    pushSend: async (_url, verdict) => { seen.push({ verdict }); return { state: "sent", up: true }; },
  });
  // Every section that failed says so once, in fixed words, and nothing from the error is carried.
  assert.deepEqual(report.findings.filter(f => f.reason.endsWith("unreadable")).map(f => f.reason).sort(),
    ["inference unreadable", "service unreadable", "state unreadable", "telemetry unreadable", "versions unreadable"]);
  assert.equal(JSON.stringify(report.findings).includes("Operation not permitted"), false);
  assert.equal(report.push?.state, "sent", "a broken section must not skip the alert");
  assert.equal(seen.length, 1);
  assert.equal(code, 1, "an unreadable section alone is a warn, never a silent run");
  assert.equal(report.verdict, "warn");
  // The other sections answered despite it: the verdict is still the whole Mac's.
  assert.equal(report.inference.state, "unreadable", "the probe failed, not the server");
  assert.ok(report.findings.some(f => f.reason === "inference unreadable"));
  // The smoke's own failure is said in the smoke's own words, once.
  assert.equal(report.smoke.result, "unavailable");
  assert.equal(report.findings.filter(f => f.reason.startsWith("smoke")).length, 1);
  assert.match(formatHealth(report), /warn  versions unreadable/);
});

test("the stale clock comes from the release switch, not from a process start", async () => {
  const day = 24 * 60 * 60_000;
  const behind = { installed: "0.4.4", lagging: 1, processes: [{ role: "service" as const, pid: 1, startedAt: new Date(at - 30 * day).toISOString(), release: "0.2.0" }] };
  const switched = await check({}, { versions: async () => behind, switchedAt: async () => at - day });
  assert.deepEqual(switched.report.components.stale, [], "the release only moved a day ago: not stale yet");
  assert.equal(switched.report.verdict, "warn");
  const old = await check({}, { versions: async () => behind, switchedAt: async () => at - 3 * day });
  assert.deepEqual(old.report.components.stale, ["service@0.2.0"]);
  assert.equal(old.report.verdict, "fail");
  let asked: unknown;
  await check({}, { versions: async () => behind, switchedAt: (moduleUrl?: string) => { asked = moduleUrl; return Promise.resolve(undefined); } });
  assert.equal(asked, undefined, "the switch time is asked for, and its answer is what the run uses");
});

test("a lagging component warns; a stopped inference or a refusal fails", async () => {
  const lag = await check({}, { versions: async () => versions("0.4.4", [["service", "0.4.3"]]) });
  assert.equal(lag.report.verdict, "warn");
  assert.equal(lag.code, 1);
  assert.ok(formatHealth(lag.report).includes("warn  lagging service@0.4.3"));
  const down = await check({}, { probe: async () => ({ state: "unreachable" }) });
  assert.equal(down.report.verdict, "fail");
  assert.equal(down.code, 2);
  assert.ok(down.report.findings.some(f => f.reason === "inference not serving"));
  // One refusal in the window is a hiccup; the third is a Mac that stopped answering.
  const one = await check({}, { telemetry: async (): Promise<HealthEvent[]> => [{ event: "rpc_error", method: "turn/start", code: -32001, errorClass: "RouteUnavailable", rejection: "adapter_routing", at }] });
  assert.equal(one.report.verdict, "warn");
  assert.ok(one.report.findings.some(f => f.level === "warn" && f.reason === "refused turn/start 1x"));
  assert.deepEqual(one.report.errors.rpcErrors, { "turn/start": 1 });
  const three = await check({}, { telemetry: async (): Promise<HealthEvent[]> => [
    { event: "rpc_error", method: "turn/start", code: -32001, errorClass: "RouteUnavailable", rejection: "adapter_routing", at },
    { event: "rpc_error", method: "thread/start", code: -32001, errorClass: "RouteUnavailable", rejection: "adapter_routing", at },
    { event: "rpc_error", method: "thread/resume", errorClass: "AdapterRefused", rejection: "other", at },
  ] });
  assert.equal(three.report.verdict, "fail");
  assert.equal(three.code, 2);
});

test("a remote client skips the loopback probe", async () => {
  let probed = 0;
  const { report } = await check({ clientOnly: true }, { probe: async () => { probed++; return healthyProbe; } });
  assert.equal(probed, 0);
  assert.equal(report.inference.state, "skipped");
  assert.ok(report.findings.some(f => f.reason === "inference remote" && f.level === "info"));
});

test("the smoke runs once per app change, and --smoke forces it again", async () => {
  const made = await shortFolder("gw-health-smoke-");
  const stateDirectory = made.directory;
  let stored: HealthState | undefined;
  let bundle = "26.10";
  let runs = 0;
  const shared: HealthDeps = {
    smokeTargets: async () => ({ gateway: "/install/g.js", packageRoot: "/install/package" }),
    smoke: async () => { runs++; return { result: "pass" as const }; },
    exists: async () => true,
    exec: async (command, args) => command.endsWith("codex") && args[0] === "--version" ? "codex-cli 0.99.1" : bundle,
    state: async () => stored,
    writeState: async (_directory, next) => { stored = next; },
  };
  const first = await check({ stateDirectory }, shared);
  assert.equal(first.report.app.changed, true);
  assert.deepEqual(first.report.smoke, { ran: true, result: "pass" });
  assert.equal(runs, 1);
  assert.deepEqual(stored?.smoke && { ...stored.smoke, at: "kept" }, { bundle: "26.10", engine: "0.99.1", result: "pass", at: "kept" });
  // The same pair, one minute later: the answer is remembered, not repeated.
  const second = await check({ stateDirectory }, shared);
  assert.equal(second.report.app.changed, false);
  assert.deepEqual(second.report.smoke, { ran: false, result: "pass", recorded: "pass" });
  assert.equal(runs, 1);
  assert.equal(second.report.verdict, "ok");
  // A new build moves the pair, so the answer has to be earned again.
  bundle = "26.11";
  const third = await check({ stateDirectory }, shared);
  assert.equal(third.report.app.changed, true);
  assert.equal(third.report.smoke.ran, true);
  assert.equal(runs, 2);
  // --smoke answers now even when nothing moved.
  const forced = await check({ stateDirectory, smoke: true }, shared);
  assert.equal(forced.report.smoke.ran, true);
  assert.equal(runs, 3);
  await made.remove();
});

test("a failing smoke keeps its phase in every later report for the pair", async () => {
  let stored: HealthState | undefined;
  const deps = base({
    exists: async () => true,
    exec: async (command, args) => command.endsWith("codex") && args[0] === "--version" ? "0.99.1" : "26.10",
    smoke: async () => ({ result: "fail" as const, phase: "thread-start" }),
    smokeTargets: async () => ({ gateway: "/g", packageRoot: "/p" }),
    state: async () => stored,
    writeState: async (_directory, next) => { stored = next; },
  });
  const first = await runHealth({ stateDirectory: "/state", port: 3457 }, deps);
  assert.equal(first.verdict, "fail");
  assert.ok(first.findings.some(f => f.reason === "smoke failed at thread-start"));
  const again = await runHealth({ stateDirectory: "/state", port: 3457 }, deps);
  assert.equal(again.smoke.ran, false);
  assert.equal(again.verdict, "fail", "the recorded failure must keep alarming until the app moves");
  assert.equal(exitCodeFor(again.verdict, again.push), 2);
});

test("an app without a packaged check warns instead of failing", async () => {
  const { report } = await check({ smoke: true });
  assert.equal(report.smoke.result, "unavailable");
  assert.equal(report.smoke.ran, true);
  assert.equal(report.verdict, "warn");
  assert.ok(report.findings.some(f => f.reason === "smoke unavailable"));
});

/** A push section, driving runHealth the way --push does. */
async function pushed(outcome: (url: string, verdict: Verdict, findings: Finding[]) => Promise<PushOutcome>, pushUrl: PushUrlReader = async () => ({ url: secretUrl })) {
  const seen: Array<{ url: string; verdict: Verdict; findings: Finding[] }> = [];
  const report = await runHealth({ stateDirectory: "/state", port: 3457, push: true }, base({
    pushUrl,
    pushSend: async (url, verdict, findings) => { seen.push({ url, verdict, findings }); return outcome(url, verdict, findings); },
  }));
  return { report, seen, text: formatHealth(report), code: exitCodeFor(report.verdict, report.push) };
}

test("the push carries the verdict to the monitor and never leaks the URL", async () => {
  const ok = await pushed(async () => ({ state: "sent", up: true }));
  assert.equal(ok.seen.length, 1);
  assert.equal(ok.seen[0]!.url, secretUrl);
  assert.equal(ok.seen[0]!.verdict, "ok");
  assert.equal(ok.report.push?.state, "sent");
  assert.equal(ok.code, 0);
  assert.match(ok.text, /push\s+sent/);
  assert.equal(ok.text.includes(secretUrl), false);
  assert.equal(JSON.stringify(ok.report).includes(secretUrl), false);
  // A fail verdict travels as down; the exit code still says the Mac is broken.
  const seen: string[] = [];
  const report = await runHealth({ stateDirectory: "/state", port: 3457, push: true }, base({
    probe: async () => ({ state: "unreachable" }),
    pushUrl: async () => ({ url: secretUrl }),
    pushSend: async (url, verdict) => { seen.push(`${verdict}:${url === secretUrl}`); return { state: "sent" as const, up: verdict !== "fail" }; },
  }));
  assert.deepEqual(seen, ["fail:true"]);
  assert.equal(report.push?.up, false);
  assert.equal(exitCodeFor(report.verdict, report.push), 2);
});

test("a refused push URL is a failure that names no path", async () => {
  const { report, code, text } = await pushed(async () => ({ state: "sent" }), async () => ({ error: "insecure" as const }));
  assert.equal(report.push?.state, "insecure");
  assert.equal(code, 2, "the alert path is broken even when the Mac itself is quiet");
  assert.match(text, /push\s+insecure/);
  assert.equal(JSON.stringify(report).includes(secretUrl), false);
  assert.equal(text.includes("/state"), false);
});

test("a monitor that never answers is reported, not retried", async () => {
  for (const [error, expected] of [["timeout", "alert push failed (timeout)"], ["http_503", "alert push failed (http_503)"]] as const) {
    const { report, code, text } = await pushed(async () => ({ state: "failed", error }));
    assert.equal(report.push?.state, "failed");
    assert.equal(code, 3, "the verdict computed but the monitor did not hear it");
    assert.ok(report.findings.some(f => f.reason === expected));
    assert.match(text, new RegExp(`push\\s+failed \\(${error}\\)`));
  }
  const skipped = await pushed(async () => ({ state: "skipped" }), async () => ({ error: "missing" as const }));
  assert.equal(skipped.report.push?.state, "skipped");
  assert.equal(skipped.code, 0);
  assert.match(skipped.text, /push\s+skipped/);
});

test("the reader is asked for the URL only in the state directory", async () => {
  const asked: string[] = [];
  await runHealth({ stateDirectory: "/state", port: 3457, push: true }, base({ pushUrl: async path => { asked.push(path); return { error: "missing" }; } }));
  assert.deepEqual(asked, [pushUrlPath("/state")]);
});

test("the report shape is stable for --json readers", async () => {
  const { report } = await check();
  const expected: Partial<Record<keyof HealthReport, unknown>> = { at: "", verdict: "ok", findings: [], app: {}, components: { installed: "0.4.4", lagging: [], stale: [] },
    service: { installed: true, components: [{ kind: "inference", state: "running" }], hostFailures: 0 }, inference: healthyProbe,
    errors: { windowMinutes: 15, rpcErrors: {}, refusals: 0, configRetries: 0, configRetryRpcErrors: 0, componentExits: {}, nativeSharing: [] }, smoke: { ran: false, result: "skipped" } };
  assert.deepEqual(Object.keys(report).sort(), Object.keys(expected).sort());
  assert.equal(report.service.hostFailures, 0);
});
