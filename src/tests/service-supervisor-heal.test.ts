import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes, type SupervisorHealing } from "../service-supervisor.js";
import { serviceStatusPath, type ServicePlan } from "../service-plan.js";
import { writePrivateJson } from "../config.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { exitReason, hostRetryDelayMs, statusWriteCode } from "../service-heal.js";
import type { HostProbeReason, HostProbeTarget } from "../service-host-probe.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixtures, killFixturesAfterTests } from "./supervisor-fixture.js";

killFixturesAfterTests();

/** Waits up to 30 s; a state that never comes fails the test, a loaded machine fails nothing. */
async function until(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 1500; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail(`the supervisor never reached: ${what}`);
}
/** A folder with a configuration whose state directory is the folder itself, and its own telemetry. */
async function folder(prefix: string) {
  const made = await shortFolder(prefix); const directory = made.directory;
  const config = join(directory, "gateway.json");
  await writePrivateJson(config, { version: 1, port: 3459, clientOnly: true, stateDirectory: directory, providers: [] });
  configureTelemetry(directory, "test");
  const events = async (name: string) => { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 600_000)).filter(event => event.event === name); };
  const status = async () => JSON.parse(await readFile(serviceStatusPath(directory), "utf8")) as { executionHost?: { state: string }; components: Array<{ id: string; state: string; pid?: number; pausedReason?: string }> };
  const remove = async () => { await flushTelemetry(); await killFixtures(directory); await made.remove(); };
  return { directory, config, events, status, remove };
}
/** A native slot for a shared-native plan: the plan reads `--codex` and `--native-home` from it. */
function relay(directory: string, source: string) {
  const component = fixtureComponent(directory, "native", "native", `require('node:fs').appendFileSync(${JSON.stringify(join(directory, "starts"))}, 'x'); ${source}`);
  component.args.push("--", "--daemon", "--codex", join(directory, "codex"), "--native-home", join(directory, "native-home"), "--relay-home", join(directory, "relay-home"));
  return component;
}
const starts = async (directory: string) => (await readFile(join(directory, "starts"), "utf8").catch(() => "")).length;
type FakeHost = { close(): Promise<void>; prepareStop(): Promise<boolean>; resume(): void };
/** A host stand-in: `idle` answers the idle check, and every start and close is counted. */
function hosts(options: { fail?: (attempt: number) => Error | undefined; idle?: () => boolean; gate?: () => Promise<void> | undefined } = {}) {
  const record = { starts: 0, closes: 0, owns: [] as boolean[], startedAt: [] as number[] };
  const start = async (startOptions: { nativeRelayOwnsRegistration?: boolean }): Promise<FakeHost> => {
    record.starts++; record.startedAt.push(performance.now()); record.owns.push(startOptions.nativeRelayOwnsRegistration === true);
    await options.gate?.();
    const failure = options.fail?.(record.starts); if (failure) throw failure;
    return { close: async () => { record.closes++; }, prepareStop: async () => options.idle?.() ?? true, resume: () => {} };
  };
  return { record, start: start as never };
}
const quiet: Partial<SupervisorHealing> = { watchKick: () => () => {}, hostProbeMs: 3_600_000, healthSchedule: () => () => {} };
const unregistered: NativeProbes = { registered: async () => false, fingerprint: async () => "same", appRunning: async () => false };

test("host start backoff is 1, 2, 5, 10 and 30 s, then 60 s, and every reason is a fixed word", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(failures => hostRetryDelayMs(failures)), [1000, 2000, 5000, 10000, 30000, 60000, 60000, 60000]);
  assert.equal(hostRetryDelayMs(3, 10), 50, "tests scale the steps");
  assert.deepEqual([exitReason(3, null), exitReason(null, "SIGKILL"), exitReason(null, "SIGNOPE" as NodeJS.Signals), exitReason(null, null)], ["exit_3", "signal_SIGKILL", "signal_other", "spawn_failed"]);
  assert.deepEqual([statusWriteCode(Object.assign(new Error("/private/path"), { code: "ENOSPC" })), statusWriteCode(new Error("no code")), statusWriteCode({ code: "a path /x" })], ["ENOSPC", "other", "other"]);
});

test("a status file that cannot be written never stops the service, and is reported at most once a minute", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const f = await folder("gwh-status-");
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [fixtureComponent(f.directory, "tunnel", "tunnel", "setInterval(()=>{},1000)")] }, f.directory, 5, undefined, undefined, undefined, undefined, quiet);
  const internals = supervisor as unknown as { stopping: boolean; slots: Array<{ child?: { pid?: number } }>; publish(): Promise<void> };
  const telemetryHome = await shortFolder("gwh-status-events-");
  try {
    await supervisor.start(); await until(async () => (await f.status()).components[0].state === "running", "a running tunnel");
    // Events go elsewhere: the state folder is the one that turns read-only.
    configureTelemetry(telemetryHome.directory, "test");
    await chmod(f.directory, 0o500);
    for (let round = 0; round < 2; round++) {
      const before = internals.slots[0].child?.pid; process.kill(before!, "SIGKILL");
      await until(() => !!internals.slots[0].child?.pid && internals.slots[0].child?.pid !== before, "the tunnel restarted with no status file");
    }
    await internals.publish(); await flushTelemetry();
    const failures = (await readTelemetry(telemetryHome.directory, Date.now() - 60_000)).filter(event => event.event === "status_write_failed");
    assert.deepEqual(failures.map(event => event.code), ["EACCES"], "one event for every failed write in the same minute");
    assert.equal(internals.stopping, false, "the service kept running");
    await chmod(f.directory, 0o700); await internals.publish();
    assert.equal((await f.status()).components[0].state, "running", "the next write lands again");
  } finally {
    await chmod(f.directory, 0o700); configureTelemetry(f.directory, "test");
    await supervisor.stop(); await telemetryHome.remove(); await f.remove();
  }
});

test("a failed host is started again at once on an adapter's kick, never twice inside the kick gap and never while one is starting", async () => {
  const f = await folder("gwh-kick-");
  let kick = () => {}; let failing = true; let release: () => void = () => {}; let gate: Promise<void> | undefined;
  const host = hosts({ fail: () => failing ? Object.assign(new Error("Execution SDK socket directory is missing"), { code: "ENOENT" }) : undefined, gate: () => gate });
  let probes = 0;
  const plan: ServicePlan = { version: 1, config: f.config, sharedExecutors: true, components: [relay(f.directory, "setInterval(()=>{},1000)")] };
  // A one-minute first backoff: every start below comes from a kick, not from the retry timer.
  const supervisor = new ServiceSupervisor(plan, f.directory, 60_000, host.start, unregistered, undefined, undefined, {
    ...quiet, kickGapMs: 300, watchKick: (_home, onKick) => { kick = onKick; return () => {}; }, probeHost: async () => { probes++; return undefined; } });
  try {
    await supervisor.start();
    assert.equal(host.record.starts, 1); assert.equal((await f.status()).executionHost?.state, "failed");
    const [failed] = await f.events("execution_host_failed");
    assert.equal(failed.reason, "sdk_dir_missing"); assert.equal(failed.failures, 1); assert.equal(failed.errorClass, undefined, "the turn classifier is not used");
    kick(); kick(); // Inside the gap after the first start: one start, when the gap ends.
    await until(() => host.record.starts === 2, "the kicked start");
    assert.ok(host.record.startedAt[1] - host.record.startedAt[0] >= 280, "the kicked start waited for the kick gap");
    await delay(400); assert.equal(host.record.starts, 2, "two kicks in one gap start the host once");
    // A kick while a start is in the air is dropped; the start settles on its own.
    gate = new Promise(resolve => { release = resolve; });
    kick(); await until(() => host.record.starts === 3, "the third start"); kick(); kick(); release(); gate = undefined;
    await delay(500); assert.equal(host.record.starts, 3, "no start was added while one was starting");
    failing = false; kick();
    await until(async () => (await f.status()).executionHost?.state === "running", "a running host");
    assert.deepEqual((await f.events("execution_host_recovered")).map(event => event.failures), [3]);
    // Kicked until the start that just settled has let go of its slot.
    await until(() => { kick(); return probes >= 1; }, "a kick to a running host probes it");
    assert.equal(host.record.starts, 4);
  } finally { release(); await supervisor.stop(); await f.remove(); }
});

test("a running host that fails two probes in a row is restarted only when idle, never inside the kick gap, and a passing probe clears it", async () => {
  const f = await folder("gwh-probe-");
  let idle = false; let verdict: HostProbeReason | undefined = "status_timeout"; const targets: HostProbeTarget[] = [];
  const host = hosts({ idle: () => idle });
  const plan: ServicePlan = { version: 1, config: f.config, sharedNativeExecutor: true, components: [relay(f.directory, "setInterval(()=>{},1000)")] };
  const supervisor = new ServiceSupervisor(plan, f.directory, 5, host.start, unregistered, undefined, undefined,
    { ...quiet, kickGapMs: 400, probeHost: async target => { targets.push(target); return verdict; } });
  try {
    await supervisor.start(); assert.equal((await f.status()).executionHost?.state, "running");
    assert.equal(targets.length, 0, "nothing is probed before the first tick");
    await supervisor.checkHost();
    assert.deepEqual(await f.events("execution_host_unhealthy"), [], "one slow answer can be a busy moment");
    await supervisor.checkHost(); await supervisor.checkHost();
    assert.deepEqual((await f.events("execution_host_unhealthy")).map(event => event.reason), ["status_timeout"], "reported once while it stays unhealthy");
    assert.equal(host.record.closes, 0, "a busy host is never restarted");
    assert.equal(targets[0].pid, process.pid); assert.equal(targets[0].codex, join(f.directory, "codex"), "a native host is checked against the app engine");
    verdict = undefined; await supervisor.checkHost();
    idle = true; await delay(450); await supervisor.checkHost();
    assert.equal(host.record.closes, 0, "a probe that passes again clears the restart");
    verdict = "socket_mismatch"; await supervisor.checkHost();
    await delay(50); assert.equal(host.record.closes, 0, "the pass in between started the count again");
    await supervisor.checkHost();
    await until(() => host.record.starts === 2, "the restarted host");
    assert.equal(host.record.closes, 1);
    assert.deepEqual((await f.events("execution_host_unhealthy")).map(event => event.reason), ["status_timeout", "socket_mismatch"]);
    assert.deepEqual((await f.events("execution_host_restarted")).map(event => event.reason), ["socket_mismatch"]);
    await until(async () => (await f.status()).executionHost?.state === "running", "the new host running");
    // Right after that start the gap holds the next restart back, then lets it through.
    await supervisor.checkHost(); await supervisor.checkHost(); assert.equal(host.record.closes, 1, "no restart inside the kick gap");
    await until(async () => { await supervisor.checkHost(); return host.record.closes === 2; }, "the restart once the gap ended");
    assert.ok(host.record.startedAt[2] - host.record.startedAt[1] >= 380, "two restarts are a kick gap apart");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("a probe that is out holds an idle restart back, and its verdict restarts nothing more (stale-probe regression)", async () => {
  const f = await folder("gwh-stale-");
  let idle = false; let gated = false; let release: (reason: HostProbeReason | undefined) => void = () => {};
  const host = hosts({ idle: () => idle });
  const probeHost = async () => gated ? new Promise<HostProbeReason | undefined>(resolve => { release = resolve; }) : undefined;
  const registered: NativeProbes = { registered: async () => true, fingerprint: async () => "same", appRunning: async () => false };
  const plan: ServicePlan = { version: 1, config: f.config, sharedNativeExecutor: true, components: [relay(f.directory, "process.exit(1)")] };
  // The relay re-check, which asks again for a refused host restart, runs every 150 ms; the probe tick never does.
  const supervisor = new ServiceSupervisor(plan, f.directory, 5, host.start, registered, 150, 3_600_000, { ...quiet, kickGapMs: 0, probeHost });
  const internals = supervisor as unknown as { hostGeneration: number };
  try {
    await supervisor.start();
    await until(async () => (await f.status()).components[0].state === "paused", "the relay set aside");
    assert.deepEqual(host.record.owns, [true], "the first host took the relay's registration, so it is due a restart once idle");
    // A probe of the first host is out when that host turns idle.
    gated = true; const probing = supervisor.checkHost();
    idle = true; await delay(500);
    assert.equal(host.record.starts, 1, "no restart while a probe is out");
    release("status_failed"); await probing;
    await until(() => host.record.starts === 2, "the restart once the probe ended");
    await delay(500);
    assert.equal(host.record.starts, 2, "the probe's verdict did not restart the new host"); assert.equal(host.record.closes, 1);
    assert.deepEqual((await f.events("execution_host_restarted")).map(event => event.reason), ["relay_paused"]);
    // Two failed verdicts in a row, each about a host that another start replaced while it was out: both are dropped.
    for (let round = 0; round < 2; round++) { const stale = supervisor.checkHost(); internals.hostGeneration++; release("status_failed"); await stale; }
    await delay(300);
    assert.deepEqual(await f.events("execution_host_unhealthy"), [], "a verdict about a replaced host never counts");
    assert.equal(host.record.starts, 2);
  } finally { gated = false; release(undefined); await supervisor.stop(); await f.remove(); }
});

test("a host that fails to close in an idle restart stays referenced, and the whole service restarts when idle instead of looping starts", async () => {
  const f = await folder("gwh-close-");
  let verdict: HostProbeReason | undefined; const record = { starts: 0, closes: 0 };
  const start = async () => { record.starts++; return { close: async () => { record.closes++; throw new Error("An execution generation did not stop; its ownership record was preserved"); }, prepareStop: async () => true, resume: () => {} }; };
  // Inference is busy for the first idle restart and accepts the second.
  const signals = join(f.directory, "usr2");
  const inference = fixtureComponent(f.directory, "inference", "inference", `const fs = require('node:fs'); process.on('SIGUSR2', () => { fs.appendFileSync(${JSON.stringify(signals)}, 'x'); if (fs.readFileSync(${JSON.stringify(signals)}, 'utf8').length >= 2) process.exit(0); }); setInterval(()=>{},1000);`);
  const plan: ServicePlan = { version: 1, config: f.config, sharedExecutors: true, components: [inference, relay(f.directory, "setInterval(()=>{},1000)")] };
  const supervisor = new ServiceSupervisor(plan, f.directory, 5, start as never, unregistered, undefined, undefined, { ...quiet, kickGapMs: 0, hostProbeMs: 200, probeHost: async () => verdict });
  let stopped = false; void supervisor.stopped.then(() => { stopped = true; });
  try {
    await supervisor.start();
    await until(async () => (await f.status()).components.some(component => component.id === "inference" && component.state === "running"), "inference running");
    verdict = "socket_mismatch";
    await until(() => record.closes === 1, "the idle restart's close");
    await delay(1000);
    assert.equal(record.starts, 1, "no start in a process whose host receipt still names it");
    await until(() => stopped, "the whole-service restart once inference was idle");
    assert.equal((await readFile(signals, "utf8")).length, 2, "the busy refusal was asked again at the next tick");
    assert.equal(record.starts, 1); assert.equal(record.closes, 2, "the stop closed the host it still referenced");
    await assert.rejects(supervisor.stop(), /did not stop/, "the stop reports the failure, so the process exits and launchd starts it anew");
    assert.equal((await f.status()).executionHost?.state, "failed");
    assert.deepEqual((await f.events("execution_host_failed")).map(event => event.reason), ["close_failed"]);
  } finally { await supervisor.stop().catch(() => undefined); await f.remove(); }
});

test("a stop while the host start waits on the relay question starts no host", async () => {
  const f = await folder("gwh-d1-");
  let release: () => void = () => {}; let asked = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const probes: NativeProbes = { registered: async () => { asked = true; await gate; return true; }, fingerprint: async () => "same", appRunning: async () => false };
  const host = hosts();
  const plan: ServicePlan = { version: 1, config: f.config, sharedNativeExecutor: true, components: [relay(f.directory, "setInterval(()=>{},1000)")] };
  const supervisor = new ServiceSupervisor(plan, f.directory, 5, host.start, probes, undefined, undefined, quiet);
  try {
    const started = supervisor.start().catch(() => undefined);
    await until(() => asked, "the relay question");
    const stopping = supervisor.stop(); release();
    await stopping; await started;
    assert.equal(host.record.starts, 0, "the host never started");
    assert.equal(await starts(f.directory), 0, "nor did the relay");
  } finally { release(); await supervisor.stop(); await f.remove(); }
});

test("a relay set aside after the host took its registration gets only the host restarted, and a busy host waits for the re-check", async () => {
  for (const busyFirst of [false, true]) {
    const f = await folder("gwh-d2-");
    let idle = !busyFirst;
    const host = hosts({ idle: () => idle });
    const registered: NativeProbes = { registered: async () => true, fingerprint: async () => "same", appRunning: async () => false };
    const plan: ServicePlan = { version: 1, config: f.config, sharedNativeExecutor: true, components: [relay(f.directory, "process.exit(1)")] };
    // The re-check runs every 200 ms here; the probe never does, so only the re-check can retry a refused restart.
    const supervisor = new ServiceSupervisor(plan, f.directory, 5, host.start, registered, 200, 3_600_000, { ...quiet, kickGapMs: 0 });
    try {
      await supervisor.start();
      await until(async () => (await f.status()).components[0].state === "paused", "the relay set aside");
      if (busyFirst) {
        await delay(100); assert.equal(host.record.starts, 1, "a busy host keeps running");
        idle = true;
      }
      await until(() => host.record.starts === 2, "the host started again");
      assert.deepEqual(host.record.owns, [true, false], "the relay was live for the first start and set aside for the second");
      assert.equal(host.record.closes, 1);
      assert.deepEqual((await f.events("execution_host_restarted")).map(event => event.reason), ["relay_paused"]);
      assert.equal(await starts(f.directory), 3, "the relay itself was not started again");
      await delay(450); assert.equal(host.record.starts, 2, "the restart does not repeat");
    } finally { await supervisor.stop(); await f.remove(); }
  }
});

test("inference and tunnels that keep exiting fast are reported once per streak and keep their backoff", async () => {
  const f = await folder("gwh-streak-");
  const mode = join(f.directory, "mode"); await writeFile(mode, "die");
  const flaky = (id: string, kind: "inference" | "tunnel", death: string) => fixtureComponent(f.directory, id, kind,
    `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(join(f.directory, id + ".starts"))}, 'x'); if (fs.readFileSync(${JSON.stringify(mode)}, 'utf8') === 'die') { ${death} } else setInterval(()=>{},1000);`);
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [flaky("tunnel", "tunnel", "process.exit(3)"), flaky("inference", "inference", "process.kill(process.pid, 'SIGKILL')")] },
    f.directory, 2, undefined, undefined, undefined, undefined, quiet);
  const internals = supervisor as unknown as { slots: Array<{ child?: { pid?: number }; startedAt: number; state: { state: string } }> };
  const count = async (id: string) => (await readFile(join(f.directory, id + ".starts"), "utf8").catch(() => "")).length;
  try {
    await supervisor.start();
    await until(async () => await count("tunnel") >= 7 && await count("inference") >= 7, "seven starts of each");
    const first = await f.events("component_failing");
    assert.deepEqual(first.map(event => [event.component, event.kind, event.failures, event.reason]).sort(), [["inference", "inference", 5, "signal_SIGKILL"], ["tunnel", "tunnel", 5, "exit_3"]]);
    assert.ok(internals.slots.every(slot => slot.state.state !== "paused"), "the components are not set aside");
    // A run of a minute or more ends the streak, and the next five quick exits are a new one.
    // A child counts as running once it noted its start: a pid alone can still be a process that has not read the mode yet.
    const dying = await count("tunnel"); await writeFile(mode, "live");
    await until(async () => await count("tunnel") > dying && !!internals.slots[0].child?.pid, "the tunnel running");
    const before = await count("tunnel"); await writeFile(mode, "die");
    internals.slots[0].startedAt -= 61_000; process.kill(internals.slots[0].child!.pid!, "SIGTERM");
    await until(async () => await count("tunnel") >= before + 6, "a second streak");
    assert.equal((await f.events("component_failing")).filter(event => event.component === "tunnel").length, 2);
  } finally { await supervisor.stop(); await f.remove(); }
});

test("a resumed relay that ran past its first minute gets three strikes again", async () => {
  const f = await folder("gwh-d3-");
  const mode = join(f.directory, "mode"); await writeFile(mode, "die"); let binaries = "one";
  const probes: NativeProbes = { registered: async () => true, fingerprint: async () => binaries, appRunning: async () => false };
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [relay(f.directory, `if (require('node:fs').readFileSync(${JSON.stringify(mode)}, 'utf8') === 'die') process.exit(1); setInterval(()=>{},1000);`)] },
    f.directory, 2, undefined, probes, 3_600_000, 3_600_000, quiet);
  const internals = supervisor as unknown as { slots: Array<{ child?: { pid?: number }; startedAt: number }> };
  try {
    await supervisor.start();
    await until(async () => (await f.status()).components[0].state === "paused", "three strikes");
    assert.equal(await starts(f.directory), 3);
    await writeFile(mode, "live"); binaries = "two"; await supervisor.resumePaused();
    await until(async () => await starts(f.directory) === 4 && !!internals.slots[0].child?.pid, "the resumed relay running");
    // It runs past its first minute, then starts failing again: that is three new strikes, not one.
    await writeFile(mode, "die"); internals.slots[0].startedAt -= 61_000; process.kill(internals.slots[0].child!.pid!, "SIGTERM");
    await until(async () => (await f.status()).components[0].state === "paused", "set aside again");
    assert.equal(await starts(f.directory), 4 + 3, "one healthy run, then three quick failures");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("the watchdog heartbeat runs while the service does, for the plan's configuration, and stops with it", async () => {
  const f = await folder("gwh-health-");
  const calls: string[][] = []; let stops = 0;
  const supervisor = new ServiceSupervisor({ version: 1, config: f.config, components: [fixtureComponent(f.directory, "tunnel", "tunnel", "setInterval(()=>{},1000)")] }, f.directory, 5, undefined, undefined, undefined, undefined,
    { ...quiet, healthSchedule: (state, config) => { calls.push([state, config]); return () => { stops++; }; } });
  try {
    await supervisor.start();
    assert.deepEqual(calls, [[f.directory, f.config]]);
    await supervisor.stop(); await supervisor.stop();
    assert.equal(stops, 1, "stopping the service stops the schedule, and with it a check that is still running");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("kicks on a failure a retry cannot fix buy one extra start per backoff step, never a loop", async () => {
  const f = await folder("gwh-kick-live-");
  let kick: () => unknown = () => {};
  // Another live owner holds the folder: the same answer however often it is asked.
  const host = hosts({ fail: () => new Error("An execution host already owns this configuration") });
  const plan: ServicePlan = { version: 1, config: f.config, sharedExecutors: true, components: [relay(f.directory, "setInterval(()=>{},1000)")] };
  // Backoff steps of 0.4, 0.8 and 2 s: the second start is a kick's, the third the timer's, the fourth a kick's again.
  const supervisor = new ServiceSupervisor(plan, f.directory, 400, host.start, unregistered, undefined, undefined,
    { ...quiet, kickGapMs: 50, watchKick: (_home, onKick) => { kick = onKick; return () => {}; } });
  try {
    await supervisor.start(); const began = performance.now();
    while (performance.now() - began < 1500) { kick(); await delay(10); }
    assert.equal(host.record.starts, 4, `one kicked start per backoff step (${host.record.starts} starts)`);
    const [, kicked, timed] = host.record.startedAt;
    assert.ok(timed - kicked >= 700, "the start after a kicked one waited for its backoff");
    assert.ok((await f.events("execution_host_failed")).every(event => event.reason === "live_owner"));
  } finally { await supervisor.stop(); await f.remove(); }
});

test("a kick handler that rejects is dropped by the watcher, which keeps watching", async () => {
  const made = await shortFolder("gwh-kick-reject-"); const { requestHostKick, watchHostKick } = await import("../execution-host-kick.js");
  await chmod(made.directory, 0o700);
  const unhandled: unknown[] = []; const note = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", note);
  let calls = 0;
  const stop = watchHostKick(made.directory, async () => { calls++; throw new Error("handler failed"); }, { intervalMs: 10, minimumGapMs: 0 });
  try {
    await requestHostKick(made.directory); await until(() => calls === 1, "the first kick");
    await delay(30); await requestHostKick(made.directory); await until(() => calls === 2, "the next kick after a rejection");
    await delay(50); assert.deepEqual(unhandled, []);
  } finally { stop(); process.off("unhandledRejection", note); await made.remove(); }
});
