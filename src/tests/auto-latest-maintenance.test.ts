import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { maintenanceReconcileOptions, startAutoLatestMaintenance, type MaintenanceOptions } from "../model-auto-latest/maintenance.js";
import { setAutoLatest } from "../model-auto-latest/toggle.js";
import type { AutoLatestDependencies } from "../model-auto-latest/types.js";
import { maintenanceFreshMs, readMaintenanceStatus, type MaintenanceIdentity } from "../model-auto-latest/maintenance-status.js";
import { maintenancePath, readState } from "../model-auto-latest/state.js";

const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) { if (await condition()) return; await pause(5); }
  assert.fail(`timed out waiting for ${what}`);
}

/** Fake clock and timer queue: nothing here waits on real time. */
class World {
  t = Date.UTC(2026, 9, 24, 12, 0, 0);
  private next = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  alive = new Set<number>([4242]);
  starts = new Map<number, number>([[4242, Date.UTC(2026, 9, 20)]]);
  boot: string | undefined = "11111111-2222-3333-4444-555555555555";
  get pending(): number { return this.timers.size; }
  readonly timerApi = {
    set: (callback: () => void, ms: number) => { const id = this.next++; this.timers.set(id, { at: this.t + ms, callback }); return id; },
    clear: (handle: unknown) => { this.timers.delete(handle as number); },
  };
  readonly identity: MaintenanceIdentity = {
    now: () => this.t, pid: () => 4242, alive: pid => this.alive.has(pid),
    start: async pid => this.starts.get(pid), boot: async () => this.boot,
  };
  /** Moves time forward, firing due timers in order and letting real file work finish after each. */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]); this.t = Math.max(this.t, due[1].at); due[1].callback();
      await pause(25);
    }
    this.t = target;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gateway-maintenance-"));
  const config = join(root, "gateway.json");
  const world = new World();
  const state = { enabled: false, calls: 0, signals: [] as AbortSignal[], gate: undefined as Promise<void> | undefined, failPolicy: false, failReconcile: false };
  const options = (extra: Partial<MaintenanceOptions> = {}): MaintenanceOptions => ({
    owner: "server", timers: world.timerApi, identity: world.identity, intervalMs: 300_000, pollMs: 30_000, heartbeatMs: 30_000, initialDelayMs: 1_000,
    readEnabled: async () => { if (state.failPolicy) throw new Error("policy"); return state.enabled; },
    reconcile: async (_path, { signal }) => {
      state.calls++; state.signals.push(signal);
      if (state.gate) await state.gate;
      if (state.failReconcile) throw new Error("secret-token-xyz");
      return { outcome: "unchanged" };
    },
    ...extra,
  });
  const status = (path = config) => readMaintenanceStatus(path, world.identity);
  const beatFile = async (path = config) => JSON.parse(await readFile(await maintenancePath(path), "utf8")) as Record<string, unknown>;
  const active = async (path = config) => (await status(path)).scheduled;
  return { root, config, world, state, options, status, beatFile, active };
}

test("an enabled policy reconciles soon after start, then once per interval, and the heartbeat reports scheduled", async () => {
  const f = await fixture(); f.state.enabled = true;
  const handle = startAutoLatestMaintenance(f.config, f.options());
  try {
    await until(() => f.active(), "first heartbeat");
    assert.equal(f.state.calls, 0);
    await f.world.advance(1_000);
    assert.equal(f.state.calls, 1);
    await f.world.advance(240_000);
    assert.equal(f.state.calls, 1, "no pass before 300 seconds");
    assert.equal((await f.status()).scheduled, true, "heartbeats keep it fresh");
    await f.world.advance(60_000);
    assert.equal(f.state.calls, 2);
    const beat = await f.beatFile();
    assert.equal(beat.protocol, 1); assert.equal(beat.pid, 4242); assert.equal(beat.owner, "server"); assert.equal(beat.state, "active");
    assert.equal(typeof beat.startedAtMs, "number"); assert.equal(typeof beat.updatedAt, "number");
  } finally { await handle.stop(); }
});

test("a disabled policy runs nothing but keeps the heartbeat fresh, and enabling triggers a pass within one poll", async () => {
  const f = await fixture();
  const handle = startAutoLatestMaintenance(f.config, f.options({ owner: "service" }));
  try {
    await f.world.advance(1_000 + maintenanceFreshMs + 60_000);
    assert.equal(f.state.calls, 0);
    assert.deepEqual(await f.status(), { scheduled: true });
    assert.equal((await f.beatFile()).owner, "service");
    f.state.enabled = true;
    await f.world.advance(30_000);
    assert.equal(f.state.calls, 1, "the enabling edge does not wait for the five-minute interval");
    f.state.enabled = false; await f.world.advance(60_000);
    f.state.enabled = true; await f.world.advance(30_000);
    assert.equal(f.state.calls, 2, "disabling and re-enabling starts a fresh pass");
  } finally { await handle.stop(); }
});

test("a slow pass is never overlapped and an unreadable policy or failing pass does not end the loop", async () => {
  const f = await fixture(); f.state.enabled = true;
  let release!: () => void; f.state.gate = new Promise<void>(done => { release = done; });
  const handle = startAutoLatestMaintenance(f.config, f.options());
  try {
    await f.world.advance(1_000);
    await f.world.advance(100_000);
    assert.equal(f.state.calls, 1, "one pass in flight, no second one started");
    assert.equal(await f.active(), true, "within the pass bound the loop still counts as healthy");
    f.state.gate = undefined; f.state.failReconcile = true; release();
    await pause(25);
    await f.world.advance(230_000);
    assert.equal(f.state.calls, 2, "the loop survived a throwing pass, and the next one is due");
    f.state.failPolicy = true; await f.world.advance(400_000);
    assert.equal(f.state.calls, 2, "an unreadable policy counts as off");
    assert.equal(await f.active(), true, "a policy read that answers with an error is still a loop that is running");
    f.state.failPolicy = false; f.state.failReconcile = false; await f.world.advance(30_000);
    assert.equal(f.state.calls, 3);
  } finally { await handle.stop(); }
});

test("stop aborts the pass in flight, waits for it, clears every timer and leaves no late work", async () => {
  const f = await fixture(); f.state.enabled = true;
  let release!: () => void; f.state.gate = new Promise<void>(done => { release = done; });
  const handle = startAutoLatestMaintenance(f.config, f.options());
  await f.world.advance(1_000);
  assert.equal(f.state.calls, 1); assert.equal(f.state.signals[0]?.aborted, false);
  const stopping = handle.stop();
  assert.equal(handle.stop(), stopping, "every call returns the same promise");
  assert.equal(f.state.signals[0]?.aborted, true);
  release(); f.state.gate = undefined;
  await stopping;
  assert.equal((await f.beatFile()).state, "stopped", "the stop record is written before the promise resolves");
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  assert.equal(f.world.pending, 0, "no timer survives stop, including the one a finishing pass would re-arm");
  await f.world.advance(3_600_000);
  assert.equal(f.state.calls, 1);
});

test("stop waits for a pass that honors the abort and then finishes the stop record", async () => {
  const f = await fixture(); f.state.enabled = true;
  const events: string[] = [];
  const handle = startAutoLatestMaintenance(f.config, f.options({
    reconcile: async (_path, { signal }) => {
      f.state.calls++;
      await new Promise<void>(done => signal.addEventListener("abort", () => done(), { once: true }));
      await pause(40); events.push("pass-ended"); return { outcome: "cancelled" };
    },
  }));
  await until(() => f.active(), "first heartbeat");
  await f.world.advance(1_000);
  assert.equal(f.state.calls, 1);
  await handle.stop();
  assert.deepEqual(events, ["pass-ended"], "stop did not resolve before the pass ended");
  assert.equal((await f.beatFile()).state, "stopped");
  assert.equal(f.world.pending, 0);
});

test("stop gives up on a pass that ignores the abort after the bounded wait", async () => {
  const f = await fixture(); f.state.enabled = true;
  let release!: () => void; f.state.gate = new Promise<void>(done => { release = done; });
  const handle = startAutoLatestMaintenance(f.config, f.options());
  try {
    await until(() => f.active(), "first heartbeat");
    await f.world.advance(1_000);
    let resolved = false;
    const stopping = handle.stop().then(() => { resolved = true; });
    await pause(60);
    assert.equal(resolved, false, "still inside the bounded wait");
    await f.world.advance(5_000);
    await stopping;
    assert.equal((await f.beatFile()).state, "stopped");
  } finally { release(); await handle.stop(); }
});

test("after stop resolves nothing more is written, and no lock or temporary file is left behind", async () => {
  const f = await fixture();
  const handle = startAutoLatestMaintenance(f.config, f.options());
  await until(() => f.active(), "first heartbeat");
  await f.world.advance(90_000);
  await handle.stop();
  const before = (await readdir(f.root)).sort(); const beat = await readFile(await maintenancePath(f.config), "utf8");
  await f.world.advance(3_600_000); await pause(100);
  assert.deepEqual((await readdir(f.root)).sort(), before);
  assert.equal(await readFile(await maintenancePath(f.config), "utf8"), beat);
  assert.deepEqual(before.filter(name => /\.(lock|tmp|break)$/.test(name)), []);
});

test("start followed at once by stop writes no active record at all", async () => {
  const f = await fixture();
  await startAutoLatestMaintenance(f.config, f.options()).stop();
  assert.deepEqual(await readdir(f.root), []);
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
});

test("a pass that never returns stops the maintenance claim even though the heartbeat stays fresh", async () => {
  const f = await fixture(); f.state.enabled = true;
  let release!: () => void; f.state.gate = new Promise<void>(done => { release = done; });
  const handle = startAutoLatestMaintenance(f.config, f.options());
  try {
    await f.world.advance(1_000);
    await f.world.advance(100_000);
    assert.equal(await f.active(), true);
    await f.world.advance(60_000);
    assert.equal(f.state.signals[0]?.aborted, true, "the pass bound aborts the pass's own signal");
    await f.world.advance(200_000);
    assert.equal(f.state.calls, 1, "nothing is started on top of the stuck pass");
    const beat = await f.beatFile();
    assert.ok(f.world.t - (beat.updatedAt as number) <= 30_000, "the heartbeat itself is still fresh");
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" });
    await handle.stop();
  } finally { release(); await handle.stop(); }
});

test("a policy read that never returns stops the maintenance claim and is not repeated on top of itself", async () => {
  const f = await fixture(); let reads = 0;
  const handle = startAutoLatestMaintenance(f.config, f.options({ readEnabled: () => { reads++; return new Promise<boolean>(() => undefined); } }));
  try {
    // The heartbeat is real asynchronous file I/O, not part of the fake deadline clock.
    await until(() => f.active(), "the initial heartbeat");
    await f.world.advance(1_000);
    assert.equal(await f.active(), true);
    await f.world.advance(400_000);
    assert.equal(reads, 1);
    assert.equal((await f.beatFile()).state, "active");
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" });
  } finally { await handle.stop(); }
});

test("stop settles an uncooperative policy read without advancing its deadline clock", { timeout: 5000 }, async () => {
  const f = await fixture(); let release!: (value: boolean) => void; let observed: AbortSignal | undefined;
  const gate = new Promise<boolean>(done => { release = done; });
  const handle = startAutoLatestMaintenance(f.config, f.options({ readEnabled: (_path, signal) => { observed = signal; return gate; } }));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await f.world.advance(1_000); await until(() => f.active(), "the initial heartbeat");
    assert.ok(observed);
    stopping = handle.stop();
    const completed = await Promise.race([stopping.then(() => true), new Promise<boolean>(done => { deadline = setTimeout(() => done(false), 1000); })]);
    assert.equal(completed, true, "shutdown must settle the attempt even when its policy ignores cancellation");
    assert.equal(observed.aborted, true);
    assert.equal(f.world.pending, 0);
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  } finally { clearTimeout(deadline); release(false); await (stopping ?? handle.stop()); }
});

async function realConfig(f: Awaited<ReturnType<typeof fixture>>) {
  const state = join(f.root, "state"); const native = join(f.root, "native");
  await mkdir(state, { recursive: true }); await mkdir(native, { recursive: true });
  const body = { version: 1, port: 3457, stateDirectory: state, providers: [
    { id: "claude", label: "Claude", type: "claude-subscription", defaultForBareModels: true, authDirectory: join(state, "claude-auth"),
      models: { "claude/claude-opus-5-4": "claude-opus-5-4" }, modelMetadata: { "claude/claude-opus-5-4": { displayName: "Opus 5.4", releasedAt: 1_780_000_000 } } },
  ] };
  await writeFile(f.config, JSON.stringify(body), { mode: 0o600 });
  const revision = async () => createHash("sha256").update(await readFile(f.config)).digest("hex");
  const deps: AutoLatestDependencies = { discoverModels: async () => [{ model: "claude-opus-5-4", metadata: { displayName: "claude-opus-5-4" } }], now: () => Date.UTC(2026, 9, 24), nativeHome: native };
  return { native, deps, set: async (on: boolean) => setAutoLatest(f.config, on, await revision(), deps) };
}

test("the default production policy reader follows the real private configuration's toggles", async () => {
  const f = await fixture();
  const real = await realConfig(f);
  const handle = startAutoLatestMaintenance(f.config, { owner: "service", timers: f.world.timerApi, identity: f.world.identity,
    reconcile: async () => { f.state.calls++; return { outcome: "unchanged" }; } });
  try {
    await f.world.advance(1_000); await pause(80);
    assert.equal(f.state.calls, 0, "no autoLatestModels setting means off");
    await real.set(true);
    await f.world.advance(30_000); await until(() => f.state.calls === 1, "first pass after enabling");
    await real.set(false);
    await f.world.advance(60_000); await pause(80);
    assert.equal(f.state.calls, 1, "disabled in the file: no pass");
    await real.set(true);
    await f.world.advance(30_000); await until(() => f.state.calls === 2, "pass after enabling again");
    await writeFile(f.config, "{broken", { mode: 0o600 });
    await f.world.advance(400_000); await pause(80);
    assert.equal(f.state.calls, 2, "an unreadable configuration counts as off");
    assert.equal((await f.status()).scheduled, true, "and the loop is still running");
  } finally { await handle.stop(); }
});

test("the production reconcile is metadata-only, capped at 120 seconds, and a hung provider is cut off", async () => {
  const signal = new AbortController().signal;
  const defaults = maintenanceReconcileOptions(signal);
  assert.equal(defaults.totalMs, 120_000); assert.equal(defaults.refresh, false); assert.equal(defaults.signal, signal);
  assert.equal(maintenanceReconcileOptions(signal, { totalMs: 50, signal: new AbortController().signal }).signal, signal, "the owner's signal always wins");

  const f = await fixture();
  const real = await realConfig(f); await real.set(true);
  const handle = startAutoLatestMaintenance(f.config, { owner: "server", timers: f.world.timerApi, identity: f.world.identity,
    reconcileOptions: { discoverModels: () => new Promise(() => undefined), nativeHome: real.native, totalMs: 80, perProviderMs: 40, now: () => Date.UTC(2026, 9, 24) } });
  try {
    await f.world.advance(1_000);
    await until(async () => (await readState(f.config)).lastCheckedAt !== undefined, "the real pass to finish despite a hung provider");
    const state = await readState(f.config);
    assert.notEqual(state.lastOutcome, "updated");
    assert.equal(typeof state.lastOutcome, "string");
  } finally { await handle.stop(); }
});

test("a record that stops being refreshed turns stale and is never reported scheduled", async () => {
  const f = await fixture();
  const handle = startAutoLatestMaintenance(f.config, f.options());
  try {
    await until(() => f.active(), "first heartbeat");
    f.world.t += maintenanceFreshMs + 1;
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" });
    f.world.t -= maintenanceFreshMs + 1 + 60_000;
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" }, "a record from the future is refused too");
  } finally { await handle.stop(); }
});

test("a dead, reused or unverifiable process is never scheduled", async () => {
  const f = await fixture();
  const handle = startAutoLatestMaintenance(f.config, f.options());
  try {
    await until(() => f.active(), "first heartbeat");
    f.world.alive.delete(4242);
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" }, "dead pid");
    f.world.alive.add(4242);
    f.world.starts.set(4242, Date.UTC(2026, 9, 24, 11, 0, 0));
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" }, "pid reused by a later process");
    f.world.starts.set(4242, Date.UTC(2026, 9, 20) + 1_500);
    assert.equal((await f.status()).scheduled, true, "kernel rounding inside the skew is the same process");
    f.world.starts.delete(4242);
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" }, "no start identity, no claim");
    f.world.starts.set(4242, Date.UTC(2026, 9, 20)); f.world.boot = "99999999-2222-3333-4444-555555555555";
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_stale" }, "a record from another boot");
  } finally { await handle.stop(); }
});

test("without an operating-system start the owner publishes nothing and the status stays false", async () => {
  const f = await fixture();
  f.world.starts.delete(4242);
  const handle = startAutoLatestMaintenance(f.config, f.options());
  try {
    await f.world.advance(5_000);
    assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  } finally { await handle.stop(); }
});

test("missing, unreadable, foreign or linked records report fixed reasons", async () => {
  const f = await fixture();
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  const path = await maintenancePath(f.config);
  await writeFile(path, "{not json", { mode: 0o600 });
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  const valid = { protocol: 1, pid: 4242, startedAtMs: Date.UTC(2026, 9, 20), owner: "server", instance: "abcdef12-0000", updatedAt: f.world.t, progressAt: f.world.t, state: "active" };
  await writeFile(path, JSON.stringify({ ...valid, protocol: 2 }), { mode: 0o600 });
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  await writeFile(path, JSON.stringify({ ...valid, pid: -1 }), { mode: 0o600 });
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
  assert.deepEqual(await f.status(), { scheduled: true });
  await writeFile(path, JSON.stringify(valid), { mode: 0o600 }); await chmod(path, 0o644);
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" }, "a record other users can write is not trusted");
  const target = join(f.root, "elsewhere.json"); await writeFile(target, JSON.stringify(valid), { mode: 0o600 });
  const { unlink } = await import("node:fs/promises"); await unlink(path); await symlink(target, path);
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" }, "a link is never followed");
});

test("two configurations keep separate records and separate loops", async () => {
  const f = await fixture(); f.state.enabled = true;
  const other = join(f.root, "other.json");
  const first = startAutoLatestMaintenance(f.config, f.options());
  try {
    await until(() => f.active(), "first heartbeat");
    assert.deepEqual(await f.status(other), { scheduled: false, reason: "service_unavailable" });
    const second = startAutoLatestMaintenance(other, f.options({ owner: "service" }));
    await until(() => f.active(other), "second heartbeat");
    assert.equal((await f.beatFile(other)).owner, "service"); assert.equal((await f.beatFile()).owner, "server");
    await second.stop();
    await until(async () => (await f.status(other)).reason === "service_unavailable", "second stopped");
    assert.equal(await f.active(), true, "stopping one configuration leaves the other running");
  } finally { await first.stop(); }
});

test("an old owner stopping after a hot swap does not overwrite the new owner's record", async () => {
  const f = await fixture();
  const old = startAutoLatestMaintenance(f.config, f.options());
  await until(() => f.active(), "old heartbeat");
  const oldInstance = (await f.beatFile()).instance;
  const replacement = startAutoLatestMaintenance(f.config, f.options({ owner: "service" }));
  try {
    await until(async () => (await f.beatFile()).instance !== oldInstance, "new heartbeat");
    await old.stop();
    await pause(150);
    const beat = await f.beatFile();
    assert.notEqual(beat.instance, oldInstance);
    assert.equal(beat.state, "active"); assert.equal(beat.owner, "service");
    assert.equal(await f.active(), true);
    // The old owner also stays silent afterwards, whatever its timers would have done.
    await f.world.advance(120_000);
    assert.equal((await f.beatFile()).instance, beat.instance);
    await replacement.stop();
    await until(async () => (await f.status()).reason === "service_unavailable", "new owner stopped");
  } finally { await old.stop(); await replacement.stop(); }
});

test("a stopped record stays stopped until its own owner is started again", async () => {
  const f = await fixture();
  await startAutoLatestMaintenance(f.config, f.options()).stop();
  await until(async () => (await f.status()).reason === "service_unavailable", "stopped");
  await f.world.advance(600_000);
  assert.deepEqual(await f.status(), { scheduled: false, reason: "service_unavailable" });
  const again = startAutoLatestMaintenance(f.config, f.options());
  try { await until(() => f.active(), "restarted heartbeat"); } finally { await again.stop(); }
});
