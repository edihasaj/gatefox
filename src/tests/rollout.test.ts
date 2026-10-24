import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { componentLiveness, rolloutCommand, runRollout, type RolloutDeps } from "../rollout.js";
import type { GatewayConfig } from "../config.js";
import type { ServicePlan } from "../service-plan.js";
import type { VersionsResult } from "../versions.js";
import type { ScrubbedExecutionProbeReport } from "../execution-probe.js";

const now = Date.parse("2026-10-20T10:00:00.000Z");
const installed = "0.6.0";
const sourceCommit = "a".repeat(40);
const catalogFingerprint = "b".repeat(64);
const sdkSha256 = "c".repeat(64);
const startedAtMs = now - 30_000;
const config: GatewayConfig = { version: 1, port: 3457, stateDirectory: "/state", providers: [] };
const plan: ServicePlan = { version: 1, config: "/gateway.json", components: [{ id: "inference", kind: "inference", command: "/gateway", args: [], log: "/gateway.log" }] };

function versions(rows: Array<Partial<VersionsResult["processes"][number]>> = []): VersionsResult {
  const defaults = [
    { role: "service" as const, pid: 101, startedAt: new Date(now - 30_000).toISOString(), release: installed },
    { role: "inference" as const, pid: 102, startedAt: new Date(now - 30_000).toISOString(), release: installed },
  ];
  return { installed, lagging: 0, processes: rows.length ? rows.map((row, index) => ({
    role: row.role ?? "service", pid: row.pid ?? 200 + index, startedAt: row.startedAt ?? new Date(now - 30_000).toISOString(), release: row.release ?? installed,
  })) : defaults };
}

function probe(overrides: Partial<ScrubbedExecutionProbeReport> = {}): ScrubbedExecutionProbeReport {
  return {
    ready: true, reason: "ready", checkedAt: new Date(now - 1000).toISOString(), hostPid: 201, startedAtMs,
    runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256,
    sdkVerified: true, configVerified: true, directToolVerified: true, completedTurn: true, commandVerified: true, ...overrides,
  };
}

function base(extra: Partial<RolloutDeps> = {}): RolloutDeps {
  return {
    now: () => now,
    configPath: async () => "/gateway.json",
    config: async () => config,
    versions: async () => versions(),
    plan: async () => plan,
    status: async () => ({ version: 1, pid: 101, updatedAt: new Date(now).toISOString(), runningRelease: installed,
      components: [{ id: "inference", kind: "inference", state: "running", pid: 102, startedAt: new Date(now - 30_000).toISOString() }] }),
    inference: async () => ({ status: 200, release: installed }),
    host: async () => ({ status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false, cachedProbe: probe({ hostPid: 101 }) } }),
    releaseSource: async () => sourceCommit,
    nativeSharingPending: async () => false,
    claudeConsolidationPending: async () => false,
    ...extra,
  };
}

test("rollout ready requires current process, PID-frozen service, header release, and matching fresh host canary", async () => {
  const report = await runRollout(false, undefined, base());
  assert.equal(report.state, "ready");
  assert.equal(report.reason, "ready");
  assert.equal(report.versions.current, 2);
  assert.equal(report.host?.pid, 101);
  assert.equal(report.probe?.commandVerified, true);
});

test("staged native adoption cannot earn readiness before activation, including a stage created during verification", async () => {
  let hostCalls = 0;
  const staged = await runRollout(true, undefined, base({
    nativeSharingPending: async () => true,
    host: async () => { hostCalls++; throw new Error("No probe should run before adoption"); },
  }));
  assert.equal(staged.reason, "native_sharing_pending");
  assert.equal(hostCalls, 0);
  const unreadable = await runRollout(false, undefined, base({ nativeSharingPending: async () => { throw new Error("private receipt unreadable"); } }));
  assert.equal(unreadable.reason, "native_sharing_pending");
  let reads = 0;
  const raced = await runRollout(true, undefined, base({ nativeSharingPending: async () => ++reads > 1 }));
  assert.equal(raced.reason, "native_sharing_pending");
  assert.equal(raced.probe?.ready, true, "a successful old-mode canary cannot certify a newly staged ownership change");
});

test("a combined host must actually own the native home before shared-native rollout is ready", async () => {
  const sharedPlan = { ...plan, sharedNativeExecutor: true, sharedExecutors: true };
  const host = { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 },
    capabilities: ["gateway", "native"], compatible: true, quiescing: false, activeWork: false, cachedProbe: probe({ hostPid: 101 }) };
  const pending = await runRollout(false, undefined, base({ plan: async () => sharedPlan, host: async () => ({ status: host }) }));
  assert.equal(pending.reason, "native_owner_pending", "advertising native support does not prove a competing private writer is gone");
  const ready = await runRollout(false, undefined, base({ plan: async () => sharedPlan, host: async () => ({ status: { ...host, nativeHomeOwned: true } }) }));
  assert.equal(ready.state, "ready");
});

test("Claude consolidation stays pending before activation, on unreadable intent, or when staged during a canary", async () => {
  let calls = 0;
  const pending = await runRollout(true, undefined, base({ claudeConsolidationPending: async () => true,
    host: async () => { calls++; throw new Error("must not run"); } }));
  assert.equal(pending.reason, "claude_consolidation_pending"); assert.equal(calls, 0);
  const unknown = await runRollout(false, undefined, base({ claudeConsolidationPending: async () => { throw new Error("unreadable"); } }));
  assert.equal(unknown.reason, "claude_consolidation_pending");
  let reads = 0;
  const raced = await runRollout(true, undefined, base({ claudeConsolidationPending: async () => ++reads > 1 }));
  assert.equal(raced.reason, "claude_consolidation_pending"); assert.equal(raced.probe?.ready, true);
});

test("each pinned Claude component needs its own live PID and start, not the main release version", async () => {
  const kinds = ["claude-adapter", "claude-inference"] as const;
  const components = kinds.map((kind, index) => ({ id: kind, kind, command: "/signed/node", args: ["/private/cli.js"], log: `/claude-${index}.log` }));
  const snapshot = { version: 1, pid: 101, updatedAt: new Date(now).toISOString(), runningRelease: installed,
    components: [{ id: "inference", kind: "inference", state: "running", pid: 102, startedAt: new Date(now - 30_000).toISOString() },
      ...kinds.map((kind, index) => ({ id: kind, kind, state: "running", pid: 301 + index, startedAt: new Date(now - 30_000).toISOString() }))] };
  const seen: number[] = [];
  const deps = base({ plan: async () => ({ ...plan, components: [...plan.components, ...components] }), status: async () => snapshot,
    componentLiveness: async (_component, pid) => { seen.push(pid); return true; } });
  assert.equal((await runRollout(false, undefined, deps)).state, "ready"); assert.deepEqual(seen, [301, 302]);
  assert.equal((await runRollout(false, undefined, { ...deps, componentLiveness: async (_component, pid) => pid !== 302 })).reason, "component_pending");
});

test("a prior process, unknown process, or HTTP 200 from an old release remains pending", async () => {
  const old = await runRollout(false, undefined, base({ versions: async () => versions([
    { role: "service", pid: 101, release: installed }, { role: "inference", pid: 102, release: "0.5.9" },
  ]) }));
  assert.equal(old.state, "pending");
  assert.equal(old.reason, "process_version_pending");
  const unknown = await runRollout(false, undefined, base({ versions: async () => versions([
    { role: "service", pid: 101, release: installed }, { role: "inference", pid: 102, release: "unknown" },
  ]) }));
  assert.equal(unknown.state, "pending");
  const oldHeader = await runRollout(false, undefined, base({ inference: async () => ({ status: 200, release: "0.5.9" }) }));
  assert.equal(oldHeader.reason, "inference_pending");
});

test("service report belongs to its current PID and immutable release", async () => {
  const wrongPid = await runRollout(false, undefined, base({ status: async () => ({
    version: 1, pid: 999, updatedAt: new Date(now).toISOString(), runningRelease: installed, components: [{ kind: "inference", state: "running" }],
  }) }));
  assert.equal(wrongPid.reason, "service_identity_pending");
  const old = await runRollout(false, undefined, base({ status: async () => ({
    version: 1, pid: 101, updatedAt: new Date(now).toISOString(), runningRelease: "0.5.9", components: [{ kind: "inference", state: "running" }],
  }) }));
  assert.equal(old.reason, "service_release_pending");
  const hostPid = await runRollout(false, undefined, base({ host: async () => ({
    status: { identity: { hostPid: 201, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 },
      capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false, cachedProbe: probe({ hostPid: 201 }) },
  }) }));
  assert.equal(hostPid.reason, "host_status_pending");
});

test("cached proof expires or fails closed when its host identity, SDK, or catalog changes", async () => {
  const stale = await runRollout(false, undefined, base({ host: async () => ({
    status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false, cachedProbe: probe({ hostPid: 101, checkedAt: new Date(now - 5 * 60_000 - 1).toISOString() }) },
  }) }));
  assert.equal(stale.reason, "probe_stale");
  const mismatch = await runRollout(false, undefined, base({ host: async () => ({
    status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false, cachedProbe: probe({ hostPid: 101, sdkSha256: "d".repeat(64) }) },
  }) }));
  assert.equal(mismatch.reason, "probe_stale");
  const source = await runRollout(false, undefined, base({ host: async () => ({
    status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false,
      cachedProbe: probe({ hostPid: 101, sourceCommit: "d".repeat(40) }) },
  }) }));
  assert.equal(source.reason, "probe_stale");
  const catalog = await runRollout(false, undefined, base({ host: async () => ({
    status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false,
      cachedProbe: probe({ hostPid: 101, catalogFingerprint: "d".repeat(64) }) },
  }) }));
  assert.equal(catalog.reason, "probe_stale");
  const failed = await runRollout(false, undefined, base({ host: async () => ({
    status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false,
      cachedProbe: probe({ hostPid: 101, ready: false, reason: "child_failed", commandVerified: false }) },
  }) }));
  assert.equal(failed.state, "failed");
  assert.equal(failed.reason, "probe_failed");
});

test("verify asks the host for a fresh isolated canary, while missing and busy hosts do not claim readiness", async () => {
  let requestedVerify = false;
  const verified = await runRollout(true, undefined, base({ host: async input => {
    requestedVerify = input.verify;
    return { status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false }, probe: probe({ hostPid: 101 }) };
  } }));
  assert.equal(requestedVerify, true);
  assert.equal(verified.state, "ready");
  const missing = await runRollout(false, undefined, base({ host: async () => ({ unavailable: true }) }));
  assert.equal(missing.reason, "host_pending");
  const busy = await runRollout(false, undefined, base({ host: async () => ({
    status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 }, capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: true },
  }) }));
  assert.equal(busy.state, "blocked");
  assert.equal(busy.reason, "active_work");
});

test("a release switch or adopted PID cohort during verify leaves the successful canary pending", async () => {
  let reads = 0;
  const changed = await runRollout(true, undefined, base({
    versions: async () => ++reads === 1 ? versions() : {
      installed: "0.6.1", lagging: 0, processes: [
        { role: "service", pid: 301, startedAt: new Date(now).toISOString(), release: "0.6.1" },
        { role: "inference", pid: 302, startedAt: new Date(now).toISOString(), release: "0.6.1" },
      ],
    },
    host: async () => ({
      status: { identity: { hostPid: 101, startedAtMs, runningRelease: installed, sourceCommit, catalogFingerprint, sdkSha256 },
        capabilities: ["gateway"], compatible: true, quiescing: false, activeWork: false },
      probe: probe({ hostPid: 101 }),
    }),
  }));
  assert.equal(reads, 2);
  assert.equal(changed.state, "pending");
  assert.equal(changed.reason, "rollout_changed");
});

test("a running service-plan component needs a current process of its own", async () => {
  const missing = await runRollout(false, undefined, base({ plan: async () => ({
    ...plan, components: [...plan.components, { id: "relay", kind: "native", command: "/relay", args: [], log: "/relay.log" }],
  }), status: async () => ({
    version: 1, pid: 101, updatedAt: new Date(now).toISOString(), runningRelease: installed,
    components: [{ kind: "inference", state: "running" }, { kind: "native", state: "running" }],
  }) }));
  assert.equal(missing.state, "pending");
  assert.equal(missing.reason, "component_pending");
});

test("one current component cannot mask a stopped sibling with the same role", async () => {
  const twinPlan: ServicePlan = {
    ...plan,
    components: [
      { id: "first-tunnel", kind: "tunnel", command: "/tunnel", args: [], log: "/one.log" },
      { id: "second-tunnel", kind: "tunnel", command: "/tunnel", args: [], log: "/two.log" },
    ],
  };
  const blocked = await runRollout(false, undefined, base({
    plan: async () => twinPlan,
    componentLiveness: async () => true,
    versions: async () => versions([
      { role: "service", pid: 101 }, { role: "inference", pid: 102 }, { role: "tunnel", pid: 103 },
    ]),
    status: async () => ({
      version: 1, pid: 101, updatedAt: new Date(now).toISOString(), runningRelease: installed,
      components: [
        { id: "first-tunnel", kind: "tunnel", state: "running", pid: 103, startedAt: new Date(now - 30_000).toISOString() },
        { id: "second-tunnel", kind: "tunnel", state: "paused" },
      ],
    }),
  }));
  assert.equal(blocked.reason, "component_pending");
});

test("system tunnel liveness binds the service PID and start to its actual executable", async () => {
  const child = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    const live = await componentLiveness({ id: "tunnel-fixture", kind: "tunnel", command: "/bin/sleep", args: [], log: "/tmp/rollout-test.log" },
      child.pid!, new Date().toISOString());
    assert.equal(live, true);
  } finally {
    child.kill("SIGTERM");
    await once(child, "close");
  }
});

test("command exit codes distinguish ready, pending, and failed without printing hidden probe detail", async () => {
  let printed = "";
  const ready = await rolloutCommand(["--json"], { ...base(), stdout: text => { printed += text; } });
  assert.equal(ready, 0);
  assert.match(printed, /"state": "ready"/);
  const pending = await rolloutCommand([], { ...base({ host: async () => ({ unavailable: true }) }), stdout: () => {} });
  assert.equal(pending, 1);
  const failed = await rolloutCommand([], { ...base({ inference: async () => ({ status: 500 }) }), stdout: () => {} });
  assert.equal(failed, 2);
});
