import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes, type SupervisorHealing } from "../service-supervisor.js";
import type { ServicePlan } from "../service-plan.js";
import type { ReleaseState } from "../self-update.js";
import type { QuietStop } from "../execution-host.js";
import { writePrivateJson } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";

killFixturesAfterTests();
// A long grace and quiet time, so that only the urgent rule can move the service inside a test. Each test sets the clocks it needs
// before its supervisor starts, because the watcher reads them then (production: 60 s checks, 15 min grace, 5 min quiet, 10 s urgent).
process.env.GATEWAY_UPGRADE_GRACE_MS = "3600000"; process.env.GATEWAY_UPGRADE_QUIET_MS = "300000";
const clocks = (checkMs: number, urgentMs: number) => { process.env.GATEWAY_UPGRADE_CHECK_MS = String(checkMs); process.env.GATEWAY_UPGRADE_URGENT_MS = String(urgentMs); };

async function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1500; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail(`the supervisor never reached: ${what}`);
}
async function folder(prefix: string) {
  const made = await shortFolder(prefix); const directory = made.directory; const config = join(directory, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3459, clientOnly: true, stateDirectory: directory, providers: [] });
  configureTelemetry(directory, "test");
  const events = async (name: string) => { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 600_000)).filter(event => event.event === name); };
  const remove = async () => { await flushTelemetry(); await killFixtures(directory); await made.remove(); };
  return { directory, config, events, remove };
}
function plan(f: { directory: string; config: string }, busy = false): ServicePlan {
  const marker = JSON.stringify(join(f.directory, "sigusr2"));
  const inference = fixtureComponent(f.directory, "inference", "inference", `process.on('SIGUSR2',()=>{require('node:fs').appendFileSync(${marker},'x');${busy ? "" : "process.exit(0);"}}); setInterval(()=>{},1000)`);
  const relay = fixtureComponent(f.directory, "native", "native", "setInterval(()=>{},1000)");
  relay.args.push("--", "--daemon", "--codex", join(f.directory, "codex"), "--native-home", join(f.directory, "native-home"), "--relay-home", join(f.directory, "relay-home"));
  return { version: 1, config: f.config, sharedExecutors: true, components: [inference, relay] };
}
const signals = async (directory: string) => (await readFile(join(directory, "sigusr2"), "utf8").catch(() => "")).length;
/**
 * A host stand-in. The quiet check answers like the real one: a running turn waits, a turn that ended less than the asked quiet
 * time ago waits, and anything else is quiet. `skewed` names the releases whose newer adapter the host has refused.
 */
function host(state: { running: () => boolean; endedAgoMs: () => number; skewed: () => string[] }) {
  const calls = { strict: 0, quiet: [] as number[], resumes: 0, closes: 0, asked: [] as string[], onSkewIdle: undefined as ((release: string) => void) | undefined };
  const start = async (options?: { onSkewIdle?: (release: string) => void }) => {
    calls.onSkewIdle = options?.onSkewIdle;
    return {
    close: async () => { calls.closes++; },
    prepareStop: async () => { calls.strict++; return false; },
    prepareQuietStop: async (quietMs?: number): Promise<QuietStop> => {
      calls.quiet.push(quietMs ?? -1);
      if (state.running()) return { wait: "running" };
      if (state.endedAgoMs() < (quietMs ?? 0)) return { wait: "recent_turn" };
      return { loadedChats: 2 };
    },
    skewRefused: (release: string) => { calls.asked.push(release); return state.skewed().includes(release); },
    resume: () => { calls.resumes++; },
    };
  };
  return { calls, start: start as never };
}
const unregistered: NativeProbes = { registered: async () => false, fingerprint: async () => "same", appRunning: async () => false };
const healing = (release: ReleaseState): Partial<SupervisorHealing> => ({ watchKick: () => () => {}, hostProbeMs: 3_600_000, healthSchedule: () => () => {}, releaseState: () => ({ ...release }) });

test("a newer adapter refused by this host moves the service at once when no turn runs, even if one ended seconds ago", { timeout: 30000 }, async () => {
  clocks(60_000, 30);
  const f = await folder("gws-urgent-"); const release = { running: "0.4.4", installed: "0.4.4" };
  const stand = host({ running: () => false, endedAgoMs: () => 3000, skewed: () => ["0.4.5"] });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  try {
    await supervisor.start(); const installedAt = performance.now(); release.installed = "0.4.5";
    await supervisor.stopped;
    assert.ok(performance.now() - installedAt < 5000, "no 15 minute grace and no minute-long check: the urgent tick moved it");
    assert.deepEqual(stand.calls.quiet, [0], "the quiet check asked for no quiet time, so the turn that ended 3 s ago did not hold it back");
    assert.equal(stand.calls.strict, 0, "the idle check is a subset of the urgent one and is not tried first");
    assert.equal(await signals(f.directory), 1, "inference was still asked through its own idle guard");
    assert.equal(stand.calls.closes, 1);
    await until(async () => (await f.events("self_upgrade")).length === 1, "the upgrade event");
    const [upgrade] = await f.events("self_upgrade");
    assert.deepEqual({ component: upgrade.component, from: upgrade.from, to: upgrade.to, mode: upgrade.mode, loadedChats: upgrade.loadedChats },
      { component: "service", from: "0.4.4", to: "0.4.5", mode: "skew", loadedChats: 2 });
  } finally { await supervisor.stop(); await f.remove(); }
});

test("an urgent move is tried every urgent interval, never stops a running turn, and goes through once the turn has ended", { timeout: 30000 }, async () => {
  clocks(60_000, 30);
  const f = await folder("gws-running-"); const release = { running: "0.4.4", installed: "0.4.5" }; let running = true;
  const stand = host({ running: () => running, endedAgoMs: () => 0, skewed: () => ["0.4.5"] });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  const internals = supervisor as unknown as { stopping: boolean };
  try {
    await supervisor.start();
    await until(() => stand.calls.quiet.length >= 5, "five urgent attempts while the turn runs");
    assert.equal(internals.stopping, false, "a running turn is never stopped");
    assert.equal(await signals(f.directory), 0, "inference was never asked to exit while a turn ran");
    assert.equal(stand.calls.closes, 0);
    assert.equal(stand.calls.resumes, 0, "a host that was not quiet never closed its gate, so there was nothing to reopen");
    assert.deepEqual((await f.events("self_upgrade_waiting")).map(event => [event.reason, event.to]), [["running", "0.4.5"]], "the wait is logged once");
    assert.deepEqual(await f.events("self_upgrade"), []);
    running = false;
    await supervisor.stopped;
    await until(async () => (await f.events("self_upgrade")).length === 1, "the upgrade event");
    assert.equal((await f.events("self_upgrade"))[0].mode, "skew");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("a refused SDK that is not the pending release's does not make the move urgent", { timeout: 30000 }, async () => {
  clocks(20, 30);
  // The host refused an adapter of 0.4.5, an earlier pending release; 0.4.6 is the one installed now.
  const f = await folder("gws-other-"); const release = { running: "0.4.4", installed: "0.4.6" };
  const stand = host({ running: () => false, endedAgoMs: () => 3000, skewed: () => ["0.4.5"] });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  const internals = supervisor as unknown as { stopping: boolean };
  try {
    await supervisor.start();
    await until(() => stand.calls.asked.length >= 5 && stand.calls.strict >= 2, "several checks");
    await delay(150);
    assert.deepEqual(stand.calls.quiet, [], "the quiet rule waits for its grace as before");
    assert.equal(internals.stopping, false); assert.deepEqual(await f.events("self_upgrade"), []);
    assert.ok(stand.calls.asked.every(release => release === "0.4.6"), "the host was asked about the pending release, not an earlier one");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("without any refused adapter the quiet rule keeps its grace and quiet time", { timeout: 30000 }, async () => {
  clocks(20, 30);
  const f = await folder("gws-calm-"); const release = { running: "0.4.4", installed: "0.4.5" };
  const stand = host({ running: () => false, endedAgoMs: () => 3000, skewed: () => [] });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  try {
    await supervisor.start();
    await until(() => stand.calls.strict >= 3, "several idle attempts");
    assert.deepEqual(stand.calls.quiet, []); assert.deepEqual(await f.events("self_upgrade"), []);
  } finally { await supervisor.stop(); await f.remove(); }
});

test("an urgent move still goes through inference's own idle guard", { timeout: 30000 }, async () => {
  clocks(60_000, 30);
  const f = await folder("gws-busy-"); const release = { running: "0.4.4", installed: "0.4.5" };
  const stand = host({ running: () => false, endedAgoMs: () => 0, skewed: () => ["0.4.5"] });
  const supervisor = new ServiceSupervisor(plan(f, true), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  const internals = supervisor as unknown as { stopping: boolean; restarting: boolean };
  try {
    await supervisor.start();
    await until(async () => await signals(f.directory) >= 2, "two attempts that inference refused");
    await until(() => !internals.restarting, "the refused attempt let go");
    assert.equal(internals.stopping, false, "the service kept running"); assert.equal(stand.calls.closes, 0);
    assert.deepEqual((await f.events("self_upgrade_waiting")).map(event => event.reason), ["inference_busy"]);
    assert.deepEqual(await f.events("self_upgrade"), []);
  } finally { await supervisor.stop(); await f.remove(); }
});

test("the host's no-turn-running signal tries an urgent move at once, between the slow ticks, and never stops a running turn", { timeout: 30000 }, async () => {
  clocks(60_000, 60_000); // Neither tick can act inside this test: only the host's signal can.
  const f = await folder("gws-signal-"); const release = { running: "0.4.4", installed: "0.4.5" }; let running = true;
  const stand = host({ running: () => running, endedAgoMs: () => 0, skewed: () => ["0.4.5"] });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  const internals = supervisor as unknown as { stopping: boolean };
  try {
    await supervisor.start();
    assert.equal(typeof stand.calls.onSkewIdle, "function", "the supervisor asks its host for the signal");
    await delay(150); assert.deepEqual(stand.calls.quiet, [], "no tick has acted");
    stand.calls.onSkewIdle!("0.4.5"); await until(() => stand.calls.quiet.length === 1, "an attempt on the signal");
    assert.equal(internals.stopping, false, "the turn that started since the signal is not stopped"); assert.equal(await signals(f.directory), 0);
    running = false; stand.calls.onSkewIdle!("0.4.5");
    await Promise.race([supervisor.stopped, delay(3000).then(() => assert.fail("the signal did not move the service"))]);
    assert.deepEqual(stand.calls.quiet, [0, 0], "through the quiet check with no quiet time, like every urgent attempt");
    await until(async () => (await f.events("self_upgrade")).length === 1, "the upgrade event");
    assert.equal((await f.events("self_upgrade"))[0].mode, "skew");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("a signal about a release the host has not refused an adapter of tries nothing", { timeout: 30000 }, async () => {
  clocks(60_000, 60_000);
  const f = await folder("gws-signal-no-"); const release = { running: "0.4.4", installed: "0.4.5" };
  const stand = host({ running: () => false, endedAgoMs: () => 3000, skewed: () => [] });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  try {
    await supervisor.start(); stand.calls.onSkewIdle!("0.4.5"); await delay(300);
    assert.deepEqual(stand.calls.quiet, []); assert.equal(stand.calls.strict, 0); assert.deepEqual(await f.events("self_upgrade"), []);
  } finally { await supervisor.stop(); await f.remove(); }
});

test("without urgency the urgent tick does nothing: no early idle move and no quiet attempts", { timeout: 30000 }, async () => {
  clocks(60_000, 30); // Only the urgent tick runs inside this test.
  const f = await folder("gws-tick-"); const release = { running: "0.4.4", installed: "0.4.5" };
  const stand = host({ running: () => false, endedAgoMs: () => 3000, skewed: () => [] });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  try {
    await supervisor.start(); await until(() => stand.calls.asked.length >= 5, "several urgent ticks that asked");
    assert.equal(stand.calls.strict, 0, "no idle attempt on a tick that is not urgent"); assert.deepEqual(stand.calls.quiet, []);
    assert.deepEqual(await f.events("self_upgrade"), []);
  } finally { await supervisor.stop(); await f.remove(); }
});
