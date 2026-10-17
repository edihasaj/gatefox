import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppServerBackends } from "../app-server-backends.js";
import { object, type Message } from "../app-server-connection.js";
import { writePrivateJson } from "../config.js";
import type { DesktopCatalog } from "../desktop-catalog.js";
import { livePid, sdkIdentity } from "../execution-host-storage.js";
import { hostUnavailable, nativeFallbackReason, setHostWaitForTests } from "../execution-host-client.js";
import { claimPrivateNativeHome, nativeHomeOwnership, readNativeHomeOwner } from "../native-execution-host-storage.js";
import { configureTelemetry } from "../telemetry.js";
import { fallbackFixture, until } from "./native-fallback-fixture.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

isolateExecutionRoots(); // Receipts, host homes and the SDK rendezvous stay in this file's folder; a down host is waited for 500 ms.
hostRunsInThisProcess(); // A receipt naming this process is a live owner here, as another process's receipt is in production.

type Fixture = Awaited<ReturnType<typeof fallbackFixture>>;
const nativeReceipt = async (f: Fixture, fields: Message) => writePrivateJson(f.receipt, { version: 1, managed: "subscription-gateway-native-execution-owner",
  configPath: resolve(f.configPath), nativeHome: resolve(f.nativeHome), ...await sdkIdentity(f.sdk), socketPath: join(f.home, "native.sock"), ...fields });
const unavailable = (error: Error & { code?: number }) => error.code === -32001 && /host is unavailable/.test(error.message);

test("a host that stays down leaves native chats to a private engine that holds the native-home lease from before its spawn until shutdown", { timeout: 20000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    const first = await f.create();
    assert.notEqual(first.adapter.native.shared, true);
    await until(async () => (await f.launches()).length > 0, "the engine start");
    const [launch, ...others] = await f.launches(); assert.equal(others.length, 0); assert.equal(launch.kind, "stdio");
    // The engine found the lease already written (a refused lease spawns nothing at all: see the fail-closed tests below).
    assert.equal(launch.lease?.hostPid, process.pid); assert.equal(launch.lease?.private, true); assert.ok(["starting", "running"].includes(String(launch.lease?.sdkState)));
    const lease = await readNativeHomeOwner(f.nativeHome);
    assert.equal(lease?.hostPid, process.pid); assert.equal(lease?.pid, launch.pid); assert.equal(lease?.state, "running"); assert.equal(lease?.sdkState, "running");
    assert.equal(lease?.configPath, resolve(f.configPath)); assert.equal(lease?.socketPath, join(f.home, "native.sock")); assert.equal(lease?.privateOwner?.previous, undefined);
    assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "live");
    // Native chats work on the private engine, and never wait for the host: none of them asks the service to restart it again.
    const kick = await stat(join(f.home, "kick"));
    const started = await first.adapter.request("thread/start", { cwd: f.directory }); const id = String(object(started.thread).id);
    assert.equal(started.executorPid, launch.pid);
    await first.adapter.request("turn/start", { threadId: id });
    await until(() => first.events.some(event => event.method === "turn/started" && object(event.params).threadId === id), "the native turn");
    assert.equal(object((await first.adapter.request("thread/read", { threadId: id })).thread).id, id);
    assert.equal((await stat(join(f.home, "kick"))).ino, kick.ino);
    // Gateway chats still need the host, so they fail closed while it is down.
    await assert.rejects(first.adapter.request("thread/start", { model: "claude/fixture" }, { engine: "gateway" }), unavailable);
    const fallbacks = await f.events("native_sharing_fallback", since);
    assert.equal(fallbacks.length, 1); assert.equal(fallbacks[0].reason, "host_unavailable");
    assert.deepEqual(Object.keys(fallbacks[0]).sort(), ["at", "component", "event", "host", "pid", "reason"]);
    // Shutting the adapter down stops the engine and only then gives the home back: no receipt was there before, so none is.
    await first.adapter.stop();
    assert.equal(livePid(launch.pid), false); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
  } finally { await f.clean(); }
});

test("an engine that exits gives back the exact receipt its lease replaced, file time included", { timeout: 20000 }, async () => {
  const f = await fallbackFixture({});
  try {
    // A host that stopped cleanly: its native-home receipt stays, naming nothing that runs.
    await nativeReceipt(f, { hostPid: 0, pid: 0, state: "stopped", sdkState: "stopped", revision: "b".repeat(64) });
    const before = await readFile(f.receipt, "utf8"); const old = new Date(Date.now() - 3_600_000); await utimes(f.receipt, old, old);
    const first = await f.create();
    const lease = await readNativeHomeOwner(f.nativeHome);
    assert.deepEqual(lease?.privateOwner?.previous, JSON.parse(before)); assert.equal(lease?.revision, "b".repeat(64)); assert.equal(lease?.hostPid, process.pid);
    // Gateway chats are not shared in this plan, so they would not wait for the host either.
    assert.equal((first.adapter as unknown as { sharedGateway?: boolean }).sharedGateway, false);
    await first.adapter.request("fixture/exit", {}).catch(() => {});
    await until(() => first.exits() === 1, "the engine exit");
    await until(async () => (await readNativeHomeOwner(f.nativeHome))?.privateOwner === undefined, "the lease release");
    assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), JSON.parse(before));
    assert.equal(Math.floor((await stat(f.receipt)).mtimeMs), Math.floor(old.getTime()));
  } finally { await f.clean(); }
});

test("a host that stays down while a native owner still lives fails closed and starts no second engine", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    // The dead host's native engine still runs; a launch the dead host recorded may still be starting.
    for (const fields of [{ hostPid: 0, pid: process.pid, state: "running", sdkState: "running" }, { hostPid: 0, pid: 0, state: "running", sdkState: "starting" }]) {
      await nativeReceipt(f, fields); const before = await readFile(f.receipt, "utf8");
      await assert.rejects(f.create(), unavailable);
      assert.equal(await readFile(f.receipt, "utf8"), before);
    }
    // No receipt at all, but something still answers at the host's native socket.
    await rm(f.receipt);
    const server = createServer(); server.listen(join(f.home, "native.sock")); await once(server, "listening"); await chmod(join(f.home, "native.sock"), 0o600);
    try { await assert.rejects(f.create(), unavailable); } finally { await new Promise<void>(done => server.close(() => done())); }
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
    // The receipt of a dead owner from another configuration is not this adapter's to take.
    await nativeReceipt(f, { configPath: join(f.directory, "other.json"), hostPid: 0, pid: 0, state: "running", sdkState: "exited" });
    await assert.rejects(f.create(), unavailable);
    assert.deepEqual(await f.launches(), []); assert.equal((await f.events("native_sharing_fallback", since)).length, 0);
  } finally { await f.clean(); }
});

test("only a host that is down falls back: a mismatched host, a changed socket or an unreadable receipt fails closed", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    const cases: Array<[string, () => Promise<void>, RegExp]> = [
      ["another configuration's live host", () => f.hostReceipt({ configPath: join(f.directory, "other.json"), pid: process.pid, state: "running" }), /ownership does not match/],
      ["another configuration's stopped host", () => f.hostReceipt({ configPath: join(f.directory, "other.json") }), /ownership does not match/],
      ["a live host whose socket changed", () => f.hostReceipt({ pid: process.pid, state: "running", socket: { inode: "1", device: "1" } }), /socket ownership changed/],
      ["an unreadable receipt", () => writeFile(join(f.home, "owner.json"), "{", { mode: 0o600 }), /host is unavailable/],
    ];
    for (const [name, arrange, message] of cases) {
      await arrange();
      await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && message.test(error.message), name);
    }
    assert.deepEqual(await f.launches(), []); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
    assert.equal((await f.events("native_sharing_fallback", since)).length, 0);
  } finally { await f.clean(); }
});

test("the fallback vocabulary is fixed and only an unavailable host or a gateway-only host qualifies", () => {
  const down = Object.assign(new Error("Shared executor host is unavailable; check gateway service status"), { hostUnavailable: true });
  const absent = Object.assign(new Error("Shared native executor is not enabled in the configured host"), { capabilityAbsent: "native" });
  assert.equal(hostUnavailable(down), true); assert.equal(nativeFallbackReason(down, false), "host_unavailable"); assert.equal(nativeFallbackReason(down, true), "host_unavailable");
  assert.equal(nativeFallbackReason(absent, true), "other"); assert.equal(nativeFallbackReason(absent, false), undefined);
  // The same text without the type is not enough: only discovery decides what "unavailable" means.
  for (const error of [new Error("Shared executor host is unavailable; check gateway service status"), new Error("Shared executor ownership does not match this adapter"),
    new Error("Shared executor socket ownership changed; it was preserved"), undefined]) assert.equal(nativeFallbackReason(error, true), undefined);
});

test("a lease taken over from a crashed fallback keeps the receipt that fallback had replaced", { timeout: 20000 }, async () => {
  const f = await fallbackFixture();
  try {
    await nativeReceipt(f, { hostPid: 0, pid: 0, state: "stopped", sdkState: "stopped" }); const original = JSON.parse(await readFile(f.receipt, "utf8"));
    const crashed = await claimPrivateNativeHome({ configPath: resolve(f.configPath), nativeHome: resolve(f.nativeHome), codex: f.sdk }, f.home);
    // The crashed adapter's receipt names processes that are gone: a pid no process holds, from this boot.
    const left = { ...(await readNativeHomeOwner(f.nativeHome))!, hostPid: 2 ** 22 + 7, pid: 2 ** 22 + 9, sdkState: "running" };
    await writePrivateJson(f.receipt, left); assert.ok(crashed);
    assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "dead_pids");
    const next = await claimPrivateNativeHome({ configPath: resolve(f.configPath), nativeHome: resolve(f.nativeHome), codex: f.sdk }, f.home);
    assert.deepEqual((await readNativeHomeOwner(f.nativeHome))?.privateOwner?.previous, original);
    await next.release(); assert.deepEqual(JSON.parse(await readFile(f.receipt, "utf8")), original);
  } finally { await f.clean(); }
});

test("a lease released while its engine still runs keeps naming that engine, without the adapter, until the engine is gone", { timeout: 20000 }, async () => {
  const f = await fallbackFixture(); let engine: ChildProcess | undefined;
  try {
    await nativeReceipt(f, { hostPid: 0, pid: 0, state: "stopped", sdkState: "stopped" }); const original = JSON.parse(await readFile(f.receipt, "utf8"));
    const identity = { configPath: resolve(f.configPath), nativeHome: resolve(f.nativeHome), codex: f.sdk };
    const lease = await claimPrivateNativeHome(identity, f.home);
    // A stand-in for an engine that outlives its adapter's release: it only sleeps.
    engine = spawn("/bin/sleep", ["30"], { stdio: "ignore" }); await once(engine, "spawn");
    await lease.engineStarted(engine.pid!); const named = await readNativeHomeOwner(f.nativeHome);
    assert.equal(named?.pid, engine.pid); assert.equal(named?.hostPid, process.pid);
    await lease.release();
    // The adapter steps back; the receipt still names the engine and keeps the receipt the lease replaced.
    const kept = await readNativeHomeOwner(f.nativeHome);
    assert.deepEqual(kept, { ...named, hostPid: 0 }); assert.deepEqual(kept?.privateOwner?.previous, original);
    assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "live");
    await assert.rejects(claimPrivateNativeHome(identity, f.home), /already owns this native home/);
    // Once the engine is gone, the dead owner rules release the home.
    engine.kill("SIGKILL"); await once(engine, "exit");
    assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "dead_pids");
  } finally { engine?.kill("SIGKILL"); await f.clean(); }
});

test("an adapter that cannot be built after its lease was taken gives the lease straight back", { timeout: 20000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    await nativeReceipt(f, { hostPid: 0, pid: 0, state: "stopped", sdkState: "stopped" });
    const before = await readFile(f.receipt, "utf8"); const old = new Date(Date.now() - 3_600_000); await utimes(f.receipt, old, old);
    const snapshot = { models: [] as Message[], revision: "fixture" };
    const catalog = { current: () => snapshot, refresh: async () => snapshot, combined: (value: typeof snapshot) => ({ models: value.models }), nativeSlugs: new Set<string>() } as unknown as DesktopCatalog;
    // An argument the operating system cannot pass makes the engine's spawn throw inside the constructor, after the lease.
    await assert.rejects(AppServerBackends.create(f.sdk, ["app-server", "--listen", "stdio://", "bad\0argument"], f.config, {}, {}, catalog, async () => {}, () => {}, f.configPath), unavailable);
    // The lease was taken (the fallback is recorded only then), and the receipt it replaced is back, file time included.
    assert.equal((await f.events("native_sharing_fallback", since)).length, 1);
    assert.equal(await readFile(f.receipt, "utf8"), before); assert.equal(Math.floor((await stat(f.receipt)).mtimeMs), Math.floor(old.getTime()));
    assert.deepEqual(await f.launches(), []);
    // The next adapter is not kept out by a lease nothing holds.
    await f.create(); assert.equal((await readNativeHomeOwner(f.nativeHome))?.hostPid, process.pid);
  } finally { await f.clean(); }
});

test("an adapter whose native home is not the plan's, even a link to the same folder, never falls back", { timeout: 20000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  try {
    const link = join(f.directory, "linked-native"); await symlink(f.nativeHome, link);
    const elsewhere = join(f.directory, "elsewhere"); await mkdir(elsewhere, { mode: 0o700 });
    for (const home of [link, elsewhere]) {
      process.env.CODEX_HOME = home;
      await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /not the one the gateway service shares/.test(error.message), home === link ? "link" : "elsewhere");
    }
    assert.deepEqual(await f.launches(), []); assert.equal((await f.events("native_sharing_fallback", since)).length, 0);
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined); assert.equal(await readNativeHomeOwner(elsewhere), undefined);
    // The plan's own spelling still falls back.
    process.env.CODEX_HOME = f.nativeHome; await f.create(); assert.ok((await readNativeHomeOwner(f.nativeHome))?.privateOwner);
  } finally { await f.clean(); }
});

// The adapter's host waits take the session's signal: a session that ends while its host is down stops waiting at once, and a
// stopped adapter ends the wait a gateway chat started, instead of holding its shutdown for up to 20 s.
test("an ending session or a stopped adapter ends its host wait at once, and an ended session never falls back", { timeout: 30000 }, async () => {
  const f = await fallbackFixture();
  try {
    setHostWaitForTests(15_000);
    const controller = new AbortController(); setTimeout(() => controller.abort(), 200); let began = Date.now();
    await assert.rejects(f.create(controller.signal), unavailable);
    assert.ok(Date.now() - began < 5000, `the wait ended with the session (${Date.now() - began} ms)`);
    assert.deepEqual(await f.launches(), [], "no private engine was started"); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
    // A fallback adapter whose gateway chat waits for the host: stopping the adapter ends that wait too.
    setHostWaitForTests(500); const { adapter } = await f.create(); setHostWaitForTests(15_000);
    const waiting = adapter.request("thread/start", { model: "claude/fixture" }, { engine: "gateway" }).then(() => "started", (error: Error) => error.message);
    await new Promise(done => setTimeout(done, 200)); began = Date.now(); await adapter.stop();
    assert.match(await waiting, /host is unavailable/); assert.ok(Date.now() - began < 5000, `the stop did not wait for the host (${Date.now() - began} ms)`);
  } finally { setHostWaitForTests(500); await f.clean(); }
});
