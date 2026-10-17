import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { clearSlotHolders, holderPsEnvironment, parseHolderSnapshot, slotHolders, type HolderDeps } from "../native-slot-holders.js";
import type { ListenerRecord } from "../ssh-listener-activity.js";
import { configureTelemetry, flushTelemetry, readTelemetry } from "../telemetry.js";

/**
 * Which engines may hold the machine's one remote-control slot, and how an idle SSH listener is asked to retire. A listener is
 * never killed from outside: it is asked (SIGUSR2) only when its activity record proves it handles the request and matches the
 * process list. Every process here is a fixture string or a stub; nothing is signalled.
 */
const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lstart = (at: number) => { const d = new Date(at); const p = (n: number) => String(n).padStart(2, "0"); return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`; };
const row = (pid: number, parent: number, at: number, args: string) => `${String(pid).padStart(6)} ${String(parent).padStart(6)} ${lstart(at)} ${args}`;
const config = "/Users/x/gateway.json";
const pendingAt = Date.now(); const before = Math.floor((pendingAt - 3_600_000) / 1000) * 1000;
const listener = (pid: number, at = before, cfg = config) => row(pid, 1, at, `/usr/bin/node /g/cli.js codex-shim --config ${cfg} --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex --ssh -- app-server --listen unix://`);
const engine = (pid: number, parent: number, at = before) => row(pid, parent, at, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex app-server --listen stdio://");
const hostEngine = (pid: number, daemon: number, at = before) => row(pid, daemon, at, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex app-server --listen unix:///state/native.sock");
const daemon = (pid: number, cfg = config) => row(pid, 1, before - 5000, `/usr/bin/node /g/cli.js daemon --config ${cfg}`);

test("only stock engines under this gateway's listeners, adapters and host that started before the pending record can hold the slot", () => {
  const snapshot = [
    listener(100), engine(101, 100),
    row(102, 100, before, "/g/gateway-codex app-server -c model_catalog_json=/state/catalog.json"),
    row(110, 1, before, `/usr/bin/node /g/cli.js codex-shim --config ${config} --codex /c --ssh -- proxy`),
    listener(120, pendingAt + 5000), engine(121, 120, pendingAt + 5000),
    listener(130, before, "/Users/y/other.json"), engine(131, 130),
    row(140, 1, before, `/usr/bin/node /g/cli.js codex-shim --config ${config} --codex /c -- app-server`), engine(141, 140),
    engine(150, 1),
    daemon(160), hostEngine(161, 160), hostEngine(162, 160, pendingAt + 5000),
  ].join("\n");
  assert.deepEqual(slotHolders(snapshot, config, pendingAt), [
    { pid: 101, owner: 100, ownerStartedAt: before, kind: "ssh-listener" },
    { pid: 141, owner: 140, ownerStartedAt: before, kind: "adapter" },
    { pid: 161, owner: 160, ownerStartedAt: before - 5000, kind: "host" },
  ]);
});

test("a config path is matched as a resolved or real path, not only as exact text", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gw-holder-paths-"));
  try {
    const real = join(folder, "real"); await mkdir(real); await writeFile(join(real, "gateway.json"), "{}");
    await symlink(real, join(folder, "link"));
    const snapshot = [listener(100, before, join(realpathSync(real), "gateway.json")), engine(101, 100)].join("\n");
    assert.deepEqual(slotHolders(snapshot, join(folder, "link", "gateway.json"), pendingAt).map(holder => holder.pid), [101], "the link resolves to the path the listener was started with");
    assert.deepEqual(slotHolders(snapshot, join(folder, "link", "..", "real", "gateway.json"), pendingAt).map(holder => holder.pid), [101], "an unnormalized spelling resolves too");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("a process list in another locale is an error, never an empty list that lets the install through", async () => {
  const german = "   100      1 So. 18 Okt. 00:05:30 2026 /usr/bin/node /g/cli.js codex-shim --config /x --ssh -- app-server";
  assert.throws(() => parseHolderSnapshot(german), /Unreadable process list/);
  assert.throws(() => slotHolders(german, config, pendingAt));
  assert.deepEqual(parseHolderSnapshot("\n  \n"), [], "blank lines are not rows");
  const { deps } = holderDeps(german, {});
  await assert.rejects(clearSlotHolders({ configPath: config, sshHome: "/ssh", pendingAtMs: pendingAt }, deps), /Cannot verify the engines running on this Mac/);
  // The real command runs in the C locale whatever the caller's: its own start time reads as English words.
  const previous = process.env.LC_ALL; process.env.LC_ALL = "de_DE.UTF-8";
  try {
    assert.equal(holderPsEnvironment().LC_ALL, "C");
    const { stdout } = await promisify(execFile)("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { env: holderPsEnvironment() });
    assert.match(stdout.trim(), /^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d{2}:\d{2}:\d{2} \d{4}$/);
    assert.equal(parseHolderSnapshot(`${process.pid} 1 ${stdout.trim()} node`).length, 1);
  } finally { if (previous === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous; }
});

interface Fixture { alive: Set<number>; signalled: number[]; asked: Array<[string, number]> }
function holderDeps(snapshot: string, records: Record<number, ListenerRecord | undefined>, overrides: Partial<HolderDeps> = {}) {
  const state: Fixture = { alive: new Set([100, 101, 200, 201]), signalled: [], asked: [] };
  const deps: HolderDeps = {
    snapshot: async () => snapshot, activity: async (home, pid) => { state.asked.push([home, pid]); return records[pid]; },
    signal: pid => { state.signalled.push(pid); setTimeout(() => { state.alive.delete(pid); state.alive.delete(pid + 1); }, 20); }, alive: pid => state.alive.has(pid), stopWaitMs: 2000, pollMs: 10, ...overrides };
  return { deps, ...state, state };
}
const record = (startedAt = before, busy = false, declinedAt?: number): ListenerRecord => ({ pid: 0, startedAt, busy, ...(declinedAt === undefined ? {} : { declinedAt }) });
const run = (deps: HolderDeps) => clearSlotHolders({ configPath: config, sshHome: "/ssh", pendingAtMs: pendingAt }, deps);
async function telemetryFolder() {
  const directory = await mkdtemp(join(tmpdir(), "gw-holders-")); configureTelemetry(directory, "test");
  return { directory, events: async (name: string) => { await flushTelemetry(); return (await readTelemetry(directory, Date.now() - 60_000)).filter(event => event.event === name); }, remove: () => rm(directory, { recursive: true, force: true }) };
}

test("an idle listener is asked to retire, and the install waits for it and its engine to go", async () => {
  const t = await telemetryFolder();
  try {
    const f = holderDeps([listener(100), engine(101, 100)].join("\n"), { 100: record(before + 400) });
    assert.equal(await run(f.deps), 1);
    assert.deepEqual(f.state.signalled, [100], "the listener was asked; its engine was never signalled");
    assert.deepEqual(f.state.asked[0], ["/ssh", 100]);
    assert.deepEqual((await t.events("native_listener_retired")).map(event => event.count), [1]);
  } finally { await t.remove(); }
});

test("a listener with no record, a stale one for a reused pid, or a busy one is never signalled and refuses the activation", async () => {
  const t = await telemetryFolder();
  try {
    const snapshot = [listener(100), engine(101, 100), listener(200), engine(201, 200)].join("\n");
    for (const [records, reason, message] of [
      [{ 100: record(), 200: undefined }, "listener_unknown", /listener from an older release is running; quit ChatGPT on the other Mac, wait about 2 minutes, then retry/],
      [{ 100: record(), 200: record(before + 3_600_000) }, "listener_unknown", /older release/],
      [{ 100: record(), 200: record(before, true) }, "listener_busy", /SSH session from another Mac is using this Mac; retry when it is idle/],
    ] as const) {
      const f = holderDeps(snapshot, records);
      await assert.rejects(run(f.deps), message);
      assert.deepEqual(f.state.signalled, [], `${reason}: the idle listener is spared too, so the refusal changes nothing`);
    }
    assert.deepEqual((await t.events("native_activation_refused")).map(event => event.reason), ["listener_unknown", "listener_unknown", "listener_busy"]);
  } finally { await t.remove(); }
});

test("a listener that declines the request keeps its sessions and refuses the activation; an old decline does not count", async () => {
  const snapshot = [listener(100), engine(101, 100)].join("\n");
  let declined = false;
  const f = holderDeps(snapshot, {}, { signal: () => { declined = true; }, activity: async () => declined ? record(before, true, Date.now() + 1) : record(before, false, Date.now() - 60_000) });
  await assert.rejects(run(f.deps), /retry when it is idle/);
  const stale = holderDeps(snapshot, { 100: record(before, false, Date.now() - 60_000) }, { signal: () => {}, stopWaitMs: 80 });
  await assert.rejects(run(stale.deps), /did not stop/, "a decline from before this request says nothing about it");
});

test("a signal that fails is a refusal with a fixed reason, never a raw throw; a listener gone by itself is a success", async () => {
  const t = await telemetryFolder();
  try {
    const snapshot = [listener(100), engine(101, 100)].join("\n");
    for (const code of ["EPERM", "EINVAL"]) {
      const f = holderDeps(snapshot, { 100: record() }, { signal: () => { throw Object.assign(new Error("kill " + code), { code }); } });
      await assert.rejects(run(f.deps), (error: Error) => /could not be asked to retire/.test(error.message) && !/kill/.test(error.message));
    }
    const gone = holderDeps(snapshot, { 100: record() }, { signal: () => { throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" }); }, alive: () => false });
    assert.equal(await run(gone.deps), 1);
    assert.deepEqual((await t.events("native_activation_refused")).map(event => event.reason), ["signal_failed", "signal_failed"]);
  } finally { await t.remove(); }
});

test("another adapter refuses, and a shared host's engine is waited for until the service restarts it or the wait ends", async () => {
  const adapter = holderDeps([row(140, 1, before, `/usr/bin/node /g/cli.js codex-shim --config ${config} --codex /c -- app-server`), engine(141, 140)].join("\n"), {});
  await assert.rejects(run(adapter.deps), /Codex session on this Mac/);
  assert.deepEqual(adapter.state.signalled, []);
  // The host's old engine disappears (the service restarted the host) after two rescans.
  let scans = 0;
  const restarting = holderDeps("", {}, { snapshot: async () => ++scans < 3 ? [daemon(160), hostEngine(161, 160)].join("\n") : daemon(160), pollMs: 400 });
  assert.equal(await run(restarting.deps), 0);
  assert.ok(scans >= 3);
  const stuck = holderDeps([daemon(160), hostEngine(161, 160)].join("\n"), {}, { stopWaitMs: 600, pollMs: 100 });
  await assert.rejects(run(stuck.deps), /shared execution host is busy/);
});
