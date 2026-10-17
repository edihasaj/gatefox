import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writePrivateJson } from "../config.js";
import { nativeRelayHome } from "../native-control.js";
import { nativePendingPath, nativeRegistrationClaimed, nativeRegistrationPath } from "../native-pause.js";
import { nativeExecutionEnvironment, nativeExecutionArgs } from "../native-execution-host-engine.js";
import { registerPlanRelay, unregisterPlanRelay, type PlanRelayDeps } from "../native-plan-registration.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import type { ServicePlan } from "../service-plan.js";

/**
 * Activating the native relay without racing the machine's one remote-control slot. The registration is written as pending
 * before anything else, idle SSH listeners that may hold the slot are retired, busy ones refuse the activation, and a failed
 * connection leaves the previous registration exactly as it was. Every process here is a fixture: no ChatGPT, no relay, no
 * launchd and no real state folder.
 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gw-activate-")); const state = join(directory, "state"); await mkdir(state, { mode: 0o700 });
  const configPath = join(directory, "gateway.json"), nativeHome = join(directory, "native"), codex = join(directory, "codex");
  const relayHome = join(dirname(nativeRelayHome(configPath, nativeHome)), "relay-under-test");
  const args = ["--native-home", nativeHome, "--relay-home", relayHome, "--gateway", "/usr/bin/true", "--gateway-config", configPath, "--codex", codex, "--daemon"];
  const plan: ServicePlan = { version: 1, config: configPath, components: [
    { id: "inference", kind: "inference", command: "/usr/bin/true", args: [], log: join(directory, "inference.log") },
    { id: "native", kind: "native", command: "/usr/bin/true", args, log: join(directory, "native.log") }] };
  configureTelemetry(state, "test");
  const exists = (path: string) => access(path).then(() => true, () => false);
  const events = async (name: string) => { await flushTelemetry(); return (await readTelemetry(state, Date.now() - 60_000)).filter(event => event.event === name); };
  return { directory, state, configPath, nativeHome, codex, relayHome, plan, exists, events, clean: () => rm(directory, { recursive: true, force: true }) };
}
const calm = (overrides: Partial<PlanRelayDeps> = {}): PlanRelayDeps => ({
  appRunning: async () => false, check: async () => {}, enable: async () => {}, clearHolders: async () => 0, ...overrides });

test("the registration is pending while the relay connects, and final once it did", async () => {
  const f = await fixture();
  try {
    const seen: Record<string, unknown> = {};
    await registerPlanRelay(f.state, f.plan, calm({
      clearHolders: async pendingAtMs => { seen.pendingBeforeClear = await f.exists(nativePendingPath(f.state)); seen.pendingAt = pendingAtMs; return 0; },
      enable: async () => {
        seen.pendingDuringEnable = JSON.parse(await readFile(nativePendingPath(f.state), "utf8"));
        seen.finalDuringEnable = await f.exists(nativeRegistrationPath(f.state));
      } }));
    const receipt = { registered: true, home: f.relayHome, nativeHome: f.nativeHome, codex: f.codex };
    assert.equal(seen.pendingBeforeClear, true, "listeners are retired only after a restarting listener would already stand down");
    assert.deepEqual(seen.pendingDuringEnable, receipt, "an adapter or listener that starts during --enable already sees the relay as registered");
    assert.equal(seen.finalDuringEnable, false, "the final registration waits for the connection");
    assert.deepEqual(JSON.parse(await readFile(nativeRegistrationPath(f.state), "utf8")), receipt);
    assert.equal(await f.exists(nativePendingPath(f.state)), false, "pending is gone once the registration is final");
  } finally { await f.clean(); }
});

test("a relay that fails to connect leaves the previous registration byte for byte, and no pending record", async () => {
  const f = await fixture();
  try {
    // An older registration, formatted the way no writer would, to prove the file is never rewritten.
    const previous = `{"registered":true,   "home":"${f.relayHome}-old","nativeHome":"${f.nativeHome}","codex":"${f.codex}" , "extra":1}\n`;
    await writeFile(nativeRegistrationPath(f.state), previous, { mode: 0o600 });
    for (const [message, reason] of [["Native relay did not connect within 45 seconds", "timeout"], ["Native relay stopped before connecting; check the Codex build and host sign-in", "exit"]] as const) {
      await assert.rejects(registerPlanRelay(f.state, f.plan, calm({ enable: async () => { throw new Error(message); } })), (error: Error) => error.message.startsWith(message) && /previous registration was kept/.test(error.message));
      assert.equal(await readFile(nativeRegistrationPath(f.state), "utf8"), previous, `${reason}: the previous file is untouched`);
      assert.equal(await f.exists(nativePendingPath(f.state)), false, `${reason}: the pending record is rolled back`);
    }
    assert.deepEqual((await f.events("native_activation_failed")).map(event => event.reason), ["timeout", "exit"]);
  } finally { await f.clean(); }
});

test("a busy listener refuses the activation: nothing connects, nothing is registered, pending is rolled back", async () => {
  const f = await fixture();
  try {
    let enabled = false;
    await assert.rejects(registerPlanRelay(f.state, f.plan, calm({ enable: async () => { enabled = true; }, clearHolders: async () => { throw new Error("An SSH session from another Mac is using this Mac; retry when it is idle"); } })),
      /retry when it is idle/);
    assert.equal(enabled, false);
    assert.equal(await f.exists(nativeRegistrationPath(f.state)), false);
    assert.equal(await f.exists(nativePendingPath(f.state)), false);
  } finally { await f.clean(); }
});

test("an open ChatGPT app still refuses before anything is written", async () => {
  const f = await fixture();
  try {
    let cleared = false;
    await assert.rejects(registerPlanRelay(f.state, f.plan, calm({ appRunning: async () => true, clearHolders: async () => { cleared = true; return 0; } })), /Quit ChatGPT normally/);
    assert.equal(cleared, false);
    assert.equal(await f.exists(nativePendingPath(f.state)), false);
    assert.equal(await f.exists(nativeRegistrationPath(f.state)), false);
    assert.deepEqual((await f.events("native_activation_refused")).map(event => event.reason), ["app_running"]);
  } finally { await f.clean(); }
});

test("the shared host's native engine stands down whenever the relay is registered, live or not", () => {
  assert.equal(nativeExecutionEnvironment("/native", true).CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, "1");
  assert.equal(nativeExecutionEnvironment("/native", false).CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED, undefined, "an unregistered Mac keeps today's behaviour");
  assert.throws(() => nativeExecutionArgs(["app-server", "--remote-control"], "/s", true), /conflicts with managed relay ownership/);
});

test("a Mac that already registered the relay clears no holders: its engines started standing down", async () => {
  const f = await fixture();
  try {
    await writePrivateJson(nativeRegistrationPath(f.state), { registered: true, home: `${f.relayHome}-old`, nativeHome: f.nativeHome, codex: f.codex });
    let cleared = false;
    await registerPlanRelay(f.state, f.plan, calm({ clearHolders: async () => { cleared = true; return 0; } }));
    assert.equal(cleared, false);
    assert.equal(JSON.parse(await readFile(nativeRegistrationPath(f.state), "utf8")).home, f.relayHome);
  } finally { await f.clean(); }
});

test("uninstall under a unified plan unregisters, keeps a backup of the old record and removes a pending one", async () => {
  const f = await fixture();
  try {
    const previous = `{"registered":true,"home":"${f.relayHome}","nativeHome":"${f.nativeHome}","codex":"${f.codex}"}\n`;
    await writeFile(nativeRegistrationPath(f.state), previous, { mode: 0o600 });
    await writeFile(nativePendingPath(f.state), "{}");
    const result = await unregisterPlanRelay(f.state, new Date("2026-10-18T01:02:03.456Z"));
    assert.equal(result.registered, false);
    assert.deepEqual(JSON.parse(await readFile(nativeRegistrationPath(f.state), "utf8")), { registered: false });
    const backups = (await readdir(f.state)).filter(name => name.startsWith("native-registration.json.pre-relay-off-"));
    assert.deepEqual(backups, ["native-registration.json.pre-relay-off-20261018T010203Z"]);
    assert.equal(await readFile(join(f.state, backups[0]), "utf8"), previous, "the backup is the old record, byte for byte");
    assert.equal(await f.exists(nativePendingPath(f.state)), false);
    assert.match(String(result.next), /gateway service restart/);
    // Nothing registered means nothing to undo, and no backup either.
    const again = await unregisterPlanRelay(f.state, new Date("2026-10-18T01:02:04Z"));
    assert.equal(again.unchanged, true); assert.equal((await readdir(f.state)).filter(name => name.includes("pre-relay-off")).length, 1);
  } finally { await f.clean(); }
});

test("once unregistered, an adapter or listener that starts keeps its engine's own remote control (the relay no longer owns it)", async () => {
  const f = await fixture();
  try {
    await writeFile(nativeRegistrationPath(f.state), `{"registered":true,"home":"${f.relayHome}","nativeHome":"${f.nativeHome}"}`);
    assert.equal(await nativeRegistrationClaimed(f.state), true);
    await unregisterPlanRelay(f.state);
    assert.equal(await nativeRegistrationClaimed(f.state), false);
  } finally { await f.clean(); }
});
