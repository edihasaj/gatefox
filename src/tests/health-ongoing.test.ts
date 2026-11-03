import test from "node:test";
import assert from "node:assert/strict";
import { exitCodeFor, type InferenceProbe } from "../health-types.js";
import { runHealth, type HealthDeps } from "../health.js";
import { readHealthTelemetry, restartExplainsExitMs, summarizeHealthEvents, type HealthEvent } from "../health-telemetry.js";
import type { ServiceStatus } from "../health-checks.js";
import type { VersionsResult } from "../versions.js";

/**
 * Production, 2026-10-17: the adapters were refused once a minute from 07:10 to 07:25Z, the service
 * upgraded itself at 07:25:54Z, and `gateway health` at 07:37Z still failed on the old refusals.
 * Every Mac also warned `inference exited 1x` right after its own self-upgrade.
 */
const at = (clock: string) => Date.parse(`2026-10-17T${clock}Z`);
const now = at("07:37:00");
const minute = 60_000;
const running: ServiceStatus = { installed: true, published: true, components: [{ kind: "inference", state: "running" }] };
const probe: InferenceProbe = { state: "answered", status: 200, release: "0.4.4", bodyStatus: "ok" };
const versions = (serviceStart: number): VersionsResult =>
  ({ installed: "0.4.4", lagging: 0, processes: [{ role: "service", pid: 10, startedAt: new Date(serviceStart).toISOString(), release: "0.4.4" }] });

const refusal = (when: number, method = "thread/resume"): HealthEvent => ({ event: "rpc_error", method, rejection: "other", at: when });
/** One refusal a minute from 07:10 through 07:24, the way the Studio adapters were refused. */
const burst = (): HealthEvent[] => Array.from({ length: 15 }, (_, index) => refusal(at("07:10:05") + index * minute));
const upgrade = (when: number, component = "service"): HealthEvent => ({ event: "self_upgrade", component, at: when });
const exit = (when: number, kind = "inference"): HealthEvent => ({ event: "component_exit", kind, at: when });

async function check(events: HealthEvent[], deps: Partial<HealthDeps> = {}, clock = now) {
  const report = await runHealth({ stateDirectory: "/state", port: 3457 }, {
    now: () => clock, exists: async () => false, state: async () => undefined, writeState: async () => {}, readPlan: async () => undefined,
    readFile: async () => "", readStatus: async () => running, versions: async () => versions(at("06:00:00")), telemetry: async () => events,
    probe: async () => probe, ...deps,
  });
  return { report, code: exitCodeFor(report.verdict, report.push), reasons: report.findings.filter(finding => finding.level !== "info") };
}

test("refusals a self-upgrade ended warn with the time they stopped, not fail", async () => {
  const { report, code, reasons } = await check([...burst(), upgrade(at("07:25:54"))]);
  assert.equal(report.verdict, "warn");
  assert.equal(code, 1);
  assert.deepEqual(reasons, [{ level: "warn", reason: "refused thread/resume 15x, none since 07:24 UTC" }]);
});

test("the same refusals fail while three are inside the last five minutes", async () => {
  const stillRefusing = [...burst(), refusal(at("07:33:00")), refusal(at("07:34:00")), refusal(at("07:35:00"))];
  const { report, code, reasons } = await check(stillRefusing);
  assert.equal(report.verdict, "fail");
  assert.equal(code, 2);
  assert.deepEqual(reasons, [{ level: "fail", reason: "refused thread/resume 18x" }]);
});

test("refusals older than five minutes with no marker are no longer ongoing", async () => {
  const { report, reasons } = await check(burst());
  assert.equal(report.verdict, "warn");
  assert.deepEqual(reasons, [{ level: "warn", reason: "refused thread/resume 15x, none since 07:24 UTC" }]);
});

test("refusals that come after the recovery marker fail again", async () => {
  const { report } = await check([...burst(), upgrade(at("07:25:54")), refusal(at("07:34:00")), refusal(at("07:35:00")), refusal(at("07:36:00"))]);
  assert.equal(report.verdict, "fail");
  // One fresh refusal after the marker is only a hiccup, not an outage.
  const hiccup = await check([...burst(), upgrade(at("07:25:54")), refusal(at("07:36:00"))]);
  assert.equal(hiccup.report.verdict, "warn");
  assert.deepEqual(hiccup.reasons, [{ level: "warn", reason: "refused thread/resume 16x" }]);
});

test("each recovery marker ends the ongoing refusals: self-upgrade of the server, recovered host, and the service's own start", async () => {
  const recent = [...burst(), refusal(at("07:34:00")), refusal(at("07:34:10")), refusal(at("07:34:20"))];
  assert.equal((await check(recent)).report.verdict, "fail", "the control: three recent refusals fail");
  for (const marker of [upgrade(at("07:35:00"), "server"), { event: "execution_host_recovered", at: at("07:35:00") }] as HealthEvent[]) {
    assert.equal((await check([...recent, marker])).report.verdict, "warn", marker.event);
  }
  // A self-upgrade of anything but the service or the server (an adapter, an ssh listener) is not a recovery.
  assert.equal((await check([...recent, upgrade(at("07:35:00"), "adapter")])).report.verdict, "fail");
});

test("the service's own start does not reset a crash loop: it counts only after five minutes of uptime", async () => {
  const recent = [refusal(at("07:34:00")), refusal(at("07:34:10")), refusal(at("07:34:20"))];
  // Started two minutes ago, after the refusals: a service that keeps crashing would do this every minute.
  const looping = await check(recent, { versions: async () => versions(at("07:35:00")) });
  assert.equal(looping.report.verdict, "fail");
  // Started six minutes ago, before the refusals: not a marker that hides them either.
  assert.equal((await check(recent, { versions: async () => versions(at("07:31:00")) })).report.verdict, "fail");
  // Up for over five minutes and followed by no recent refusal: the older refusals are answered.
  const settled = await check([refusal(at("07:20:00")), refusal(at("07:21:00")), refusal(at("07:22:00"))], { versions: async () => versions(at("07:30:00")) });
  assert.equal(settled.report.verdict, "warn");
  assert.match(settled.reasons[0]!.reason, /none since 07:22 UTC$/);
});

test("fail needs three refusals that are each under five minutes old, not one recent among old ones", async () => {
  const early = [refusal(at("07:01:00")), refusal(at("07:01:10")), refusal(at("07:14:30"))];
  const hiccup = await check(early, {}, at("07:15:00"));
  assert.equal(hiccup.report.verdict, "warn");
  assert.deepEqual(hiccup.reasons, [{ level: "warn", reason: "refused thread/resume 3x" }]);
  // The outage: one refusal a minute, still going when the watchdog looks.
  const outage = Array.from({ length: 10 }, (_, index) => refusal(at("07:10:05") + index * minute));
  const down = await check(outage, {}, at("07:20:00"));
  assert.equal(down.report.verdict, "fail");
  assert.equal(down.code, 2);
});

test("a host that keeps recovering and failing does not hold the verdict at warn", async () => {
  const flapping: HealthEvent[] = [];
  for (const [recovered, failed] of [["07:12:30", "07:13:30"], ["07:15:00", "07:16:00"], ["07:17:30", "07:18:30"]] as const) {
    flapping.push({ event: "execution_host_recovered", at: at(recovered) }, { event: "execution_host_failed", at: at(failed) });
  }
  const refusals = Array.from({ length: 10 }, (_, index) => refusal(at("07:10:05") + index * minute));
  assert.equal((await check([...refusals, ...flapping], {}, at("07:20:00"))).report.verdict, "fail");
  // A restart after the recovery undoes it the same way as a failure does.
  const restarted = flapping.map(row => row.event === "execution_host_failed" ? { ...row, event: "execution_host_restarted" } : row);
  assert.equal((await check([...refusals, ...restarted], {}, at("07:20:00"))).report.verdict, "fail");
  // A recovery that held is a marker: the same refusals end there.
  const held = await check([...refusals, { event: "execution_host_recovered", at: at("07:17:30") }], {}, at("07:20:00"));
  assert.equal(held.report.verdict, "warn");
});

test("a server_drain alone explains the inference exit nine milliseconds later, read from the file", async () => {
  const stamp = (ms: number) => new Date(ms).toISOString();
  const drained = at("07:25:52");
  const file = [
    JSON.stringify({ at: stamp(drained), component: "server", event: "server_drain", active: 0, drainedMs: 3, aborted: 0 }),
    JSON.stringify({ at: stamp(drained + 9), component: "inference", event: "component_exit", kind: "inference", code: 0 }),
  ].join("\n") + "\n";
  const rows = await readHealthTelemetry("/state", { readFile: async path => path.endsWith("events-2026-10-17.jsonl") ? file : "", now: () => now });
  assert.equal(rows.length, 2);
  const signals = summarizeHealthEvents(rows, { now });
  assert.deepEqual(signals.exits, {});
  assert.deepEqual(signals.explainedExits, { inference: 1 });
});

test("a replay cut drops rows from its own future, and a live read sets no cut", async () => {
  const file = [refusal(now - minute), refusal(now + minute)].map(row => JSON.stringify({ ...row, at: new Date(row.at).toISOString() })).join("\n") + "\n";
  const read = (until?: number) => readHealthTelemetry("/state", { readFile: async path => path.endsWith("events-2026-10-17.jsonl") ? file : "", now: () => now, until });
  assert.equal((await read()).length, 2);
  assert.equal((await read(now)).length, 1);
  // runHealth cuts at its own clock when the clock is injected, so a fixture file cannot leak later rows into a replay.
  const future = [1, 2, 3].map(step => JSON.stringify({ event: "rpc_error", method: "thread/resume", rejection: "other", at: new Date(now + step * minute).toISOString() })).join("\n") + "\n";
  const replay = await check([], { telemetry: undefined, readFile: async path => path.endsWith("events-2026-10-17.jsonl") ? future : "" });
  assert.equal(replay.report.verdict, "ok");
  assert.equal(replay.report.errors.refusals, 0);
});

test("the inference exit a self-upgrade explains is not counted, and the one it does not explain is", async () => {
  const restart = [upgrade(at("07:25:54")), { event: "server_drain", component: "server", at: at("07:25:52") } as HealthEvent, exit(at("07:25:53"))];
  const explained = await check(restart);
  assert.equal(explained.report.verdict, "ok");
  assert.deepEqual(explained.report.errors.componentExits, {});
  assert.deepEqual(explained.reasons, []);
  const crash = await check([exit(at("07:30:00"))]);
  assert.equal(crash.report.verdict, "warn");
  assert.deepEqual(crash.reasons, [{ level: "warn", reason: "inference exited 1x" }]);
  // An exit a few minutes from the upgrade is a different event, and so is an exit of a component the restart did not touch.
  assert.equal((await check([upgrade(at("07:25:54")), exit(at("07:29:00"))])).report.verdict, "warn");
  assert.deepEqual((await check([{ event: "server_drain", component: "server", at: at("07:25:52") } as HealthEvent, exit(at("07:25:53"), "tunnel")])).reasons,
    [{ level: "warn", reason: "tunnel exited 1x" }]);
  assert.equal((await check([upgrade(at("07:25:54"), "adapter"), exit(at("07:25:53"))])).report.verdict, "warn");
});

test("an exit is explained within the window and not past it, and each kind keeps its own count", () => {
  const upgraded = at("07:25:54");
  const counts = (rows: HealthEvent[]) => summarizeHealthEvents(rows, { now });
  assert.deepEqual(counts([upgrade(upgraded), exit(upgraded + restartExplainsExitMs)]).exits, {});
  assert.deepEqual(counts([upgrade(upgraded), exit(upgraded - restartExplainsExitMs)]).exits, {});
  assert.deepEqual(counts([upgrade(upgraded), exit(upgraded + restartExplainsExitMs + 1)]).exits, { inference: 1 });
  // A service self-upgrade restarts every component; a server upgrade or a drain only the inference server.
  assert.deepEqual(counts([upgrade(upgraded), exit(upgraded, "tunnel"), exit(upgraded, "native")]).exits, {});
  assert.deepEqual(counts([upgrade(upgraded, "server"), exit(upgraded, "tunnel")]).exits, { tunnel: 1 });
  assert.deepEqual(counts([upgrade(upgraded), exit(upgraded), exit(upgraded + 5 * minute)]).explainedExits, { inference: 1 });
  assert.equal(counts([upgrade(upgraded), exit(upgraded, "native")]).nativeExited, false);
});

test("release skew refusals fail until a service on the installed release starts, which answers them at once", async () => {
  const skew = { event: "release_skew_refused", direction: "adapter_newer", count: 23, at: at("07:30:00") } as HealthEvent;
  const lagging: VersionsResult = { installed: "0.4.4", lagging: 1, processes: [{ role: "service", pid: 10, startedAt: new Date(at("06:00:00")).toISOString(), release: "0.4.3" }] };
  const stuck = await check([skew], { versions: async () => lagging });
  assert.equal(stuck.report.verdict, "fail");
  assert.ok(stuck.reasons.some(finding => /chats refused 23x/.test(finding.reason)));
  // Restarted a minute ago onto the installed release: younger than the five minutes ordinary refusals wait for.
  const restarted = await check([skew], { versions: async () => versions(now - minute) });
  assert.equal(restarted.reasons.some(finding => /chats refused/.test(finding.reason)), false);
});
