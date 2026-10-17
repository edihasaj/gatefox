import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes } from "../service-supervisor.js";
import { serviceStatusPath, type ServiceComponent } from "../service-plan.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixturesAfterTests } from "./supervisor-fixture.js";

killFixturesAfterTests();

/**
 * The relay is optional: a slot that cannot run is paused quietly instead of
 * restarted forever. These probes stand in for the three questions the
 * supervisor asks, so no test needs a ChatGPT app, a relay or a real binary.
 */
interface RelayProbes extends NativeProbes { registeredNow: boolean; binaries: string; appOpen: boolean }
function probes(options: { registered?: boolean; fingerprint?: string; appRunning?: boolean } = {}): RelayProbes {
  const state: RelayProbes = {
    registeredNow: options.registered ?? true, binaries: options.fingerprint ?? "one", appOpen: options.appRunning ?? false,
    registered: async () => state.registeredNow, fingerprint: async () => state.binaries, appRunning: async () => state.appOpen,
  };
  return state;
}

/** The supervisor's own clocks: the five minute re-check and the half-hourly blind retry, in ms. */
async function fixture(prefix: string, build: (directory: string) => ServiceComponent, supervisorProbes: NativeProbes, retryBaseMs = 5, recheckMs = 60000, blindRetryMs = 1800000) {
  const folder = await shortFolder(prefix);
  configureTelemetry(folder.directory, "test");
  const supervisor = new ServiceSupervisor({ version: 1, config: `${folder.directory}/gateway.json`, components: [build(folder.directory)] },
    folder.directory, retryBaseMs, undefined, supervisorProbes, recheckMs, blindRetryMs);
  const read = async () => (JSON.parse(await readFile(serviceStatusPath(folder.directory), "utf8")).components[0]) as { state: string; pausedReason?: string; pid?: number; restarts: number };
  const events = async (name: string) => (await readTelemetry(folder.directory, Date.now() - 60_000)).filter(event => event.event === name);
  const starts = async () => (await readFile(`${folder.directory}/starts`, "utf8").catch(() => "")).length;
  const remove = async () => { await supervisor.stop(); await flushTelemetry(); await folder.remove(); };
  return { directory: folder.directory, supervisor, read, events, starts, remove };
}

/** A child that notes every start in its own folder, then lives or dies at once with a non-zero code. */
function relayComponent(source: string): (directory: string) => ServiceComponent {
  return directory => fixtureComponent(directory, "native", "native", `require('node:fs').appendFileSync(${JSON.stringify(`${directory}/starts`)}, 'x'); ${source}`);
}
const alive = "setInterval(()=>{},1000)";
const dies = "process.exit(1)";
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail("the supervisor did not reach the expected state");
}

test("an unregistered relay is paused before it ever starts, once and quietly", async () => {
  const f = await fixture("gw-pause-unregistered-", relayComponent(alive), probes({ registered: false }));
  try {
    await f.supervisor.start();
    assert.deepEqual(await f.read().then(value => [value.state, value.pausedReason]), ["paused", "not_registered"]);
    assert.equal(await f.starts(), 0, "the relay was never spawned");
    assert.equal((await f.events("component_paused")).length, 1);
    assert.equal((await f.events("component_exit")).length, 0, "a relay that never ran exits never");
    assert.equal((await readFile(`${f.directory}/native.log`, "utf8").catch(() => "")), "", "pausing writes no log lines");
  } finally { await f.remove(); }
});

test("a relay that fails three times fast is paused and left alone", async () => {
  const f = await fixture("gw-pause-failing-", relayComponent(dies), probes({ registered: true }), 5);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    const state = await f.read();
    assert.equal(state.pausedReason, "failing");
    assert.equal(await f.starts(), 3, "exactly the three quick failures were tried");
    assert.equal((await f.events("component_paused")).length, 1);
    await delay(120);
    assert.equal(await f.starts(), 3, "a paused relay is not restarted on a timer");
    assert.equal((await f.events("component_exit")).length, 3, "no exit is reported after the pause");
  } finally { await f.remove(); }
});

test("a registered relay with new binaries starts again once, and only when ChatGPT is closed", async () => {
  const relay = probes({ registered: false });
  const f = await fixture("gw-pause-resume-", relayComponent(alive), relay);
  try {
    await f.supervisor.start();
    assert.equal((await f.read()).pausedReason, "not_registered");
    relay.registeredNow = true; relay.appOpen = true;
    await f.supervisor.resumePaused();
    assert.equal((await f.read()).state, "paused", "a running ChatGPT app keeps the relay paused");
    assert.equal(await f.starts(), 0);
    relay.appOpen = false;
    await f.supervisor.resumePaused();
    await until(async () => (await f.starts()) === 1);
    assert.equal((await f.read()).state, "running");
    assert.equal(await f.starts(), 1, "the relay started once");
    assert.equal((await f.events("component_resumed")).length, 1);
    await f.supervisor.resumePaused();
    assert.equal(await f.starts(), 1, "a running slot is not started again by a re-check");
    assert.equal((await f.events("component_resumed")).length, 1);
  } finally { await f.remove(); }
});

test("a failing relay waits for its binaries to change before it is tried again", async () => {
  const relay = probes({ registered: true, fingerprint: "old" });
  const f = await fixture("gw-pause-fingerprint-", relayComponent(dies), relay);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    await f.supervisor.resumePaused();
    assert.equal(await f.starts(), 3, "the same binaries are not a reason to retry");
    relay.binaries = "new";
    await f.supervisor.resumePaused();
    // The resumed child fails the same way, so the check is that the retry happened at all.
    await until(async () => (await f.starts()) >= 4);
    assert.equal((await f.events("component_resumed")).length, 1, "the retry was announced once");
    await f.supervisor.resumePaused();
    assert.equal((await f.events("component_resumed")).length, 1, "a paused slot is not started twice");
  } finally { await f.remove(); }
});

test("only the relay pauses: inference and tunnels keep their backoff", async () => {
  const directory = (await shortFolder("gw-pause-kinds-")).directory;
  const other = probes({ registered: true });
  const failing = (id: ServiceComponent["kind"]) => fixtureComponent(directory, id, id, "process.exit(1)");
  const supervisor = new ServiceSupervisor({ version: 1, config: `${directory}/gateway.json`, components: [failing("inference"), failing("tunnel")] }, directory, 5, undefined, other, 60000);
  try {
    await supervisor.start();
    const read = async () => (JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components) as Array<{ state: string; restarts: number }>;
    await until(async () => (await read()).every(value => value.restarts >= 3));
    const finals = await read();
    assert.equal(finals.length, 2);
    for (const value of finals) {
      assert.ok(value.state === "waiting" || value.state === "running", `both kept retrying with a backoff, got ${value.state}`);
      assert.ok(value.restarts >= 3, "both kept restarting");
    }
  } finally { await supervisor.stop(); }
});

test("a change made while the app is open is still a reason to restart after the app quits", async () => {
  const relay = probes({ registered: true, fingerprint: "old" });
  const f = await fixture("gw-pause-baseline-", relayComponent(dies), relay);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    assert.equal(await f.starts(), 3);
    relay.binaries = "new"; relay.appOpen = true;
    await f.supervisor.resumePaused();
    assert.equal((await f.read()).state, "paused", "the app being open holds the restart back");
    assert.equal(await f.starts(), 3, "nothing was started while the app was open");
    assert.equal((await f.events("component_resumed")).length, 0);
    relay.appOpen = false;
    await f.supervisor.resumePaused();
    await until(async () => (await f.starts()) === 4);
    assert.equal((await f.events("component_resumed")).length, 1, "the forgotten change was not forgotten");
  } finally { await f.remove(); }
});

test("a re-check that answers during shutdown leaves the relay stopped and says nothing", async () => {
  const relay = probes({ registered: true, fingerprint: "old" });
  let released = false;
  relay.appRunning = async () => { while (!released) await delay(5); return false; };
  const f = await fixture("gw-pause-race-", relayComponent(dies), relay);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    relay.binaries = "new";
    const checking = f.supervisor.resumePaused();
    await delay(20); // The re-check is now parked inside the app probe.
    await f.supervisor.stop();
    released = true;
    await checking;
    assert.equal((await f.read()).state, "stopped", "the shutdown won the race");
    assert.equal(await f.starts(), 3, "the paused relay was never started again");
    assert.equal((await f.events("component_resumed")).length, 0, "a relay that never restarted announced nothing");
  } finally { released = true; await f.supervisor.stop(); await f.remove(); }
});

test("a relay binary that cannot be found is set aside, not started once a minute forever", async () => {
  const missing = (directory: string): ServiceComponent => ({ id: "native", kind: "native", command: `${directory}/absent-relay-binary`, args: [], log: `${directory}/native.log` });
  const f = await fixture("gw-pause-absent-", missing, probes({ registered: true }));
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    const state = await f.read();
    assert.equal(state.pausedReason, "failing", "a process that never spawned is a failing relay");
    assert.ok(state.restarts >= 2, "it was tried a few times first");
    const exits = (await f.events("component_exit")).length;
    await delay(120);
    assert.equal((await f.events("component_exit")).length, exits, "a paused relay is never launched again");
  } finally { await f.remove(); }
});

test("a relay that cannot even open its log is set aside while the service keeps running", async () => {
  const directory = (await shortFolder("gw-pause-logdir-")).directory;
  const relay = probes({ registered: true });
  // The log path is a folder, so opening it fails: the relay cannot start here at all.
  const broken: ServiceComponent = { ...fixtureComponent(directory, "native", "native", alive), log: directory };
  const tunnel = fixtureComponent(directory, "tunnel", "tunnel", alive);
  const supervisor = new ServiceSupervisor({ version: 1, config: `${directory}/gateway.json`, components: [broken, tunnel] }, directory, 5, undefined, relay, 60000, 60000);
  const read = async () => (JSON.parse(await readFile(serviceStatusPath(directory), "utf8")).components) as Array<{ id: string; state: string; pausedReason?: string; pid?: number }>;
  try {
    await supervisor.start();
    await until(async () => (await read()).some(value => value.id === "native" && value.state === "paused"));
    const native = (await read()).find(value => value.id === "native")!;
    assert.equal(native.pausedReason, "failing");
    const other = (await read()).find(value => value.id === "tunnel")!;
    assert.equal(other.state, "running", "the service is alive and its other component is up");
    assert.ok(other.pid && other.pid > 0);
  } finally { await supervisor.stop(); }
});

test("an unchanged relay is tried again on the half-hourly blind retry, and a resumed one gets one strike", async () => {
  const relay = probes({ registered: true, fingerprint: "one" });
  const f = await fixture("gw-pause-blind-", relayComponent(dies), relay, 5, 60000, 30);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    assert.equal(await f.starts(), 3, "the three strikes were used up first");
    await delay(60);
    await f.supervisor.resumePaused();
    await until(async () => (await f.starts()) === 4);
    assert.equal((await f.events("component_resumed")).length, 1, "the retry was announced once");
    await until(async () => (await f.read()).state === "paused" && (await f.read()).pausedReason === "failing");
    assert.equal(await f.starts(), 4, "a resumed relay that dies at once is set aside again without a fresh budget");
    assert.equal((await f.events("component_paused")).length, 2, "each pause was announced once");
  } finally { await f.remove(); }
});

test("the re-check timer resumes a paused relay by itself", async () => {
  const relay = probes({ registered: false });
  const f = await fixture("gw-pause-timer-", relayComponent(alive), relay, 5, 20);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    relay.registeredNow = true;
    await until(async () => (await f.starts()) === 1);
    await until(async () => (await f.read()).state === "running");
    assert.equal((await f.events("component_resumed")).length, 1, "the timer started the relay with no help");
  } finally { await f.remove(); }
});

test("a re-check that cannot be answered leaves the relay paused, not the service stopped", async () => {
  const relay = probes({ registered: true });
  relay.appRunning = async () => { throw new Error("ps is not answering"); };
  const f = await fixture("gw-pause-recheck-", relayComponent(dies), relay);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    relay.binaries = "new";
    await f.supervisor.resumePaused();
    const state = await f.read();
    assert.deepEqual([state.state, state.pausedReason], ["paused", "failing"]);
    assert.equal((await f.events("component_resumed")).length, 0, "a question that was never answered started nothing");
    assert.equal((await f.events("component_paused")).length, 1, "the pause is still announced once");
    await f.supervisor.resumePaused();
    assert.equal((await f.events("component_paused")).length, 1, "an unanswered re-check never repeats the announcement");
    await delay(30);
    assert.ok((await readFile(serviceStatusPath(f.directory), "utf8")).includes('"paused"'), "the service kept publishing its own status");
  } finally { await f.remove(); }
});

test("a live relay never competes with an open app, however often the re-check runs", async () => {
  const relay = probes({ registered: false, fingerprint: "old", appRunning: true });
  const f = await fixture("gw-pause-appopen-", relayComponent(alive), relay, 5, 20);
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    relay.registeredNow = true; relay.binaries = "new";
    await delay(80); // Several re-check timers have run with the app open.
    assert.equal(await f.starts(), 0, "the relay stayed aside while ChatGPT was open");
    assert.equal((await f.read()).state, "paused");
    relay.appOpen = false;
    await until(async () => (await f.starts()) === 1);
    assert.equal((await f.events("component_resumed")).length, 1, "one resume when the app closes");
    await delay(80);
    assert.equal((await f.events("component_resumed")).length, 1, "a running relay is never resumed twice");
    assert.equal(await f.starts(), 1);
  } finally { await f.remove(); }
});

test("stopping a supervisor with a paused relay returns at once", async () => {
  const f = await fixture("gw-pause-stop-", relayComponent(alive), probes({ registered: false }));
  try {
    await f.supervisor.start();
    await until(async () => (await f.read()).state === "paused");
    const began = Date.now();
    await f.supervisor.stop();
    assert.ok(Date.now() - began < 1000, "nothing was waited for");
    assert.equal((await f.read()).state, "stopped");
  } finally { await f.supervisor.stop(); await f.remove(); }
});
