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

test("a registered relay that runs but is not connected for five minutes warns; a connected or fresh one does not", () => {
  const running = status({ state: "running" });
  assert.match(relayFindings(running, { registered: true, connected: false, statusAgeMs: 9 * 60_000 }, at)[0].reason, /^native relay registered but not connected for 9 min;.*gateway native uninstall/);
  assert.deepEqual(relayFindings(running, { registered: true, connected: false, statusAgeMs: 60_000 }, at), []);
  assert.deepEqual(relayFindings(running, { registered: true, connected: true, statusAgeMs: 99 * 60_000 }, at), []);
  assert.deepEqual(relayFindings(running, { registered: true, connected: false }, at), [], "an unknown age says nothing");
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

test("health reports the warning from the snapshot and the registration it reads", async () => {
  const files: Record<string, string> = {
    "/state/native-registration.json": JSON.stringify({ registered: true, home: "/relay" }),
    "/relay/status.json": JSON.stringify({ status: "connecting" }),
  };
  const report = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({
    readFile: async path => files[path] ?? "", mtime: async path => path === "/relay/status.json" ? at - 20 * 60_000 : undefined,
    readStatus: async () => status({ state: "running" }) }));
  assert.equal(report.verdict, "warn");
  assert.match(report.findings.find(finding => finding.level === "warn")!.reason, /native relay registered but not connected for 20 min/);
  const paused = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({ readFile: async path => files[path] ?? "", readStatus: async () => status({ state: "paused", pausedReason: "failing", pausedAt: ago(30) }) }));
  assert.equal(paused.verdict, "warn");
  assert.ok(paused.findings.some(finding => finding.level === "info" && finding.reason === "native paused"), "the plain note stays");
  assert.ok(paused.findings.some(finding => finding.level === "warn" && /paused for 30 min \(the relay keeps failing\)/.test(finding.reason)));
  const unregistered = await runHealth({ stateDirectory: "/state", port: 3457 }, deps({ readFile: async () => "", readStatus: async () => status({ state: "paused", pausedReason: "failing", pausedAt: ago(30) }) }));
  assert.equal(unregistered.verdict, "ok", "a relay nobody registered is a choice");
});
