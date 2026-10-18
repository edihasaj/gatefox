import test from "node:test";
import assert from "node:assert/strict";
import { relayFindings, statusFields, type RelayHealth, type ServiceStatus } from "../health-checks.js";
import { runHealth, type HealthDeps } from "../health.js";
import type { InferenceProbe } from "../health-types.js";
import type { VersionsResult } from "../versions.js";

/**
 * A registered relay owns the machine's remote control, so a relay that is paused or not connected leaves the phone without
 * this Mac. `gateway health` warns once that has lasted about five minutes, names the cause class and the way out.
 */
const at = Date.parse("2026-10-18T09:00:00.000Z");
const ago = (minutes: number) => new Date(at - minutes * 60_000).toISOString();
const status = (native: Record<string, unknown>): ServiceStatus => ({ installed: true, published: true, components: [{ kind: "inference", state: "running" }, { kind: "native", state: "running", ...native }] as ServiceStatus["components"] });
const registered: RelayHealth = { registered: true };

test("a registered relay paused for more than five minutes warns with its cause class and the way out", () => {
  const failing = relayFindings(status({ state: "paused", pausedReason: "failing", pausedAt: ago(12) }), registered, at);
  assert.equal(failing.length, 1); assert.equal(failing[0].level, "warn");
  assert.match(failing[0].reason, /^native relay registered but paused for 12 min \(the relay keeps failing\); the phone cannot reach this Mac; gateway native uninstall gives remote control back to ChatGPT$/);
  assert.match(relayFindings(status({ state: "paused", pausedReason: "not_registered", pausedAt: ago(7) }), registered, at)[0].reason, /service has not started it since the registration/);
  assert.match(relayFindings(status({ state: "paused", pausedAt: ago(7) }), registered, at)[0].reason, /cause unknown/);
});

test("a relay paused for less than five minutes, an unregistered one, or a snapshot without a pause time warns about nothing", () => {
  assert.deepEqual(relayFindings(status({ state: "paused", pausedReason: "failing", pausedAt: ago(4) }), registered, at), []);
  assert.deepEqual(relayFindings(status({ state: "paused", pausedReason: "failing", pausedAt: ago(60) }), { registered: false }, at), []);
  assert.deepEqual(relayFindings(status({ state: "paused", pausedReason: "failing" }), registered, at), []);
  assert.deepEqual(relayFindings({ installed: true, published: true, components: [{ kind: "inference", state: "running" }] }, registered, at), []);
});

test("a registered relay that runs but has not been connected for five minutes warns, measured from the last time it was connected", () => {
  const down: RelayHealth = { registered: true, connected: false };
  const since = (state: Record<string, unknown>) => relayFindings(status({ state: "running", ...state }), down, at);
  assert.match(since({ startedAt: ago(60), lastConnectedAt: ago(9) })[0].reason, /^native relay registered but not connected for 9 min;.*gateway native uninstall/);
  assert.deepEqual(since({ startedAt: ago(60), lastConnectedAt: ago(2) }), [], "a flicker is not an outage");
  assert.match(since({ startedAt: ago(30) })[0].reason, /not connected for 30 min/, "never connected in this run: measured from the start");
  assert.match(since({ startedAt: ago(10), lastConnectedAt: ago(500) })[0].reason, /not connected for 10 min/, "a connection from an earlier run does not hide a fresh outage");
  assert.deepEqual(since({ startedAt: ago(2) }), [], "a relay that just started has had no time");
  assert.deepEqual(since({}), [], "without a start time there is nothing to measure from");
  assert.deepEqual(relayFindings(status({ state: "running", startedAt: ago(60) }), { registered: true, connected: true }, at), []);
});

test("the snapshot reader keeps only a fixed pause reason and a real time", () => {
  const value = statusFields({ components: [{ kind: "native", state: "paused", pausedReason: "failing", pausedAt: ago(3), command: ["secret"] }, { kind: "native", state: "paused", pausedReason: "/Users/x/secret path", pausedAt: "not a time" }] });
  assert.deepEqual(value.components, [{ kind: "native", state: "paused", pausedReason: "failing", pausedAt: ago(3) }, { kind: "native", state: "paused" }]);
});

const versions: VersionsResult = { installed: "0.4.8", lagging: 0, processes: [{ role: "service", pid: 1, startedAt: ago(600), release: "0.4.8" }] };
const probe: InferenceProbe = { state: "answered", status: 200, release: "0.4.8", bodyStatus: "ok" };
function deps(extra: Partial<HealthDeps>): HealthDeps {
  return { now: () => at, exists: async () => false, state: async () => undefined, writeState: async () => {}, readPlan: async () => undefined, versions: async () => versions, telemetry: async () => [], probe: async () => probe, ...extra };
}

test("health warns during a refusal loop: the relay's status file keeps changing, its connection never comes", async () => {
  // A second engine holds the one slot (HTTP 409), so the relay flips connecting <-> errored for as long as it likes. Every flip
  // rewrites status.json, so its age is always fresh; only the last time it was connected shows the outage.
  const statuses = ["connecting", "errored"];
  let flip = 0;
  const loop = () => ({ "/state/native-registration.json": JSON.stringify({ registered: true, home: "/relay" }), "/relay/status.json": JSON.stringify({ status: statuses[flip++ % 2] }) }) as Record<string, string>;
  const down = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({ readFile: async path => loop()[path] ?? "", readStatus: async () => status({ state: "running", startedAt: ago(45), lastConnectedAt: ago(40) }) }));
  assert.equal(down.verdict, "warn");
  assert.match(down.findings.find(finding => finding.level === "warn")!.reason, /native relay registered but not connected for 40 min/);
  const brief = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({ readFile: async path => loop()[path] ?? "", readStatus: async () => status({ state: "running", startedAt: ago(45), lastConnectedAt: ago(1) }) }));
  assert.equal(brief.verdict, "ok");
  const connected = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({ readFile: async path => ({ "/state/native-registration.json": JSON.stringify({ registered: true, home: "/relay" }), "/relay/status.json": JSON.stringify({ status: "connected" }) })[path] ?? "", readStatus: async () => status({ state: "running", startedAt: ago(45), lastConnectedAt: ago(40) }) }));
  assert.equal(connected.verdict, "ok", "a relay that is connected now has nothing to warn about");
  const files: Record<string, string> = { "/state/native-registration.json": JSON.stringify({ registered: true, home: "/relay" }) };
  const paused = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({ readFile: async path => files[path] ?? "", readStatus: async () => status({ state: "paused", pausedReason: "failing", pausedAt: ago(30) }) }));
  assert.equal(paused.verdict, "warn");
  assert.ok(paused.findings.some(finding => finding.level === "info" && finding.reason === "native paused"), "the plain note stays");
  assert.ok(paused.findings.some(finding => finding.level === "warn" && /paused for 30 min \(the relay keeps failing\)/.test(finding.reason)));
  const unregistered = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({ readFile: async () => "", readStatus: async () => status({ state: "paused", pausedReason: "failing", pausedAt: ago(30) }) }));
  assert.equal(unregistered.verdict, "ok", "a relay nobody registered is a choice");
});
