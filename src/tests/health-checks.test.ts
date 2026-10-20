import test from "node:test";
import assert from "node:assert/strict";
import { appFindings, componentFindings, errorFindings, inferenceFindings, minorDistance, nativePaused, serviceFindings, smokeFindings, statusFields } from "../health-checks.js";
import { exitCodeFor, staleLagMs, staleServiceLagMs, verdictOf, type AppInfo, type InferenceProbe } from "../health-types.js";
import { emptySignals, type TelemetrySignals } from "../health-telemetry.js";
import type { VersionsResult } from "../versions.js";

const at = Date.parse("2026-10-16T09:00:00.000Z");
const iso = (msAgo: number) => new Date(at - msAgo).toISOString();
const minutes = (count: number) => count * 60_000;

/** A versions answer with one row per given [role, release, ageMinutes] triple. */
function versions(installed: string | null, rows: Array<[string, string, number]>): VersionsResult {
  return { installed, lagging: 0, processes: rows.map(([role, release, age], index) => ({ role: role as VersionsResult["processes"][number]["role"], pid: 100 + index, startedAt: iso(minutes(age)), release })) };
}

test("minorDistance counts minor gaps and treats a major as many", () => {
  // Only the major and minor numbers count: a patch gap is not "a minor behind".
  assert.equal(minorDistance("0.4.4", "0.4.3"), 0);
  assert.equal(minorDistance("0.4.4", "0.4.4"), 0);
  assert.equal(minorDistance("0.4.4", "0.3.9"), 1);
  assert.equal(minorDistance("0.4.4", "0.2.1"), 2);
  assert.equal(minorDistance("1.4.4", "0.3.9"), 101);
  // A different major is more than one minor behind even when its minors say otherwise.
  assert.ok(minorDistance("2.0.0", "1.99.0")! > 1);
  assert.equal(minorDistance("0.4.4", "unknown"), undefined);
  assert.equal(minorDistance("checkout", "0.4.4"), undefined);
});

test("verdictOf takes the worst level and info never moves it", () => {
  assert.equal(verdictOf([]), "ok");
  assert.equal(verdictOf([{ level: "info", reason: "app changed" }]), "ok");
  assert.equal(verdictOf([{ level: "info", reason: "x" }, { level: "warn", reason: "y" }]), "warn");
  assert.equal(verdictOf([{ level: "warn", reason: "y" }, { level: "fail", reason: "z" }]), "fail");
});

test("exit codes map verdicts and push outcomes", () => {
  assert.equal(exitCodeFor("ok"), 0);
  assert.equal(exitCodeFor("warn"), 1);
  assert.equal(exitCodeFor("fail"), 2);
  assert.equal(exitCodeFor("ok", { state: "sent", up: true }), 0);
  assert.equal(exitCodeFor("warn", { state: "failed", error: "network" }), 3);
  assert.equal(exitCodeFor("fail", { state: "failed", error: "timeout" }), 3);
  // An unreadable monitor URL is a failure of the alert path itself.
  assert.equal(exitCodeFor("ok", { state: "insecure" }), 2);
});

test("lag alone warns and a stale lag fails", () => {
  const recent = versions("0.4.4", [["service", "0.4.3", 10]]);
  const lag = componentFindings(recent, at);
  assert.deepEqual(lag.lagging, ["service@0.4.3"]);
  assert.deepEqual(lag.stale, []);
  assert.deepEqual(lag.findings, [{ level: "warn", reason: "lagging service@0.4.3" }]);
  // More than one minor behind and longer than the stale window: a fail.
  const stale = versions("0.4.4", [["inference", "0.2.9", 49 * 60]]);
  const out = componentFindings(stale, at);
  assert.deepEqual(out.stale, ["inference@0.2.9"]);
  assert.deepEqual(out.lagging, []);
  assert.deepEqual(out.findings, [{ level: "fail", reason: "stale inference@0.2.9" }]);
  // A recent move two minors behind is still a lag, not a stale component.
  assert.deepEqual(componentFindings(versions("0.4.4", [["inference", "0.2.9", 10]]), at).lagging, ["inference@0.2.9"]);
  // One minor behind for longer than the stale window stays a lag: only "more than one" fails.
  assert.deepEqual(componentFindings(versions("0.4.4", [["inference", "0.3.9", (staleLagMs + minutes(1)) / 60_000]]), at).stale, []);
  // With nothing installed to compare against, every running row is still named as behind.
  const bare = componentFindings(versions(null, [["service", "0.4.1", 9999]]), at);
  assert.deepEqual(bare.stale, []);
  assert.deepEqual(bare.findings, [{ level: "warn", reason: "lagging service@0.4.1" }]);
});

test("the stale clock runs from the release switch, not the process start", () => {
  const day = 24 * 60 * 60_000;
  // A daemon that has run for a month is only as behind as the release it is running is old.
  const behind = versions("0.4.0", [["service", "0.2.0", (40 * day) / 60_000]]);
  assert.deepEqual(componentFindings(behind, at).stale, ["service@0.2.0"], "with no switch answer, the process start is the clock");
  assert.deepEqual(componentFindings(behind, at, at - minutes(30)).stale, [], "a fresh release gives the service time to move");
  assert.deepEqual(componentFindings(behind, at, at - 3 * day).stale, ["service@0.2.0"]);
  // A different major counts as more than one minor behind, whatever its minor numbers say.
  assert.ok((minorDistance("2.0.0", "1.99.0") ?? 0) > 1);
  assert.deepEqual(componentFindings(versions("2.0.0", [["service", "1.99.0", 10]]), at, at - 3 * day).stale, ["service@1.99.0"]);
});

test("a service stuck one minor or one patch behind fails after an hour without evicting old chat engines", () => {
  const old = (staleServiceLagMs + 1) / 60_000;
  for (const release of ["0.4.8", "0.5.5"]) {
    const result = versions("0.5.6", [["service", release, old], ["gateway-engine", release, old]]);
    const stale = componentFindings(result, at, at - staleServiceLagMs - 1);
    assert.deepEqual(stale.stale, [`service@${release}`]);
    assert.deepEqual(stale.lagging, [`gateway-engine@${release}`]);
    assert.equal(verdictOf(stale.findings), "fail");
    assert.deepEqual(componentFindings(result, at, at - staleServiceLagMs).stale, [], "the full grace is available");
  }
  for (const release of ["0.5.6", "0.5.7", "checkout", "unknown"]) {
    assert.deepEqual(componentFindings(versions("0.5.6", [["service", release, old]]), at).stale, []);
  }
});

test("a lagging row with an unreadable start is a lag, not stale", () => {
  const result: VersionsResult = { installed: "0.4.4", lagging: 1, processes: [{ role: "service", pid: 1, startedAt: "not a date", release: "0.3.0" }] };
  const out = componentFindings(result, at);
  assert.deepEqual(out.stale, []);
  assert.deepEqual(out.lagging, ["service@0.3.0"]);
});

test("app change and absence are info, never a fault", () => {
  const found: AppInfo = { state: "found", path: "/Applications/ChatGPT.app", enginePath: "/e", bundle: "26.10", engine: "0.4.4" };
  assert.deepEqual(appFindings(found, true), [{ level: "info", reason: "app changed" }]);
  assert.deepEqual(appFindings(found, false), []);
  const absent: AppInfo = { state: "absent", path: "/a", enginePath: "/e", bundle: null, engine: null };
  assert.deepEqual(appFindings(absent, false), [{ level: "info", reason: "app absent" }]);
});

test("statusFields keeps only kinds, states, and the host answer", () => {
  assert.deepEqual(statusFields(undefined), { installed: false, components: [], published: false });
  assert.deepEqual(statusFields(42), { installed: false, components: [], published: false });
  const value = statusFields({ pid: 42, updatedAt: iso(0), runningRelease: "0.5.7", components: [{ kind: "inference", state: "running", command: ["secret"] }, { kind: 7 }], executionHost: { state: "running" }, stopping: true });
  assert.deepEqual(value.components, [{ kind: "inference", state: "running" }]);
  assert.equal(value.executionHost, "running");
  assert.equal(value.stopping, true);
  assert.equal(value.pid, 42); assert.equal(value.updatedAt, iso(0)); assert.equal(value.runningRelease, "0.5.7");
  assert.equal(value.published, true);
  assert.equal(JSON.stringify(value).includes("secret"), false);
  const rejected = statusFields({ pid: "42", updatedAt: "not a date", runningRelease: "/private/secret" });
  assert.equal(rejected.pid, undefined); assert.equal(rejected.updatedAt, undefined); assert.equal(rejected.runningRelease, undefined);
});

test("service findings cover installed, empty, states and host answers", () => {
  assert.deepEqual(serviceFindings({ installed: false, components: [], published: false }, emptySignals()), [{ level: "info", reason: "service not installed" }]);
  assert.deepEqual(serviceFindings({ installed: true, components: [], published: false }, emptySignals()), [{ level: "warn", reason: "service published nothing" }]);
  assert.deepEqual(serviceFindings({ installed: true, components: [], published: true }, emptySignals()), [{ level: "warn", reason: "service runs no components" }]);
  assert.deepEqual(serviceFindings({ installed: true, components: [], published: true, stopping: true }, emptySignals()), []);
  const rows = serviceFindings({ installed: true, components: [{ kind: "inference", state: "running" }, { kind: "native", state: "paused" }, { kind: "desktop", state: "backoff" }], published: true, executionHost: "failed" }, emptySignals());
  assert.deepEqual(rows, [{ level: "info", reason: "native paused" }, { level: "warn", reason: "desktop backoff" }, { level: "fail", reason: "execution host failed" }]);
  const restarted = serviceFindings({ installed: true, components: [{ kind: "inference", state: "complete" }], published: true }, { ...emptySignals(), hostFailures: 2 });
  assert.deepEqual(restarted, [{ level: "warn", reason: "execution host restarted 2x" }]);
  const shared = serviceFindings({ installed: true, components: [{ kind: "native", state: "running" }], published: true }, { ...emptySignals(), nativeSharing: ["native_sharing_fallback"] });
  assert.deepEqual(shared, [{ level: "info", reason: "native_sharing_fallback" }]);
});

test("a paused native relay reads as info from the snapshot", () => {
  assert.equal(nativePaused({ installed: true, components: [{ kind: "native", state: "paused" }], published: true }), true);
  assert.equal(nativePaused({ installed: true, components: [{ kind: "native", state: "running" }], published: true }), false);
});

test("error findings name refusals, retries, and exits by count only", () => {
  // One refusal in fifteen minutes is a hiccup; the third one is a Mac that stopped working.
  const ongoing = (rpcErrors: Record<string, number>): TelemetrySignals => {
    const refusals = Object.values(rpcErrors).reduce((left, right) => left + right, 0);
    return { ...emptySignals(), rpcErrors, refusals, activeRefusals: refusals, recentRefusals: refusals, refusalsOngoing: true, ongoingMethods: Object.keys(rpcErrors).sort(),
      lastRefusalAt: Object.fromEntries(Object.keys(rpcErrors).map(method => [method, at])) };
  };
  const single = errorFindings(ongoing({ "turn/start": 1 }));
  assert.deepEqual(single, [{ level: "warn", reason: "refused turn/start 1x" }]);
  assert.equal(errorFindings(ongoing({ "thread/resume": 2 }))[0]!.level, "warn");
  const signals = ongoing({ "turn/start": 2, "thread/resume": 1 });
  const out = errorFindings(signals);
  assert.deepEqual(out, [{ level: "fail", reason: "refused thread/resume 1x" }, { level: "fail", reason: "refused turn/start 2x" }]);
  // Refusals that have stopped are a warning with the time they stopped, however many there were.
  const stopped: TelemetrySignals = { ...ongoing({ "thread/resume": 14 }), refusalsOngoing: false, ongoingMethods: [], activeRefusals: 0, recentRefusals: 0,
    lastRefusalAt: { "thread/resume": Date.parse("2026-10-16T07:25:10.000Z") } };
  assert.deepEqual(errorFindings(stopped), [{ level: "warn", reason: "refused thread/resume 14x, none since 07:25 UTC" }]);
  // A method that stopped beside one that is ongoing says so; only the ongoing one can fail.
  const mixed: TelemetrySignals = { ...ongoing({ "turn/start": 3, "thread/start": 4 }), ongoingMethods: ["turn/start"], lastRefusalAt: { "turn/start": at, "thread/start": at - minutes(9) } };
  assert.deepEqual(errorFindings(mixed), [{ level: "warn", reason: "refused thread/start 4x, none since 08:51 UTC" }, { level: "fail", reason: "refused turn/start 3x" }]);
  assert.deepEqual(errorFindings({ ...emptySignals(), featureRetries: 3 }), [{ level: "info", reason: "config retried 3x" }]);
  assert.deepEqual(errorFindings({ ...emptySignals(), featureRetries: 3, retriedThenRefused: 1 }), [{ level: "fail", reason: "config retry refused 1x" }]);
  assert.deepEqual(errorFindings({ ...emptySignals(), exits: { native: 1 } }), [{ level: "warn", reason: "native exited 1x" }]);
  // The same exit is only churn when the relay was not parked on purpose.
  assert.deepEqual(errorFindings({ ...emptySignals(), exits: { native: 1 } }, true), [{ level: "info", reason: "native exited 1x" }]);
});

test("inference verdicts run from unreachable to matching release", () => {
  assert.deepEqual(inferenceFindings({ state: "skipped" }, "0.4.4"), [{ level: "info", reason: "inference remote" }]);
  assert.deepEqual(inferenceFindings({ state: "unreachable" }, "0.4.4"), [{ level: "fail", reason: "inference not serving" }]);
  // The probe failing is a warning about the check, never a fault claimed against inference.
  assert.deepEqual(inferenceFindings({ state: "unreadable" }, "0.4.4"), [{ level: "warn", reason: "inference unreadable" }]);
  // A probe that could not run is a warning about the check, never a fault claimed against inference.
  assert.deepEqual(inferenceFindings({ state: "unreadable" }, "0.4.4"), [{ level: "warn", reason: "inference unreadable" }]);
  const probe = (extra: Partial<InferenceProbe>): InferenceProbe => ({ state: "answered", status: 200, ...extra });
  assert.deepEqual(inferenceFindings(probe({ status: 503 }), "0.4.4"), [{ level: "fail", reason: "inference status 503" }]);
  assert.deepEqual(inferenceFindings(probe({ bodyStatus: "degraded" }), "0.4.4"), [{ level: "fail", reason: "inference degraded" }]);
  // A header or a body field that is not a version token is named unknown, never carried through.
  assert.deepEqual(inferenceFindings(probe({ release: "0.4.4 /home/x/dist/cli.js" }), "0.4.4"), [{ level: "warn", reason: "inference release unknown" }]);
  assert.deepEqual(inferenceFindings(probe({ release: "0.4.3" }), "0.4.4"), [{ level: "warn", reason: "lagging inference@0.4.3" }]);
  assert.deepEqual(inferenceFindings(probe({ bodyStatus: "ok: true, uptime 41d" }), "0.4.4"), [{ level: "fail", reason: "inference unknown" }]);
  assert.deepEqual(inferenceFindings(probe({}), "0.4.4"), [{ level: "warn", reason: "inference release unknown" }]);
  assert.deepEqual(inferenceFindings(probe({ release: "0.4.3" }), "0.4.4"), [{ level: "warn", reason: "lagging inference@0.4.3" }]);
  assert.deepEqual(inferenceFindings(probe({ release: "0.4.3" }), null), []);
  assert.deepEqual(inferenceFindings(probe({ release: "0.4.4", bodyStatus: "ok" }), "0.4.4"), []);
});

test("smoke verdicts: a failing phase is the loudest finding", () => {
  assert.deepEqual(smokeFindings("pass"), []);
  assert.deepEqual(smokeFindings("skipped"), []);
  assert.deepEqual(smokeFindings("unavailable"), [{ level: "warn", reason: "smoke unavailable" }]);
  assert.deepEqual(smokeFindings("fail"), [{ level: "fail", reason: "smoke failed" }]);
  assert.deepEqual(smokeFindings("fail", "startup"), [{ level: "fail", reason: "smoke failed at startup" }]);
  // A recorded phase that is not a phase name is still a failure, but it does not get quoted.
  assert.deepEqual(smokeFindings("fail", "/tmp/gw-fast-abc:611:7 boom"), [{ level: "fail", reason: "smoke failed at unknown" }]);
});
