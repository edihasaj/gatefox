import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, readdir, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { object, type Message } from "../app-server-connection.js";
import { writePrivateJson } from "../config.js";
import { startExecutionHost } from "../execution-host.js";
import { executionHostHome, executionHostMarker, livePid, sdkIdentity, type HostIdentity } from "../execution-host-storage.js";
import { archiveStoppedExecutionReceipt } from "../service-execution-recovery.js";
import { claimNativeHome, nativeHomeOwnership, privateNativeHolders, readNativeHomeOwner } from "../native-execution-host-storage.js";
import { SocketAppServerConnection } from "../socket-app-server-connection.js";
import { configureTelemetry } from "../telemetry.js";
import { fallbackFixture, until } from "./native-fallback-fixture.js";
import { hostRunsInThisProcess } from "./in-process-host.js";
import { isolateExecutionRoots } from "./isolated-execution-roots.js";

const roots = isolateExecutionRoots(); // Receipts, host homes and the SDK rendezvous stay in this file's folder; a down host is waited for 500 ms.
hostRunsInThisProcess(); // The host runs inside this process; a receipt naming this process is a live owner here, as in production.

type Fixture = Awaited<ReturnType<typeof fallbackFixture>>;
/** A host for the fixture's configuration that shares native and gateway chats and runs the fixture codex for both. */
async function hostOptions(f: Fixture) {
  const identity = await sdkIdentity(f.sdk);
  return { config: f.config, configPath: f.configPath, nativeHome: f.nativeHome, codex: f.sdk, capabilities: ["native" as const, "gateway" as const],
    nativeSdkVerifier: async () => ({ nativeSdkExecutable: identity.codex, nativeSdkSha256: identity.sdkSha256 }),
    gatewayRuntime: async () => ({ executable: identity.codex, binarySha256: identity.sdkSha256, selectedModelCompaction: true as const, executorIdentity: true as const, codeModeHost: false }) };
}
const descriptor = async (f: Fixture, digit: string): Promise<Message> => ({ revision: digit.repeat(64), args: ["app-server"], settings: { model: "fixture" },
  catalog: { models: [{ slug: "fixture", tool_mode: "direct" }] }, aliases: ["fixture"], gatewaySdkSha256: (await sdkIdentity(f.sdk)).sdkSha256 });

test("a host that comes back while the fallback runs refuses native ownership, keeps serving gateway work, and takes the home once the fallback ends", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined; let control: SocketAppServerConnection | undefined;
  try {
    const first = await f.create(); const lease = await readNativeHomeOwner(f.nativeHome); assert.ok(lease?.privateOwner);
    // The host starts: it finds a live owner of the native home and leaves it alone instead of failing its whole start.
    host = await startExecutionHost(await hostOptions(f));
    assert.deepEqual(await readNativeHomeOwner(f.nativeHome), lease);
    control = new SocketAppServerConnection(join(f.home, "host.sock"), async () => {}); await control.ready;
    const status = await control.request("execution/status", {});
    assert.deepEqual(status.capabilities, ["native", "gateway"]); assert.equal(status.native, null);
    await assert.rejects(control.request("native/acquire", { args: ["app-server"], cwd: f.directory }), /ownership is held by a live owner/);
    assert.deepEqual(await readNativeHomeOwner(f.nativeHome), lease);
    // Gateway work goes on.
    assert.equal((await control.request("execution/acquire", { descriptor: await descriptor(f, "c") })).revision, "c".repeat(64));
    // Another adapter, such as an SSH session, now reaches the host, which still refuses native ownership: instead of failing,
    // it joins the fallback with a private engine of its own, and the host keeps waiting for both.
    const second = await f.create(); assert.notEqual(second.adapter.native.shared, true);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 2);
    await assert.rejects(control.request("native/acquire", { args: ["app-server"], cwd: f.directory }), /ownership is held by a live owner/);
    // Both fallbacks' native chats work meanwhile.
    for (const { adapter } of [first, second]) { const started = await adapter.request("thread/start", {}); await adapter.request("turn/start", { threadId: object(started.thread).id }); }
    let launches = await f.launches();
    assert.equal(launches.filter(launch => launch.kind === "stdio").length, 2); assert.equal(launches.filter(launch => launch.kind === "native").length, 0);
    // The fallbacks end: their leases go with their engines, and the next adapter start brings native sharing back through the host.
    await first.adapter.stop(); assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
    await second.adapter.stop(); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
    const third = await f.create(); assert.equal(third.adapter.native.shared, true);
    launches = await f.launches(); const native = launches.filter(launch => launch.kind === "native");
    assert.equal(native.length, 1); assert.equal(launches.filter(launch => launch.kind === "stdio").length, 2);
    const owner = await readNativeHomeOwner(f.nativeHome);
    assert.equal(owner?.hostPid, process.pid); assert.equal(owner?.pid, native[0].pid); assert.equal(owner?.privateOwner, undefined);
    assert.deepEqual((await f.events("native_sharing_unavailable", since)).map(event => event.reason), ["native_owner"]);
    assert.ok((await f.events("native_acquire", since)).some(event => event.outcome === "refused_owner"));
    assert.deepEqual((await f.events("native_sharing_fallback", since)).map(event => [event.reason, event.holders]), [["host_unavailable", 1], ["native_owner", 2]]);
  } finally {
    control?.stop(); await Promise.allSettled([...f.adapters].map(adapter => adapter.stop())); await host?.close(); await f.clean();
  }
});

test("a fallback adapter that crashes leaves a receipt the host reclaims as a dead owner", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  // The adapter runs in a process of its own, so it can be killed the way a crash kills it.
  const script = join(f.directory, "adapter.mjs");
  await writeFile(script, `const options = JSON.parse(process.argv[2]);
(await import(options.client)).setHostWaitForTests(200);
const { AppServerBackends } = await import(options.backends);
const snapshot = { models: [], revision: "fixture" };
const catalog = { current: () => snapshot, refresh: async () => snapshot, combined: value => ({ models: value.models }) };
await AppServerBackends.create(options.sdk, ["app-server", "--listen", "stdio://"], options.config, {}, {}, catalog, async () => {}, () => {}, options.configPath);
process.stdout.write("ready\\n"); setInterval(() => {}, 60000);
`);
  const isolated = roots.child();
  const options = { client: new URL("../execution-host-client.js", import.meta.url).href, backends: new URL("../app-server-backends.js", import.meta.url).href, sdk: f.sdk, config: f.config, configPath: f.configPath };
  const adapter = spawn(process.execPath, [...isolated.args, script, JSON.stringify(options)], { env: { ...process.env, ...isolated.env }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [line] = await once(createInterface({ input: adapter.stdout! }), "line"); assert.equal(line, "ready");
    await until(async () => (await f.launches()).length > 0, "the engine start");
    const lease = await readNativeHomeOwner(f.nativeHome); const [launch] = await f.launches();
    assert.equal(lease?.hostPid, adapter.pid); assert.equal(lease?.pid, launch.pid); assert.ok(lease?.privateOwner);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1); assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "absent");
    adapter.kill("SIGKILL"); await once(adapter, "exit");
    // Its engine leaves when the dead adapter's pipe closes; until then the lease is still live.
    await until(() => !livePid(launch.pid), "the orphaned engine exit");
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 0); assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "dead_pids");
    host = await startExecutionHost(await hostOptions(f));
    const owner = await readNativeHomeOwner(f.nativeHome);
    assert.equal(owner?.hostPid, process.pid); assert.equal(owner?.privateOwner, undefined);
    // The lease's own receipt is archived; the marker it kept in owner.json had replaced nothing, so it simply goes.
    const stale = await readdir(join(dirname(f.receipt), "stale")); assert.equal(stale.length, 1); assert.match(stale[0], /^private-\d+\.json$/);
    assert.equal(JSON.parse(await readFile(join(dirname(f.receipt), "stale", stale[0]), "utf8")).privateOwner.instanceId, lease?.privateOwner?.instanceId);
    assert.deepEqual((await f.events("execution_owner_reclaimed", since)).map(event => [event.scope, event.reason]), [["native_home", "dead_pids"]]);
    assert.equal((await f.events("native_sharing_unavailable", since)).length, 0);
  } finally { if (adapter.exitCode === null && adapter.signalCode === null) adapter.kill("SIGKILL"); await host?.close(); await f.clean(); }
});

/** A native-home receipt for the fixture's configuration, written as some earlier owner left it. */
const leftReceipt = async (f: Fixture, fields: Message) => writePrivateJson(f.receipt, { version: 1, managed: "subscription-gateway-native-execution-owner",
  configPath: resolve(f.configPath), nativeHome: resolve(f.nativeHome), ...await sdkIdentity(f.sdk), socketPath: join(f.home, "native.sock"), ...fields });
const gone = { hostPid: 2 ** 22 + 7, pid: 2 ** 22 + 9 }; // Pids no process holds, from this boot.

test("a host that never claimed the native home claims it on close, so the receipt a fallback put back becomes a clean stopped one and rollback proceeds", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  try {
    // A crashed host's receipt: it still says running and names a native launch (its revision) whose processes are gone.
    await leftReceipt(f, { ...gone, state: "running", sdkState: "running", revision: "b".repeat(64) }); const crashed = JSON.parse(await readFile(f.receipt, "utf8"));
    const first = await f.create(); const lease = await readNativeHomeOwner(f.nativeHome); assert.deepEqual(lease?.privateOwner?.previous, crashed);
    // A host that starts and stops while the fallback runs leaves its live lease alone.
    host = await startExecutionHost(await hostOptions(f)); await host.close(); host = undefined;
    assert.deepEqual(await readNativeHomeOwner(f.nativeHome), lease);
    // Another host comes back during the fallback; the fallback ends and puts the crashed host's receipt back.
    host = await startExecutionHost(await hostOptions(f));
    await first.adapter.stop(); assert.deepEqual(await readNativeHomeOwner(f.nativeHome), crashed);
    await host.close(); host = undefined;
    const stopped = await readNativeHomeOwner(f.nativeHome);
    assert.deepEqual([stopped?.state, stopped?.sdkState, stopped?.hostPid, stopped?.pid, stopped?.revision, stopped?.privateOwner], ["stopped", "stopped", 0, 0, undefined, undefined]);
    assert.deepEqual((await f.events("native_sharing_unavailable", since)).map(event => event.reason), ["native_owner", "native_owner"]);
    assert.deepEqual((await f.events("execution_owner_reclaimed", since)).filter(event => event.scope === "native_home").map(event => event.reason), ["dead_pids"]);
    // Rollback to legacy writers now finds every managed writer stopped.
    const owner = JSON.parse(await readFile(join(f.home, "owner.json"), "utf8"));
    assert.ok(await archiveStoppedExecutionReceipt({ configPath: resolve(f.configPath), nativeHome: resolve(f.nativeHome), codex: owner.codex, sdkSha256: owner.sdkSha256 }, join(f.directory, "backup")));
    assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
  } finally { await Promise.allSettled([...f.adapters].map(adapter => adapter.stop())); await host?.close(); await f.clean(); }
});

// The end state of a close: a host that never claimed the home (a live owner held it at its start) closes after that owner died,
// and the dead owner's receipt becomes the clean stopped one. This does not pin the order of the claim and the removal of the
// control socket; the test below it does.
test("a host that never claimed the native home closes over a dead owner's receipt and leaves the clean stopped one", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  try {
    // A live owner (this process) holds the home when the host starts, so the host leaves it alone.
    await leftReceipt(f, { hostPid: process.pid, pid: 0, state: "running", sdkState: "idle" }); const live = await readFile(f.receipt, "utf8");
    host = await startExecutionHost(await hostOptions(f)); assert.equal(await readFile(f.receipt, "utf8"), live);
    assert.deepEqual((await f.events("native_sharing_unavailable", since)).map(event => event.reason), ["native_owner"]);
    // Then that owner dies, leaving a receipt that still says running and names a native launch whose processes are gone.
    await leftReceipt(f, { ...gone, state: "running", sdkState: "running", revision: "b".repeat(64) });
    await host.close(); host = undefined;
    const stopped = await readNativeHomeOwner(f.nativeHome);
    assert.deepEqual([stopped?.state, stopped?.sdkState, stopped?.hostPid, stopped?.pid, stopped?.revision, stopped?.privateOwner], ["stopped", "stopped", 0, 0, undefined, undefined]);
    assert.deepEqual((await f.events("execution_owner_reclaimed", since)).filter(event => event.scope === "native_home").map(event => event.reason), ["dead_pids"]);
    assert.equal(JSON.parse(await readFile(join(f.home, "owner.json"), "utf8")).state, "stopped");
    await assert.rejects(lstat(join(f.home, "host.sock")), { code: "ENOENT" });
  } finally { await host?.close(); await f.clean(); }
});

// The claim only comes once the host's own control socket is gone. When that removal is refused (the link was swapped for another
// one, so it is not provably this host's), close() fails and must not have taken the native home on the way.
test("a host that cannot remove its control socket on close does not claim the native home first", { skip: process.platform === "win32", timeout: 30000 }, async () => {
  const f = await fallbackFixture(); let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  try {
    await leftReceipt(f, { hostPid: process.pid, pid: 0, state: "running", sdkState: "idle" });
    host = await startExecutionHost(await hostOptions(f));
    await leftReceipt(f, { ...gone, state: "running", sdkState: "running", revision: "b".repeat(64) }); const dead = await readFile(f.receipt, "utf8");
    const link = join(f.home, "host.sock"); const target = await readlink(link); await unlink(link); await symlink(target, link);
    await assert.rejects(host.close(), /belongs to another listener/);
    assert.equal(await readFile(f.receipt, "utf8"), dead, "the dead owner's receipt was not touched, so the home was not claimed");
    host = undefined;
  } finally { await f.clean(); }
});

test("a host that finds a native-home receipt left under another spelling of the home serves gateway chats and claims the home once it is free", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined; let control: SocketAppServerConnection | undefined;
  try {
    // What an adapter that reached the home through a link left when it crashed, before such fallbacks were refused.
    const link = join(f.directory, "linked-native"); await symlink(f.nativeHome, link);
    await leftReceipt(f, { ...gone, nativeHome: link, socketPath: join(executionHostHome(f.configPath, link), "native.sock"), state: "running", sdkState: "running",
      privateOwner: { instanceId: randomUUID() } });
    const left = await readFile(f.receipt, "utf8");
    // A native-only host has nothing else to offer and still fails its start.
    // The refusal names the receipt to move aside, so a person can act on it.
    const named = (error: Error) => /^Native execution ownership changed/.test(error.message) && error.message.includes(`Move ${f.receipt} aside`);
    await assert.rejects(startExecutionHost({ ...await hostOptions(f), capabilities: ["native" as const] }), named);
    host = await startExecutionHost(await hostOptions(f)); assert.equal(await readFile(f.receipt, "utf8"), left);
    control = new SocketAppServerConnection(join(f.home, "host.sock"), async () => {}); await control.ready;
    assert.equal((await control.request("execution/status", {})).native, null);
    await assert.rejects(control.request("native/acquire", { args: ["app-server"], cwd: f.directory }), named);
    assert.equal(await readFile(f.receipt, "utf8"), left);
    assert.equal((await control.request("execution/acquire", { descriptor: await descriptor(f, "d") })).revision, "d".repeat(64));
    // Once the leftover is moved aside, the next native request claims the home.
    await rm(f.receipt);
    await control.request("native/acquire", { args: ["app-server"], cwd: f.directory });
    const owner = await readNativeHomeOwner(f.nativeHome); assert.equal(owner?.hostPid, process.pid); assert.ok(Number(owner?.pid) > 0);
    assert.deepEqual((await f.events("native_sharing_unavailable", since)).map(event => event.reason), ["native_identity"]);
  } finally { control?.stop(); await host?.close(); await f.clean(); }
});

/** The host's own identity for the fixture's configuration, as its native-home claim names it. */
const hostIdentity = async (f: Fixture): Promise<HostIdentity> => ({ version: 1, managed: executionHostMarker, configPath: resolve(f.configPath), nativeHome: resolve(f.nativeHome),
  ...await sdkIdentity(f.sdk), socketPath: join(f.home, "host.sock") });

test("adapters whose host runs without native sharing each run a private engine under a lease of their own, and the host's writer waits for all of them", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  try {
    host = await startExecutionHost({ ...await hostOptions(f), capabilities: ["gateway" as const] });
    // The app's own adapter, then a connected machine's SSH session on the same native home: both start.
    const first = await f.create(); const second = await f.create();
    for (const { adapter } of [first, second]) { assert.notEqual(adapter.native.shared, true); assert.equal((adapter as unknown as { sharedGateway?: boolean }).sharedGateway, true); }
    await until(async () => (await f.launches()).length === 2, "both engine starts");
    const launches = await f.launches(); const engines = [first, second].map(({ adapter }) => (adapter.native as unknown as { pid: number }).pid);
    assert.deepEqual(launches.map(launch => launch.kind), ["stdio", "stdio"]); assert.deepEqual(launches.map(launch => launch.pid), engines);
    // Each engine found its lease written before it started.
    for (const launch of launches) { assert.equal(launch.lease?.private, true); assert.ok(launch.lease?.hostPid); }
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 2);
    // owner.json names both engines, for releases that read only that file.
    const marker = await readNativeHomeOwner(f.nativeHome);
    assert.equal(marker?.privateOwner?.shared, true); assert.deepEqual([marker?.hostPid, marker?.pid].sort(), [...engines].sort());
    // Native chats work on both engines.
    for (const [index, { adapter }] of [first, second].entries()) assert.equal((await adapter.request("thread/start", { cwd: f.directory })).executorPid, engines[index]);
    // The host's native writer is refused while either private engine runs.
    const identity = await hostIdentity(f);
    await assert.rejects(claimNativeHome(identity, f.home), /already owns this native home/);
    await first.adapter.stop(); assert.equal(livePid(engines[0]), false);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
    const left = await readNativeHomeOwner(f.nativeHome); assert.deepEqual([left?.hostPid, left?.pid], [process.pid, engines[1]]);
    await assert.rejects(claimNativeHome(identity, f.home), /already owns this native home/);
    // Once both are gone the home is as it was (no receipt), and the host's writer may claim it.
    await second.adapter.stop(); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined); assert.equal(await privateNativeHolders(f.nativeHome, f.home), 0);
    await claimNativeHome(identity, f.home); assert.equal((await readNativeHomeOwner(f.nativeHome))?.privateOwner, undefined);
    assert.deepEqual((await f.events("native_sharing_fallback", since)).map(event => [event.reason, event.holders]), [["other", 1], ["other", 2]]);
  } finally { await Promise.allSettled([...f.adapters].map(adapter => adapter.stop())); await host?.close(); await f.clean(); }
});

test("a private engine release 0.4.5 or earlier started keeps the home to itself: a new adapter fails closed, names it and starts nothing", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const since = Date.now() - 1000; configureTelemetry(f.config.stateDirectory, "test");
  let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined; const engine = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    await once(engine, "spawn");
    host = await startExecutionHost({ ...await hostOptions(f), capabilities: ["gateway" as const] });
    // The private receipt of release 0.4.5 or earlier: owner.json with a private owner and no `shared`, naming its live engine.
    await leftReceipt(f, { hostPid: 0, pid: engine.pid, state: "running", sdkState: "running", privateOwner: { instanceId: randomUUID() } });
    const before = await readFile(f.receipt, "utf8");
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /was started by gateway release 0\.4\.5 or earlier, which keeps this native home to itself/.test(error.message)
      && error.message.includes(`(process ${engine.pid})`));
    assert.equal(await readFile(f.receipt, "utf8"), before); assert.deepEqual(await f.launches(), []);
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 0); assert.equal((await f.events("native_sharing_fallback", since)).length, 0);
  } finally { engine.kill("SIGKILL"); await host?.close(); await f.clean(); }
});

test("a shared marker beside a host native socket that answers is refused as that live owner, never named as an earlier release's engine", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); let host: Awaited<ReturnType<typeof startExecutionHost>> | undefined;
  const server = createServer();
  try {
    host = await startExecutionHost({ ...await hostOptions(f), capabilities: ["gateway" as const] });
    await f.create(); assert.equal((await readNativeHomeOwner(f.nativeHome))?.privateOwner?.shared, true);
    // Something now answers at the host's native socket: a writer no private engine may join, whatever the marker says.
    server.listen(join(f.home, "native.sock")); await once(server, "listening"); await chmod(join(f.home, "native.sock"), 0o600);
    assert.equal(await nativeHomeOwnership(f.nativeHome, f.home), "live");
    await assert.rejects(f.create(), (error: Error & { code?: number }) => error.code === -32001 && /owns this native home/.test(error.message) && !/0\.4\.5 or earlier/.test(error.message));
    assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
  } finally { await new Promise<void>(done => server.close(() => done())); await Promise.allSettled([...f.adapters].map(adapter => adapter.stop())); await host?.close(); await f.clean(); }
});

test("a release that failed when the engine exited is tried again when the adapter stops", { timeout: 30000 }, async () => {
  const f = await fallbackFixture(); const holder = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  try {
    await once(holder, "spawn");
    const first = await f.create(); assert.equal(await privateNativeHolders(f.nativeHome, f.home), 1);
    // Another process holds the receipt's lock while the engine exits, so the release at its exit fails after five seconds.
    const lock = `${f.receipt}.lock`; await writeFile(lock, String(holder.pid), { mode: 0o600 });
    await first.adapter.request("fixture/exit", {}).catch(() => {}); await until(() => first.exits() === 1, "the engine exit");
    await (first.adapter as unknown as { leaseReleased?: Promise<void> }).leaseReleased;
    assert.equal((await readdir(dirname(f.receipt))).filter(name => name.startsWith("private-")).length, 1);
    // The lock is free again; stopping the adapter releases the lease.
    await rm(lock); await first.adapter.stop();
    assert.deepEqual((await readdir(dirname(f.receipt))).filter(name => name.startsWith("private-")), []); assert.equal(await readNativeHomeOwner(f.nativeHome), undefined);
  } finally { holder.kill("SIGKILL"); await f.clean(); }
});
