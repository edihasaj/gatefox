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
// The test hooks for the upgrade clocks (production uses 60 s checks, a 15 min grace and 5 min of quiet).
process.env.GATEWAY_UPGRADE_CHECK_MS = "20"; process.env.GATEWAY_UPGRADE_GRACE_MS = "400"; process.env.GATEWAY_UPGRADE_QUIET_MS = "1234";

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
/** A shared-executor plan: inference (`busy` ignores the idle restart's SIGUSR2) and a relay slot that names the SDK and native home. */
function plan(f: { directory: string; config: string }, busy = false): ServicePlan {
  const marker = JSON.stringify(join(f.directory, "sigusr2"));
  const inference = fixtureComponent(f.directory, "inference", "inference", `process.on('SIGUSR2',()=>{require('node:fs').appendFileSync(${marker},'x');${busy ? "" : "process.exit(0);"}}); setInterval(()=>{},1000)`);
  const relay = fixtureComponent(f.directory, "native", "native", "setInterval(()=>{},1000)");
  relay.args.push("--", "--daemon", "--codex", join(f.directory, "codex"), "--native-home", join(f.directory, "native-home"), "--relay-home", join(f.directory, "relay-home"));
  return { version: 1, config: f.config, sharedExecutors: true, components: [inference, relay] };
}
const signals = async (directory: string) => (await readFile(join(directory, "sigusr2"), "utf8").catch(() => "")).length;
/** A host stand-in: the strict check answers `idle`, the quiet check `quiet` (after `gate`, when set); every call is counted. */
function host(options: { idle?: () => boolean; quiet?: () => QuietStop | undefined; gate?: () => Promise<void> | undefined } = {}) {
  const calls = { strict: 0, quiet: [] as Array<{ quietMs?: number; atMs: number }>, resumes: 0, closes: 0 };
  const start = async () => ({
    close: async () => { calls.closes++; },
    prepareStop: async () => { calls.strict++; return options.idle?.() ?? false; },
    prepareQuietStop: async (quietMs?: number) => { calls.quiet.push({ quietMs, atMs: performance.now() }); await options.gate?.(); return options.quiet?.(); },
    resume: () => { calls.resumes++; },
  });
  return { calls, start: start as never };
}
const unregistered: NativeProbes = { registered: async () => false, fingerprint: async () => "same", appRunning: async () => false };
const healing = (release: ReleaseState): Partial<SupervisorHealing> => ({ watchKick: () => () => {}, hostProbeMs: 3_600_000, healthSchedule: () => () => {}, releaseState: () => ({ ...release }) });

test("an upgrade that the idle restart keeps refusing restarts when quiet once the grace has passed", { timeout: 30000 }, async () => {
  const f = await folder("gwu-quiet-"); const release = { running: "0.4.4", installed: "0.4.4" };
  const stand = host({ quiet: () => ({ loadedChats: 2 }) });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  try {
    await supervisor.start();
    await delay(100); assert.equal(stand.calls.strict, 0, "nothing happens while the running release is the installed one");
    const installedAt = performance.now(); release.installed = "0.4.5";
    await supervisor.stopped;
    assert.ok(stand.calls.strict >= 2, "the idle restart was tried first, and again at each attempt");
    assert.ok(stand.calls.quiet.length >= 1 && stand.calls.quiet[0].atMs - installedAt >= 400, "the quiet rule waited out the grace");
    assert.ok(stand.calls.quiet.every(call => call.quietMs === 1234), "the host is asked for the configured quiet time");
    assert.equal(await signals(f.directory), 1, "inference was asked through its own idle guard, once");
    assert.equal(stand.calls.closes, 1, "the stop closed the host");
    await until(async () => (await f.events("self_upgrade")).length === 1, "the upgrade event");
    const [upgrade] = await f.events("self_upgrade");
    assert.deepEqual({ component: upgrade.component, from: upgrade.from, to: upgrade.to, mode: upgrade.mode, loadedChats: upgrade.loadedChats },
      { component: "service", from: "0.4.4", to: "0.4.5", mode: "quiet", loadedChats: 2 });
  } finally { await supervisor.stop(); await f.remove(); }
});

test("inference with requests running still refuses a quiet upgrade, and the host is opened again each time", { timeout: 30000 }, async () => {
  const f = await folder("gwu-busy-"); const release = { running: "0.4.4", installed: "0.4.5" };
  const stand = host({ quiet: () => ({ loadedChats: 1 }) });
  const supervisor = new ServiceSupervisor(plan(f, true), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  const internals = supervisor as unknown as { stopping: boolean; restarting: boolean };
  try {
    await supervisor.start();
    await until(async () => await signals(f.directory) >= 2, "two quiet attempts that inference refused");
    await until(() => !internals.restarting, "the refused attempt let go");
    assert.equal(stand.calls.resumes, stand.calls.quiet.length, "every refusal reopened the host's gate");
    assert.equal(internals.stopping, false, "the service kept running");
    assert.equal(stand.calls.closes, 0);
    assert.deepEqual(await f.events("self_upgrade"), []);
  } finally { await supervisor.stop(); await f.remove(); }
});

test("an idle service still upgrades by the idle rule, and gateway service restart never uses the quiet one", { timeout: 30000 }, async () => {
  const f = await folder("gwu-idle-"); const release = { running: "0.4.4", installed: "0.4.4" }; let idle = false;
  const stand = host({ idle: () => idle, quiet: () => ({ loadedChats: 3 }) });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  try {
    await supervisor.start();
    assert.equal(await supervisor.restartWhenIdle(), false, "a restart (SIGUSR2) of a busy host is refused");
    assert.equal(stand.calls.quiet.length, 0, "and it never asked the quiet rule");
    idle = true; release.installed = "0.4.5";
    await supervisor.stopped;
    assert.equal(stand.calls.quiet.length, 0, "an idle host upgrades before the grace ends");
    await until(async () => (await f.events("self_upgrade")).length === 1, "the upgrade event");
    const [upgrade] = await f.events("self_upgrade");
    assert.equal(upgrade.mode, "idle"); assert.equal(upgrade.loadedChats, undefined, "only a quiet upgrade counts loaded chats");
  } finally { await supervisor.stop(); await f.remove(); }
});

test("a quiet upgrade never runs twice at once and never while the service stops", { timeout: 30000 }, async () => {
  const f = await folder("gwu-once-"); const release = { running: "0.4.4", installed: "0.4.4" };
  let open: () => void = () => {}; let gate: Promise<void> | undefined = new Promise(resolve => { open = resolve; });
  const stand = host({ gate: () => gate, quiet: () => undefined });
  const supervisor = new ServiceSupervisor(plan(f), f.directory, 5, stand.start, unregistered, undefined, undefined, healing(release));
  const upgrade = (supervisor as unknown as { upgrade(pendingMs: number): Promise<unknown> }).upgrade.bind(supervisor);
  try {
    await supervisor.start();
    const first = upgrade(3_600_000);
    await until(() => stand.calls.quiet.length === 1, "the first quiet check");
    assert.equal(await upgrade(3_600_000), false, "a second upgrade while the first is checking is refused");
    assert.equal(stand.calls.strict, 1, "and it never reached the host");
    open(); gate = undefined;
    assert.equal(await first, false, "a host that is not quiet refuses");
    assert.equal(await upgrade(100), false, "inside the grace only the idle rule is tried");
    assert.equal(stand.calls.quiet.length, 1);
    await supervisor.stop();
    assert.equal(await upgrade(3_600_000), false, "a stopping service never restarts");
    assert.equal(stand.calls.quiet.length, 1); assert.equal(stand.calls.strict, 2);
  } finally { open(); await supervisor.stop(); await f.remove(); }
});
