import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ServiceSupervisor, type NativeProbes } from "../service-supervisor.js";
import { serviceStatusPath } from "../service-plan.js";
import { shortFolder } from "./short-folder.js";
import { fixtureComponent, killFixturesAfterTests } from "./supervisor-fixture.js";

killFixturesAfterTests();

/**
 * `gateway native install` registers the relay while the service runs it paused as `not_registered`. The relay must start
 * within moments of the registration, not at the next five-minute re-check, or the machine's one remote-control slot is
 * left free for any engine that starts in between.
 */
interface Probes extends NativeProbes { registeredNow: boolean; binaries: string; appOpen: boolean; appAsked: number }
function probes(): Probes {
  const state: Probes = { registeredNow: false, binaries: "unregistered", appOpen: false, appAsked: 0,
    registered: async () => state.registeredNow, fingerprint: async () => state.binaries, appRunning: async () => { state.appAsked++; return state.appOpen; } };
  return state;
}
async function fixture(pollMs: number) {
  const folder = await shortFolder("gw-reg-poll-"); const relay = probes();
  const component = fixtureComponent(folder.directory, "native", "native", `require('node:fs').appendFileSync(${JSON.stringify(`${folder.directory}/starts`)}, 'x'); setInterval(()=>{},1000)`);
  const supervisor = new ServiceSupervisor({ version: 1, config: `${folder.directory}/gateway.json`, components: [component] }, folder.directory, 5, undefined, relay, 600_000, 1_800_000, {}, pollMs);
  const state = async () => (JSON.parse(await readFile(serviceStatusPath(folder.directory), "utf8")).components[0]) as { state: string };
  const starts = async () => (await readFile(`${folder.directory}/starts`, "utf8").catch(() => "")).length;
  return { relay, supervisor, state, starts, remove: async () => { await supervisor.stop(); await folder.remove(); } };
}
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) { if (await predicate()) return; await delay(20); }
  assert.fail("the supervisor did not reach the expected state");
}

test("a relay set aside as unregistered starts at once when the registration appears, long before the re-check", async () => {
  const f = await fixture(20);
  try {
    await f.supervisor.start();
    assert.equal((await f.state()).state, "paused");
    await delay(100);
    assert.equal(await f.starts(), 0, "nothing changed, nothing started");
    f.relay.registeredNow = true; f.relay.binaries = "registered";
    await until(async () => await f.starts() === 1 && (await f.state()).state === "running");
  } finally { await f.remove(); }
});

test("an open ChatGPT app is asked about once per registration change, not on every poll", async () => {
  const f = await fixture(20);
  try {
    await f.supervisor.start();
    f.relay.appOpen = true; f.relay.registeredNow = true; f.relay.binaries = "registered";
    await until(async () => f.relay.appAsked >= 1);
    await delay(200);
    assert.equal(f.relay.appAsked, 1);
    assert.equal(await f.starts(), 0, "the relay never competes with the open app");
    assert.equal((await f.state()).state, "paused");
  } finally { await f.remove(); }
});

test("the service records the last time the relay was connected, ignoring a status left by an earlier run and a status that only changes", async () => {
  const folder = await shortFolder("gw-reg-seen-"); const home = `${folder.directory}/relay-home`; await mkdir(home);
  const status = (value: string) => writeFile(`${home}/status.json`, JSON.stringify({ status: value }));
  // A `connected` from an earlier run of the relay: older than this start, so it is not this run's connection.
  await status("connected"); const old = new Date(Date.now() - 3_600_000); await utimes(`${home}/status.json`, old, old);
  const component = fixtureComponent(folder.directory, "native", "native", "setInterval(()=>{},1000)");
  component.args.push("--", "--relay-home", home);
  const probes = { registered: async () => true, fingerprint: async () => "same", appRunning: async () => false };
  const supervisor = new ServiceSupervisor({ version: 1, config: `${folder.directory}/gateway.json`, components: [component] }, folder.directory, 5, undefined, probes, 600_000, 1_800_000, {}, 20);
  // The snapshot is published every five seconds; a test asks for it now.
  const read = async () => { await (supervisor as unknown as { publish(): Promise<void> }).publish(); return (JSON.parse(await readFile(serviceStatusPath(folder.directory), "utf8")).components[0]) as { state: string; startedAt?: string; lastConnectedAt?: string }; };
  try {
    await supervisor.start();
    await until(async () => (await read()).state === "running");
    await delay(200);
    const running = await read();
    assert.ok(running.startedAt, "the snapshot says when the relay started");
    assert.equal(running.lastConnectedAt, undefined, "an old status says nothing about this run");
    await status("connecting"); await delay(150);
    assert.equal((await read()).lastConnectedAt, undefined, "a changing status is not a connection");
    await status("connected");
    await until(async () => (await read()).lastConnectedAt !== undefined);
    const connected = (await read()).lastConnectedAt!;
    await status("errored"); await delay(200); await status("connecting"); await delay(200);
    assert.equal(Date.parse((await read()).lastConnectedAt!) - Date.parse(connected) < 1000, true, "it stopped moving once the relay stopped being connected");
  } finally { await supervisor.stop(); await folder.remove(); }
});
