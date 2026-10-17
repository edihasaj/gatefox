import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { serviceNativeExecutionPaths, servicePlanPath, serviceStatusPath, validateServicePlan, type ServicePlan } from "../service-plan.js";
import { ServiceSupervisor } from "../service-supervisor.js";
import { startExecutionHost, executionHostHome } from "../execution-host.js";
import { sdkIdentity } from "../execution-host-storage.js";
import { nativeHomeOwnerPath } from "../native-execution-host-storage.js";
import { executionHostReady, enableSharedExecutors } from "../mac-shared-executors.js";
import { gatewaySdkRuntime } from "../gateway-sdk-runtime.js";
import { enableSharedNative, type SharedNativeMigrationDependencies } from "../mac-shared-native.js";
import { legacyNativeWriters } from "../service-native-writers.js";
import { writePrivateJson } from "../config.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // The SDK rendezvous and host and native homes stay in this file's own folder.
hostRunsInThisProcess(); // This file's host runs inside the test process: see src/tests/in-process-host.ts.

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gateway-service-native-")); const state = join(directory, "state");
  const nativeHome = join(directory, "native"); const relayHome = join(directory, "relay");
  await mkdir(nativeHome, { mode: 0o700 }); await mkdir(relayHome, { mode: 0o700 });
  await writeFile(join(nativeHome, "config.toml"), 'model="original"\n', { mode: 0o600 });
  await writeFile(join(nativeHome, "auth.json"), '{"fixture":"unchanged"}\n', { mode: 0o600 });
  const codex = join(directory, "codex"); await writeFile(codex, `#!${process.execPath}\nconsole.log('codex-cli 0.162.0-alpha.17.2');\n`, { mode: 0o700 });
  const configPath = join(directory, "gateway.json");
  await writePrivateJson(configPath, { version: 1, port: 3459, clientOnly: true, stateDirectory: state, providers: [] });
  const plan: ServicePlan = { version: 1, config: configPath, sharedExecutors: false, components: [{
    id: "native", kind: "native", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)", "--", "--daemon", "--codex", codex, "--native-home", nativeHome, "--relay-home", relayHome], log: join(state, "native.log"),
  }] };
  await writePrivateJson(servicePlanPath(state), plan);
  await writePrivateJson(join(relayHome, "status.json"), { status: "connected", environmentId: "existing-fixture-machine" });
  let pid = 101; const calls: string[] = [];
  const status = async () => ({ installed: true, pid, statusCurrent: true, runtime: { executionHost: { state: "running" }, components: [{ state: "running" }] } });
  const dependencies: Partial<SharedNativeMigrationDependencies> = {
    platform: "darwin", pending: async () => false, registration: async () => true, status, writers: async () => [],
    maintenance: async () => { calls.push("maintenance"); }, sdk: async () => ({ codex, sdkSha256: "a".repeat(64) }),
    validateSdk: async () => { calls.push("verified-sdk"); assert.equal(JSON.parse(await readFile(servicePlanPath(state), "utf8")).sharedNativeExecutor, undefined); },
    ready: async current => { assert.equal(current.sharedNativeExecutor, true); assert.equal(current.sharedExecutors, false); return true; },
    restart: async () => { calls.push("restart"); pid = 102; await writePrivateJson(join(relayHome, "status.json"), { status: "connected", environmentId: "existing-fixture-machine" }); },
    health: async () => true, rollbackTiming: { readyMs: 20, pollMs: 1, restartAttempts: 2, retryMs: 1 },
    archive: async () => { calls.push("archive"); }, install: async () => { calls.push("install"); },
  };
  return { directory, state, nativeHome, relayHome, codex, configPath, plan, calls, dependencies, setPid: (value: number) => { pid = value; },
    cleanup: async () => { await rm(directory, { recursive: true, force: true }); await rm(executionHostHome(configPath, nativeHome), { recursive: true, force: true }); await rm(dirname(nativeHomeOwnerPath(nativeHome)), { recursive: true, force: true }); } };
}

test("native ownership remains opt-in, independent, and restricted to an existing daemon relay", () => {
  const plan = { version: 1, config: "/private/gateway.json", sharedExecutors: false, components: [{ id: "native", kind: "native", command: "/private/relay",
    args: ["--daemon", "--codex", "/signed/codex", "--native-home", "/private/native", "--relay-home", "/private/relay-home"], log: "/private/log" }] };
  assert.equal(validateServicePlan(plan).sharedNativeExecutor, undefined);
  const native = validateServicePlan({ ...plan, sharedNativeExecutor: true });
  assert.equal(native.sharedExecutors, false); assert.deepEqual(serviceNativeExecutionPaths(native), { codex: "/signed/codex", nativeHome: "/private/native" });
  assert.throws(() => validateServicePlan({ ...plan, sharedNativeExecutor: "yes" }), /boolean/);
  assert.throws(() => validateServicePlan({ ...plan, sharedNativeExecutor: true, components: [{ ...plan.components[0], kind: "desktop", args: ["--app", "/Applications/ChatGPT.app"] }] }), /existing native relay/);
  assert.throws(() => validateServicePlan({ ...plan, sharedNativeExecutor: true, components: [{ ...plan.components[0], args: ["--codex", "/signed/codex", "--native-home", "/private/native"] }] }), /daemon relay/);
});

test("native writer inventory includes relay-owned SDKs and never exposes process arguments", () => {
  const snapshot = ["10 1 /gateway daemon --config /private/gateway.json", "11 10 /relay --daemon", "12 11 /gateway codex-shim --config /private/gateway.json -- app-server",
    "13 12 /signed/codex app-server --listen stdio:// PRIVATE_FIXTURE_SECRET=not-returned", "14 12 /signed/codex app-server -c model_catalog_json=/private/catalog.json",
    "20 1 /signed/codex app-server --listen stdio://", "30 1 /unrelated/codex app-server", "40 1 /signed/codex app-server proxy", "50 10 /signed/codex app-server --listen unix:///owned/native.sock"].join("\n");
  assert.deepEqual(legacyNativeWriters(snapshot, "/private/gateway.json", "/signed/codex", 50), [
    { pid: 13, kind: "native-sdk" }, { pid: 14, kind: "gateway-sdk" }, { pid: 20, kind: "native-sdk" },
  ]);
  assert.ok(!JSON.stringify(legacyNativeWriters(snapshot, "/private/gateway.json", "/signed/codex")).includes("PRIVATE_FIXTURE_SECRET"));
});

test("native-only supervisor starts one native capability host without enabling gateway ownership", { timeout: 15000 }, async () => {
  const f = await fixture(); const plan = { ...f.plan, sharedNativeExecutor: true };
  const supervisor = new ServiceSupervisor(plan, f.state, 1000, options => {
    assert.deepEqual(options.capabilities, ["native"]); assert.equal(options.nativeRelayOwnsRegistration, true);
    return startExecutionHost({ ...options, nativeSdkVerifier: async codex => { const identity = await sdkIdentity(codex); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; } });
  });
  try {
    await supervisor.start(); const status = JSON.parse(await readFile(serviceStatusPath(f.state), "utf8"));
    assert.equal(status.executionHost.sharedNativeExecutor, true); assert.equal(status.executionHost.sharedGatewayExecutors, false);
    assert.equal(await executionHostReady(plan, process.pid), true);
    assert.equal(await executionHostReady({ ...plan, sharedNativeExecutor: false, sharedExecutors: true }, process.pid), false);
    await supervisor.stop();
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model="original"\n');
    assert.equal(await readFile(join(f.nativeHome, "auth.json"), "utf8"), '{"fixture":"unchanged"}\n');
  } finally { await supervisor.stop(); await f.cleanup(); }
});

test("explicit combined service flags retain native ownership and expose both independent capabilities", { timeout: 15000 }, async () => {
  const f = await fixture(); const plan = { ...f.plan, sharedNativeExecutor: true, sharedExecutors: true };
  const supervisor = new ServiceSupervisor(plan, f.state, 1000, options => {
    assert.deepEqual(options.capabilities, ["native", "gateway"]);
    return startExecutionHost({ ...options, nativeSdkVerifier: async codex => { const identity = await sdkIdentity(codex); return { nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }; } });
  });
  try {
    await supervisor.start(); assert.equal(await executionHostReady(plan, process.pid), true);
    assert.equal(await executionHostReady({ ...plan, sharedExecutors: false }, process.pid), false);
    await supervisor.stop(); assert.equal(await readFile(join(f.nativeHome, "auth.json"), "utf8"), '{"fixture":"unchanged"}\n');
  } finally { await supervisor.stop(); await f.cleanup(); }
});

test("gateway sharing over native ownership requires a verified release artifact before service mutation", { skip: process.platform !== "darwin" }, async () => {
  if (await gatewaySdkRuntime()) return; // Packaged release artifact validity is covered by runtime tests.
  const f = await fixture();
  try {
    await writePrivateJson(servicePlanPath(f.state), { ...f.plan, sharedNativeExecutor: true });
    const before = await readFile(servicePlanPath(f.state));
    await assert.rejects(enableSharedExecutors(f.configPath, true), /verified selected-model compaction SDK/);
    assert.deepEqual(await readFile(servicePlanPath(f.state)), before);
    assert.ok(!(await readdir(f.state)).includes("service-backups"));
  } finally { await f.cleanup(); }
});

test("native migration preview is inert and successful application preserves the native account and relay", async () => {
  const f = await fixture();
  try {
    const before = await readFile(servicePlanPath(f.state));
    const preview = await enableSharedNative(f.configPath, false, f.dependencies);
    assert.equal(preview.applied, false); assert.equal(preview.sharedExecutors, false); assert.equal(preview.startupJobs, 1); assert.deepEqual(f.calls, []);
    assert.deepEqual(await readFile(servicePlanPath(f.state)), before);
    const applied = await enableSharedNative(f.configPath, true, f.dependencies);
    assert.equal(applied.applied, true); assert.deepEqual(f.calls, ["maintenance", "verified-sdk", "restart"]);
    assert.equal(JSON.parse(await readFile(servicePlanPath(f.state), "utf8")).sharedNativeExecutor, true);
    assert.equal(await readFile(join(f.nativeHome, "config.toml"), "utf8"), 'model="original"\n');
    assert.equal(await readFile(join(f.nativeHome, "auth.json"), "utf8"), '{"fixture":"unchanged"}\n');
    assert.equal(JSON.parse(await readFile(join(f.relayHome, "status.json"), "utf8")).environmentId, "existing-fixture-machine");
  } finally { await f.cleanup(); }
});

test("pending plans, mismatched registrations, active native writers, and unsigned SDKs refuse before plan mutation", async () => {
  const f = await fixture();
  try {
    const before = await readFile(servicePlanPath(f.state));
    await assert.rejects(enableSharedNative(f.configPath, true, { ...f.dependencies, pending: async () => true }), /pending/);
    await assert.rejects(enableSharedNative(f.configPath, true, { ...f.dependencies, registration: async () => false }), /another configuration/);
    await assert.rejects(enableSharedNative(f.configPath, true, { ...f.dependencies, writers: async () => [{ pid: 77, kind: "native-sdk" }] }), /still connected/);
    const { validateSdk: _testVerifier, ...strict } = f.dependencies;
    await assert.rejects(enableSharedNative(f.configPath, true, strict), /original signed Codex SDK/);
    assert.deepEqual(await readFile(servicePlanPath(f.state)), before);
    assert.ok(!(await readdir(f.state)).includes("service-backups"));
    assert.ok(!f.calls.includes("restart"));
  } finally { await f.cleanup(); }
});

test("refused restart restores the old plan, and a replacement that cannot be restarted keeps its plan file and its writers", async () => {
  const f = await fixture();
  try {
    await assert.rejects(enableSharedNative(f.configPath, true, { ...f.dependencies, restart: async () => { throw new Error("idle restart refused"); } }), /idle restart refused/);
    assert.equal(JSON.parse(await readFile(servicePlanPath(f.state), "utf8")).sharedNativeExecutor, undefined);
    await new Promise(resolve => setTimeout(resolve, 2));
    let restarts = 0;
    await assert.rejects(enableSharedNative(f.configPath, true, { ...f.dependencies,
      restart: async () => { restarts++; f.setPid(102); throw new Error(restarts === 1 ? "replacement startup failed" : "loaded native work refuses idle shutdown"); },
    }), /keeps running the plan with shared-native.*`gateway service shared-native --disable --apply` when idle/);
    // The replacement still runs the native plan, so the plan file names it; no receipt was archived and nothing was started.
    assert.equal(JSON.parse(await readFile(servicePlanPath(f.state), "utf8")).sharedNativeExecutor, true);
    assert.equal(restarts, 3, "the migration restart and two rollback attempts");
    assert.ok(!f.calls.includes("archive")); assert.ok(!f.calls.includes("install"));
  } finally { await f.cleanup(); }
});

test("a failed native migration rolls back by the plan swap: the plan goes back first, the replacement restarts onto it, then the receipt is archived", async () => {
  const f = await fixture();
  try {
    const original = await readFile(servicePlanPath(f.state), "utf8"); const planAtRestart: Array<boolean | undefined> = []; let restarts = 0;
    await assert.rejects(enableSharedNative(f.configPath, true, { ...f.dependencies,
      restart: async () => {
        restarts++; planAtRestart.push(JSON.parse(await readFile(servicePlanPath(f.state), "utf8")).sharedNativeExecutor); f.calls.push("restart"); f.setPid(101 + restarts);
        if (restarts === 1) throw new Error("replacement startup failed");
      },
    }), /replacement startup failed/);
    // The rollback restart found the previous plan on disk, so launchd's relaunch cannot start the native host again.
    assert.deepEqual(planAtRestart, [true, undefined]);
    assert.equal(await readFile(servicePlanPath(f.state), "utf8"), original);
    assert.deepEqual(f.calls, ["maintenance", "verified-sdk", "restart", "restart", "archive"]);
  } finally { await f.cleanup(); }
});
