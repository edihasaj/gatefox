import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes } from "../service-supervisor.js";
import { serviceStatusPath, type ServiceComponent } from "../service-plan.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";
import { shortFolder } from "./short-folder.js";

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

async function fixture(prefix: string, build: (directory: string) => ServiceComponent, supervisorProbes: NativeProbes, retryBaseMs = 5, recheckMs = 60000) {
  const folder = await shortFolder(prefix);
  configureTelemetry(folder.directory, "test");
  const supervisor = new ServiceSupervisor({ version: 1, config: `${folder.directory}/gateway.json`, components: [build(folder.directory)] }, folder.directory, retryBaseMs, undefined, supervisorProbes, recheckMs);
  const read = async () => (JSON.parse(await readFile(serviceStatusPath(folder.directory), "utf8")).components[0]) as { state: string; pausedReason?: string; pid?: number; restarts: number };
  const events = async (name: string) => (await readTelemetry(folder.directory, Date.now() - 60_000)).filter(event => event.event === name);
  const starts = async () => (await readFile(`${folder.directory}/starts`, "utf8").catch(() => "")).length;
  const remove = async () => { await supervisor.stop(); await flushTelemetry(); await folder.remove(); };
  return { directory: folder.directory, supervisor, read, events, starts, remove };
}

/** A child that notes every start in its own folder, then lives or dies at once with a non-zero code. */
function relayComponent(source: string): (directory: string) => ServiceComponent {
  return directory => ({ id: "native", kind: "native", command: process.execPath, args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(`${directory}/starts`)}, 'x'); ${source}`], log: `${directory}/native.log` });
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
  const failing = (id: ServiceComponent["kind"]) => ({ id, kind: id, command: process.execPath, args: ["-e", "process.exit(1)"], log: `${directory}/${id}.log` });
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
